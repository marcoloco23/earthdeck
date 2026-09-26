// The ledger end to end: append → sign → tile → checkpoint, the trust contract's rules,
// and `verify` catching every kind of tampering a dishonest operator (or a disk) could do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type EventInput } from "../src/ledger/store.js";
import { CANDIDATE_TTL_DAYS, NOTICE_PRIVATE_HOURS, PUBLIC_STATUSES, PUBLISH_POLICY_VERSION, publishGates } from "../src/ledger/schema.js";
import type { Evidence } from "../src/ledger/schema.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "earthdeck-ledger-"));
}

const gfw: Evidence = {
  id: "gfw-integrated-2026-09-01-tile-21LYH",
  kind: "alert",
  source: "gfw-integrated-alerts",
  datetime: "2026-09-01T00:00:00Z",
  method: { name: "forest_loss", version: "1.0", params: { minConfidence: "high", minHa: 5 } },
  values: { alerts: 412, ha: 38.2 },
};
const ndvi: Evidence = {
  id: "S2B_MSIL2A_20260903T140049_N0511_R110_T21LYH",
  kind: "scene",
  source: "sentinel-2-l2a",
  datetime: "2026-09-03T14:00:49Z",
  method: { name: "eo_compare", version: "1.0", params: { index: "NDVI", composite: "median" } },
  values: { deltaNdvi: -0.31, validPct: 94 },
};

function created(overrides: Partial<Extract<EventInput, { kind: "created" }>> = {}): EventInput {
  return {
    kind: "created",
    findingId: "01923e5a-0000-7000-8000-000000000001",
    actor: "system:forest_loss@1.0",
    rule: { name: "forest_loss", version: "1.0" },
    title: "Forest loss, São Félix do Xingu",
    summary: "412 high-confidence GFW alerts, 38 ha, in a 90-day window.",
    tier: 1,
    geometry: { type: "Polygon", coordinates: [[[-52.1, -6.7], [-52.0, -6.7], [-52.0, -6.6], [-52.1, -6.6], [-52.1, -6.7]]] },
    bbox: [-52.1, -6.7, -52.0, -6.6],
    aoi: { id: "br-sfx-01", name: "São Félix do Xingu" },
    observedAt: "2026-09-01T00:00:00Z",
    evidence: [gfw],
    ...overrides,
  };
}

test("ledger: append → checkpoint → verify round-trip, files on disk", () => {
  const dir = tmp();
  const l = Ledger.open(dir);
  const { event, index } = l.append(created());
  assert.equal(index, 0);
  assert.equal(event.kind, "created");
  assert.ok(existsSync(join(dir, "entries.jsonl")));
  assert.ok(existsSync(join(dir, "checkpoint")));
  assert.ok(existsSync(join(dir, "ledger.key")));
  assert.ok(existsSync(join(dir, "ledger.pub")));
  assert.ok(existsSync(join(dir, "tile/0/000.p/1")));

  l.append({ kind: "confirmed", findingId: event.findingId, actor: "system:forest_loss@1.0", signal: ndvi, independence: "sensor" });
  assert.ok(existsSync(join(dir, "tile/0/000.p/2")));
  assert.ok(!existsSync(join(dir, "tile/0/000.p/1")), "stale partial tile removed");

  const f = l.get(event.findingId)!;
  assert.equal(f.status, "confirmed");
  assert.equal(f.eventCount, 2);
  assert.equal(f.confirmed?.independence, "sensor");

  const report = l.verify();
  assert.deepEqual(report.problems, []);
  assert.equal(report.size, 2);
  assert.deepEqual(report.signedBy, ["earthdeck"]);

  // Reopen from disk: same projection, same root; a read-only opener can verify with ledger.pub.
  const again = Ledger.open(dir);
  assert.equal(again.size, 2);
  assert.equal(again.get(event.findingId)?.status, "confirmed");
  assert.ok(again.root().equals(l.root()));
  const proof = again.inclusionProof(1);
  assert.equal(proof.proof.length, 1);
});

test("ledger: verify catches edited, deleted, reordered and forged entries", () => {
  const dir = tmp();
  const l = Ledger.open(dir);
  const { event } = l.append(created());
  l.append({ kind: "confirmed", findingId: event.findingId, actor: "system:forest_loss@1.0", signal: ndvi, independence: "sensor" });
  l.append({ kind: "evidence_added", findingId: event.findingId, actor: "system:forest_loss@1.0", evidence: [{ ...gfw, id: "gfw-2" }] });
  const trusted = l.checkpointText()!;
  const path = join(dir, "entries.jsonl");
  const original = readFileSync(path, "utf8");
  const lines = original.trimEnd().split("\n");

  // 1. Edit a byte inside line 2's payload → signature + root + checkpoint all disagree.
  writeFileSync(path, [lines[0], lines[1]!.replace(/"payload":"([A-Za-z0-9+/]{10})/, (_m, p) => `"payload":"${p.slice(0, 9)}${p[9] === "A" ? "B" : "A"}`), lines[2]].join("\n") + "\n");
  let r = Ledger.open(dir, { createKey: false }).verify({ trustedCheckpoint: trusted });
  assert.ok(!r.ok);
  assert.ok(r.problems.some((p) => p.index === 1 && /signature/.test(p.message)), JSON.stringify(r.problems));
  assert.ok(r.problems.some((p) => /checkpoint root/.test(p.message)));

  // 2. Delete the last line → size mismatch and the log "shrank" relative to the trusted checkpoint.
  writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");
  r = Ledger.open(dir, { createKey: false }).verify({ trustedCheckpoint: trusted });
  assert.ok(r.problems.some((p) => /size 3 ≠ 2/.test(p.message)));
  assert.ok(r.problems.some((p) => /shrank/.test(p.message)));

  // 3. Reorder lines → prev-hash chain breaks (a rule violation), root differs.
  writeFileSync(path, [lines[0], lines[2], lines[1]].join("\n") + "\n");
  r = Ledger.open(dir, { createKey: false }).verify();
  assert.ok(r.problems.some((p) => /prev hash mismatch|rule violation/.test(p.message)));

  // 4. Forge: a *different* key signs a fresh, internally valid history → not our key.
  writeFileSync(path, original);
  const forger = Ledger.open(tmp());
  forger.append(created());
  const forgedLine = readFileSync(join(forger.dir, "entries.jsonl"), "utf8");
  writeFileSync(path, forgedLine);
  r = Ledger.open(dir, { createKey: false }).verify({ trustedCheckpoint: trusted });
  assert.ok(r.problems.some((p) => /no valid signature by a known key/.test(p.message)));
  assert.ok(r.problems.some((p) => /NOT consistent|shrank/.test(p.message)));

  // Restored original passes again, including consistency with the trusted checkpoint.
  writeFileSync(path, original);
  assert.deepEqual(Ledger.open(dir, { createKey: false }).verify({ trustedCheckpoint: trusted }).problems, []);
});

test("trust contract: evidence required, prev chain, independence, transitions", () => {
  const l = Ledger.open(tmp());
  assert.throws(() => l.append(created({ evidence: [] })), /evidence/);
  const { event } = l.append(created());
  const id = event.findingId;
  const sys = "system:forest_loss@1.0";

  // Same evidence can't confirm itself.
  assert.throws(() => l.append({ kind: "confirmed", findingId: id, actor: sys, signal: gfw, independence: "provider" }), /independent/);
  // A candidate can't be published or notified.
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: sys, from: "candidate", to: "published" }), /illegal transition/);
  assert.throws(() => l.append({ kind: "notified", findingId: id, actor: sys, to: { kind: "authority", name: "IBAMA" }, publicAt: "2026-10-01T00:00:00Z" }), /cannot notify/);
  // Wrong `from` is rejected.
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: sys, from: "confirmed", to: "expired" }), /status is candidate/);
  // Unknown finding.
  assert.throws(() => l.append({ kind: "retracted", findingId: "01923e5a-0000-7000-8000-0000000000ff", actor: sys, reason: "x" }), /does not exist/);
  // Anonymous actors are rejected.
  assert.throws(() => l.append({ kind: "evidence_added", findingId: id, actor: "bob", evidence: [ndvi] }), /actor must be/);

  l.append({ kind: "confirmed", findingId: id, actor: sys, signal: ndvi, independence: "sensor" });
  // Narration may only cite evidence the finding holds.
  assert.throws(
    () => l.append({ kind: "narrated", findingId: id, actor: "model:claude-opus-5-5", text: "…", model: { id: "claude-opus-5-5" }, promptSha256: "a".repeat(64), evidenceRefs: ["made-up"] }),
    /cites evidence the finding does not hold/,
  );
  l.append({ kind: "narrated", findingId: id, actor: "model:claude-opus-5-5", text: "38 ha lost; NDVI fell 0.31.", model: { id: "claude-opus-5-5" }, promptSha256: "a".repeat(64), evidenceRefs: [gfw.id, ndvi.id] });

  // Candidate TTL is the GLAD rule.
  assert.equal(CANDIDATE_TTL_DAYS, 180);
  assert.ok(!PUBLIC_STATUSES.includes("candidate") && !PUBLIC_STATUSES.includes("confirmed"));
});

test("trust contract: tiers, four-eyes naming, right-of-reply clock, retraction is final", () => {
  const l = Ledger.open(tmp());
  const sys = "system:methane_anomaly@1.0";
  const { event } = l.append(created({ tier: 3, actor: sys, rule: { name: "methane_anomaly", version: "1.0" } }));
  const id = event.findingId;
  l.append({ kind: "confirmed", findingId: id, actor: sys, signal: ndvi, independence: "provider" });

  // Tier ≥ 1 can't publish without a human; the opener can't be that human.
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: sys, from: "confirmed", to: "published" }), /human approval/);
  assert.throws(() => l.append({ kind: "reviewed", findingId: id, actor: sys, decision: "approve", tier: 3 }), /reviewer: or model: actor/);
  l.append({ kind: "reviewed", findingId: id, actor: "reviewer:ana", decision: "approve", tier: 3 });
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published" }), /two distinct/);
  l.append({ kind: "reviewed", findingId: id, actor: "reviewer:ben", decision: "approve", tier: 3 });

  // Naming a party: two distinct reviewers, neither the opener.
  const party = { name: "Example Gas Co.", registry: { name: "Climate TRACE", url: "https://climatetrace.org/", id: "ct-123" } };
  const subject = { kind: "asset" as const, name: "Compressor station 7" };
  assert.throws(() => l.append({ kind: "attributed", findingId: id, actor: "reviewer:ana", subject, party, reviewers: ["reviewer:ana"] }), /two distinct/);
  assert.throws(() => l.append({ kind: "attributed", findingId: id, actor: "reviewer:ana", subject, party, reviewers: ["reviewer:ana", "reviewer:ana"] }), /distinct/);
  assert.throws(() => l.append({ kind: "attributed", findingId: id, actor: "reviewer:ana", subject, party, reviewers: ["reviewer:ana", sys] }), /actor must|opened the finding|reviewer/);
  l.append({ kind: "attributed", findingId: id, actor: "reviewer:ana", subject, party, reviewers: ["reviewer:ana", "reviewer:ben"] });

  // Tier 3: private notice first, then the public clock must have run out.
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published" }), /private notice/);
  l.append({ kind: "notified", findingId: id, actor: "reviewer:ana", to: { kind: "party", name: party.name, channel: "https://example.com/contact" }, publicAt: "2026-10-30T00:00:00Z", at: "2026-09-30T00:00:00Z" });
  assert.throws(
    () => l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published", at: "2026-10-15T00:00:00Z" }),
    /right-of-reply clock/,
  );
  // A reply inside the private window is recorded verbatim but doesn't change status.
  l.append({ kind: "replied", findingId: id, actor: "reviewer:ana", from: party.name, text: "Valve replaced 2026-10-02.", receivedAt: "2026-10-03T00:00:00Z", at: "2026-10-03T00:00:00Z" });
  assert.equal(l.get(id)!.status, "confirmed");
  assert.equal(l.get(id)!.replies.length, 1);
  // Clock has run: publish, then close out.
  l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published", at: "2026-11-01T00:00:00Z" });
  l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "published", to: "resolved", reason: "Reply verified against a later S5P pass.", at: "2026-11-02T00:00:00Z" });

  // Retraction is an event, final, and keeps the whole history.
  l.append({ kind: "retracted", findingId: id, actor: "reviewer:ana", reason: "Test retraction." });
  const f = l.get(id)!;
  assert.equal(f.status, "retracted");
  assert.equal(f.history.length, 10);
  assert.throws(() => l.append({ kind: "evidence_added", findingId: id, actor: sys, evidence: [ndvi] }), /retracted/);
  assert.deepEqual(l.verify().problems, []);
});

test("ledger: a lower tier publishes with one approval; a rejection blocks", () => {
  const l = Ledger.open(tmp());
  const sys = "system:forest_loss@1.0";
  const { event } = l.append(created());
  l.append({ kind: "confirmed", findingId: event.findingId, actor: sys, signal: ndvi, independence: "sensor" });
  l.append({ kind: "reviewed", findingId: event.findingId, actor: "reviewer:ana", decision: "approve", tier: 1 });
  l.append({ kind: "reviewed", findingId: event.findingId, actor: "reviewer:ben", decision: "reject", tier: 1, note: "cloud edge" });
  assert.throws(() => l.append({ kind: "status_changed", findingId: event.findingId, actor: "reviewer:ana", from: "confirmed", to: "published" }), /rejected/);
  l.append({ kind: "reviewed", findingId: event.findingId, actor: "reviewer:ben", decision: "approve", tier: 1 });
  l.append({ kind: "status_changed", findingId: event.findingId, actor: "reviewer:ana", from: "confirmed", to: "published" });
  assert.equal(l.get(event.findingId)!.status, "published");
  assert.equal(l.list({ status: ["published"] }).length, 1);
});

// ---- Policy 2026-09-26-autonomous: the AI publishes on its own, behind checked gates ----

const A = "model:claude-opus-5-5"; // narrator
const B = "model:claude-fable-5-1"; // independent reviewer model
const narrate = (id: string): EventInput => ({
  kind: "narrated",
  findingId: id,
  actor: A,
  text: "38 ha lost; NDVI fell 0.31.",
  model: { id: "claude-opus-5-5" },
  promptSha256: "a".repeat(64),
  evidenceRefs: [gfw.id, ndvi.id],
});

function confirmedFinding(l: Ledger, tier = 1): string {
  const { event } = l.append(created({ tier }));
  l.append({ kind: "confirmed", findingId: event.findingId, actor: "system:forest_loss@1.0", signal: ndvi, independence: "sensor" });
  return event.findingId;
}

test("autonomous publish: narration + a different identity's publish verdict; gates recorded and checked", () => {
  const l = Ledger.open(tmp());
  const id = confirmedFinding(l);
  const publish = (extra: Partial<Extract<EventInput, { kind: "status_changed" }>> = {}): EventInput => ({
    kind: "status_changed", findingId: id, actor: A, from: "confirmed", to: "published", reason: "Gates passed.", ...extra,
  });

  // No narration yet: nothing to publish, and a model can't publish without gates at all.
  assert.deepEqual(publishGates(l.get(id)!).missing, ["no narrated event"]);
  assert.throws(() => l.append(publish()), /must carry gates/);
  l.append(narrate(id));

  // Same identity: the narrator reviewing itself doesn't count; a verdict-less review doesn't either.
  l.append({ kind: "reviewed", findingId: id, actor: A, decision: "approve", verdict: "publish", tier: 1 });
  l.append({ kind: "reviewed", findingId: id, actor: "reviewer:ana", decision: "approve", tier: 1 });
  let g = publishGates(l.get(id)!);
  assert.equal(g.ok, false);
  assert.match(g.missing.join(), /verdict "publish".*other than the narrator/);
  assert.throws(() => l.append(publish({ gates: { narratedBy: A, reviewedBy: [A], policy: PUBLISH_POLICY_VERSION } })), /cannot publish/);
  assert.throws(() => l.append(publish({ gates: { narratedBy: A, reviewedBy: ["reviewer:ana"], policy: PUBLISH_POLICY_VERSION } })), /cannot publish/, "no verdict is not a publish verdict");

  // Model reviews must carry a verdict; verdict and decision must agree; never a system: reviewer.
  assert.throws(() => l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", tier: 1 }), /must carry a verdict/);
  assert.throws(() => l.append({ kind: "reviewed", findingId: id, actor: B, decision: "reject", verdict: "publish", tier: 1 }), /contradicts/);
  assert.throws(() => l.append({ kind: "reviewed", findingId: id, actor: "system:forest_loss@1.0", decision: "approve", verdict: "publish", tier: 1 }), /reviewer: or model:/);
  l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", verdict: "publish", tier: 1 });
  g = publishGates(l.get(id)!);
  assert.deepEqual(g, { ok: true, missing: [], gates: { narratedBy: A, reviewedBy: [B], policy: PUBLISH_POLICY_VERSION } });

  // A fresh narration voids earlier reviews: the published text must be the reviewed text.
  l.append(narrate(id));
  assert.equal(publishGates(l.get(id)!).ok, false);
  l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", verdict: "publish", tier: 1 });
  const gates = publishGates(l.get(id)!).gates!;

  // Gates that don't match the ledger's events are refused.
  assert.throws(() => l.append(publish({ gates: { ...gates, narratedBy: B } })), /gates inconsistent: narratedBy/);
  assert.throws(() => l.append(publish({ gates: { ...gates, reviewedBy: ["model:someone-else"] } })), /gates inconsistent: no "publish" review/);
  assert.throws(() => l.append(publish({ gates: { ...gates, reviewedBy: [B, B] } })), /duplicates/);
  assert.throws(() => l.append(publish({ gates: { ...gates, reviewedBy: [B, A] } })), /narrated this finding/);
  assert.throws(() => l.append(publish({ gates: { ...gates, noticeHours: 100 } })), /gates inconsistent: noticeHours/);
  assert.throws(() => l.append(publish({ gates: { ...gates, policy: "2020-01-01-old" } })), /unknown publish policy/);
  assert.throws(() => l.append(publish({ gates, reason: undefined })), /must give a reason/);
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: A, from: "confirmed", to: "expired", reason: "x", gates }), /only on a move into published/);

  // Happy path: published by the model, gates on the record.
  const { event } = l.append(publish({ gates }));
  assert.equal(l.get(id)!.status, "published");
  assert.deepEqual(event.kind === "status_changed" && event.gates, { narratedBy: A, reviewedBy: [B], policy: "2026-09-26-autonomous" });

  // After publication a model may move it on — with a reason — and may always retract.
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: A, from: "published", to: "resolved" }), /reason/);
  l.append({ kind: "notified", findingId: id, actor: A, to: { kind: "authority", name: "IBAMA" }, publicAt: "2026-10-30T00:00:00Z" });
  l.append({ kind: "status_changed", findingId: id, actor: A, from: "notified", to: "no_response", reason: "30 days, no answer." });
  l.append({ kind: "retracted", findingId: id, actor: A, reason: "Re-check: cloud shadow, not clearing." });
  assert.equal(l.get(id)!.status, "retracted");
  assert.deepEqual(l.verify().problems, []);
});

test("autonomous publish: tier 3 needs a human actor; a hold verdict blocks", () => {
  const l = Ledger.open(tmp());
  const id = confirmedFinding(l, 3);
  l.append(narrate(id));
  l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", verdict: "publish", tier: 3 });
  l.append({ kind: "notified", findingId: id, actor: A, to: { kind: "authority", name: "ANP" }, publicAt: "2026-10-01T00:00:00Z", at: "2026-09-01T00:00:00Z" });
  const g = publishGates(l.get(id)!, "2026-10-02T00:00:00Z");
  assert.equal(g.ok, false);
  assert.deepEqual(g.missing, ["tier 3 needs a human reviewer: actor to publish"]);
  const move = { kind: "status_changed" as const, findingId: id, from: "confirmed" as const, to: "published" as const, reason: "ok", gates: g.gates!, at: "2026-10-02T00:00:00Z" };
  assert.throws(() => l.append({ ...move, actor: A }), /tier 3 needs a human/);
  // The right-of-reply clock still applies to the human, through the same gates.
  assert.throws(() => l.append({ ...move, actor: "reviewer:ana", at: "2026-09-20T00:00:00Z" }), /right-of-reply clock/);
  l.append({ ...move, actor: "reviewer:ana" });
  assert.equal(l.get(id)!.status, "published");

  const l2 = Ledger.open(tmp());
  const id2 = confirmedFinding(l2, 1);
  l2.append(narrate(id2));
  l2.append({ kind: "reviewed", findingId: id2, actor: B, decision: "approve", verdict: "publish", tier: 1 });
  const gates = publishGates(l2.get(id2)!).gates!;
  l2.append({ kind: "reviewed", findingId: id2, actor: "model:third-opinion", decision: "reject", verdict: "hold", tier: 1, note: "wait for next pass" });
  assert.match(publishGates(l2.get(id2)!).missing.join(), /holds publication/);
  assert.throws(() => l2.append({ kind: "status_changed", findingId: id2, actor: A, from: "confirmed", to: "published", reason: "x", gates }), /holds publication/);
});

test("naming a party: two reviewer identities (not the narrator) and a 72 h private notice, or unreachable", () => {
  const l = Ledger.open(tmp());
  const id = confirmedFinding(l, 2);
  l.append(narrate(id));
  const party = { name: "Example Gas Co.", registry: { name: "Climate TRACE", url: "https://climatetrace.org/", id: "ct-123" } };
  const subject = { kind: "asset" as const, name: "Compressor station 7" };
  assert.throws(() => l.append({ kind: "attributed", findingId: id, actor: B, subject, party, reviewers: [A, B] }), /narrator cannot review the attribution/);
  assert.throws(() => l.append({ kind: "attributed", findingId: id, actor: B, subject, party, reviewers: [B] }), /two distinct reviewers/);
  l.append({ kind: "attributed", findingId: id, actor: B, subject, party, reviewers: [B, "model:third-opinion"] });
  l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", verdict: "publish", tier: 2 });

  const T0 = "2026-09-01T00:00:00Z";
  const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString().replace(".000Z", "Z");
  const move = (h: number, gates = publishGates(l.get(id)!, at(h)).gates!): EventInput =>
    ({ kind: "status_changed", findingId: id, actor: A, from: "confirmed", to: "published", reason: "Gates passed.", gates, at: at(h) });

  assert.match(publishGates(l.get(id)!, T0).missing.join(), /needs private notice ≥ 72 h/);
  assert.throws(() => l.append(move(0)), /needs private notice ≥ 72 h/);
  l.append({ kind: "notified", findingId: id, actor: A, to: { kind: "party", name: party.name, channel: "https://example.com/contact" }, publicAt: at(30 * 24), at: T0 });
  assert.throws(() => l.append(move(10)), /only 10 h old \(needs 72 h\)/);
  const g = publishGates(l.get(id)!, at(NOTICE_PRIVATE_HOURS + 1)).gates!;
  assert.equal(g.noticeHours, 73);
  const { noticeHours: _drop, ...noHours } = g;
  assert.throws(() => l.append(move(73, noHours)), /noticeHours must be recorded/);
  assert.throws(() => l.append(move(73, { ...g, noticeHours: 200 })), /gates inconsistent: noticeHours/);
  l.append(move(73, g));
  assert.equal(l.get(id)!.status, "published");

  // An unreachable party is recorded instead of the 72 h wait — only for a party notice.
  const l2 = Ledger.open(tmp());
  const id2 = confirmedFinding(l2, 2);
  l2.append(narrate(id2));
  l2.append({ kind: "attributed", findingId: id2, actor: B, subject, party, reviewers: [B, "reviewer:ana"] });
  l2.append({ kind: "reviewed", findingId: id2, actor: "reviewer:ana", decision: "approve", verdict: "publish", tier: 2 });
  assert.throws(
    () => l2.append({ kind: "notified", findingId: id2, actor: A, to: { kind: "authority", name: "ANP" }, publicAt: T0, unreachable: true }),
    /only a notice to a party/,
  );
  l2.append({ kind: "notified", findingId: id2, actor: A, to: { kind: "party", name: party.name }, publicAt: T0, unreachable: true });
  const g2 = publishGates(l2.get(id2)!);
  assert.deepEqual(g2, { ok: true, missing: [], gates: { narratedBy: A, reviewedBy: ["reviewer:ana"], policy: PUBLISH_POLICY_VERSION } });
  l2.append({ kind: "status_changed", findingId: id2, actor: A, from: "confirmed", to: "published", reason: "Party unreachable; gates passed.", gates: g2.gates });
  assert.deepEqual(l2.verify().problems, []);
});

test("human route (reviewer:, no gates) keeps the v1 rule; model approvals don't count toward it", () => {
  const l = Ledger.open(tmp());
  const id = confirmedFinding(l, 1);
  l.append({ kind: "reviewed", findingId: id, actor: B, decision: "approve", verdict: "publish", tier: 1 });
  assert.throws(() => l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published" }), /human approval/);
  l.append({ kind: "reviewed", findingId: id, actor: "reviewer:ben", decision: "approve", tier: 1 });
  l.append({ kind: "status_changed", findingId: id, actor: "reviewer:ana", from: "confirmed", to: "published" });
  assert.equal(l.get(id)!.status, "published");
});
