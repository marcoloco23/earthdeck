// The Watch Kernel end to end with a fake tool caller: candidates open with context and
// blind spots, independent signals confirm, cooldowns add evidence instead of duplicating,
// controls count, failures become gaps (watermark untouched), dry runs write nothing,
// stale candidates expire. Plus watchlist validation and the rule contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, defineRule, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { loadWatchlists, parseWatchlist } from "../src/watch/watchlist.js";
import { mockFetch } from "./helpers.js";

const NOW = "2026-09-26T12:00:00Z";
const forestAoi = {
  id: "br-sfx",
  name: "São Félix do Xingu",
  bbox: [-52.4, -6.9, -51.9, -6.4] as [number, number, number, number],
  rules: [{ name: "forest_loss", params: { minAlerts: 100, minHa: 10 } }],
};
const fireAoi = {
  id: "br-kayapo",
  name: "TI Kayapó",
  bbox: [-53.2, -8.1, -52.7, -7.6] as [number, number, number, number],
  cooldownDays: 14,
  rules: [{ name: "fires_in_protected", params: {} }],
};

/** A scripted tool caller: responses keyed by tool, with a per-call override hook. */
function fakeCall(script: Record<string, (args: Record<string, unknown>) => unknown>): { call: ToolCall; calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const fn = script[tool];
    if (!fn) throw new ToolError(tool, "not scripted");
    return fn(args);
  };
  return { call, calls };
}

// Same shape the live forest_alerts tool returns (nested per-confidence objects).
const alerts = (n: number, ha: number) => ({ window: { from: "2026-06-28", to: "2026-09-26" }, alertCount: n, areaHa: ha, byConfidence: { high: { alertCount: n, areaHa: ha }, highest: { alertCount: 0, areaHa: null } } });
const compare = (delta: number, valid = 95) => ({ dateA: "2026-05-14", dateB: "2026-09-26", validPctA: valid, validPctB: valid, delta: { meanChange: delta }, provenanceA: { scenes: ["S2A_X"] }, provenanceB: { scenes: ["S2B_Y"] } });
const fires = (n: number, frp = 40, date = "2026-09-26") => ({ count: n, source: "VIIRS_NOAA20_NRT", fires: Array.from({ length: n }, (_, i) => ({ lat: -7.85 + i * 0.001, lon: -52.95, frp, brightness: 340, confidence: "h", acqDate: date, acqTime: "1730", satellite: "N20" })) });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-watch-"));
  const fm = mockFetch(() => new Response("{}", { status: 200 })); // dashboard push → swallowed
  return { dir, ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")), restore: fm.restore };
}

test("kernel: forest loss opens with context + blind spots + baseline and is confirmed by NDVI", async (t) => {
  const s = setup();
  t.after(s.restore);
  const { call, calls } = fakeCall({
    forest_alerts: (a) => ((a.bbox as number[])[0]! < -52.4 ? alerts(900, 60) : alerts(420, 38.2)), // ring gets more, AOI is denser
    eo_compare: () => compare(-0.21),
    enso: () => ({ phase: "La Niña", latest: { oni: -0.7 } }),
    events: () => ({ events: [{ id: "EONET_1", title: "Drought, Pará", category: "Drought" }] }),
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [forestAoi] });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  assert.deepEqual(r.gaps, []);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.status, "confirmed");
  assert.equal(f.tier, 1);
  assert.equal(f.confirmed?.independence, "sensor");
  assert.equal(f.evidence[0]!.source, "gfw-integrated-alerts");
  assert.equal(f.confirmed?.signal.source, "sentinel-2-l2a");
  assert.equal(f.context?.enso?.phase, "La Niña");
  assert.equal(f.context?.events?.[0]?.category, "Drought");
  assert.equal(f.context?.baseline?.metric, "alert ha per deg²");
  assert.ok((f.context?.baseline?.ratio ?? 0) > 1, "AOI denser than its ring");
  assert.ok(f.blindSpots!.length >= 3);
  assert.match(f.summary, /0\.5 deg²|neighbourhood|Awaiting/);
  assert.equal(s.journal.watermark("br-sfx", "forest_loss"), NOW);
  assert.equal(s.ledger.verify().ok, true);
  assert.ok(calls.some((c) => c.tool === "eo_compare" && c.args.composite === "median"));
  // The journal records every call with a response hash.
  const journal = readFileSync(join(s.dir, "watch/journal.jsonl"), "utf8");
  assert.ok(journal.includes('"kind":"tool_call"') && journal.includes('"responseSha256"'));
  assert.ok(existsSync(join(s.dir, "watch/heartbeat.json")));
});

test("kernel: fires stay candidate without a second signal, then confirm on revisit; cooldown adds evidence", async (t) => {
  const s = setup();
  t.after(s.restore);
  let day = "2026-09-26";
  const { call } = fakeCall({
    fires_in: (a) => ((a.bbox as number[])[0]! < -53.2 ? fires(6) : fires(7, 40, day)),
    events: () => ({ events: [] }),
    enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }),
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [fireAoi] });
  const r1 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0);
  const id = r1.created[0]!;
  assert.equal(s.ledger.get(id)!.status, "candidate");
  assert.equal(s.ledger.get(id)!.geometry.type, "Point");

  // Next day: same candidate, revisit detections after observedAt → confirmed (revisit).
  day = "2026-09-27";
  const r2 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: "2026-09-27T14:00:00Z", hasKey: () => true });
  assert.equal(r2.created.length, 0);
  assert.deepEqual(r2.confirmed, [id]);
  assert.equal(s.ledger.get(id)!.confirmed?.independence, "revisit");

  // Day 3, still burning and inside the cooldown: evidence is added to the open case, no duplicate.
  day = "2026-09-28";
  const r3 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: "2026-09-28T14:00:00Z", hasKey: () => true });
  assert.equal(r3.created.length, 0);
  assert.deepEqual(r3.evidenceAdded, [id]);
  assert.equal(s.ledger.get(id)!.evidence.length, 2);
  assert.equal(s.ledger.list().length, 1);
  assert.equal(s.ledger.verify().ok, true);
});

test("kernel: quiet AOIs, controls, missing keys, gaps, dry runs, expiry", async (t) => {
  const s = setup();
  t.after(s.restore);
  const control = { ...forestAoi, id: "ctl-jau", name: "Jaú core", control: true, rules: [{ name: "forest_loss", params: { minAlerts: 10, minHa: 1 } }] };
  const broken = { ...forestAoi, id: "br-broken", rules: [{ name: "forest_loss", params: {} }, { name: "no_such_rule", params: {} }] };
  const { call } = fakeCall({
    forest_alerts: (a) => {
      const w = (a.bbox as number[])[0]!;
      if (w > -52.4 && w < -52.39) throw new ToolError("forest_alerts", "429 Too Many Requests"); // br-broken AOI (exact bbox) fails
      return alerts(12, 1.5);
    },
    eo_compare: () => compare(-0.05),
    enso: () => ({ phase: "Neutral", latest: { oni: 0 } }),
    events: () => ({ events: [] }),
  });
  broken.bbox = [-52.395, -6.9, -51.9, -6.4];
  const wl = parseWatchlist({ version: 1, name: "t", aois: [forestAoi, control, broken] });

  // Dry run: nothing written, but the report says what would happen.
  const dry = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, dryRun: true, hasKey: () => true });
  assert.equal(dry.created.length, 1); // the control fires (12 alerts ≥ 10)
  assert.equal(s.ledger.size, 0);

  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r.created.length, 1);
  const ctl = s.ledger.get(r.created[0]!)!;
  assert.ok(ctl.aoi?.tags?.includes("control"));
  assert.match(ctl.context?.notes?.join(" ") ?? "", /CONTROL AOI/);
  assert.equal(ctl.status, "candidate"); // NDVI delta too small to confirm
  assert.equal(r.gaps.length, 2);
  assert.ok(r.gaps.some((g) => g.rule === "no_such_rule"));
  assert.ok(r.gaps.some((g) => /429/.test(g.message)));
  assert.equal(s.journal.watermark("br-broken", "forest_loss"), null, "watermark untouched on failure");
  assert.equal(s.journal.watermark("br-sfx", "forest_loss"), NOW);

  // Missing keys → skipped, not a gap.
  const rk = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: (k) => k !== "GFW_API_KEY" });
  assert.equal(rk.skipped.length, 3);
  assert.equal(rk.created.length, 0);

  // 181 days later the unconfirmed control candidate expires (GLAD's rule).
  const later = new Date(Date.parse(NOW) + 181 * 86_400_000).toISOString();
  const rx = await sweep({ watchlists: [], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: later, hasKey: () => true });
  assert.deepEqual(rx.expired, [ctl.findingId]);
  assert.equal(s.ledger.get(ctl.findingId)!.status, "expired");
  assert.equal(s.ledger.verify().ok, true);
});

test("watchlists: seeds load and validate; bad input is rejected", () => {
  const lists = loadWatchlists("watchlists");
  assert.ok(lists.length >= 3);
  const aois = lists.flatMap((l) => l.aois);
  assert.ok(aois.some((a) => a.control));
  for (const a of aois) for (const r of a.rules) assert.ok(RULES.has(r.name), `${a.id} uses unknown rule ${r.name}`);
  assert.throws(() => parseWatchlist({ version: 1, name: "x", aois: [{ ...forestAoi, bbox: [1, 1, 0, 0] }] }), /west/);
  assert.throws(() => parseWatchlist({ version: 1, name: "x", aois: [forestAoi, forestAoi] }), /duplicate/);
  assert.throws(() => parseWatchlist({ version: 1, name: "x", aois: [{ ...forestAoi, id: "Bad Id" }] }), /id/);
});

test("rules: every rule declares blind spots, a version and an independent confirmation path", async () => {
  for (const r of RULES.values()) {
    assert.ok(r.blindSpots.length >= 3, r.name);
    assert.match(r.version, /^\d+\.\d+$/);
    assert.ok(r.requires.length > 0);
  }
  assert.throws(() => defineRule({ ...RULES.get("forest_loss")!, name: "x", blindSpots: [] }), /blindSpots/);
  // Cloudy compare → not confirmable yet (null), not an error.
  const { call } = fakeCall({ eo_compare: () => compare(-0.4, 30) });
  const rule = RULES.get("forest_loss")!;
  const conf = await rule.confirm({ aoi: parseWatchlist({ version: 1, name: "t", aois: [forestAoi] }).aois[0]!, params: {}, now: NOW, since: null, call }, { observedAt: NOW, evidence: [], values: {}, geometry: undefined });
  assert.equal(conf, null);
});
