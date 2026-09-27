// weather: Open-Meteo forecast + ERA5 normals (weather_now), NHC/CPHC + GDACS storms with
// forecast cones (storms), both fetch-mocked against fixtures recorded live on 2026-09-27; the
// cone/bbox geometry; and weather_extreme@1.0 (heat, cyclone, rain) through the kernel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeStorms, coneIntersectsBBox, gdacsStormName, matchEonet, nhcValidTime, saffirSimpson, type ConeGeometry } from "../src/clients/storms.js";
import { clearNormalsCache, shiftYears, weatherReport } from "../src/clients/weather.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { stormNoun } from "../src/watch/rules/weatherExtreme.js";
import { loadWatchlists, parseWatchlist } from "../src/watch/watchlist.js";
import type { BBox } from "../src/types.js";
import { windArrows, windGrid } from "../web/src/layers/windMath.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as Record<string, unknown>;

// ---- weather_now client -----------------------------------------------------------------

test("weatherReport: forecast days classified by local date, ERA5 normals + anomalies, ERA5-only recent days", async (t) => {
  clearNormalsCache();
  const forecast = fixture("openmeteo-forecast-delhi-2026-09-27.json");
  const recent = fixture("openmeteo-era5-delhi-2026-09-20.json");
  const year = fixture("openmeteo-era5-delhi-1991-window.json");
  const fm = mockFetch((url) => {
    if (url.startsWith("https://api.open-meteo.com/v1/forecast")) return jsonResponse(forecast);
    if (url.includes("start_date=2026-")) return jsonResponse(recent);
    return jsonResponse(year); // every climatology year answers with the recorded 1991 window
  });
  t.after(fm.restore);

  const r = await weatherReport(28.61, 77.21);
  assert.equal(r.today, "2026-09-27");
  assert.equal(r.days.length, 14);
  assert.deepEqual([...new Set(r.days.map((d) => d.kind))], ["past", "today", "forecast"]);
  assert.equal(r.days.filter((d) => d.kind === "past").length, 7);

  // 30 one-per-year climatology windows, ERA5 only (no forecast back-fill), each ≤ 3 weeks.
  const clim = fm.calls.filter((c) => c.url.includes("archive-api") && !c.url.includes("start_date=2026-"));
  assert.equal(clim.length, 30);
  assert.ok(clim.every((c) => c.url.includes("models=era5")));
  assert.ok(clim.some((c) => c.url.includes("start_date=1991-09-17&end_date=1991-10-06")));
  assert.ok(clim.some((c) => c.url.includes("start_date=2020-09-17&end_date=2020-10-06")));

  // Normal for day i = mean of the recorded window's values i..i+6 (identical across the mocked years).
  const tmax = (year.daily as { temperature_2m_max: number[] }).temperature_2m_max;
  const expectNormal = (i: number) => Math.round((tmax.slice(i, i + 7).reduce((a, b) => a + b, 0) / 7) * 10) / 10;
  const today = r.days[7]!;
  assert.equal(today.date, "2026-09-27");
  assert.equal(today.tmaxNormalC, expectNormal(7));
  assert.equal(today.tmaxAnomalyC, Math.round((today.tmaxC! - expectNormal(7)) * 10) / 10);
  assert.equal(r.normals.available, true);

  // ERA5's own reading of the elapsed days keeps its ~6-day latency as nulls.
  assert.equal(r.era5.length, 7);
  assert.equal(r.era5[0]!.tmaxC, 33.7);
  assert.equal(r.era5[6]!.tmaxC, null);
  assert.match(r.provenance.disclaimer, /not station observations/);
});

test("weatherReport: a normals failure degrades to null anomalies with the reason, never an error", async (t) => {
  clearNormalsCache();
  const forecast = fixture("openmeteo-forecast-delhi-2026-09-27.json");
  const fm = mockFetch((url) =>
    url.startsWith("https://api.open-meteo.com/") ? jsonResponse(forecast) : jsonResponse({ error: true, reason: "boom" }, { status: 400 }),
  );
  t.after(fm.restore);
  const r = await weatherReport(28.61, 77.21);
  assert.equal(r.normals.available, false);
  assert.match(r.normals.error ?? "", /boom/);
  assert.ok(r.days.every((d) => d.tmaxAnomalyC === null));
  assert.deepEqual(r.era5, []);
});

test("shiftYears keeps the calendar day and rolls Feb 29 forward", () => {
  assert.equal(shiftYears("2026-09-17", -35), "1991-09-17");
  assert.equal(shiftYears("2024-02-29", -1), "2023-03-01");
});

// ---- storms client ----------------------------------------------------------------------

test("saffirSimpson + storm nouns", () => {
  assert.deepEqual([63, 64, 82, 83, 95, 96, 112, 113, 136, 137].map(saffirSimpson), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
  assert.equal(saffirSimpson(null), null);
  assert.equal(stormNoun({ basin: "EP", position: null, category: 3, classification: "HU" }), "Hurricane");
  assert.equal(stormNoun({ basin: "global", position: { lat: 18, lon: 125 }, category: 2, classification: "" }), "Typhoon");
  assert.equal(stormNoun({ basin: "global", position: { lat: -18, lon: 40 }, category: 2, classification: "" }), "Cyclone");
  assert.equal(stormNoun({ basin: "global", position: { lat: 18, lon: 88 }, category: 0, classification: "Tropical Storm" }), "Tropical storm");
  assert.equal(gdacsStormName("SURIGAE-26"), "Surigae");
});

test("coneIntersectsBBox: vertex inside, box inside cone, crossing edges, disjoint", () => {
  const cone: ConeGeometry = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
  assert.equal(coneIntersectsBBox(cone, [9, 9, 20, 20]), true, "cone vertex in box");
  assert.equal(coneIntersectsBBox(cone, [2, 2, 3, 3]), true, "box inside cone");
  assert.equal(coneIntersectsBBox(cone, [-5, 4, 15, 6]), true, "edges cross, no vertex inside either");
  assert.equal(coneIntersectsBBox(cone, [11, 11, 12, 12]), false);
  const multi: ConeGeometry = { type: "MultiPolygon", coordinates: [[[[20, 20], [21, 20], [21, 21], [20, 20]]], cone.coordinates] };
  assert.equal(coneIntersectsBBox(multi, [2, 2, 3, 3]), true);
});

test("nhcValidTime anchors DD/HHMM on the advisory month and rolls over month end", () => {
  assert.equal(nhcValidTime("28/1200", "2026-09-27T03:00:00.000Z"), "2026-09-28T12:00:00Z");
  assert.equal(nhcValidTime("01/0000", "2026-09-29T21:00:00.000Z"), "2026-10-01T00:00:00Z");
  assert.equal(nhcValidTime("bad", "2026-09-27T03:00:00.000Z"), null);
});

function mockStormFeeds() {
  const gdacsGeom = fixture("gdacs-geometry-one-26.json");
  return mockFetch((url) => {
    if (url === "https://www.nhc.noaa.gov/CurrentStorms.json") return jsonResponse(fixture("nhc-currentstorms-2026-09-27.json"));
    if (url.includes("/MapServer/5/query")) return jsonResponse(fixture("nhc-gis-points-2026-09-27.json"));
    if (url.includes("/MapServer/7/query")) return jsonResponse(fixture("nhc-gis-cone-2026-09-27.json"));
    if (url.includes("geteventlist")) return jsonResponse(fixture("gdacs-tc-list-2026-09-27.json"));
    if (url.includes("getgeometry") && url.includes("eventid=1001326")) return jsonResponse(gdacsGeom);
    if (url.includes("getgeometry")) return new Response("nope", { status: 404 });
    return new Response("{}", { status: 200 }); // dashboard push
  });
}

test("activeStorms: NHC storms with tracks + cones, GDACS for the rest (deduped), geometry failures degrade", async (t) => {
  const fm = mockStormFeeds();
  t.after(fm.restore);
  const { storms, sources } = await activeStorms("2026-09-27");
  assert.deepEqual(sources, { nhc: "ok", gdacs: "ok" });
  assert.deepEqual(storms.map((s) => s.name), ["Fay", "Odalys", "Polo", "Nolo", "Surigae", "Gonzalo", "One"], "NHC first; GDACS dupes of NHC storms and non-current Dujuan dropped");

  const polo = storms.find((s) => s.name === "Polo")!;
  assert.equal(polo.source, "noaa-nhc");
  assert.equal(polo.basin, "EP");
  assert.equal(polo.maxWindKt, 105);
  assert.equal(polo.category, 3);
  assert.equal(polo.track.length, 7);
  assert.deepEqual(polo.track.map((p) => p.maxWindKt), [105, 100, 95, 90, 80, 65, 30]);
  assert.equal(polo.track[1]!.t, "2026-09-27T12:00:00Z");
  assert.equal(polo.cone?.type, "Polygon");
  assert.ok(polo.bbox && polo.bbox[0] < -110 && polo.bbox[3] > 25);
  // The GIS query asks the server to generalize the cone.
  assert.ok(fm.calls.some((c) => c.url.includes("/MapServer/7/query") && c.url.includes("maxAllowableOffset=0.05")));

  const one = storms.find((s) => s.name === "One")!; // Bay of Bengal — outside NHC's basins
  assert.equal(one.source, "gdacs");
  assert.equal(one.maxWindKt, 45);
  assert.equal(one.category, 0);
  assert.ok(one.cone, "Poly_Cones → cone");
  assert.ok(one.track.length >= 2);
  assert.equal(storms.find((s) => s.name === "Surigae")!.cone, null, "geometry 404 → no cone, storm kept");
});

test("activeStorms: one feed down → the other still answers; both down → error", async (t) => {
  const fm = mockFetch((url) => (url.includes("gdacs") ? jsonResponse(fixture("gdacs-tc-list-2026-09-27.json")) : new Response("down", { status: 503 })));
  t.after(fm.restore);
  const r = await activeStorms("2026-09-27");
  assert.match(r.sources.nhc, /503/);
  assert.ok(r.storms.length >= 4 && r.storms.every((s) => s.source === "gdacs"));
  fm.restore();
  const fm2 = mockFetch(() => new Response("down", { status: 503 }));
  t.after(fm2.restore);
  await assert.rejects(activeStorms("2026-09-27"), /both storm feeds failed/);
});

test("matchEonet: by storm name first, else nearest open event within 500 km", () => {
  const eonet = (fixture("eonet-severe-storms-2026-09-27.json").events as Array<{ id: string; title: string; geometry: Array<{ coordinates: [number, number] }> }>).map((e) => ({
    id: e.id,
    title: e.title,
    coordinates: e.geometry[e.geometry.length - 1]!.coordinates,
  }));
  assert.equal(matchEonet({ name: "Polo", position: null }, eonet)?.id, "EONET_24721");
  assert.equal(matchEonet({ name: "Zzz", position: { lat: 18.2, lon: 83.9 } }, eonet)?.id, "EONET_24785", "TC 01B by proximity");
  assert.equal(matchEonet({ name: "Zzz", position: { lat: -40, lon: 0 } }, eonet), null);
});

// ---- weather_extreme@1.0 through the kernel ----------------------------------------------

const NOW = "2026-09-27T09:00:00Z";
const delhi = { id: "in-delhi", name: "Delhi, India", bbox: [77.06, 28.46, 77.36, 28.76] as BBox, rules: [{ name: "weather_extreme", params: { hazards: ["heat", "rain"], absC: 44, anomalyC: 7, minDays: 2, mm: 100 } }] };
const baja = { id: "mx-baja", name: "Baja California Sur", bbox: [-112.5, 22.8, -109.4, 24.5] as BBox, rules: [{ name: "weather_extreme", params: { hazards: ["cyclone"], minCategory: 1 } }] };

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
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-weather-"));
  return { ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")) };
}

/** A weather_now result: `tmax` for 2026-09-21..(today) with a flat normal; forecast days after. */
function weatherNow(today: string, tmax: number[], opts: { normal?: number; precip?: number[]; era5?: Array<number | null> } = {}) {
  const normal = opts.normal ?? 36;
  const n = tmax.length;
  const start = new Date(`${today}T00:00:00Z`).getTime() - (n - 1) * 86_400_000;
  const date = (i: number) => new Date(start + i * 86_400_000).toISOString().slice(0, 10);
  const days = tmax.map((v, i) => ({
    date: date(i),
    kind: i < n - 1 ? "past" : "today",
    tmaxC: v,
    precipMm: opts.precip?.[i] ?? 0,
    tmaxNormalC: normal,
    tmaxAnomalyC: Math.round((v - normal) * 10) / 10,
  }));
  for (let k = 1; k <= 3; k++) days.push({ date: date(n - 1 + k), kind: "forecast", tmaxC: 46, precipMm: 0, tmaxNormalC: normal, tmaxAnomalyC: 10 });
  const era5 = (opts.era5 ?? []).map((v, i) => ({ date: date(i), tmaxC: v, precipMm: 0 }));
  return { today, days, era5, normals: { period: "1991–2020" } };
}

const ctxCommon = { enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }), events: () => ({ events: [] }) };

test("weather_extreme heat: plain-language title, candidate until a later hot day confirms (revisit)", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const s = setup();
  let day = 1;
  const { call, calls } = fakeCall({
    ...ctxCommon,
    weather_now: () =>
      day === 1
        ? weatherNow("2026-09-27", [38, 39, 40, 41, 44.6, 45.2, 45.0])
        : weatherNow("2026-09-28", [39, 40, 41, 44.6, 45.2, 45.0, 45.8]),
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [delhi] });
  const r1 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0, "forecast values alone never confirm");
  const f = s.ledger.get(r1.created[0]!)!;
  assert.equal(f.title, "Heatwave in Delhi, India: 45 °C, 9 °C above normal, third day");
  assert.equal(f.tier, 0);
  assert.equal(f.status, "candidate");
  assert.equal(f.observedAt, "2026-09-27T00:00:00Z");
  assert.equal(f.evidence[0]!.source, "open-meteo-forecast");
  assert.equal(f.evidence[0]!.values?.runDays, 3);
  assert.equal(f.evidence[0]!.values?.forecastHotDaysAhead, 3);
  assert.ok(f.blindSpots!.some((b) => /station/i.test(b)));
  assert.ok(calls.some((c) => c.tool === "weather_now" && c.args.normals === true && c.args.lat === 28.61));

  day = 2;
  const r2 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: "2026-09-28T09:00:00Z", hasKey: () => true });
  assert.equal(r2.confirmed.length, 1);
  const g = s.ledger.get(r1.created[0]!)!;
  assert.equal(g.status, "confirmed");
  assert.equal(g.confirmed?.independence, "revisit");
  assert.equal(g.confirmed?.signal.datetime, "2026-09-28T00:00:00Z");
  assert.equal(s.ledger.verify().ok, true);
});

test("weather_extreme heat: ERA5 agreeing on the flagged days confirms (provider); quiet below threshold", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const rule = RULES.get("weather_extreme")!;
  const aoi = parseWatchlist({ version: 1, name: "t", aois: [delhi] }).aois[0]!;
  const quiet = fakeCall({ weather_now: () => weatherNow("2026-09-27", [38, 39, 40, 41, 43, 43.9, 44.1], { normal: 40 }) });
  assert.equal(await rule.detect({ aoi, params: aoi.rules[0]!.params, now: NOW, since: null, call: quiet.call }), null, "one day over the bar is not a run of two");

  const hot = weatherNow("2026-09-27", [38, 39, 40, 41, 44.6, 45.2, 45.0], { era5: [38, 39, 40, 41, 44.1, 44.5, null] });
  const { call } = fakeCall({ weather_now: () => hot });
  const ctx = { aoi, params: aoi.rules[0]!.params, now: NOW, since: null, call };
  const c = await rule.detect(ctx);
  assert.ok(c);
  const conf = await rule.confirm(ctx, c);
  assert.equal(conf?.independence, "provider");
  assert.equal(conf?.signal.source, "ecmwf-era5");
  assert.equal(conf?.signal.values?.era5HotDays, 2);
});

test("weather_extreme cyclone: live NHC Polo cone over the AOI → candidate, confirmed by EONET (provider)", async (t) => {
  const fm = mockStormFeeds();
  t.after(fm.restore);
  const { storms } = await activeStorms("2026-09-27");
  const s = setup();
  const { call, calls } = fakeCall({
    ...ctxCommon,
    storms: (a) => ({ storms: storms.filter((x) => x.cone && coneIntersectsBBox(x.cone, a.bbox as BBox)) }),
    events: (a) => (a.category === "severeStorms" ? { events: [{ id: "EONET_24721", title: "Hurricane Polo", category: "Severe Storms", lastDate: "2026-09-27T00:00:00Z", coordinates: [-112.9, 19], link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_24721" }] } : { events: [] }),
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [baja] });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.title, "Hurricane Polo (category 3): forecast cone over Baja California Sur");
  assert.equal(f.evidence[0]!.source, "noaa-nhc");
  assert.equal(f.evidence[0]!.id, "ep172026@adv-026a");
  assert.equal(f.geometry.type, "Polygon", "the cone is the finding's geometry");
  assert.equal(f.confirmed?.independence, "provider");
  assert.equal(f.confirmed?.signal.source, "nasa-eonet");
  assert.ok(calls.some((c) => c.tool === "storms" && c.args.minCategory === 1));
  assert.equal(s.ledger.verify().ok, true);
});

test("weather_extreme cyclone: storms below minCategory are quiet", async () => {
  const rule = RULES.get("weather_extreme")!;
  const aoi = parseWatchlist({ version: 1, name: "t", aois: [baja] }).aois[0]!;
  const { call } = fakeCall({ storms: () => ({ storms: [{ id: "al1", name: "Weak", source: "noaa-nhc", basin: "AL", classification: "TS", maxWindKt: 50, category: 0, peakCategory: 0, position: null, advisory: { number: "1", issued: NOW, url: null }, cone: null }] }) });
  assert.equal(await rule.detect({ aoi, params: aoi.rules[0]!.params, now: NOW, since: null, call }), null);
});

test("weather_extreme rain: 180 mm → candidate; GloFAS ≥ 2× confirms (provider); no river cell → persistence only", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const rule = RULES.get("weather_extreme")!;
  const aoi = parseWatchlist({ version: 1, name: "t", aois: [{ ...delhi, id: "in-mumbai", name: "Mumbai, India" }] }).aois[0]!;
  const wet = weatherNow("2026-09-27", [30, 30, 30, 30, 30, 30, 30], { precip: [0, 0, 0, 0, 0, 12, 180.4] });
  const { call } = fakeCall({ weather_now: () => wet, river_discharge: () => ({ latest: { t: "2026-09-27", v: 5200 }, latestVsMean: 2.6, stats: { mean: 2000 } }) });
  const ctx = { aoi, params: aoi.rules[0]!.params, now: NOW, since: null, call };
  const c = await rule.detect(ctx);
  assert.equal(c?.title, "Extreme rain in Mumbai, India: 180.4 mm in one day");
  const conf = await rule.confirm(ctx, c!);
  assert.equal(conf?.independence, "provider");
  assert.equal(conf?.signal.source, "glofas");

  const noRiver = fakeCall({ weather_now: () => wet, river_discharge: () => { throw new ToolError("river_discharge", "no discharge data"); } });
  assert.equal(await rule.confirm({ ...ctx, call: noRiver.call }, c!), null);
});

test("weather_extreme: heat and rain on the same day → heat leads, rain rides along as a note", async () => {
  const rule = RULES.get("weather_extreme")!;
  const aoi = parseWatchlist({ version: 1, name: "t", aois: [delhi] }).aois[0]!;
  const both = weatherNow("2026-09-27", [38, 39, 40, 41, 44.6, 45.2, 45.0], { precip: [0, 0, 0, 0, 0, 0, 120] });
  const { call, calls } = fakeCall({ weather_now: () => both });
  const c = await rule.detect({ aoi, params: aoi.rules[0]!.params, now: NOW, since: null, call });
  assert.match(c!.title, /^Heatwave in Delhi/);
  assert.ok(c!.notes?.some((n) => /Extreme rain/.test(n)));
  assert.equal(calls.filter((x) => x.tool === "weather_now").length, 1, "heat + rain share one call");
});

test("watchlists/weather.json: 12 cities + 6 cyclone regions, every rule known", () => {
  const [wl] = loadWatchlists(new URL("../watchlists/weather.json", import.meta.url).pathname);
  assert.equal(wl!.aois.length, 18);
  assert.equal(wl!.aois.filter((a) => a.tags.includes("city")).length, 12);
  assert.equal(wl!.aois.filter((a) => a.tags.includes("cyclone")).length, 6);
  for (const a of wl!.aois) for (const r of a.rules) assert.ok(RULES.has(r.name), r.name);
});

// ---- map layer geometry (web/src/layers/windMath.ts) --------------------------------------

test("wind arrows: grid stays off the poles; a northerly wind (from 0°) points south", () => {
  const g = windGrid([-180, -90, 180, 90], 4, 3);
  assert.equal(g.length, 12);
  assert.ok(g.every(([, lat]) => lat > -75 && lat < 75));
  const fc = windArrows([{ lon: 10, lat: 0, speedKmh: 30, dirDeg: 0 }], 10);
  const [shaft] = fc.features[0]!.geometry.coordinates;
  const [tail, tip] = shaft as [[number, number], [number, number]];
  assert.ok(tip[1] < 0 && tail[1] > 0, "arrow runs north → south");
  assert.ok(Math.abs(tip[0] - 10) < 1e-9);
  assert.equal(fc.features[0]!.properties.speed, 30);
});
