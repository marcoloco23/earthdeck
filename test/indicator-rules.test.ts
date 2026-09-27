// indicator_threshold@1.0 + indicator_trend@1.0 end to end through the kernel with a scripted
// tool caller. Tool outputs are real responses recorded live on 2026-09-27 (NSIDC, OISST via
// ERDDAP, GloFAS + CAMS via Open-Meteo, CPC ONI, USGS, OWID) — see test/fixtures/ind-*.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDICATORS } from "../src/clients/owid.js";
import { Ledger } from "../src/ledger/store.js";
import { dailyMeans } from "../src/tools/climate.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { costOf } from "../src/watch/quota.js";
import { indicatorBlindSpots, indicatorParams, indicatorThreshold, pm25Streak, sstAnomalies } from "../src/watch/rules/indicatorThreshold.js";
import { fmtValue } from "../src/watch/rules/indicatorTrend.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { loadWatchlists, parseWatchlist, type Watchlist } from "../src/watch/watchlist.js";
import { addDays } from "../src/util.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const fx = (f: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const SEA_ICE = fx("ind-sea-ice-north-2026-09-25.json"); // latest 2026-09-25: 5.169 < p10 5.329
const ENSO = fx("ind-enso-2026-09-27.json"); // El Niño, 3 seasons: not yet an event
const QUAKES = fx("ind-quakes-japan-2026-09-27.json"); // two M5.0, sig 385, reviewed
const AIR = fx("ind-air-delhi-2026-09-27.json"); // 7 full days > 15 µg/m³
const RIVER = fx("ind-river-ganges-patna-2026-09-27.json"); // 3.07× period mean, monsoon
const PULSE = fx("ind-world-pulse-life-2026-09-27.json");
const MED = { recent: fx("ind-sst-med-recent-2026-09-27.json"), base: fx("ind-sst-med-base-2016-2025.json") };
const GBR = { recent: fx("ind-sst-gbr-recent-2026-09-27.json"), base: fx("ind-sst-gbr-base-2016-2025.json") };
const NINO = { recent: fx("ind-sst-nino34-recent-2026-09-27.json"), base: fx("ind-sst-nino34-base-2016-2025.json") };

const NOW = "2026-09-27T06:00:00Z";
const NEXT = "2026-09-28T06:00:00Z";

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
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-indicators-"));
  return { ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")) };
}

const context = { enso: () => ({ phase: "El Niño", latest: { oni: 1.8 } }), events: () => ({ events: [] }) };

function aoiList(params: Record<string, unknown>, extra: Record<string, unknown> = {}, rule = "indicator_threshold"): Watchlist {
  return parseWatchlist({ version: 1, name: "t", aois: [{ id: "t-aoi", name: "Test place", bbox: [5, 38, 6, 39], rules: [{ name: rule, params }], ...extra }] });
}

const run = (s: ReturnType<typeof setup>, wl: Watchlist, call: ToolCall, now: string) => sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now, hasKey: () => true });

/** A sea_ice result moved to a later day with a given extent. */
function seaIceOn(date: string, v: number): Json {
  const r = clone(SEA_ICE);
  r.latest = { t: date, v };
  return r;
}

// ---- sea ice -----------------------------------------------------------------------------

test("sea_ice: below p10 opens a candidate; a later day still below confirms it (revisit)", async () => {
  const s = setup();
  let today = SEA_ICE;
  const { call, calls } = fakeCall({ sea_ice: () => today, ...context });
  const wl = aoiList({ indicator: "sea_ice", hemisphere: "arctic" });

  const r1 = await run(s, wl, call, NOW);
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0, "same data day cannot confirm itself");
  assert.deepEqual(calls.find((c) => c.tool === "sea_ice")!.args, { pole: "north" });
  const f = s.ledger.get(r1.created[0]!)!;
  assert.equal(f.tier, 1);
  assert.match(f.title, /^Arctic sea ice is below the lowest tenth of past years — 5\.17 M km², 0\.16 M km² under the p10 line$/);
  assert.equal(f.evidence[0]!.kind, "series");
  assert.deepEqual(f.evidence[0]!.values, { extent_mkm2: 5.169, p10_mkm2: 5.329, anomaly_mkm2: -1.371, below_p10_mkm2: 0.16 });
  assert.ok(f.context?.notes?.some((n) => n.includes("NSIDC Sea Ice Index")));
  assert.ok(f.blindSpots?.some((b) => b.startsWith("Sea ice:")));
  assert.ok(f.blindSpots?.every((b) => b.startsWith("Sea ice:") || b.startsWith("All:")), "only this indicator's blind spots (+ All)");

  // Next sweep, data has not moved on → still unconfirmed.
  const r2 = await run(s, wl, call, "2026-09-27T18:00:00Z");
  assert.equal(r2.confirmed.length, 0);
  // A later day, still below p10 → confirmed as a revisit.
  today = seaIceOn("2026-09-26", 5.2);
  const r3 = await run(s, wl, call, NEXT);
  assert.deepEqual(r3.confirmed, [f.findingId]);
  const g = s.ledger.get(f.findingId)!;
  assert.equal(g.status, "confirmed");
  assert.equal(g.confirmed?.independence, "revisit");
  assert.equal(g.confirmed?.signal.values?.extent_mkm2, 5.2);
});

test("sea_ice: above p10 is quiet; a later day back above p10 does not confirm", async () => {
  const s = setup();
  const quiet = fakeCall({ sea_ice: () => seaIceOn("2026-09-25", 5.5), ...context });
  const r = await run(s, aoiList({ indicator: "sea_ice", hemisphere: "antarctic" }), quiet.call, NOW);
  assert.equal(r.created.length, 0);
  assert.deepEqual(quiet.calls.find((c) => c.tool === "sea_ice")!.args, { pole: "south" });

  const s2 = setup();
  let today = SEA_ICE;
  const { call } = fakeCall({ sea_ice: () => today, ...context });
  const wl = aoiList({ indicator: "sea_ice", hemisphere: "arctic" });
  await run(s2, wl, call, NOW);
  today = seaIceOn("2026-09-26", 5.4);
  const r2 = await run(s2, wl, call, NEXT);
  assert.equal(r2.confirmed.length, 0);
});

// ---- marine heatwave ---------------------------------------------------------------------

test("sstAnomalies: day-of-year climatology from a strided baseline, trailing streak", () => {
  const base = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].flatMap((y) => [`${y}-08-25`, `${y}-09-04`, `${y}-09-14`].map((t) => ({ t, v: 20 })));
  const recent = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((t, i) => ({ t, v: [20.5, 22, 22, 21.6][i]! }));
  const a = sstAnomalies(recent, base, 1.5)!;
  assert.equal(a.latest.clim, 20);
  assert.equal(a.latest.anomaly, 1.6);
  assert.equal(a.streak, 3);
  assert.equal(a.wholeWindow, false);
  assert.equal(a.maxAnomaly, 2);
  assert.equal(sstAnomalies(recent, base.slice(0, 5), 1.5), null, "too thin a baseline");
});

function sstScript(pair: { recent: Json; base: Json }) {
  return (args: Record<string, unknown>) => (args.end ? pair.base : pair.recent);
}

test("marine_heatwave: real Mediterranean pull opens a candidate; GBR is quiet", async () => {
  const s = setup();
  const { call, calls } = fakeCall({ ocean_temp: sstScript(MED), ...context });
  const r = await run(s, aoiList({ indicator: "marine_heatwave", lat: 38.5, lon: 5.5 }), call, NOW);
  assert.equal(r.created.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  const v = f.evidence[0]!.values!;
  assert.ok(v.anomaly_c! >= 1.5 && v.days_over! >= 5, JSON.stringify(v));
  assert.match(f.title, /^Marine heatwave at Test place: the sea surface is \d+\.\d °C warmer than normal, \d+ days running$/);
  assert.deepEqual(f.geometry, { type: "Point", coordinates: [5.625, 38.625] });
  // detect + confirm share one pull per args within the sweep (recent + baseline = 2 calls).
  assert.equal(calls.filter((c) => c.tool === "ocean_temp").length, 2);
  const baseArgs = calls.find((c) => c.tool === "ocean_temp" && c.args.end)!.args;
  assert.deepEqual(baseArgs, { lat: 38.5, lon: 5.5, start: "2016-01-01", end: "2025-12-31" });

  const q = setup();
  const quiet = fakeCall({ ocean_temp: sstScript(GBR), ...context });
  const rq = await run(q, aoiList({ indicator: "marine_heatwave", lat: -18.5, lon: 147.5 }), quiet.call, NOW);
  assert.equal(rq.created.length, 0);
  assert.equal(rq.gaps.length, 0);
});

test("marine_heatwave: persistence on the next data day confirms (revisit)", async () => {
  const s = setup();
  let pair = MED;
  // One caller across both sweeps: the per-sweep memo must not serve the first sweep's pull.
  const { call } = fakeCall({ ocean_temp: (a) => sstScript(pair)(a), ...context });
  const wl = aoiList({ indicator: "marine_heatwave", lat: 38.5, lon: 5.5 });
  const r1 = await run(s, wl, call, NOW);
  assert.equal(r1.confirmed.length, 0);
  const recent = clone(MED.recent);
  const last = recent.series[recent.series.length - 1];
  recent.series.push({ t: addDays(last.t, 1), v: last.v });
  recent.window.to = addDays(last.t, 1);
  pair = { recent, base: MED.base };
  const r2 = await run(s, wl, call, NEXT);
  assert.equal(r2.confirmed.length, 1);
  assert.equal(s.ledger.get(r1.created[0]!)!.confirmed?.independence, "revisit");
});

// ---- river discharge ---------------------------------------------------------------------

test("river_discharge: 3× the period mean opens a case; the seasonal gate keeps a normal monsoon quiet", async () => {
  const s = setup();
  const { call } = fakeCall({ river_discharge: () => RIVER, ...context });
  const r = await run(s, aoiList({ indicator: "river_discharge", lat: 25.62, lon: 85.15 }), call, NOW);
  assert.equal(r.created.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  const v = f.evidence[0]!.values!;
  assert.equal(v.ratio, 3.07);
  assert.equal(v.threshold_ratio, 2);
  assert.ok(typeof v.seasonal_ratio === "number" && v.seasonal_ratio < 1.5, `seasonal ${v.seasonal_ratio}`);
  assert.match(f.title, /is running high: 30,060 m³\/s, 3\.07× its 10-year average/);
  assert.equal(r.confirmed.length, 0, "no flood event, same data day");

  const q = setup();
  const r2 = await run(q, aoiList({ indicator: "river_discharge", lat: 25.62, lon: 85.15, minSeasonalRatio: 1.5 }), fakeCall({ river_discharge: () => RIVER, ...context }).call, NOW);
  assert.equal(r2.created.length, 0);
});

test("river_discharge: an EONET flood within 200 km confirms (provider); one 400 km away does not", async () => {
  const flood = (lon: number) => ({ events: [{ id: "EONET_9999", title: "Floods — Bihar", category: "Floods", closed: false, lastDate: "2026-09-25T00:00:00Z", coordinates: [lon, 25.6], magnitude: null, link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_9999" }] });
  const far = setup();
  const r1 = await run(far, aoiList({ indicator: "river_discharge", lat: 25.62, lon: 85.15 }), fakeCall({ river_discharge: () => RIVER, enso: context.enso, events: (a) => (a.category === "floods" ? flood(89.2) : { events: [] }) }).call, NOW);
  assert.equal(r1.confirmed.length, 0);

  const near = setup();
  const { call, calls } = fakeCall({ river_discharge: () => RIVER, enso: context.enso, events: (a) => (a.category === "floods" ? flood(85.9) : { events: [] }) });
  const r2 = await run(near, aoiList({ indicator: "river_discharge", lat: 25.62, lon: 85.15 }), call, NOW);
  assert.equal(r2.confirmed.length, 1);
  const f = near.ledger.get(r2.created[0]!)!;
  assert.equal(f.confirmed?.independence, "provider");
  assert.equal(f.confirmed?.signal.source, "nasa-eonet");
  const ev = calls.find((c) => c.tool === "events" && c.args.category === "floods")!.args;
  assert.equal(ev.status, "all");
});

// ---- air quality -------------------------------------------------------------------------

test("dailyMeans: UTC-day means from hourly CAMS, forecast hours excluded", () => {
  const pts = [
    { t: "2026-09-26T22:00", v: 10 },
    { t: "2026-09-26T23:00", v: 20 },
    { t: "2026-09-27T00:00", v: 40 },
    { t: "2026-09-27T01:00", v: null },
    { t: "2026-09-27T07:00", v: 999 }, // forecast
  ];
  assert.deepEqual(dailyMeans(pts, "2026-09-27T06:30:00.000Z"), [
    { t: "2026-09-26", v: 15, hours: 2 },
    { t: "2026-09-27", v: 40, hours: 1 },
  ]);
});

test("pm25Streak: partial days are ignored; the streak is the trailing run above the guideline", () => {
  const s = pm25Streak([{ t: "a", v: 30, hours: 24 }, { t: "b", v: 10, hours: 24 }, { t: "c", v: 20, hours: 24 }, { t: "d", v: 25, hours: 24 }, { t: "e", v: 5, hours: 6 }], 15)!;
  assert.equal(s.last.t, "d");
  assert.equal(s.days, 2);
  assert.equal(s.max, 25);
  assert.equal(s.mean, 22.5);
});

test("air_quality: Delhi above the WHO guideline 7 days → candidate; a later full day above confirms", async () => {
  const s = setup();
  let today = AIR;
  const { call, calls } = fakeCall({ air_quality: () => today, ...context });
  const wl = aoiList({ indicator: "air_quality", lat: 28.61, lon: 77.21 });
  const r1 = await run(s, wl, call, NOW);
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0);
  assert.deepEqual(calls.find((c) => c.tool === "air_quality")!.args, { lat: 28.61, lon: 77.21, pastDays: 7 });
  const f = s.ledger.get(r1.created[0]!)!;
  assert.deepEqual(f.evidence[0]!.values, { pm25_daily_ugm3: 48.8, days_over: 7, guideline_ugm3: 15, pm25_mean_ugm3: 58.8, pm25_max_ugm3: 73.3, times_guideline: 3.3 });
  assert.equal(f.observedAt, "2026-09-26T00:00:00Z", "today's partial day (8 h) is not a full day");

  today = clone(AIR);
  today.pm25Daily[today.pm25Daily.length - 1] = { t: "2026-09-27", v: 51, hours: 24 };
  const r2 = await run(s, wl, call, NEXT);
  assert.equal(r2.confirmed.length, 1);
  assert.equal(s.ledger.get(f.findingId)!.confirmed?.independence, "revisit");
});

test("air_quality: fewer than minDays above the guideline is quiet", async () => {
  const s = setup();
  const clean = clone(AIR);
  clean.pm25Daily = clean.pm25Daily.map((d: Json, i: number) => ({ ...d, v: i >= 5 ? 30 : 8 })); // 2 full days above
  const r = await run(s, aoiList({ indicator: "air_quality", lat: 28.61, lon: 77.21 }), fakeCall({ air_quality: () => clean, ...context }).call, NOW);
  assert.equal(r.created.length, 0);
});

// ---- ENSO --------------------------------------------------------------------------------

test("enso: 3 seasons is not an event (quiet); 5 seasons opens one global case, confirmed by Niño3.4 OISST", async () => {
  const q = setup();
  const quiet = await run(q, aoiList({ indicator: "enso" }), fakeCall({ enso: () => ENSO, events: () => ({ events: [] }) }).call, NOW);
  assert.equal(quiet.created.length, 0);

  const declared = clone(ENSO);
  declared.consecutiveSeasons = 5;
  declared.meetsEventDefinition = true;
  const s = setup();
  const { call, calls } = fakeCall({ enso: () => declared, events: () => ({ events: [] }), ocean_temp: sstScript(NINO) });
  const wl = aoiList({ indicator: "enso" }, { cooldownDays: 180 });
  const r = await run(s, wl, call, NOW);
  assert.equal(r.created.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  assert.match(f.title, /^El Niño is here: the Pacific has been warmer than normal for 5 seasons in a row \(ONI \+1\.8 °C\)$/);
  assert.deepEqual(f.evidence[0]!.values, { oni_c: 1.8, consecutive_seasons: 5, phase_sign: 1 });
  assert.ok(f.aoi?.tags?.includes("el-nino"));
  assert.equal(r.confirmed.length, 1, "OISST at the Niño3.4 centre is warm too");
  const g = s.ledger.get(f.findingId)!;
  assert.equal(g.confirmed?.independence, "method");
  assert.ok(g.confirmed!.signal.values!.nino34_point_anomaly_c! >= 0.3);
  assert.ok(calls.some((c) => c.tool === "ocean_temp" && c.args.lat === 0 && c.args.lon === -145));

  // Same event next day: no duplicate case, no new evidence (same ONI release).
  const r2 = await run(s, wl, call, NEXT);
  assert.equal(r2.created.length, 0);
  assert.equal(r2.evidenceAdded.length, 0);
});

// ---- earthquakes -------------------------------------------------------------------------

test("quake: M7 floor keeps two M5s quiet; at M5 they open a case; USGS review + sig confirms (method)", async () => {
  const q = setup();
  const quiet = await run(q, aoiList({ indicator: "quake" }), fakeCall({ quakes: () => QUAKES, ...context }).call, NOW);
  assert.equal(quiet.created.length, 0);

  const s = setup();
  const { call, calls } = fakeCall({ quakes: () => QUAKES, ...context });
  const wl = aoiList({ indicator: "quake", minMagnitude: 5 });
  const r = await run(s, wl, call, NOW);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0, "sig 385 < 600");
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "M5 earthquake — 38 km E of Nobeoka, Japan");
  assert.equal(f.evidence.length, 2);
  assert.equal(f.evidence[0]!.kind, "record");
  assert.deepEqual(f.evidence[0]!.values, { magnitude: 5, depth_km: 42.7, sig: 385 });
  assert.equal(calls.find((c) => c.tool === "quakes")!.args.days, 7, "first sweep: default 7-day lookback");

  const s2 = setup();
  const r2 = await run(s2, aoiList({ indicator: "quake", minMagnitude: 5, minSig: 300 }), fakeCall({ quakes: () => QUAKES, ...context }).call, NOW);
  assert.equal(r2.confirmed.length, 1);
  const g = s2.ledger.get(r2.created[0]!)!;
  assert.equal(g.confirmed?.independence, "method");
  assert.equal(g.confirmed?.signal.source, "usgs-comcat-review");

  // The second sweep looks back only to the last one (+1 day overlap).
  await run(s, wl, call, "2026-09-29T06:00:00Z");
  assert.equal(calls.filter((c) => c.tool === "quakes").pop()!.args.days, 3);
});

test("quake: an unreviewed (automatic) event does not confirm", async () => {
  const auto = clone(QUAKES);
  for (const q of auto.quakes) Object.assign(q, { status: "automatic", sig: 900 });
  const s = setup();
  const r = await run(s, aoiList({ indicator: "quake", minMagnitude: 5 }), fakeCall({ quakes: () => auto, ...context }).call, NOW);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 0);
});

test("indicator_threshold: unknown indicator is a gap, not a crash", async () => {
  const s = setup();
  const r = await run(s, aoiList({ indicator: "volcano" }), fakeCall(context).call, NOW);
  assert.equal(r.gaps.length, 1);
  assert.match(r.gaps[0]!.message, /params\.indicator must be one of/);
  assert.throws(() => indicatorParams({ indicator: "sea_ice", hemisphere: "north" }), /arctic or antarctic/);
});

// ---- indicator_trend ---------------------------------------------------------------------

function pulseWith(slug: string, patch: (row: Json) => void = () => {}): Json {
  const r = clone(PULSE);
  r.indicators = r.indicators.filter((i: Json) => i.slug === slug);
  patch(r.indicators[0]);
  return r;
}

/** `ledger_list` over the test ledger — what the real tool returns (compact rows). */
function ledgerList(s: ReturnType<typeof setup>) {
  return (a: Record<string, unknown>) => ({
    findings: s.ledger
      .list({})
      .filter((f) => (!a.rule || f.rule.name === a.rule) && (!a.aoi || f.aoi?.id === a.aoi))
      .map((f) => ({ findingId: f.findingId, observedAt: f.observedAt, rule: `${f.rule.name}@${f.rule.version}`, aoi: f.aoi ? { id: f.aoi.id, name: f.aoi.name } : undefined })),
  });
}

const trendList = (slug: string) => parseWatchlist({ version: 1, name: "t", aois: [{ id: "wp-test", name: "World: test", bbox: [-180, -90, 180, 90], cooldownDays: 1, rules: [{ name: "indicator_trend", params: { indicator: slug } }] }] });

test("indicator_trend: a new year opens one case; a later unchanged read confirms; the year never re-opens; next year opens a new case", async () => {
  const s = setup();
  let pulse = pulseWith("global-living-planet-index");
  const { call, calls } = fakeCall({ world_pulse: () => pulse, ledger_list: ledgerList(s), ...context });
  const wl = trendList("global-living-planet-index");

  const r1 = await run(s, wl, call, NOW);
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0, "the same sweep's read is not a second read");
  assert.deepEqual(calls.find((c) => c.tool === "world_pulse")!.args, { indicators: ["global-living-planet-index"] });
  const f = s.ledger.get(r1.created[0]!)!;
  assert.equal(f.title, "Living Planet Index (wildlife populations) fell to 27.1 (index, 1970 = 100) in 2020 — wildlife populations keep shrinking");
  assert.equal(f.observedAt, "2020-01-01T00:00:00Z");
  assert.equal(f.evidence[0]!.id, "owid-global-living-planet-index-2020");
  assert.equal(f.evidence[0]!.kind, "series");
  assert.deepEqual(Object.keys(f.evidence[0]!.values!).sort(), ["changePct", "pctPerDecade", "previous", "value", "year"]);
  assert.equal(f.evidence[0]!.values!.changePct, -0.71);
  assert.ok(f.aoi?.tags?.includes("worsening"));

  const r2 = await run(s, wl, call, NEXT);
  assert.deepEqual(r2.confirmed, [f.findingId]);
  assert.equal(s.ledger.get(f.findingId)!.confirmed?.independence, "method");

  // Days, then a year later: same indicator-year → never re-opened (cooldown 1 day notwithstanding).
  for (const now of ["2026-09-30T06:00:00Z", "2027-09-30T06:00:00Z"]) {
    const r = await run(s, wl, call, now);
    assert.equal(r.created.length + r.evidenceAdded.length, 0, now);
  }

  // A new year appears → a new case for 2021.
  pulse = pulseWith("global-living-planet-index", (row) => {
    row.previous = row.latest;
    row.latest = { t: "2021", v: 26.5 };
  });
  const r4 = await run(s, wl, call, "2027-10-01T06:00:00Z");
  assert.equal(r4.created.length, 1);
  const g = s.ledger.get(r4.created[0]!)!;
  assert.match(g.title, /fell to 26\.5 .* in 2021/);
  assert.ok(g.context?.notes?.some((n) => n.includes("Last year this watch reported: 2020")));
  assert.equal(s.ledger.list({}).length, 2);
});

test("indicator_trend: improving → tag improvement; flat → quiet; a revised value does not confirm", async () => {
  const s = setup();
  let pulse = pulseWith("marine-protected-areas");
  const { call } = fakeCall({ world_pulse: () => pulse, ledger_list: ledgerList(s), ...context });
  const r = await run(s, trendList("marine-protected-areas"), call, NOW);
  const f = s.ledger.get(r.created[0]!)!;
  assert.ok(f.aoi?.tags?.includes("improvement"));
  assert.match(f.title, /^Marine protected areas rose to 17\.5 \(% of territorial waters\) in 2025 — more of the ocean is protected$/);
  pulse = pulseWith("marine-protected-areas", (row) => (row.latest.v = 17.9));
  const r2 = await run(s, trendList("marine-protected-areas"), call, NEXT);
  assert.equal(r2.confirmed.length, 0);

  const q = setup();
  const flat = pulseWith("red-list-index", (row) => (row.direction = "flat"));
  const rq = await run(q, trendList("red-list-index"), fakeCall({ world_pulse: () => flat, ledger_list: ledgerList(q), ...context }).call, NOW);
  assert.equal(rq.created.length, 0);
});

test("indicator_trend: a year moving against the trend says so; the ledger read failing is a gap", async () => {
  const s = setup();
  const r = await run(s, trendList("fish-stocks-within-sustainable-levels"), fakeCall({ world_pulse: () => pulseWith("fish-stocks-within-sustainable-levels"), ledger_list: ledgerList(s), ...context }).call, NOW);
  const f = s.ledger.get(r.created[0]!)!;
  assert.match(f.title, /rose to 64\.5 \(% of stocks\) in 2021 — a better year, but over ten years more of the ocean's fish stocks are overfished/);
  assert.ok(f.aoi?.tags?.includes("worsening"));

  const g = setup();
  const rg = await run(g, trendList("red-list-index"), fakeCall({ world_pulse: () => pulseWith("red-list-index"), ...context }).call, NOW);
  assert.equal(rg.created.length, 0);
  assert.equal(rg.gaps.length, 1);
});

test("fmtValue: readable numbers", () => {
  assert.equal(fmtValue(29559676), "29.6 million");
  assert.equal(fmtValue(4321.4), "4,321");
  assert.equal(fmtValue(27.134067), "27.1");
  assert.equal(fmtValue(8.042414), "8.042");
  assert.equal(fmtValue(0.74), "0.74");
});

// ---- watchlist, registry, quota ------------------------------------------------------------

test("watchlists/indicators.json: valid, ~30 AOIs, every rule known, every indicator param valid", () => {
  const [wl] = loadWatchlists(new URL("../watchlists/indicators.json", import.meta.url).pathname);
  assert.ok(wl!.aois.length >= 25);
  const kinds: Record<string, number> = {};
  for (const a of wl!.aois)
    for (const r of a.rules) {
      assert.ok(RULES.has(r.name), r.name);
      if (r.name === "indicator_threshold") {
        const { kind } = indicatorParams(r.params);
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      } else {
        assert.ok(INDICATORS.some((i) => i.slug === r.params.indicator), String(r.params.indicator));
        assert.equal(a.cooldownDays, 1);
        assert.match(a.id, /^wp-/);
        kinds.trend = (kinds.trend ?? 0) + 1;
      }
    }
  assert.deepEqual(kinds, { sea_ice: 2, marine_heatwave: 6, river_discharge: 5, air_quality: 6, enso: 1, quake: 4, trend: 6 });
});

test("indicator rules: registered, tier 1, zero-key, blind spots fit the ledger contract; their tools are not quota-governed", () => {
  for (const name of ["indicator_threshold", "indicator_trend"]) {
    const r = RULES.get(name)!;
    assert.equal(r.tier, 1);
    assert.deepEqual(r.requires, []);
    assert.ok(r.blindSpots.length <= 20 && r.blindSpots.every((b) => b.length <= 300));
  }
  for (const tool of ["sea_ice", "ocean_temp", "river_discharge", "air_quality", "enso", "quakes", "world_pulse", "events", "ledger_list"]) assert.equal(costOf(tool, {}), null, tool);
});

test("indicatorBlindSpots: filters the generic list to one indicator, keeps All, fails open", () => {
  const all = indicatorThreshold.blindSpots;
  const sst = indicatorBlindSpots(all, "marine_heatwave");
  assert.ok(sst.length >= 3 && sst.every((b) => b.startsWith("Marine heatwave:") || b.startsWith("All:")));
  assert.ok(!sst.some((b) => b.startsWith("Sea ice:")));
  assert.ok(indicatorBlindSpots(all, "air_quality").some((b) => b.startsWith("Air quality:")));
  assert.deepEqual(indicatorBlindSpots(all, undefined), [...all], "unknown indicator → nothing hidden");
  assert.deepEqual(indicatorBlindSpots(all, "nope"), [...all]);
});
