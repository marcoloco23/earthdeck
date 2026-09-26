// `ledger_*` — Claude's hands on the findings ledger: read, narrate, review, advance, publish.
// Every write goes through `Ledger.append`, so the trust contract (`checkAppend` in
// src/ledger/schema.ts, policy PUBLISH_POLICY_VERSION) decides; its error messages are
// returned verbatim. Publishing is an AI act that runs autonomously and is verified
// afterwards: the gates (narration + a publish verdict by a different identity, tier ≤ 2,
// private notice before naming a party) are the ledger's, not this file's. See TRUST.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ledgerDir } from "../config.js";
import { pushFindingCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import {
  gates as gatesSchema,
  NOTICE_PRIVATE_HOURS,
  PUBLIC_STATUSES,
  PUBLISH_POLICY_VERSION,
  publishGates,
  STATUSES,
  TRANSITIONS,
  type Finding,
  type Status,
} from "../ledger/schema.js";
import { Ledger, type EventInput } from "../ledger/store.js";
import { safe } from "../result.js";

const findingId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "findingId must be a UUID").describe("Finding id (UUID)");
const writerActor = z
  .string()
  .regex(/^(model|reviewer):\S.*$/, "actor must be model:<id> or reviewer:<handle>")
  .describe("Who is acting: `model:<id>` (you) or `reviewer:<handle>` (a named human, only on their explicit instruction)");
const reviewerIdentity = z.string().regex(/^(reviewer|model):\S.*$/, "must be reviewer:<handle> or model:<id>");
const registryRef = z.object({ name: z.string().min(1), url: z.string().url(), id: z.string().min(1) });
const MAX_NARRATION_CHARS = 20_000; // mirrors the `narrated` event's text limit in schema.ts
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** Statuses ledger_advance may request from here: the legal moves, plus retraction (always, with a reason). */
export function advanceableFrom(status: Status): Status[] {
  return status === "retracted" ? [] : [...TRANSITIONS[status], "retracted"];
}

export function compactFinding(f: Finding) {
  return {
    findingId: f.findingId,
    status: f.status,
    public: PUBLIC_STATUSES.includes(f.status),
    tier: f.tier,
    title: f.title,
    rule: `${f.rule.name}@${f.rule.version}`,
    aoi: f.aoi ? { id: f.aoi.id, name: f.aoi.name } : undefined,
    observedAt: f.observedAt,
    updatedAt: f.updatedAt,
    evidence: f.evidence.length + (f.confirmed ? 1 : 0),
    history: f.history.length,
  };
}

function hasLedger(dir: string): boolean {
  return existsSync(join(dir, "entries.jsonl"));
}

/** Readers never create a key (or a directory, if there is no ledger yet). */
function openRead(): Ledger | null {
  const dir = ledgerDir();
  return hasLedger(dir) ? Ledger.open(dir, { createKey: false }) : null;
}

/** Writers need an existing ledger and its existing key — never mint a new one here. */
function openWrite(): Ledger {
  const dir = ledgerDir();
  if (!hasLedger(dir)) throw new OverviewError(`no ledger at ${dir} (set EARTHDECK_LEDGER_DIR, or run a sweep first)`);
  return Ledger.open(dir, { createKey: false });
}

function mustGet(l: Ledger, id: string): Finding {
  const f = l.get(id);
  if (!f) throw new OverviewError(`no such finding ${id}`);
  return f;
}

/** Append through the store (trust contract enforced there), push the card, report. */
async function write(id: string, build: (current: Finding) => EventInput) {
  const l = openWrite();
  const input = build(mustGet(l, id));
  let res: ReturnType<Ledger["append"]>;
  try {
    res = l.append(input);
  } catch (err) {
    // zod / checkAppend messages are the contract's own words — surface them as-is.
    throw new OverviewError(err instanceof z.ZodError ? z.prettifyError(err) : err instanceof Error ? err.message : String(err));
  }
  const f = mustGet(l, id);
  const pushed = await pushFindingCard(f);
  return {
    appended: { eventId: res.event.eventId, kind: res.event.kind, at: res.event.at, actor: res.event.actor, index: res.index },
    finding: compactFinding(f),
    ledger: { size: l.size, root: l.root().toString("hex") },
    dashboard: pushed ? "card pushed" : "dashboard not running",
  };
}

export function registerLedgerTools(server: McpServer): void {
  server.registerTool(
    "ledger_list",
    {
      title: "Ledger — list findings",
      description:
        "List findings in the local Earth Watch ledger (newest activity first) as compact rows: " +
        "id, status, tier, title, rule, AOI, observedAt, evidence count, history length, and " +
        "whether it is public. Filter by status, rule name, AOI id, or activity since a time. " +
        "Read-only. Use ledger_get for one finding's full record.",
      inputSchema: {
        status: z.array(z.enum(STATUSES)).optional().describe("Only these statuses"),
        rule: z.string().optional().describe("Rule name, e.g. forest_loss"),
        aoi: z.string().optional().describe("AOI id, e.g. br-sfx-01"),
        since: z.string().optional().describe("Only findings updated at/after this ISO date/time"),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ status, rule, aoi, since, limit }) =>
      safe(async () => {
        const l = openRead();
        if (!l) return { ledger: ledgerDir(), size: 0, total: 0, findings: [], note: "no ledger yet" };
        let sinceMs: number | undefined;
        if (since) {
          sinceMs = Date.parse(since);
          if (!Number.isFinite(sinceMs)) throw new OverviewError(`since: not a date/time: ${since}`);
        }
        const all = l.list(status ? { status } : {});
        const matched = all.filter(
          (f) => (!rule || f.rule.name === rule) && (!aoi || f.aoi?.id === aoi) && (sinceMs === undefined || Date.parse(f.updatedAt) >= sinceMs),
        );
        const page = matched.slice(0, limit);
        const counts: Record<string, number> = {};
        for (const f of matched) counts[f.status] = (counts[f.status] ?? 0) + 1;
        const pushed = await Promise.all(page.slice(0, 20).map((f) => pushFindingCard(f)));
        return {
          ledger: ledgerDir(),
          size: l.size,
          total: matched.length,
          counts,
          findings: page.map(compactFinding),
          dashboard: pushed.some(Boolean) ? "cards pushed" : "dashboard not running",
        };
      }),
  );

  server.registerTool(
    "ledger_get",
    {
      title: "Ledger — one finding",
      description:
        "One finding's full record: the folded projection (evidence, confirmation signal, context, " +
        "blind spots, attribution, narration, reviews, notices, replies, history) plus every event " +
        "in order, and which status moves ledger_advance may make from here. Read-only.",
      inputSchema: { findingId },
    },
    async ({ findingId: id }) =>
      safe(async () => {
        const l = openRead();
        if (!l) throw new OverviewError(`no ledger at ${ledgerDir()}`);
        const f = mustGet(l, id);
        const pushed = await pushFindingCard(f);
        return {
          finding: f,
          events: l.eventsOf(id).map((ev) => ({ index: l.eventIndex(ev.eventId), ...ev })),
          next: { legal: TRANSITIONS[f.status], viaLedgerAdvance: advanceableFrom(f.status), publish: publishGates(f) },
          dashboard: pushed ? "card pushed" : "dashboard not running",
        };
      }),
  );

  server.registerTool(
    "ledger_verify",
    {
      title: "Ledger — verify",
      description:
        "Re-derive the whole ledger from entries.jsonl (the same check `earthdeck ledger verify` " +
        "and any third party runs): every entry signed, canonical, rule-abiding, and the signed " +
        "checkpoint matching the recomputed Merkle root. Optionally prove consistency with an " +
        "earlier trusted checkpoint. Read-only.",
      inputSchema: {
        trustedCheckpoint: z.string().optional().describe("Text of an earlier checkpoint to prove append-only consistency against"),
      },
    },
    async ({ trustedCheckpoint }) =>
      safe(async () => {
        const l = openRead();
        if (!l) return { ledger: ledgerDir(), ok: true, size: 0, note: "no ledger yet" };
        const r = l.verify({ trustedCheckpoint });
        const pubPath = join(l.dir, "ledger.pub");
        return {
          ledger: l.dir,
          ok: r.ok,
          size: r.size,
          findings: r.findings,
          root: r.root,
          checkpoint: { signedBy: r.signedBy, text: l.checkpointText() },
          publicKey: existsSync(pubPath) ? readFileSync(pubPath, "utf8").trim() : null,
          problems: r.problems,
        };
      }),
  );

  server.registerTool(
    "ledger_advance",
    {
      title: "Ledger — advance, publish or retract a finding",
      description:
        "Append a status_changed event (with a reason) to a finding, or a retracted event when " +
        "to = retracted (always allowed, with a reason). Only legal moves are accepted. Publishing " +
        `(confirmed → published) is autonomous under policy ${PUBLISH_POLICY_VERSION}: the ledger ` +
        "requires an independent second signal, a narration, and after it a review with verdict " +
        '"publish" by a DIFFERENT identity than the narrator (another model:<id> or a reviewer:); ' +
        "tier ≤ 2 only — tier 3 needs a human reviewer: actor. Naming a party additionally needs two " +
        `distinct attribution reviewers and a private notice to the party ≥ ${NOTICE_PRIVATE_HOURS} h before ` +
        "publishing (or a recorded unreachable notice). A model:'s publish carries `gates` (who " +
        "narrated/reviewed, notice hours, policy); omit them and they are computed from the ledger " +
        "(ledger_get shows next.publish). Moves out of a public status need a reason. Confirmation " +
        "happens only via the watch kernel's independent second signal, not here.",
      inputSchema: {
        findingId,
        to: z.enum(STATUSES).describe("Target status (retracted appends a retraction)"),
        reason: z.string().min(1).max(2000).describe("Why — recorded in the ledger forever"),
        actor: writerActor,
        gates: gatesSchema.optional().describe("Publish only: the gates passed; computed from the ledger when omitted"),
      },
    },
    async ({ findingId: id, to, reason, actor, gates }) =>
      safe(async () => {
        if (to === "retracted") return write(id, () => ({ kind: "retracted", findingId: id, actor, reason }));
        return write(id, (f) => {
          let g = gates;
          if (to === "published" && !g && actor.startsWith("model:")) {
            const check = publishGates(f);
            if (!check.gates) throw new OverviewError(`cannot publish: ${check.missing.join("; ")}`);
            g = check.gates;
          }
          return { kind: "status_changed", findingId: id, actor, from: f.status, to, reason, ...(g ? { gates: g } : {}) };
        });
      }),
  );

  server.registerTool(
    "ledger_narrate",
    {
      title: "Ledger — narrate a finding",
      description:
        "Append an AI narration (a plain-language account) to a finding. Every claim must cite " +
        "evidence ids the finding actually holds (evidenceRefs; unknown ids are refused). Carries " +
        "the model id and a SHA-256 of the prompt (pass promptSha256, or pass the prompt text and " +
        `it is hashed here). Max ${MAX_NARRATION_CHARS} chars. Not a review and not a publication.`,
      inputSchema: {
        findingId,
        text: z.string().min(1).max(MAX_NARRATION_CHARS),
        model: z.object({ id: z.string().min(1), provider: z.string().optional() }),
        evidenceRefs: z.array(z.string().min(1)).min(1).describe("Evidence ids (from ledger_get) the narration relies on"),
        prompt: z.string().min(1).optional().describe("Prompt text; hashed into promptSha256"),
        promptSha256: sha256Hex.optional(),
        transcriptSha256: sha256Hex.optional(),
        actor: writerActor.optional().describe("Default model:<model.id>"),
      },
    },
    async ({ findingId: id, text, model, evidenceRefs, prompt, promptSha256, transcriptSha256, actor }) =>
      safe(async () => {
        const hash = promptSha256 ?? (prompt ? createHash("sha256").update(prompt).digest("hex") : undefined);
        if (!hash) throw new OverviewError("pass promptSha256 or prompt");
        return write(id, () => ({
          kind: "narrated",
          findingId: id,
          actor: actor ?? `model:${model.id}`,
          text,
          model,
          promptSha256: hash,
          ...(transcriptSha256 ? { transcriptSha256 } : {}),
          evidenceRefs,
        }));
      }),
  );

  server.registerTool(
    "ledger_review",
    {
      title: "Ledger — record a review",
      description:
        "Record a review of a finding (a reviewed event) with a publication verdict: publish | hold | " +
        "reject. The reviewer is a model:<id> (an independent second model, not the one that " +
        "narrated) or a reviewer:<handle> (a named human, only on their explicit instruction). A " +
        '"publish" verdict by an identity other than the narrator, after the latest narration, is ' +
        "what the autonomous publication gate needs; hold/reject as the latest review blocks it. The " +
        "ledger refuses reviews by the actor that opened the finding. Never publishes by itself.",
      inputSchema: {
        findingId,
        reviewer: reviewerIdentity.describe("model:<id> or reviewer:<handle> of whoever decided"),
        verdict: z.enum(["publish", "hold", "reject"]),
        decision: z.enum(["approve", "reject"]).optional().describe("Default: approve for publish, reject otherwise"),
        tier: z.number().int().min(0).max(3).optional().describe("Tier the decision covers (default: the finding's tier)"),
        note: z.string().max(2000).optional(),
      },
    },
    async ({ findingId: id, reviewer, verdict, decision, tier, note }) =>
      safe(async () => {
        return write(id, (f) => ({
          kind: "reviewed",
          findingId: id,
          actor: reviewer,
          decision: decision ?? (verdict === "publish" ? "approve" : "reject"),
          verdict,
          tier: tier ?? f.tier,
          ...(note ? { note } : {}),
        }));
      }),
  );

  server.registerTool(
    "ledger_propose_attribution",
    {
      title: "Ledger — propose an attribution",
      description:
        "Append an attributed event: what the finding is about (subject: an asset, place or " +
        "institution — never a natural person) and, optionally, a responsible party, which must " +
        "come from a cited registry (Climate TRACE / GEM ownership etc.). Naming a party requires " +
        "tier ≥ 2 and two distinct reviewer identities (models allowed; neither the actor who opened " +
        "the finding nor its narrator) — the ledger refuses otherwise. This is a PROPOSAL recorded in the ledger; it NEVER publishes " +
        "and never changes the finding's status.",
      inputSchema: {
        findingId,
        actor: writerActor,
        subject: z.object({
          kind: z.enum(["asset", "place", "institution"]),
          name: z.string().min(1),
          registry: registryRef.optional(),
        }),
        party: z
          .object({ name: z.string().min(1), registry: registryRef, stake: z.number().min(0).max(1).optional() })
          .optional()
          .describe("Responsible party, only via a cited registry"),
        reviewers: z.array(reviewerIdentity).default([]).describe("Distinct reviewer identities who signed off (two when a party is named)"),
      },
    },
    async ({ findingId: id, actor, subject, party, reviewers }) =>
      safe(async () => write(id, () => ({ kind: "attributed", findingId: id, actor, subject, ...(party ? { party } : {}), reviewers }))),
  );
}
