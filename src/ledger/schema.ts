// The finding-event schema (predicate `https://earthdeck.dev/finding-event/v1`) and the
// trust contract as code: which events exist, which status transitions are legal, and
// what a publication needs before it can happen (evidence, an independent second signal,
// the right number of distinct human reviewers, the right-of-reply clock for tier 3).
//
// The ledger is event-sourced: a Finding is a fold over its events (`applyEvent`), never a
// mutable row. Rules that need the finding's current state live in `checkAppend`, which
// the store calls with the projection before it signs anything. Schema changes are
// additive only — v2 gets a new predicateType beside v1.

import { z } from "zod";
import { canonicalize } from "./jcs.js";
import { createHash } from "node:crypto";

export const PREDICATE_TYPE = "https://earthdeck.dev/finding-event/v1";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** Days an unconfirmed candidate lives before it should be expired (GLAD's rule). */
export const CANDIDATE_TTL_DAYS = 180;
/** The two clocks: private notice to the party/authority, then public release. */
export const NOTICE_PRIVATE_HOURS = 72;
export const NOTICE_PUBLIC_DAYS = 30;

// ---- Building blocks ---------------------------------------------------------------------

const rfc3339 = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "RFC 3339 UTC timestamp required");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Who did it: the deterministic layer, a human reviewer, or a model. Never anonymous. */
export const actor = z.string().regex(/^(system|reviewer|model):[^\s].*$/, "actor must be system:<rule@ver> | reviewer:<handle> | model:<id>");

const position = z.tuple([z.number(), z.number()]).rest(z.number());
const ring = z.array(position).min(4);
/** GeoJSON (RFC 7946) geometry — the subset findings use. */
export const geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: position }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(ring).min(1)).min(1) }),
]);
export type Geometry = z.infer<typeof geometry>;

export const bbox = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** The method that produced a piece of evidence — versioned so a number is never orphaned. */
export const method = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

/**
 * One piece of evidence, STAC-Item-shaped. `id` + `source` must let a third party fetch
 * the same input; `digest` pins any derived artifact we produced from it.
 */
export const evidence = z.object({
  id: z.string().min(1),
  kind: z.enum(["scene", "alert", "series", "raster", "record", "document"]),
  source: z.string().min(1), // provider / dataset, e.g. "sentinel-2-l2a", "gfw-integrated-alerts"
  collection: z.string().optional(),
  datetime: rfc3339,
  href: z.string().url().optional(),
  digest: sha256Hex.optional(),
  method,
  summary: z.string().max(2000).optional(),
  values: z.record(z.string(), z.number()).optional(),
});
export type Evidence = z.infer<typeof evidence>;

export const tier = z.number().int().min(0).max(3);

export const STATUSES = [
  "candidate",
  "confirmed",
  "published",
  "notified",
  "replied",
  "no_response",
  "resolved",
  "ignored",
  "expired",
  "false_positive",
  "retracted",
] as const;
export type Status = (typeof STATUSES)[number];
const status = z.enum(STATUSES);

/** Legal `status_changed` moves. `confirmed`, `notified`, `replied`, `retracted` are their own events. */
export const TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  candidate: ["expired", "false_positive"],
  confirmed: ["published", "expired", "false_positive"],
  published: ["resolved", "ignored", "false_positive"],
  notified: ["no_response", "resolved", "ignored", "false_positive"],
  replied: ["resolved", "ignored", "false_positive"],
  no_response: ["resolved", "ignored", "false_positive"],
  resolved: [],
  ignored: ["resolved"],
  expired: [],
  false_positive: [],
  retracted: [],
};

/** Statuses visible on the public site. Candidates and confirmed-but-unreviewed are not. */
export const PUBLIC_STATUSES: readonly Status[] = ["published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"];

// ---- Events ------------------------------------------------------------------------------

const base = z.object({
  v: z.literal(1),
  eventId: uuid,
  findingId: uuid,
  at: rfc3339,
  actor,
  /** Hash of the previous event of this finding (null for `created`) — cheap fork detection. */
  prev: sha256Hex.nullable(),
});

const registryRef = z.object({ name: z.string().min(1), url: z.string().url(), id: z.string().min(1) });

export const eventPayload = z.discriminatedUnion("kind", [
  base.extend({
    kind: z.literal("created"),
    rule: method,
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2000),
    tier,
    geometry,
    bbox,
    aoi: z.object({ id: z.string(), name: z.string().optional(), tags: z.array(z.string()).optional() }).optional(),
    observedAt: rfc3339,
    evidence: z.array(evidence).min(1, "a finding cannot exist without evidence"),
  }),
  base.extend({ kind: z.literal("evidence_added"), evidence: z.array(evidence).min(1) }),
  base.extend({
    kind: z.literal("confirmed"),
    /** The independent second signal — different sensor physics, provider, or a later revisit. */
    signal: evidence,
    independence: z.enum(["sensor", "provider", "revisit", "human"]),
  }),
  base.extend({ kind: z.literal("status_changed"), from: status, to: status, reason: z.string().max(2000).optional() }),
  base.extend({
    kind: z.literal("attributed"),
    /** What the finding is about. Assets, places, institutions — never natural persons. */
    subject: z.object({
      kind: z.enum(["asset", "place", "institution"]),
      name: z.string().min(1),
      registry: registryRef.optional(),
    }),
    /** A responsible party, only via a cited registry (Climate TRACE / GEM ownership, etc.). */
    party: z
      .object({ name: z.string().min(1), registry: registryRef, stake: z.number().min(0).max(1).optional() })
      .optional(),
    /** Distinct human reviewers who signed off on the attribution. Two when a party is named. */
    reviewers: z.array(z.string().regex(/^reviewer:/)).default([]),
  }),
  base.extend({
    kind: z.literal("narrated"),
    text: z.string().min(1).max(20_000),
    model: z.object({ id: z.string().min(1), provider: z.string().optional() }),
    promptSha256: sha256Hex,
    transcriptSha256: sha256Hex.optional(),
    /** Every claim must point at evidence the finding actually holds. */
    evidenceRefs: z.array(z.string().min(1)).min(1),
    reviewedBy: z.string().regex(/^reviewer:/).optional(),
  }),
  base.extend({
    kind: z.literal("reviewed"),
    decision: z.enum(["approve", "reject"]),
    tier,
    note: z.string().max(2000).optional(),
  }),
  base.extend({
    kind: z.literal("notified"),
    to: z.object({ kind: z.enum(["party", "authority", "public"]), name: z.string().min(1), channel: z.string().url().optional() }),
    /** When the finding may go public (the 30-day clock), set at notification time. */
    publicAt: rfc3339,
  }),
  base.extend({
    kind: z.literal("replied"),
    from: z.string().min(1),
    text: z.string().min(1).max(20_000),
    receivedAt: rfc3339,
  }),
  base.extend({ kind: z.literal("retracted"), reason: z.string().min(1).max(2000) }),
]);
export type FindingEvent = z.infer<typeof eventPayload>;
export type EventKind = FindingEvent["kind"];

// ---- in-toto Statement + DSSE envelope ---------------------------------------------------

export const statement = z.object({
  _type: z.literal(STATEMENT_TYPE),
  subject: z.array(z.object({ name: z.string(), digest: z.object({ sha256: sha256Hex }) })).length(1),
  predicateType: z.literal(PREDICATE_TYPE),
  predicate: eventPayload,
});
export type Statement = z.infer<typeof statement>;

export const envelope = z.object({
  payloadType: z.literal(PAYLOAD_TYPE),
  payload: z.string().min(1), // base64 of the JCS-canonical Statement
  signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })).min(1),
});
export type Envelope = z.infer<typeof envelope>;

/** SHA-256 of an event's canonical form — what the next event's `prev` points at. */
export function eventHash(ev: FindingEvent): string {
  return createHash("sha256").update(canonicalize(ev)).digest("hex");
}

/** Wrap an event as an in-toto Statement whose subject is the finding. */
export function toStatement(ev: FindingEvent): Statement {
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: ev.findingId, digest: { sha256: eventHash(ev) } }],
    predicateType: PREDICATE_TYPE,
    predicate: ev,
  };
}

/** DSSE pre-authentication encoding: what actually gets signed. */
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `, "utf8"),
    payload,
  ]);
}

// ---- Projection --------------------------------------------------------------------------

export interface Finding {
  findingId: string;
  status: Status;
  tier: number;
  rule: z.infer<typeof method>;
  title: string;
  summary: string;
  geometry: Geometry;
  bbox: [number, number, number, number];
  aoi?: { id: string; name?: string; tags?: string[] };
  observedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  confirmed: null | { at: string; independence: string; signal: Evidence };
  evidence: Evidence[];
  attribution: null | Extract<FindingEvent, { kind: "attributed" }>;
  narration: null | Extract<FindingEvent, { kind: "narrated" }>;
  reviews: Extract<FindingEvent, { kind: "reviewed" }>[];
  notifications: Extract<FindingEvent, { kind: "notified" }>[];
  replies: Extract<FindingEvent, { kind: "replied" }>[];
  retracted: null | { at: string; reason: string };
  history: { at: string; kind: EventKind; status: Status; actor: string }[];
  eventCount: number;
  lastEventHash: string;
}

/**
 * Check that `ev` may be appended given the finding's current projection (`f` is null for
 * `created`). Throws with a plain-English reason. This is the trust contract's teeth.
 */
export function checkAppend(f: Finding | null, ev: FindingEvent): void {
  if (ev.kind === "created") {
    if (f) throw new Error(`finding ${ev.findingId} already exists`);
    if (ev.prev !== null) throw new Error("created event must have prev = null");
    return;
  }
  if (!f) throw new Error(`finding ${ev.findingId} does not exist`);
  if (ev.prev !== f.lastEventHash) throw new Error(`prev hash mismatch for ${ev.findingId} (fork or stale writer)`);
  if (f.status === "retracted") throw new Error("finding is retracted; no further events");

  switch (ev.kind) {
    case "confirmed":
      if (f.status !== "candidate") throw new Error(`can only confirm a candidate (status is ${f.status})`);
      if (f.evidence.some((e) => e.id === ev.signal.id && e.source === ev.signal.source)) {
        throw new Error("the confirming signal must be independent of the existing evidence");
      }
      return;
    case "status_changed": {
      if (ev.from !== f.status) throw new Error(`status is ${f.status}, not ${ev.from}`);
      if (!TRANSITIONS[f.status].includes(ev.to)) throw new Error(`illegal transition ${f.status} → ${ev.to}`);
      if (ev.to === "published") checkPublishable(f, ev.at);
      return;
    }
    case "attributed": {
      const distinct = new Set(ev.reviewers);
      if (distinct.size !== ev.reviewers.length) throw new Error("attribution reviewers must be distinct");
      if (ev.reviewers.includes(f.createdBy)) throw new Error("the actor who opened the finding cannot review its attribution");
      if (ev.party) {
        if (f.tier < 2) throw new Error("naming a party requires tier ≥ 2");
        if (distinct.size < 2) throw new Error("naming a party requires two distinct human reviewers");
      }
      return;
    }
    case "narrated": {
      const known = new Set(f.evidence.map((e) => e.id));
      if (f.confirmed) known.add(f.confirmed.signal.id);
      const missing = ev.evidenceRefs.filter((r) => !known.has(r));
      if (missing.length) throw new Error(`narration cites evidence the finding does not hold: ${missing.join(", ")}`);
      return;
    }
    case "reviewed":
      if (!ev.actor.startsWith("reviewer:")) throw new Error("reviews must come from a reviewer: actor");
      if (ev.actor === f.createdBy) throw new Error("the actor who opened the finding cannot review it");
      return;
    case "notified":
      if (!["confirmed", "published"].includes(f.status)) throw new Error(`cannot notify from status ${f.status}`);
      return;
    case "replied":
      // A reply can only follow a notice — but it may arrive before publication (the
      // private-notice window is exactly when we hope to hear back).
      if (f.notifications.length === 0) throw new Error("cannot record a reply: nobody was notified");
      if (!["confirmed", "published", "notified", "no_response"].includes(f.status)) throw new Error(`cannot record a reply from status ${f.status}`);
      return;
    case "evidence_added":
    case "retracted":
      return;
  }
}

function checkPublishable(f: Finding, at: string): void {
  if (!f.confirmed) throw new Error("cannot publish an unconfirmed finding (no independent second signal)");
  const approvers = new Set(f.reviews.filter((r) => r.decision === "approve" && r.tier >= f.tier).map((r) => r.actor));
  const latest = f.reviews[f.reviews.length - 1];
  const rejected = latest?.decision === "reject";
  if (f.tier >= 1 && approvers.size < 1) throw new Error("tier ≥ 1 needs a human approval before publishing");
  if (f.tier >= 2 && approvers.size < 2) throw new Error("tier ≥ 2 needs two distinct human approvals before publishing");
  if (rejected) throw new Error("latest review rejected publication");
  if (f.attribution?.party && f.attribution.reviewers.length < 2) throw new Error("a named party needs two attribution reviewers");
  if (f.tier >= 3) {
    const notice = f.notifications.find((n) => n.to.kind !== "public");
    if (!notice) throw new Error("tier 3 requires private notice (right of reply) before publishing");
    if (at < notice.publicAt) throw new Error(`right-of-reply clock runs until ${notice.publicAt}`);
  }
}

/** Fold one event into the projection. Assumes `checkAppend` passed. */
export function applyEvent(f: Finding | null, ev: FindingEvent): Finding {
  const hash = eventHash(ev);
  if (ev.kind === "created") {
    const created: Finding = {
      findingId: ev.findingId,
      status: "candidate",
      tier: ev.tier,
      rule: ev.rule,
      title: ev.title,
      summary: ev.summary,
      geometry: ev.geometry,
      bbox: ev.bbox,
      aoi: ev.aoi,
      observedAt: ev.observedAt,
      createdAt: ev.at,
      updatedAt: ev.at,
      createdBy: ev.actor,
      confirmed: null,
      evidence: [...ev.evidence],
      attribution: null,
      narration: null,
      reviews: [],
      notifications: [],
      replies: [],
      retracted: null,
      history: [],
      eventCount: 0,
      lastEventHash: hash,
    };
    created.history.push({ at: ev.at, kind: ev.kind, status: created.status, actor: ev.actor });
    created.eventCount = 1;
    return created;
  }
  if (!f) throw new Error("applyEvent: missing finding");
  const n: Finding = { ...f, evidence: [...f.evidence], reviews: [...f.reviews], notifications: [...f.notifications], replies: [...f.replies], history: [...f.history] };
  switch (ev.kind) {
    case "evidence_added":
      n.evidence.push(...ev.evidence);
      break;
    case "confirmed":
      n.confirmed = { at: ev.at, independence: ev.independence, signal: ev.signal };
      n.status = "confirmed";
      break;
    case "status_changed":
      n.status = ev.to;
      break;
    case "attributed":
      n.attribution = ev;
      break;
    case "narrated":
      n.narration = ev;
      break;
    case "reviewed":
      n.reviews.push(ev);
      break;
    case "notified":
      n.notifications.push(ev);
      if (n.status === "published") n.status = "notified";
      break;
    case "replied":
      n.replies.push(ev);
      // Before publication the reply is recorded (and shown verbatim later); status moves
      // to `replied` only once the finding is in its public phase.
      if (n.status === "notified" || n.status === "no_response") n.status = "replied";
      break;
    case "retracted":
      n.retracted = { at: ev.at, reason: ev.reason };
      n.status = "retracted";
      break;
  }
  n.updatedAt = ev.at;
  n.eventCount = f.eventCount + 1;
  n.lastEventHash = hash;
  n.history.push({ at: ev.at, kind: ev.kind, status: n.status, actor: ev.actor });
  return n;
}
