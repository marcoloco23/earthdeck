// The ledger_* MCP tools, driven through a real MCP client over an in-memory transport,
// against a temp ledger seeded with the demo cases. Offline: the dashboard URL points at a
// closed port, so card pushes fail fast (best-effort) without touching the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { seedDemo } from "../src/ledger/cli.js";
import { Ledger } from "../src/ledger/store.js";
import { registerLedgerTools } from "../src/tools/ledger.js";

const PUBLISHED = "01994a2e-0000-7000-8000-00000000d001"; // notified (public), tier 1
const CANDIDATE = "01994a2e-0000-7000-8000-00000000d002"; // candidate, tier 1
const CONFIRMED = "01994a2e-0000-7000-8000-00000000d003"; // confirmed, tier 2

type Result = { isError: boolean; body: Record<string, any> };

async function setup(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-ledger-tools-"));
  seedDemo(Ledger.open(dir));
  const saved = { dir: process.env.EARTHDECK_LEDGER_DIR, url: process.env.EARTHDECK_DASHBOARD_URL, key: process.env.EARTHDECK_LEDGER_KEY };
  process.env.EARTHDECK_LEDGER_DIR = dir;
  process.env.EARTHDECK_DASHBOARD_URL = "http://127.0.0.1:9";
  delete process.env.EARTHDECK_LEDGER_KEY;

  const server = new McpServer({ name: "t", version: "0" });
  registerLedgerTools(server);
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => {
    await client.close();
    await server.close();
    for (const [k, v] of [["EARTHDECK_LEDGER_DIR", saved.dir], ["EARTHDECK_DASHBOARD_URL", saved.url], ["EARTHDECK_LEDGER_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    let body: Record<string, any>;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text }; // SDK input-validation errors are plain text
    }
    return { isError: Boolean(res.isError), body };
  };
  const size = () => Ledger.open(dir, { createKey: false }).size;
  return { dir, call, size };
}

test("ledger tools: registered with never-publish wording", async (t) => {
  const server = new McpServer({ name: "t", version: "0" });
  registerLedgerTools(server);
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ["ledger_advance", "ledger_get", "ledger_list", "ledger_narrate", "ledger_propose_attribution", "ledger_review", "ledger_verify"]);
  for (const n of ["ledger_advance", "ledger_propose_attribution"]) {
    assert.match(tools.find((x) => x.name === n)!.description!, /NEVER publish/);
  }
});

test("ledger_list / ledger_get / ledger_verify read the seeded ledger", async (t) => {
  const { call, size } = await setup(t);

  const all = await call("ledger_list", {});
  assert.equal(all.isError, false);
  assert.equal(all.body.total, 3);
  assert.equal(all.body.size, 8);
  assert.equal(all.body.dashboard, "dashboard not running");
  const row = all.body.findings.find((f: any) => f.findingId === PUBLISHED);
  assert.deepEqual(
    { status: row.status, public: row.public, tier: row.tier, rule: row.rule, evidence: row.evidence, history: row.history, observedAt: row.observedAt },
    { status: "notified", public: true, tier: 1, rule: "forest_loss@1.0", evidence: 2, history: 5, observedAt: "2026-08-30T00:00:00Z" },
  );

  assert.deepEqual((await call("ledger_list", { status: ["candidate"] })).body.findings.map((f: any) => f.findingId), [CANDIDATE]);
  assert.deepEqual((await call("ledger_list", { rule: "methane_anomaly" })).body.findings.map((f: any) => f.findingId), [CONFIRMED]);
  assert.deepEqual((await call("ledger_list", { aoi: "br-kayapo" })).body.findings.map((f: any) => f.findingId), [CANDIDATE]);
  assert.equal((await call("ledger_list", { since: "2026-09-20" })).body.total, 2);
  const limited = await call("ledger_list", { limit: 1 });
  assert.equal(limited.body.findings.length, 1);
  assert.equal(limited.body.total, 3);
  assert.equal((await call("ledger_list", { since: "not a date" })).isError, true);

  const one = await call("ledger_get", { findingId: CONFIRMED });
  assert.equal(one.isError, false);
  assert.equal(one.body.finding.status, "confirmed");
  assert.equal(one.body.events.length, 2);
  assert.deepEqual(one.body.events.map((e: any) => e.index), [6, 7]);
  assert.deepEqual(one.body.next.legal, ["published", "expired", "false_positive"]);
  assert.deepEqual(one.body.next.viaLedgerAdvance, ["expired", "false_positive"]);
  const missing = await call("ledger_get", { findingId: "01994a2e-0000-7000-8000-00000000dfff" });
  assert.equal(missing.isError, true);
  assert.match(missing.body.error, /no such finding/);

  const v = await call("ledger_verify", {});
  assert.equal(v.body.ok, true);
  assert.equal(v.body.size, 8);
  assert.equal(v.body.findings, 3);
  assert.match(v.body.checkpoint.text, /^earthdeck\.dev\/findings\/v1\n8\n/);
  assert.deepEqual(v.body.checkpoint.signedBy, ["earthdeck"]);
  assert.equal(size(), 8, "read tools never write");
});

test("ledger_advance: legal non-public moves only; publishing is refused", async (t) => {
  const { call, size } = await setup(t);

  const pub = await call("ledger_advance", { findingId: CONFIRMED, to: "published", reason: "looks solid", actor: "model:claude-opus-5-5" });
  assert.equal(pub.isError, true);
  assert.match(pub.body.error, /refused: "published" is a public status.*human act/);
  const pubByReviewer = await call("ledger_advance", { findingId: PUBLISHED, to: "resolved", reason: "fixed", actor: "reviewer:ana" });
  assert.equal(pubByReviewer.isError, true, "even a reviewer: actor cannot move into a public status through MCP");
  assert.equal(size(), 8);

  const illegal = await call("ledger_advance", { findingId: CANDIDATE, to: "confirmed", reason: "trust me", actor: "model:x" });
  assert.equal(illegal.isError, true);
  assert.match(illegal.body.error, /illegal transition candidate → confirmed/);

  const sys = await call("ledger_advance", { findingId: CANDIDATE, to: "false_positive", reason: "x", actor: "system:kernel@1.0" });
  assert.equal(sys.isError, true, "system: actors are the kernel's, not the MCP caller's");

  const fp = await call("ledger_advance", { findingId: CANDIDATE, to: "false_positive", reason: "Agricultural burn outside the boundary on re-check.", actor: "model:claude-opus-5-5" });
  assert.equal(fp.isError, false, JSON.stringify(fp.body));
  assert.equal(fp.body.appended.kind, "status_changed");
  assert.equal(fp.body.appended.index, 8);
  assert.equal(fp.body.finding.status, "false_positive");
  assert.equal(size(), 9);

  const again = await call("ledger_advance", { findingId: CANDIDATE, to: "expired", reason: "x", actor: "model:x" });
  assert.equal(again.isError, true);
  assert.match(again.body.error, /illegal transition false_positive → expired/);
  assert.equal((await call("ledger_verify", {})).body.ok, true);
});

test("ledger_narrate: cites held evidence only, length-capped, hashes the prompt", async (t) => {
  const { dir, call, size } = await setup(t);
  const base = { findingId: CONFIRMED, model: { id: "claude-opus-5-5", provider: "anthropic" }, prompt: "Narrate this finding." };

  const bad = await call("ledger_narrate", { ...base, text: "Methane anomaly near an asset.", evidenceRefs: ["made-up-id"] });
  assert.equal(bad.isError, true);
  assert.match(bad.body.error, /narration cites evidence the finding does not hold: made-up-id/);
  const long = await call("ledger_narrate", { ...base, text: "x".repeat(20_001), evidenceRefs: ["s5p-ch4-2026-09-18..20-anomaly"] });
  assert.equal(long.isError, true);
  const noPrompt = await call("ledger_narrate", { findingId: CONFIRMED, model: base.model, text: "t", evidenceRefs: ["s5p-ch4-2026-09-18..20-anomaly"] });
  assert.equal(noPrompt.isError, true);
  assert.equal(size(), 8);

  const ok = await call("ledger_narrate", { ...base, text: "S5P shows +38 ppb over three passes; a registered asset sits at the centroid.", evidenceRefs: ["s5p-ch4-2026-09-18..20-anomaly", "climatetrace-v7-asset-demo-0001"] });
  assert.equal(ok.isError, false, JSON.stringify(ok.body));
  assert.equal(ok.body.appended.actor, "model:claude-opus-5-5");
  assert.equal(ok.body.finding.status, "confirmed", "narration never changes status");
  const f = Ledger.open(dir, { createKey: false }).get(CONFIRMED)!;
  assert.equal(f.narration?.promptSha256, createHash("sha256").update("Narrate this finding.").digest("hex"));
  assert.equal(f.narration?.reviewedBy, undefined, "the tool cannot claim a human reviewed the narration");
});

test("ledger_review: reviewer actors only; approvals never publish by themselves", async (t) => {
  const { call } = await setup(t);
  const model = await call("ledger_review", { findingId: CONFIRMED, reviewer: "model:x", decision: "approve" });
  assert.equal(model.isError, true);

  const a = await call("ledger_review", { findingId: CONFIRMED, reviewer: "reviewer:ana", decision: "approve", note: "Plume matches the asset." });
  assert.equal(a.isError, false, JSON.stringify(a.body));
  const b = await call("ledger_review", { findingId: CONFIRMED, reviewer: "reviewer:ben", decision: "approve" });
  assert.equal(b.body.finding.status, "confirmed");
  const got = await call("ledger_get", { findingId: CONFIRMED });
  assert.deepEqual(got.body.finding.reviews.map((r: any) => [r.actor, r.tier]), [["reviewer:ana", 2], ["reviewer:ben", 2]]);
  // Two approvals exist, and still the MCP surface refuses to publish.
  const pub = await call("ledger_advance", { findingId: CONFIRMED, to: "published", reason: "approved twice", actor: "reviewer:ana" });
  assert.equal(pub.isError, true);
});

test("ledger_propose_attribution: four-eyes rule for naming a party is the ledger's, not weakened", async (t) => {
  const { call, size } = await setup(t);
  const registry = { name: "Climate TRACE v7", url: "https://climatetrace.org/", id: "asset-demo-0001" };
  const subject = { kind: "asset", name: "Demo oil & gas production site", registry };
  const party = { name: "Demo Operator Inc.", registry: { ...registry, id: "owner-demo-01" }, stake: 1 };
  const actor = "model:claude-opus-5-5";

  const person = await call("ledger_propose_attribution", { findingId: CONFIRMED, actor, subject: { kind: "person", name: "J. Doe" } });
  assert.equal(person.isError, true, "never natural persons");

  const one = await call("ledger_propose_attribution", { findingId: CONFIRMED, actor, subject, party, reviewers: ["reviewer:ana"] });
  assert.equal(one.isError, true);
  assert.match(one.body.error, /naming a party requires two distinct human reviewers/);
  const twice = await call("ledger_propose_attribution", { findingId: CONFIRMED, actor, subject, party, reviewers: ["reviewer:ana", "reviewer:ana"] });
  assert.match(twice.body.error, /attribution reviewers must be distinct/);
  const lowTier = await call("ledger_propose_attribution", { findingId: CANDIDATE, actor, subject, party, reviewers: ["reviewer:ana", "reviewer:ben"] });
  assert.match(lowTier.body.error, /naming a party requires tier ≥ 2/);
  const noRegistry = await call("ledger_propose_attribution", { findingId: CONFIRMED, actor, subject, party: { name: "Someone" }, reviewers: ["reviewer:ana", "reviewer:ben"] });
  assert.equal(noRegistry.isError, true, "a party only via a cited registry");
  assert.equal(size(), 8);

  const place = await call("ledger_propose_attribution", { findingId: CANDIDATE, actor, subject: { kind: "place", name: "TI Kayapó" } });
  assert.equal(place.isError, false, JSON.stringify(place.body));
  const named = await call("ledger_propose_attribution", { findingId: CONFIRMED, actor, subject, party, reviewers: ["reviewer:ana", "reviewer:ben"] });
  assert.equal(named.isError, false, JSON.stringify(named.body));
  assert.equal(named.body.finding.status, "confirmed", "attribution never publishes");
  assert.equal(named.body.finding.public, false);
  assert.equal((await call("ledger_verify", {})).body.ok, true);
});

test("ledger tools: missing ledger is reported, never created", async (t) => {
  const { call } = await setup(t);
  const empty = mkdtempSync(join(tmpdir(), "earthdeck-ledger-none-"));
  process.env.EARTHDECK_LEDGER_DIR = join(empty, "nope");
  const list = await call("ledger_list", {});
  assert.equal(list.body.total, 0);
  const adv = await call("ledger_advance", { findingId: CANDIDATE, to: "expired", reason: "x", actor: "model:x" });
  assert.equal(adv.isError, true);
  assert.match(adv.body.error, /no ledger at/);
  assert.throws(() => readFileSync(join(empty, "nope", "ledger.key")), "no key minted by a tool call");
});
