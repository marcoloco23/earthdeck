// Sweeping ~350 AOIs inside Lambda's 15 minutes and the free API tiers: deterministic,
// disjoint shards; least-recently-swept ordering; the time budget; the per-day quota
// governor (persistence, skip reasons, 429 handling).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { parseShard, shardOf, sweep } from "../src/watch/kernel.js";
import { capsFromEnv, costOf, isQuotaError, providersForRequires, QuotaExceeded, QuotaGovernor, ruleKey, type QuotaCaps } from "../src/watch/quota.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { parseWatchlist, type Watchlist } from "../src/watch/watchlist.js";
import { mockFetch } from "./helpers.js";

const NOW = "2026-09-26T12:00:00Z";
const DAY = "2026-09-26";
const CAPS: QuotaCaps = { cdse: 60, gfw: 400, firms: 300, gfw_fishing: 200, analystCases: 10, analystUsd: 3, perRule: { METHANE_ANOMALY: { cdse: 10 } } };

/** n quiet fire AOIs (one fires_in call each when quiet). */
function fireList(n: number, prefix = "a"): Watchlist {
  return parseWatchlist({
    version: 1,
    name: "t",
    aois: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `AOI ${i}`, bbox: [10 + i * 0.01, 0, 10.5 + i * 0.01, 0.5], rules: [{ name: "fires_in_protected", params: {} }] })),
  });
}
const quiet = { count: 0, source: "VIIRS_NOAA20_NRT", fires: [] };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-scale-"));
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  return { dir, ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")), restore: fm.restore };
}

function recorder(fn: (tool: string, args: Record<string, unknown>) => unknown = () => quiet) {
  const calls: { tool: string; aoi: string }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, aoi: String((args.bbox as number[])[0]) });
    return fn(tool, args);
  };
  return { call, calls };
}

test("shards: deterministic, disjoint, covering; parseShard validates", () => {
  const ids = Array.from({ length: 350 }, (_, i) => `aoi-${i}`);
  const rules = ["forest_loss", "fires_in_protected"];
  const counts = new Array(8).fill(0);
  for (const id of ids)
    for (const r of rules) {
      const s = shardOf(id, r, 8);
      assert.equal(shardOf(id, r, 8), s, "stable");
      assert.ok(s >= 0 && s < 8);
      counts[s]++;
    }
  assert.equal(counts.reduce((a, b) => a + b, 0), 700);
  for (const c of counts) assert.ok(c > 50 && c < 125, `balanced-ish: ${counts.join(",")}`);
  assert.equal(shardOf("br-sfx", "forest_loss", 8), shardOf("br-sfx", "forest_loss", 8));
  assert.deepEqual(parseShard("3/8"), { index: 3, count: 8 });
  assert.throws(() => parseShard("8/8"), /0 ≤ i < n/);
  assert.throws(() => parseShard("1/0"), /shard/);
  assert.throws(() => parseShard("x"), /shard/);
});

test("kernel: shard i/n sweeps exactly its pairs; the n shards together cover the list once", async (t) => {
  const s = setup();
  t.after(s.restore);
  const wl = fireList(40);
  const seen = new Map<string, number>();
  for (let i = 0; i < 4; i++) {
    const { call } = recorder();
    const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true, shard: { index: i, count: 4 } });
    for (const a of wl.aois) if (shardOf(a.id, "fires_in_protected", 4) === i) seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
    assert.equal(r.pairs, wl.aois.filter((a) => shardOf(a.id, "fires_in_protected", 4) === i).length);
  }
  assert.equal(seen.size, 40);
  assert.ok([...seen.values()].every((n) => n === 1));
  for (const a of wl.aois) assert.equal(s.journal.watermark(a.id, "fires_in_protected"), NOW);
});

test("kernel: least-recently-swept pairs go first (never-swept first of all)", async (t) => {
  const s = setup();
  t.after(s.restore);
  const wl = fireList(4);
  s.journal.setWatermark("a-0", "fires_in_protected", "2026-09-26T06:00:00Z");
  s.journal.setWatermark("a-1", "fires_in_protected", "2026-09-25T06:00:00Z");
  s.journal.setWatermark("a-3", "fires_in_protected", "2026-09-26T00:00:00Z");
  const { call, calls } = recorder();
  await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  const order = calls.map((c) => wl.aois.find((a) => String(a.bbox[0]) === c.aoi)!.id);
  assert.deepEqual(order, ["a-2", "a-1", "a-3", "a-0"]);
  // With a cap, the stalest pair is what gets swept.
  const { call: c2, calls: calls2 } = recorder();
  s.journal.setWatermark("a-3", "fires_in_protected", "2026-09-20T00:00:00Z"); // the one left behind
  await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call: c2, now: "2026-09-27T12:00:00Z", hasKey: () => true, maxPairs: 1 });
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0]!.aoi, String(wl.aois[3]!.bbox[0]));
});

test("kernel: time budget stops opening pairs, keeps the ones done, reports k of n", async (t) => {
  const s = setup();
  t.after(s.restore);
  let clock = 1_000_000;
  const { call } = recorder(() => {
    clock += 10_000; // each pair takes 10 s
    return quiet;
  });
  const lines: string[] = [];
  const r = await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true, clock: () => clock, deadline: 1_000_000 + 25_000, log: (l) => lines.push(l) });
  // pair 1 at 0 s, pair 2 at 10 s (10+10 ≤ 25), pair 3 at 20 s would need until 30 s → stop.
  assert.deepEqual(r.budgetExhausted, { done: 2, total: 5 });
  assert.ok(lines.includes("budget exhausted: 2 of 5 pairs done"));
  assert.equal(s.journal.watermark("a-0", "fires_in_protected"), NOW);
  assert.equal(s.journal.watermark("a-1", "fires_in_protected"), NOW);
  assert.equal(s.journal.watermark("a-2", "fires_in_protected"), null);
  const kinds = readFileSync(join(s.dir, "watch/journal.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);
  assert.ok(kinds.includes("budget_exhausted"));
  assert.equal(kinds.at(-1), "sweep_end");

  // Next run (resume): the untouched pairs go first.
  const { call: c2, calls } = recorder();
  await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call: c2, now: "2026-09-26T18:00:00Z", hasKey: () => true, maxPairs: 3 });
  assert.deepEqual(calls.map((c) => c.aoi), ["10.02", "10.03", "10.04"]);

  // No deadline → no budget report.
  const { call: c3 } = recorder();
  const r3 = await sweep({ watchlists: [fireList(2)], rules: RULES, ledger: s.ledger, journal: s.journal, call: c3, now: NOW, hasKey: () => true });
  assert.equal(r3.budgetExhausted, undefined);
});

test("quota: cost model, provider mapping, env caps, quota-error detection", () => {
  assert.deepEqual(costOf("forest_alerts", {}), { provider: "gfw", units: 1 });
  assert.deepEqual(costOf("eo_compare", {}), { provider: "cdse", units: 1 });
  assert.deepEqual(costOf("methane_plumes", {}), { provider: "cdse", units: 1 });
  assert.deepEqual(costOf("fires_in", {}), { provider: "firms", units: 1 });
  assert.deepEqual(costOf("flaring", { days: 30 }), { provider: "firms", units: 12 });
  assert.deepEqual(costOf("flaring", { days: 2 }), { provider: "firms", units: 2 });
  assert.deepEqual(costOf("flaring", { days: 30, sources: ["VIIRS_NOAA20_NRT"] }), { provider: "firms", units: 6 });
  assert.equal(costOf("events", {}), null);
  assert.equal(costOf("enso", {}), null);
  assert.deepEqual(providersForRequires(RULES.get("forest_loss")!.requires).sort(), ["cdse", "gfw"]);
  assert.deepEqual(providersForRequires(RULES.get("flaring")!.requires), ["firms"]);
  assert.deepEqual(providersForRequires(RULES.get("methane_anomaly")!.requires), ["cdse"]);

  assert.deepEqual(capsFromEnv({}), CAPS);
  assert.deepEqual(capsFromEnv({ EARTHDECK_MAX_CDSE_CALLS: "5", EARTHDECK_MAX_ANALYST_USD: "0.5" }), { ...CAPS, cdse: 5, analystUsd: 0.5 });
  assert.throws(() => capsFromEnv({ EARTHDECK_MAX_GFW_CALLS: "lots" }), /EARTHDECK_MAX_GFW_CALLS/);

  assert.equal(isQuotaError("GFW query failed (429)", 429), true);
  assert.equal(isQuotaError("FIRMS request failed (429)"), true);
  assert.equal(isQuotaError("Copernicus Process failed (403)", 403, '{"error":"processing units quota exceeded"}'), true);
  assert.equal(isQuotaError("GFW API key was rejected", 403, "Forbidden"), false); // a bad key is not a quota
  assert.equal(isQuotaError("Copernicus Process failed (500)", 500), false);
});

test("quota governor: per-day caps skip pairs as quota:<provider>, persist across runs, reset next day", async (t) => {
  const s = setup();
  t.after(s.restore);
  const caps = { ...CAPS, firms: 3 };
  const q1 = new QuotaGovernor(s.journal.dir, caps, DAY);
  const { call: raw, calls } = recorder();
  const r1 = await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call: q1.wrap(raw), quota: q1, now: NOW, hasKey: () => true });
  assert.equal(calls.length, 3);
  assert.deepEqual(r1.skipped.map((x) => x.reason), ["quota:firms", "quota:firms"]);
  assert.equal(r1.gaps.length, 0);
  assert.equal(s.journal.watermark("a-3", "fires_in_protected"), null, "watermark untouched on a quota skip");
  assert.equal(s.journal.watermark("a-4", "fires_in_protected"), null);
  const journal = readFileSync(join(s.dir, "watch/journal.jsonl"), "utf8");
  assert.match(journal, /"kind":"skip","aoi":"a-3","rule":"fires_in_protected","message":"quota:firms"/);
  assert.ok(existsSync(join(s.journal.dir, "quota.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(s.journal.dir, "quota.json"), "utf8")), { [DAY]: { firms: 3 } });

  // Same day, a later run (new process): the cap is already spent — nothing is called.
  const q2 = new QuotaGovernor(s.journal.dir, caps, DAY);
  assert.equal(q2.used("firms"), 3);
  const { call: raw2, calls: calls2 } = recorder();
  const r2 = await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call: q2.wrap(raw2), quota: q2, now: "2026-09-26T18:00:00Z", hasKey: () => true });
  assert.equal(calls2.length, 0);
  assert.equal(r2.skipped.length, 5);

  // Next UTC day: fresh counters, and the two starved pairs go first.
  const q3 = new QuotaGovernor(s.journal.dir, caps, "2026-09-27");
  const { call: raw3, calls: calls3 } = recorder();
  await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call: q3.wrap(raw3), quota: q3, now: "2026-09-27T00:00:00Z", hasKey: () => true });
  assert.deepEqual(calls3.map((c) => c.aoi), ["10.03", "10.04", "10"]);
  const file = JSON.parse(readFileSync(join(s.journal.dir, "quota.json"), "utf8")) as Record<string, { firms: number }>;
  assert.deepEqual(Object.keys(file).sort(), ["2026-09-26", "2026-09-27"]);
  assert.equal(file["2026-09-27"]!.firms, 3);
});

test("quota governor: a 429 marks the provider exhausted for the rest of the run; over-cap calls throw QuotaExceeded", async (t) => {
  const s = setup();
  t.after(s.restore);
  const q = new QuotaGovernor(null, CAPS, DAY);
  let n = 0;
  const { call: raw } = recorder(() => {
    if (++n === 2) throw new ToolError("fires_in", "FIRMS request failed (429)", 429, "Too Many Requests");
    return quiet;
  });
  const r = await sweep({ watchlists: [fireList(5)], rules: RULES, ledger: s.ledger, journal: s.journal, call: q.wrap(raw), quota: q, now: NOW, hasKey: () => true });
  assert.equal(n, 2);
  assert.equal(r.gaps.length, 1); // the call that got the 429 is a real gap
  assert.match(r.gaps[0]!.message, /429/);
  assert.deepEqual(r.skipped.map((x) => x.reason), ["quota:firms", "quota:firms", "quota:firms"]);
  assert.equal(q.blocked("gfw"), null, "other providers unaffected");

  // Direct: a call that would cross the cap is refused before it reaches the provider.
  const q2 = new QuotaGovernor(null, { ...CAPS, firms: 10 }, DAY);
  let reached = 0;
  const wrapped = q2.wrap(async () => (reached++, quiet));
  await assert.rejects(wrapped("flaring", { days: 30 }), (e: unknown) => e instanceof QuotaExceeded && e.provider === "firms" && e instanceof ToolError);
  assert.equal(reached, 0);
  await wrapped("events", {}); // ungoverned
  assert.equal(q2.used("firms"), 0);
});

test("quota governor: a confirm-only provider defers confirmation, never the detection", async (t) => {
  const s = setup();
  t.after(s.restore);
  const forest = parseWatchlist({
    version: 1,
    name: "t",
    aois: [{ id: "f-0", name: "Forest 0", bbox: [-52.4, -6.9, -51.9, -6.4], rules: [{ name: "forest_loss", params: { minAlerts: 10, minHa: 1 } }] }],
  });
  const q = new QuotaGovernor(s.journal.dir, { ...CAPS, cdse: 0 }, DAY);
  const { call: raw, calls } = recorder((tool) => {
    if (tool === "forest_alerts") return { window: { from: "2026-06-28", to: "2026-09-26" }, alertCount: 900, areaHa: 60, byConfidence: { high: { alertCount: 900, areaHa: 60 } } };
    if (tool === "enso") return { phase: "Neutral", latest: { oni: 0 } };
    if (tool === "events") return { events: [] };
    throw new Error(`unexpected tool ${tool}`);
  });
  const r = await sweep({ watchlists: [forest], rules: RULES, ledger: s.ledger, journal: s.journal, call: q.wrap(raw), quota: q, now: NOW, hasKey: () => true });
  assert.equal(r.skipped.length, 0, "a spent confirm-only provider must not skip the pair");
  assert.equal(r.created.length, 1, "detection (GFW) still opens the candidate");
  assert.equal(r.confirmed.length, 0, "confirmation is deferred");
  assert.ok(!calls.some((c) => c.tool === "eo_compare"), "no Copernicus call was attempted");
  assert.equal(s.ledger.get(r.created[0]!)!.status, "candidate");
});

test("quota: per-rule sub-caps from EARTHDECK_MAX_<PROVIDER>_CALLS_<RULE>", () => {
  assert.deepEqual(capsFromEnv({}).perRule, { METHANE_ANOMALY: { cdse: 10 } }, "methane defaults to 10 CDSE calls");
  assert.deepEqual(capsFromEnv({ EARTHDECK_MAX_CDSE_CALLS_METHANE_ANOMALY: "4", EARTHDECK_MAX_FIRMS_CALLS_FLARING: "120", EARTHDECK_MAX_GFW_CALLS_FOREST_LOSS: "" }).perRule, {
    METHANE_ANOMALY: { cdse: 4 },
    FLARING: { firms: 120 },
  });
  assert.equal(ruleKey("methane-anomaly"), "METHANE_ANOMALY");
  assert.equal(ruleKey("fires_in_protected"), "FIRES_IN_PROTECTED");
  assert.throws(() => capsFromEnv({ EARTHDECK_MAX_CDSE_CALLS_METHANE_ANOMALY: "-1" }), /EARTHDECK_MAX_CDSE_CALLS_METHANE_ANOMALY/);
  const q = new QuotaGovernor(null, { ...CAPS, perRule: { METHANE_ANOMALY: { cdse: 1 } } }, DAY);
  assert.equal(q.blocked("cdse", 1, "methane_anomaly"), null);
  q.chargeRule("methane_anomaly", "cdse", 1);
  q.chargeRule("forest_loss", "cdse", 1); // no sub-cap → not counted per rule
  assert.equal(q.blocked("cdse", 1, "methane_anomaly"), "quota:cdse");
  assert.equal(q.blocked("cdse", 1, "forest_loss"), null);
  assert.equal(q.blocked("cdse"), null, "the provider-wide cap is untouched by sub-caps");
  assert.deepEqual(q.snapshot().rules, { METHANE_ANOMALY: { cdse: 1 } });
});

test("quota governor: methane's CDSE sub-cap leaves the rest of the budget to forest confirmations", async (t) => {
  const s = setup();
  t.after(s.restore);
  const bbox = (i: number) => [10 + i, 0, 10.2 + i, 0.2];
  const wl = parseWatchlist({
    version: 1,
    name: "t",
    aois: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `m-${i}`, name: `Basin ${i}`, bbox: bbox(i), rules: [{ name: "methane_anomaly", params: {} }] })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `f-${i}`, name: `Forest ${i}`, bbox: bbox(20 + i), rules: [{ name: "forest_loss", params: { minAlerts: 10, minHa: 1 } }] })),
    ],
  });
  // Global CDSE cap 13 = methane's 10 + the 3 forest confirmations. Without the sub-cap the
  // 12 methane pairs (swept first) would spend 12 and starve two forest confirmations.
  const q = new QuotaGovernor(s.journal.dir, { ...CAPS, cdse: 13, perRule: { METHANE_ANOMALY: { cdse: 10 } } }, DAY);
  const { call: raw, calls } = recorder((tool) => {
    if (tool === "methane_plumes") return {}; // no usable retrievals → quiet
    if (tool === "forest_alerts") return { window: { from: "2026-06-28", to: "2026-09-26" }, alertCount: 900, areaHa: 60, byConfidence: { high: { alertCount: 900, areaHa: 60 } } };
    if (tool === "eo_compare") return { validPctA: 95, validPctB: 95, delta: { meanChange: -0.3 } };
    if (tool === "enso") return { phase: "Neutral", latest: { oni: 0 } };
    if (tool === "events") return { events: [] };
    throw new Error(`unexpected tool ${tool}`);
  });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call: q.wrap(raw), quota: q, now: NOW, hasKey: () => true });
  assert.equal(calls.filter((c) => c.tool === "methane_plumes").length, 10);
  assert.deepEqual(r.skipped, [
    { aoi: "m-10", rule: "methane_anomaly", reason: "quota:cdse" },
    { aoi: "m-11", rule: "methane_anomaly", reason: "quota:cdse" },
  ]);
  assert.equal(calls.filter((c) => c.tool === "eo_compare").length, 3);
  assert.equal(r.confirmed.length, 3, "every forest confirmation still ran");
  assert.equal(q.used("cdse"), 13);
  assert.equal(q.ruleUsed("methane_anomaly", "cdse"), 10);
  assert.deepEqual(JSON.parse(readFileSync(join(s.journal.dir, "quota.json"), "utf8"))[DAY].rules, { METHANE_ANOMALY: { cdse: 10 } });

  // Mid-pair: the pair check passes (1 unit left) but a 12-unit flaring call would cross the
  // rule's sub-cap — refused inside the kernel's call wrapper, before the provider (skip, not gap).
  const q2 = new QuotaGovernor(null, { ...CAPS, perRule: { FLARING: { firms: 5 } } }, DAY);
  const { call: raw2, calls: calls2 } = recorder();
  const flare = parseWatchlist({ version: 1, name: "t", aois: [{ id: "fl-0", name: "Field 0", bbox: bbox(30), rules: [{ name: "flaring", params: {} }] }] });
  const r2 = await sweep({ watchlists: [flare], rules: RULES, ledger: s.ledger, journal: s.journal, call: q2.wrap(raw2), quota: q2, now: NOW, hasKey: () => true });
  assert.equal(calls2.length, 0);
  assert.deepEqual(r2.skipped, [{ aoi: "fl-0", rule: "flaring", reason: "quota:firms" }]);
  assert.equal(r2.gaps.length, 0);
  assert.equal(q2.used("firms"), 0);
});
