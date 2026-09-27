// improvement@1.0 end to end through the kernel with a scripted tool caller. Tool outputs are
// real responses recorded live on 2026-09-27 (GFW, FIRMS + EOG VNF, NOAA CRW, CAMS) — see
// test/fixtures/imp-*.json — edited only where a test needs the good-news branch to fire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { select, type AnalystLedger } from "../src/analyst/analyst.js";
import { alertsWhere } from "../src/clients/gfw.js";
import { parseVnfKml } from "../src/clients/vnf.js";
import type { Finding } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { airClean, bleachingRelief, fireClusters, improvementParams } from "../src/watch/rules/improvement.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { loadWatchlists, parseWatchlist, type Watchlist } from "../src/watch/watchlist.js";
import { addDays } from "../src/util.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const fx = (f: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const GFW = fx("imp-gfw-sao-felix-2026-09-27.json"); // 169.25 ha now vs 828.87 ha a year earlier
const FLARE = fx("imp-flaring-rumaila-2026-09-27.json"); // VNF 2.869 → 3.201 BCM (up); 882 hot nights a year ago
const CORAL = fx("imp-coral-galapagos-2026-09-25.json"); // Watch now; Warning 07-29, clear 08-04…08-30
const AIR = fx("imp-air-delhi-15d-2026-09-27.json"); // 15 full days, all > 15 µg/m³
const FIRES = fx("imp-fires-pacaas-novos.json"); // 5 low-FRP detections now; 7 hot (one 6-detection cell) a year ago

const NOW = "2026-09-27T06:00:00Z";

function fakeCall(script: Record<string, (args: Record<string, unknown>) => unknown>): { call: ToolCall; calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const fn = script[tool];
    if (!fn) throw new ToolError(tool, "not scripted");
    return JSON.parse(JSON.stringify(await fn(args)));
  };
  return { call, calls };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-improvement-"));
  return { ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")) };
}

const context = { enso: () => ({ phase: "El Niño", latest: { oni: 1.8 } }), events: () => ({ events: [] }) };

function list(params: Record<string, unknown>, bbox: [number, number, number, number] = [-52.4, -6.9, -51.9, -6.4], name = "São Félix do Xingu (PA)"): Watchlist {
  return parseWatchlist({ version: 1, name: "t", aois: [{ id: "t-aoi", name, bbox, tags: ["test"], rules: [{ name: "improvement", params }] }] });
}

async function run(s: ReturnType<typeof setup>, wl: Watchlist, call: ToolCall, now = NOW) {
  return sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now, hasKey: () => true });
}

// ---- forest_recovery ---------------------------------------------------------------------

test("forest_recovery: loss ≤ 30 % of the same window last year and below the ring → improvement case, NDVI confirms", async () => {
  const s = setup();
  const end = addDays(NOW.slice(0, 10), -14); // alert lag
  const { call, calls } = fakeCall({
    ...context,
    forest_alerts: (a) => {
      if (a.endDate === end && (a.bbox as number[])[0] === -52.4) return GFW.now;
      if (a.endDate === addDays(end, -365)) return GFW.yearAgo;
      return { ...GFW.now, areaHa: 2000 }; // the 25 km ring: busier than the AOI
    },
    eo_compare: () => ({ dateA: "x", dateB: "y", validPctA: 98, validPctB: 98, delta: { meanChange: 0.038 } }),
  });
  const r = await run(s, list({ kind: "forest_recovery" }), call);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "Forest loss near São Félix do Xingu (PA) fell 80 % year on year");
  assert.ok(f.aoi?.tags?.includes("improvement"), "the case carries the improvement tag");
  assert.equal(f.observedAt, `${end}T00:00:00Z`);
  assert.equal(f.evidence[0]!.values!.drop_pct, 80);
  assert.ok(f.context?.baseline && f.context.baseline.ratio! < 1);
  assert.equal(f.confirmed!.independence, "sensor");
  const fa = calls.filter((c) => c.tool === "forest_alerts");
  assert.deepEqual(fa.map((c) => c.args.endDate), [end, addDays(end, -365), end]);
  assert.equal(calls.find((c) => c.tool === "eo_compare")!.args.dateA, addDays(end, -365), "NDVI compared year on year");
});

test("forest_recovery: quiet when the ring is quieter, or last year was already small", async () => {
  const s = setup();
  const quietRing = fakeCall({ ...context, forest_alerts: (a) => ((a.bbox as number[])[0] === -52.4 ? (a.endDate === addDays(NOW.slice(0, 10), -14) ? GFW.now : GFW.yearAgo) : { ...GFW.now, areaHa: 10 }) });
  assert.equal((await run(s, list({ kind: "forest_recovery" }), quietRing.call)).created.length, 0);
  const small = fakeCall({ ...context, forest_alerts: () => ({ ...GFW.now, areaHa: 5 }) });
  assert.equal((await run(setup(), list({ kind: "forest_recovery" }), small.call)).created.length, 0);
  assert.equal(small.calls.filter((c) => c.tool === "forest_alerts").length, 2, "no ring pull once last year is too small");
});

test("forest_recovery: no optical check → stays candidate; the next 30 days still low confirms (revisit)", async () => {
  const s = setup();
  const end = addDays(NOW.slice(0, 10), -14);
  const first = fakeCall({
    ...context,
    forest_alerts: (a) => ((a.bbox as number[])[0] !== -52.4 ? { ...GFW.now, areaHa: 2000 } : a.endDate === end ? GFW.now : GFW.yearAgo),
    // eo_compare unscripted: throws like a missing CDSE key would
  });
  const r = await run(s, list({ kind: "forest_recovery" }), first.call);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0);
  assert.equal(r.gaps.length, 0, "a failed optical check is not a coverage gap");
  // 23 days later the next window has not cleared the alert lag yet
  const early = fakeCall({ ...context, forest_alerts: () => GFW.now });
  const r2 = await run(s, list({ kind: "forest_recovery" }), early.call, "2026-10-20T06:00:00Z");
  assert.equal(r2.confirmed.length, 0);
  assert.equal(early.calls.filter((c) => c.tool === "forest_alerts").length, 0);
  // 45 days later: next 30 d = 20 ha vs 300 ha a year earlier
  const later = fakeCall({ ...context, forest_alerts: (a) => ({ ...GFW.now, areaHa: String(a.endDate) < "2026-01-01" ? 300 : 20 }) });
  const r3 = await run(s, list({ kind: "forest_recovery" }), later.call, "2026-11-11T06:00:00Z");
  assert.equal(r3.confirmed.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.confirmed!.independence, "revisit");
  assert.deepEqual(later.calls.filter((c) => c.tool === "forest_alerts").map((c) => [c.args.days, c.args.endDate]), [[30, addDays(end, 30)], [30, addDays(end, 30 - 365)]]);
});

// ---- flaring_decline ---------------------------------------------------------------------

test("flaring_decline: Rumaila's live VNF went up 2023→2024 → quiet after one registry pull", async () => {
  const { call, calls } = fakeCall({ ...context, flaring: () => FLARE.registry });
  const r = await run(setup(), list({ kind: "flaring_decline" }, [47.0, 30.2, 47.6, 30.8], "Rumaila field (Basra, Iraq)"), call);
  assert.equal(r.created.length, 0);
  assert.equal(calls.filter((c) => c.tool === "flaring").length, 1);
  assert.deepEqual(calls[0]!.args, { bbox: [47.0, 30.2, 47.6, 30.8], days: 1, sources: ["VIIRS_NOAA21_NRT"], limit: 1 });
});

test("flaring_decline: VNF −36 % and fewer hot nights than a year ago → improvement; a second lower window confirms", async () => {
  const s = setup();
  const reg = clone(FLARE.registry);
  reg.vnf.previous.bcmTotal = 5.0; // 5.0 → 3.201 BCM
  const nowWin = { ...clone(FLARE.yearAgo), window: { from: "2026-08-29", to: "2026-09-27", days: 30 }, counts: { ...FLARE.yearAgo.counts, hotNightDetections: 400 } };
  const script = (a: Record<string, unknown>) => (a.days === 1 ? reg : String(a.endDate) < "2026-01-01" ? FLARE.yearAgo : nowWin);
  const first = fakeCall({ ...context, flaring: script });
  const wl = list({ kind: "flaring_decline" }, [47.0, 30.2, 47.6, 30.8], "Rumaila field (Basra, Iraq)");
  const r = await run(s, wl, first.call);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0, "the next window has not elapsed");
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "Gas flaring near Rumaila field (Basra, Iraq) fell 36 % year on year");
  assert.ok(f.aoi?.tags?.includes("improvement"));
  assert.equal(f.evidence.length, 2);
  assert.equal(f.evidence[1]!.values!.hot_nights_year_ago, 882);
  const firms = first.calls.filter((c) => c.tool === "flaring" && c.args.days === 30);
  assert.deepEqual(firms.map((c) => c.args.endDate), ["2026-09-27", "2025-09-27"]);
  assert.ok(firms.every((c) => (c.args.sources as string[]).join() === "VIIRS_NOAA21_NRT" && c.args.vnf === false), "same satellite both years");
  const later = fakeCall({ ...context, flaring: script });
  const r2 = await run(s, wl, later.call, "2026-10-29T06:00:00Z");
  assert.equal(r2.confirmed.length, 1);
  assert.deepEqual(later.calls.map((c) => c.args.endDate), ["2026-10-27", "2025-10-27"]);
});

// ---- bleaching_relief --------------------------------------------------------------------

test("bleaching_relief: live Galápagos is on Watch today → quiet; the same series cut at 08-30 → 27 clear days after a Warning", async () => {
  const reef = (fixture: Json) => fakeCall({ ...context, coral_bleaching: () => fixture });
  const wl = list({ kind: "bleaching_relief", lat: -1.0, lon: -92.0 }, [-92.5, -1.5, -91.5, -0.5], "Galápagos (west of Isabela, Ecuador)");
  assert.equal((await run(setup(), wl, reef(CORAL).call)).created.length, 0);

  const cut = clone(CORAL);
  cut.series = cut.series.filter((p: { t: string }) => p.t <= "2026-08-30");
  cut.latest = { ...cut.latest, date: "2026-08-30", alertLevel: 0, alert: "No stress", dhw: 0.45 };
  assert.deepEqual(bleachingRelief(cut), { peak: 2, peakDhw: 0.45, lastAlert: "2026-08-02", clearDays: 27 });
  const s = setup();
  const r = await run(s, wl, reef(cut).call, "2026-09-01T06:00:00Z");
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0, "same data day: persistence waits");
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "Coral heat stress has eased at Galápagos (west of Isabela, Ecuador): no bleaching alert for 27 days");
  assert.match(f.summary, /Bleaching Warning/);
  assert.ok(f.aoi?.tags?.includes("improvement"));
  // A later day still "No stress" confirms; a relapse would not.
  const next = clone(cut);
  next.latest.date = "2026-09-01";
  next.series.push({ t: "2026-09-01", dhw: 0.44, sstAnomaly: 0, baa: 0, sst: 26 });
  const r2 = await run(s, wl, reef(next).call, "2026-09-03T06:00:00Z");
  assert.equal(r2.confirmed.length, 1);
});

// ---- air_quality_clean -------------------------------------------------------------------

test("air_quality_clean: live Delhi (15 days above) → quiet; a clean last week after 7 above → improvement, confirmed a day later", async () => {
  const wl = list({ kind: "air_quality_clean", lat: 28.61, lon: 77.21 }, [76.96, 28.36, 77.46, 28.86], "Delhi (India)");
  const live = fakeCall({ ...context, air_quality: () => AIR });
  assert.equal((await run(setup(), wl, live.call)).created.length, 0);
  assert.deepEqual(live.calls.find((c) => c.tool === "air_quality")!.args, { lat: 28.61, lon: 77.21, pastDays: 15 });

  const clean = clone(AIR);
  for (const d of clean.pm25Daily.slice(-8, -1)) d.v = 11.5; // 09-20…09-26; 09-27 is partial (9 h)
  assert.deepEqual(airClean(clean.pm25Daily, 15), { last: "2026-09-26", mean: 11.5, priorAbove: 7, priorMean: 49.2 });
  const s = setup();
  const r = await run(s, wl, fakeCall({ ...context, air_quality: () => clean }).call);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "Cleaner air in Delhi (India): a week below the WHO fine-particle guideline");
  assert.ok(f.aoi?.tags?.includes("improvement"));
  const next = clone(clean);
  next.pm25Daily[next.pm25Daily.length - 1] = { t: "2026-09-27", v: 12, hours: 24 };
  next.pm25Daily.push({ t: "2026-09-28", v: 10, hours: 6 });
  const r2 = await run(s, wl, fakeCall({ ...context, air_quality: () => next }).call, "2026-09-28T06:00:00Z");
  assert.equal(r2.confirmed.length, 1);
});

// ---- fires_absent ------------------------------------------------------------------------

test("fires_absent: live Pacaás Novos — no hot cluster this season, one a year ago, sensor alive nearby → improvement", async () => {
  const LY = FIRES["yearAgo_2025-09-08"];
  const NOWF = FIRES["now_2026-09-23"];
  assert.deepEqual(fireClusters(LY.fires, { minFrp: 20, clusterMin: 3, cellDeg: 0.05 }), { hot: 7, clusters: 1 });
  assert.deepEqual(fireClusters(NOWF.fires, { minFrp: 20, clusterMin: 3, cellDeg: 0.05 }), { hot: 0, clusters: 0 });
  const script = (a: Record<string, unknown>) => (a.date === undefined ? NOWF : a.date === "2025-09-08" ? LY : String(a.date) < "2026-01-01" ? { count: 0, fires: [] } : a.date === "2026-09-23" ? NOWF : { count: 0, fires: [] });
  const s = setup();
  const wl = list({ kind: "fires_absent", minHotLastYear: 5 }, [-64.04, -11.69, -62.53, -10.52], "Pacaás Novos National Park (Brazil)");
  const first = fakeCall({ ...context, fires_in: script });
  const r = await run(s, wl, first.call);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "No fire clusters in Pacaás Novos National Park (Brazil) so far this season — 7 hot fire detections in the same weeks last year");
  assert.ok(f.aoi?.tags?.includes("improvement"));
  const fi = first.calls.filter((c) => c.tool === "fires_in");
  assert.equal(fi.length, 13, "6 chunks this year + 6 a year ago + 1 alive check");
  assert.ok(fi.every((c) => c.args.source === "VIIRS_NOAA21_NRT"));
  assert.equal(fi[0]!.args.date, "2026-09-23", "newest chunk first");
  // Too soon for persistence; 6 days on, still no cluster → confirmed.
  const r2 = await run(s, wl, fakeCall({ ...context, fires_in: script }).call, "2026-09-29T06:00:00Z");
  assert.equal(r2.confirmed.length, 0);
  const r3 = await run(s, wl, fakeCall({ ...context, fires_in: () => NOWF }).call, "2026-10-03T06:00:00Z");
  assert.equal(r3.confirmed.length, 1);
});

test("fires_absent: a cluster this season stops after one pull; a silent sensor opens nothing", async () => {
  const LY = FIRES["yearAgo_2025-09-08"];
  const wl = list({ kind: "fires_absent", minHotLastYear: 5 }, [-64.04, -11.69, -62.53, -10.52], "Pacaás Novos");
  const burning = fakeCall({ ...context, fires_in: () => LY });
  assert.equal((await run(setup(), wl, burning.call)).created.length, 0);
  assert.equal(burning.calls.filter((c) => c.tool === "fires_in").length, 1);
  const dark = fakeCall({ ...context, fires_in: (a) => (a.date === "2025-09-08" ? LY : { count: 0, fires: [] }) });
  assert.equal((await run(setup(), wl, dark.call)).created.length, 0, "no detection within 100 km either: can't tell calm from a gap");
});

// ---- plumbing ----------------------------------------------------------------------------

test("improvement params: unknown kind fails loudly; defaults merge under AOI params", () => {
  assert.throws(() => improvementParams({ kind: "vibes" }), /params.kind must be one of/);
  assert.equal(improvementParams({ kind: "forest_recovery", maxShareOfBaseline: 0.5 }).p.maxShareOfBaseline, 0.5);
  assert.equal(improvementParams({ kind: "forest_recovery" }).p.lagDays, 14);
});

test("watchlists: good-news + the amazon/flaring improvement pairs load and name known kinds", () => {
  const wls = [...loadWatchlists("watchlists/good-news.json"), ...loadWatchlists("watchlists/amazon.json"), ...loadWatchlists("watchlists/flaring.json")];
  const pairs = wls.flatMap((w) => w.aois.flatMap((a) => a.rules.filter((r) => r.name === "improvement").map((r) => [a.id, improvementParams(r.params).kind] as const)));
  const count = (k: string) => pairs.filter(([, kind]) => kind === k).length;
  assert.deepEqual([count("forest_recovery"), count("flaring_decline"), count("bleaching_relief"), count("air_quality_clean"), count("fires_absent")], [4, 3, 4, 6, 6]);
  assert.ok(RULES.has("improvement"));
});

test("analyst select: a confirmed good-news case gets a slot even when busier rules outrank it", () => {
  const mk = (id: string, rule: string, ratio: number, tags: string[] = []) =>
    ({ findingId: id, status: "confirmed", rule: { name: rule, version: "1.0", params: {} }, observedAt: "2026-09-20T00:00:00Z", aoi: { id: id, tags }, evidence: [{ id: `ev-${id}`, values: {} }], context: { baseline: { metric: "m", ringKm: 25, aoiValue: 1, regionalValue: 1, ratio } }, narration: null, reviews: [] }) as unknown as Finding;
  const findings = [mk("fl-1", "flaring", 9), mk("fo-1", "forest_loss", 8), mk("me-1", "methane_anomaly", 7), mk("st-1", "flaring_stopped", 0.1, ["improvement"]), mk("im-1", "improvement", 0.2, ["amazon", "improvement"])];
  const ledger = { list: () => findings, get: () => undefined, append: () => ({}) } as unknown as AnalystLedger;
  const two = select(ledger, 2).map((s) => s.finding.findingId);
  assert.deepEqual(two, ["im-1", "fl-1"], "good news leads the first round, then novelty");
  // flaring_stopped and improvement@1.0 share one group: one per round, not two.
  assert.deepEqual(select(ledger, 5).map((s) => s.finding.findingId), ["im-1", "fl-1", "fo-1", "me-1", "st-1"]);
});

// ---- client changes the rule relies on ---------------------------------------------------

test("parseVnfKml reads scientific notation (the 2023 file writes tiny sites as 2.67e-05)", () => {
  const kml = `<kml><Document><Placemark><name>IRQ_UPS_2015_47.3351E_30.4018N_v0.2</name><description><![CDATA[Country: <b>IRQ</b> Lat=30.401752, Lon=47.335143 deg.
<tr><td>2023</td><td>2.674e-05</td><td>368</td><td>0.543%</td><td>3550</td></tr>
<tr><td>BCM_total=2.67e-05</td><td>Type: oil upstream</td></tr>]]></description></Placemark></Document></kml>`;
  const [s] = parseVnfKml(kml);
  assert.equal(s!.bcm, 2.67e-5);
  assert.equal(s!.clearObs, 368);
});

test("forest_alerts window can end in the past (GFW WHERE gets an upper date bound)", () => {
  assert.equal(alertsWhere("2025-06-29", "nominal", "2025-09-27"), "gfw_integrated_alerts__date >= '2025-06-29' AND gfw_integrated_alerts__date <= '2025-09-27'");
  assert.equal(alertsWhere("2025-06-29", "nominal"), "gfw_integrated_alerts__date >= '2025-06-29'");
});
