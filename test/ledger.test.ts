// The ledger end to end: append → sign → tile → checkpoint, the trust contract's rules,
// and `verify` catching every kind of tampering a dishonest operator (or a disk) could do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type EventInput } from "../src/ledger/store.js";
import { CANDIDATE_TTL_DAYS, PUBLIC_STATUSES } from "../src/ledger/schema.js";
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
  assert.throws(() => l.append({ kind: "reviewed", findingId: id, actor: sys, decision: "approve", tier: 3 }), /reviewer: actor/);
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
