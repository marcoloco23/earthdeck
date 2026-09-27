// indicator_threshold@1.0 — one generic rule over the zero-key planetary indicators the repo
// already ingests. The AOI's params pick the indicator; each has its own detector and its own
// second signal:
//
//   sea_ice          NSIDC extent below the 1981–2010 p10 for the latest day   → confirm: still below on a later day (revisit)
//   marine_heatwave  OISST anomaly ≥ minAnomalyC for ≥ minDays at a point       → confirm: still hot on a later day (revisit)
//   river_discharge  GloFAS discharge ≥ ratio × the period mean at a point       → confirm: an EONET flood event within floodKm (provider), else a later day still high (revisit)
//   air_quality      CAMS PM2.5 daily mean > WHO 15 µg/m³ for ≥ minDays          → confirm: a later full day still above (revisit)
//   enso             ONI meets NOAA's event definition (≥ 5 seasons beyond ±0.5) → confirm: OISST at the Niño3.4 centre has the same-sign anomaly (method)
//   quake            USGS M ≥ minMagnitude inside the AOI bbox                    → confirm: USGS marks it "reviewed" with sig ≥ minSig (method — same provider)
//
// Persistence confirmations compare data dates, not sweep times: in the sweep that opens the
// case the data has not moved on, so confirmation always waits for a later observation.
// Every value is a plain number; titles name places (the AOI), never people or companies.

import type { Evidence, Geometry } from "../../ledger/schema.js";
import { round } from "../../series.js";
import { addDays } from "../../util.js";
import { dayStart, defineRule, num, ringBBox, type Candidate, type Confirmation, type RuleContext, type ToolCall } from "./types.js";

export const INDICATOR_KINDS = ["sea_ice", "marine_heatwave", "river_discharge", "air_quality", "enso", "quake"] as const;
export type IndicatorKind = (typeof INDICATOR_KINDS)[number];

/** Per-indicator defaults (the rule-level `defaults` stay empty so a case's params show only what applies). */
export const INDICATOR_DEFAULTS: Record<IndicatorKind, Record<string, unknown>> = {
  sea_ice: { hemisphere: "arctic" },
  marine_heatwave: { minAnomalyC: 1.5, minDays: 5, baselineYears: 10 },
  // minSeasonalRatio (optional): also require latest ≥ this × the same calendar month of the
  // other years — keeps a monsoon peak that is normal for the season from opening a case.
  river_discharge: { ratio: 2.0, years: 10, floodKm: 200 },
  air_quality: { minDays: 3, guideline: 15 },
  enso: { confirmAnomalyC: 0.3, baselineYears: 10 },
  quake: { minMagnitude: 7.0, minSig: 600, days: 7 },
};

const NINO34 = { lat: 0, lon: -145 }; // centre of the Niño3.4 box (5°N–5°S, 170°W–120°W)
const WHO_PM25 = 15;

// ---- tool result shapes (the fields this rule reads) --------------------------------------

interface SeaIceResult {
  source: string;
  pole: "north" | "south";
  latest: { t: string; v: number };
  anomalyVsAverage: number | null;
  belowP10: boolean | null;
  climatologyForDay: { doy: number; average: number; p10: number } | null;
}
interface OceanTempResult {
  source: string;
  gridCell: { lat: number; lon: number };
  window: { from: string; to: string; strideDays: number };
  series: { t: string; v: number | null }[];
}
interface RiverResult {
  source: string;
  unit: string;
  window: { from: string; to: string };
  latest: { t: string; v: number | null } | null;
  stats: { mean: number | null };
  latestVsMean: number | null;
  series: { t: string; v: number | null }[];
}
interface AirResult {
  source: string;
  pm25Daily?: { t: string; v: number; hours: number }[];
}
interface EnsoResult {
  source: string;
  phase: string;
  latest: { season: string; year: number; oni: number };
  consecutiveSeasons: number;
  meetsEventDefinition: boolean;
  series: { t: string; v: number | null }[];
}
interface QuakeRow {
  id: string;
  mag: number | null;
  place: string;
  time: string;
  lon: number;
  lat: number;
  depthKm: number | null;
  tsunami: boolean;
  alert: string | null;
  url: string;
  sig?: number | null;
  status?: string | null;
}
interface QuakesResult {
  source: string;
  window: { from: string; to: string };
  quakes: QuakeRow[];
}
interface EventsResult {
  events: { id: string; title: string; category: string; lastDate: string | null; coordinates: [number, number] | null; link: string }[];
}

// ---- shared helpers ----------------------------------------------------------------------

type P = Record<string, unknown>;

/** The indicator an AOI asks for, with its defaults merged under the AOI's params. */
export function indicatorParams(params: P): { kind: IndicatorKind; p: P } {
  const kind = params.indicator as IndicatorKind;
  if (!INDICATOR_KINDS.includes(kind)) throw new Error(`indicator_threshold: params.indicator must be one of ${INDICATOR_KINDS.join(", ")} (got ${JSON.stringify(params.indicator)})`);
  const p = { ...INDICATOR_DEFAULTS[kind], ...params };
  if (kind === "sea_ice" && p.hemisphere !== "arctic" && p.hemisphere !== "antarctic") throw new Error(`indicator_threshold: sea_ice hemisphere must be arctic or antarctic (got ${JSON.stringify(p.hemisphere)})`);
  return { kind, p };
}

/** The point an AOI is about: explicit params.lat/lon, else the bbox centre. */
function pointOf(ctx: RuleContext, p: P): { lat: number; lon: number } {
  const [w, s, e, n] = ctx.aoi.bbox;
  return { lat: num(p.lat, round((s + n) / 2, 3)), lon: num(p.lon, round((w + e) / 2, 3)) };
}

const pointGeom = (lat: number, lon: number): Geometry => ({ type: "Point", coordinates: [round(lon, 3), round(lat, 3)] });

// One pull per tool+args per sweep, shared by detect and confirm. Scoped to the sweep-level
// caller (the kernel exposes it as `base` on its per-rule wrappers) AND the sweep's `now`, so
// a caller reused across sweeps never serves last sweep's data.
const memo = new WeakMap<ToolCall, { now: string; m: Map<string, Promise<unknown>> }>();
function shared(ctx: RuleContext, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const call = ctx.call;
  const scope = (call as ToolCall & { base?: ToolCall }).base ?? call;
  let slot = memo.get(scope);
  if (!slot || slot.now !== ctx.now) memo.set(scope, (slot = { now: ctx.now, m: new Map() }));
  const m = slot.m;
  const key = `${tool} ${JSON.stringify(args)}`;
  let pr = m.get(key);
  if (!pr) {
    pr = call(tool, args);
    m.set(key, pr);
    pr.catch(() => m.delete(key));
  }
  return pr;
}

function method(kind: IndicatorKind, params: P): Evidence["method"] {
  return { name: "indicator_threshold", version: "1.0", params: { indicator: kind, ...params } };
}

const today = (ctx: RuleContext) => ctx.now.slice(0, 10);
const sign = (v: number) => (v >= 0 ? "+" : "−");
const abs1 = (v: number) => Math.abs(v).toFixed(1);

function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- sea ice -----------------------------------------------------------------------------

async function seaIce(ctx: RuleContext, p: P) {
  const pole = p.hemisphere === "antarctic" ? "south" : "north";
  const r = (await shared(ctx, "sea_ice", { pole })) as SeaIceResult;
  const c = r.climatologyForDay;
  if (!c || r.latest?.v == null) throw new Error("sea_ice: no climatology match for the latest day");
  return { r, c, label: pole === "north" ? "Arctic" : "Antarctic", below: r.latest.v < c.p10 };
}

async function detectSeaIce(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const { r, c, label, below } = await seaIce(ctx, p);
  if (!below) return null;
  const under = round(c.p10 - r.latest.v, 3);
  const values = { extent_mkm2: r.latest.v, p10_mkm2: c.p10, anomaly_mkm2: r.anomalyVsAverage ?? round(r.latest.v - c.average, 3), below_p10_mkm2: under };
  const observedAt = dayStart(r.latest.t);
  return {
    title: `${label} sea ice is below the lowest tenth of past years — ${r.latest.v.toFixed(2)} M km², ${under.toFixed(2)} M km² under the p10 line`,
    summary:
      `On ${r.latest.t} ${label} sea-ice extent was ${r.latest.v} million km². For this day of the year, 9 in 10 years of 1981–2010 had more ice (the 10th percentile is ${c.p10} M km²); ` +
      `the 1981–2010 average is ${c.average} M km², so today is ${Math.abs(values.anomaly_mkm2)} M km² ${values.anomaly_mkm2 < 0 ? "below" : "above"} average. ` +
      `A second, later day still below the line confirms it is not a one-day blip.`,
    observedAt,
    evidence: [
      {
        id: `nsidc-${r.pole}-extent-${r.latest.t}`,
        kind: "series",
        source: "nsidc-g02135-v4",
        datetime: observedAt,
        href: "https://nsidc.org/data/g02135",
        method: method("sea_ice", { hemisphere: p.hemisphere }),
        summary: `${label} daily extent ${r.latest.v} M km² on ${r.latest.t}; 1981–2010 p10 for day ${c.doy} = ${c.p10} M km², average ${c.average} M km².`,
        values,
      },
    ],
    values,
    notes: [`Dataset: NSIDC Sea Ice Index v4 (G02135), daily extent vs the 1981–2010 day-of-year climatology (5-day trailing mean, passive microwave). Window: ${r.latest.t}.`],
  };
}

async function confirmSeaIce(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const { r, c, label, below } = await seaIce(ctx, p);
  if (!below || dayStart(r.latest.t) <= c0.observedAt) return null;
  return {
    independence: "revisit",
    signal: {
      id: `nsidc-${r.pole}-extent-${r.latest.t}-persist`,
      kind: "series",
      source: "nsidc-g02135-v4",
      datetime: dayStart(r.latest.t),
      href: "https://nsidc.org/data/g02135",
      method: method("sea_ice", { hemisphere: p.hemisphere }),
      summary: `${label} extent still below p10 on a later day: ${r.latest.v} M km² vs p10 ${c.p10} M km² (${r.latest.t}).`,
      values: { extent_mkm2: r.latest.v, p10_mkm2: c.p10, below_p10_mkm2: round(c.p10 - r.latest.v, 3) },
    },
  };
}

// ---- sea-surface temperature anomaly (marine heatwave + ENSO confirmation) ---------------

export interface SstAnomaly {
  latest: { t: string; sst: number; clim: number; anomaly: number };
  /** Consecutive most-recent days with anomaly ≥ threshold. */
  streak: number;
  wholeWindow: boolean;
  maxAnomaly: number;
  /** Mean anomaly over the whole recent window. */
  meanAnomaly: number;
  gridCell: { lat: number; lon: number };
  window: { from: string; to: string };
  baseline: { from: string; to: string; points: number };
  source: string;
}

function doy(date: string): number {
  const d = Date.parse(`${date}T00:00:00Z`);
  return Math.floor((d - Date.UTC(Number(date.slice(0, 4)), 0, 1)) / 86_400_000) + 1;
}

/**
 * Pure: SST anomalies of `recent` against a day-of-year climatology built from `base` (±15
 * days, circular), plus the trailing streak at or above `threshold`. Null when the baseline
 * is too thin (< 8 points) for the latest day.
 */
export function sstAnomalies(recent: { t: string; v: number | null }[], base: { t: string; v: number | null }[], threshold: number) {
  const basePts = base.filter((b): b is { t: string; v: number } => b.v !== null).map((b) => ({ d: doy(b.t), v: b.v }));
  const climFor = (date: string): number | null => {
    const d = doy(date);
    const near = basePts.filter((b) => Math.min(Math.abs(b.d - d), 366 - Math.abs(b.d - d)) <= 15);
    return near.length >= 8 ? near.reduce((s, b) => s + b.v, 0) / near.length : null;
  };
  const rows = recent
    .filter((r): r is { t: string; v: number } => r.v !== null)
    .map((r) => {
      const c = climFor(r.t);
      return c === null ? null : { t: r.t, sst: r.v, clim: round(c, 2), anomaly: round(r.v - c, 2) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const latest = rows[rows.length - 1];
  if (!latest) return null;
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i]!.anomaly >= threshold; i--) streak++;
  return {
    latest,
    streak,
    /** The streak spans every day fetched: the heat started before the window. */
    wholeWindow: streak === rows.length,
    maxAnomaly: Math.max(...rows.slice(rows.length - Math.max(1, streak)).map((r) => r.anomaly)),
    meanAnomaly: round(rows.reduce((s, r) => s + r.anomaly, 0) / rows.length, 2),
  };
}

async function sstAnomaly(ctx: RuleContext, pt: { lat: number; lon: number }, recentDays: number, baselineYears: number, threshold: number): Promise<SstAnomaly> {
  const t = today(ctx);
  const y = Number(t.slice(0, 4));
  const baseArgs = { lat: pt.lat, lon: pt.lon, start: `${y - baselineYears}-01-01`, end: `${y - 1}-12-31` };
  const [recent, base] = (await Promise.all([
    shared(ctx, "ocean_temp", { lat: pt.lat, lon: pt.lon, start: addDays(t, -recentDays) }),
    shared(ctx, "ocean_temp", baseArgs),
  ])) as [OceanTempResult, OceanTempResult];
  const a = sstAnomalies(recent.series, base.series, threshold);
  if (!a) throw new Error(`ocean_temp: baseline too thin for a climatology at ${pt.lat}, ${pt.lon}`);
  return { ...a, gridCell: recent.gridCell, window: { from: recent.window.from, to: recent.window.to }, baseline: { from: base.window.from, to: base.window.to, points: base.series.length }, source: recent.source };
}

async function detectHeatwave(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const pt = pointOf(ctx, p);
  const minA = num(p.minAnomalyC, 1.5);
  const minDays = num(p.minDays, 5);
  const a = await sstAnomaly(ctx, pt, 60, num(p.baselineYears, 10), minA);
  if (a.streak < minDays) return null;
  const values = { sst_c: a.latest.sst, climatology_c: a.latest.clim, anomaly_c: a.latest.anomaly, days_over: a.streak, max_anomaly_c: a.maxAnomaly, threshold_c: minA };
  const observedAt = dayStart(a.latest.t);
  return {
    title: `Marine heatwave at ${ctx.aoi.name}: the sea surface is ${abs1(a.latest.anomaly)} °C warmer than normal, ${a.wholeWindow ? "at least " : ""}${a.streak} days running`.slice(0, 200),
    summary:
      `Sea-surface temperature at ${a.gridCell.lat}, ${a.gridCell.lon} was ${a.latest.sst} °C on ${a.latest.t}, ${a.latest.anomaly} °C above the same time of year in ${a.baseline.from.slice(0, 4)}–${a.baseline.to.slice(0, 4)} (${a.latest.clim} °C). ` +
      `It has been at least ${minA} °C above normal for ${a.wholeWindow ? `all ${a.streak} days fetched (it began earlier)` : `${a.streak} consecutive days`} (peak ${a.maxAnomaly} °C). Heat this persistent stresses corals, kelp and fisheries; a later day still this warm confirms it.`,
    observedAt,
    evidence: [
      {
        id: `oisst-${ctx.aoi.id}-${a.latest.t}`,
        kind: "series",
        source: "noaa-oisst-v2.1",
        datetime: observedAt,
        href: "https://www.ncei.noaa.gov/products/optimum-interpolation-sst",
        method: method("marine_heatwave", { minAnomalyC: minA, minDays, baselineYears: num(p.baselineYears, 10), lat: pt.lat, lon: pt.lon }),
        summary: `OISST ${a.window.from}…${a.window.to} at ${a.gridCell.lat}, ${a.gridCell.lon}: ${a.streak} trailing days ≥ +${minA} °C vs a ±15-day climatology from ${a.baseline.points} points.`,
        values,
      },
    ],
    values,
    geometry: pointGeom(a.gridCell.lat, a.gridCell.lon),
    notes: [`Dataset: NOAA OISST v2.1 (0.25°, daily, satellite + in-situ) via ERDDAP. Window ${a.window.from}…${a.window.to}; climatology = same ±15 days of ${a.baseline.from.slice(0, 4)}–${a.baseline.to.slice(0, 4)}.`],
  };
}

async function confirmHeatwave(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const pt = pointOf(ctx, p);
  const minA = num(p.minAnomalyC, 1.5);
  const a = await sstAnomaly(ctx, pt, 60, num(p.baselineYears, 10), minA);
  if (a.latest.anomaly < minA || dayStart(a.latest.t) <= c0.observedAt) return null;
  return {
    independence: "revisit",
    signal: {
      id: `oisst-${ctx.aoi.id}-${a.latest.t}-persist`,
      kind: "series",
      source: "noaa-oisst-v2.1",
      datetime: dayStart(a.latest.t),
      href: "https://www.ncei.noaa.gov/products/optimum-interpolation-sst",
      method: method("marine_heatwave", { minAnomalyC: minA, lat: pt.lat, lon: pt.lon }),
      summary: `Still ${a.latest.anomaly} °C above normal on ${a.latest.t} (${a.streak} days running).`,
      values: { anomaly_c: a.latest.anomaly, days_over: a.streak },
    },
  };
}

// ---- river discharge ---------------------------------------------------------------------

async function river(ctx: RuleContext, p: P) {
  const pt = pointOf(ctx, p);
  const t = today(ctx);
  const r = (await shared(ctx, "river_discharge", { lat: pt.lat, lon: pt.lon, start: addDays(t, -Math.round(num(p.years, 10) * 365)) })) as RiverResult;
  if (r.latest?.v == null || !r.stats.mean) throw new Error("river_discharge: no latest value or period mean");
  const ratio = r.latestVsMean ?? round(r.latest.v / r.stats.mean, 2);
  // Same calendar month in the other years of the window: how unusual is it for the season?
  const month = r.latest.t.slice(5, 7);
  const year = r.latest.t.slice(0, 4);
  const same = r.series.filter((s) => s.v !== null && s.t.slice(5, 7) === month && s.t.slice(0, 4) !== year).map((s) => s.v!);
  const seasonalMean = same.length >= 3 ? same.reduce((a, b) => a + b, 0) / same.length : null;
  return { pt, r, ratio, seasonalRatio: seasonalMean ? round(r.latest.v / seasonalMean, 2) : null, latest: r.latest as { t: string; v: number }, mean: r.stats.mean };
}

async function detectRiver(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const k = num(p.ratio, 2);
  const { pt, r, ratio, seasonalRatio, latest, mean } = await river(ctx, p);
  if (ratio < k) return null;
  const minSeasonal = typeof p.minSeasonalRatio === "number" ? p.minSeasonalRatio : null;
  if (minSeasonal !== null && (seasonalRatio === null || seasonalRatio < minSeasonal)) return null;
  const values: Record<string, number> = { discharge_m3s: latest.v, mean_m3s: round(mean, 1), ratio, threshold_ratio: k };
  if (seasonalRatio !== null) values.seasonal_ratio = seasonalRatio;
  const observedAt = dayStart(latest.t);
  return {
    title: `${ctx.aoi.name} is running high: ${Math.round(latest.v).toLocaleString("en-US")} m³/s, ${ratio}× its ${num(p.years, 10)}-year average`.slice(0, 200),
    summary:
      `Modelled river discharge at ${pt.lat}, ${pt.lon} was ${latest.v} m³/s on ${latest.t} — ${ratio}× the ${r.window.from.slice(0, 4)}–${r.window.to.slice(0, 4)} mean of ${round(mean, 1)} m³/s (threshold ${k}×). ` +
      (seasonalRatio !== null ? `Against the same month in other years it is ${seasonalRatio}×${seasonalRatio < 1.2 ? " — high water for the season, not above it" : ""}. ` : "") +
      `A flood report nearby (NASA EONET) or a later day still this high confirms it.`,
    observedAt,
    evidence: [
      {
        id: `glofas-${ctx.aoi.id}-${latest.t}`,
        kind: "series",
        source: "glofas-v4",
        datetime: observedAt,
        href: "https://open-meteo.com/en/docs/flood-api",
        method: method("river_discharge", { ratio: k, years: num(p.years, 10), lat: pt.lat, lon: pt.lon, ...(minSeasonal !== null ? { minSeasonalRatio: minSeasonal } : {}) }),
        summary: `GloFAS discharge ${latest.v} m³/s on ${latest.t}; period mean ${round(mean, 1)} m³/s (${r.window.from}…${r.window.to}).`,
        values,
      },
    ],
    values,
    geometry: pointGeom(pt.lat, pt.lon),
    notes: [`Dataset: GloFAS river discharge (hydrological model, ~5 km) via Open-Meteo. Window ${r.window.from}…${r.window.to}; mean over the whole window, all seasons.`],
    tags: ["high-water"],
  };
}

async function confirmRiver(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const pt = pointOf(ctx, p);
  const km = num(p.floodKm, 200);
  const box: [number, number, number, number] = ringBBox([pt.lon - 0.01, pt.lat - 0.01, pt.lon + 0.01, pt.lat + 0.01], km);
  const ev = (await shared(ctx, "events", { category: "floods", status: "all", bbox: box, days: 30, limit: 50 })) as EventsResult;
  const flood = ev.events.find((e) => e.coordinates && kmBetween(pt, { lon: e.coordinates[0], lat: e.coordinates[1] }) <= km);
  if (flood) {
    const d = kmBetween(pt, { lon: flood.coordinates![0], lat: flood.coordinates![1] });
    return {
      independence: "provider",
      signal: {
        id: flood.id,
        kind: "alert",
        source: "nasa-eonet",
        datetime: flood.lastDate && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(flood.lastDate) ? flood.lastDate : ctx.now.replace(/\.\d+Z$/, "Z"),
        href: flood.link?.startsWith("http") ? flood.link : undefined,
        method: method("river_discharge", { floodKm: km }),
        summary: `EONET flood event "${flood.title}" ${round(d, 0)} km from the gauge point.`.slice(0, 2000),
        values: { flood_km: round(d, 1) },
      },
    };
  }
  const { ratio, seasonalRatio, latest } = await river(ctx, p);
  const minSeasonal = typeof p.minSeasonalRatio === "number" ? p.minSeasonalRatio : null;
  if (ratio < num(p.ratio, 2) || (minSeasonal !== null && (seasonalRatio === null || seasonalRatio < minSeasonal)) || dayStart(latest.t) <= c0.observedAt) return null;
  return {
    independence: "revisit",
    signal: {
      id: `glofas-${ctx.aoi.id}-${latest.t}-persist`,
      kind: "series",
      source: "glofas-v4",
      datetime: dayStart(latest.t),
      href: "https://open-meteo.com/en/docs/flood-api",
      method: method("river_discharge", { ratio: num(p.ratio, 2), lat: pt.lat, lon: pt.lon }),
      summary: `Still ${ratio}× the period mean on ${latest.t} (${latest.v} m³/s).`,
      values: { discharge_m3s: latest.v, ratio },
    },
  };
}

// ---- air quality -------------------------------------------------------------------------

/** Pure: trailing run of full days (≥ 18 valid hours) with PM2.5 mean above `guideline`. */
export function pm25Streak(daily: { t: string; v: number; hours: number }[], guideline: number) {
  const full = daily.filter((d) => d.hours >= 18);
  const last = full[full.length - 1];
  if (!last) return null;
  let n = 0;
  for (let i = full.length - 1; i >= 0 && full[i]!.v > guideline; i--) n++;
  const run = full.slice(full.length - n);
  return { last, days: n, max: run.length ? Math.max(...run.map((d) => d.v)) : last.v, mean: run.length ? round(run.reduce((s, d) => s + d.v, 0) / run.length, 1) : last.v };
}

async function air(ctx: RuleContext, p: P) {
  const pt = pointOf(ctx, p);
  const r = (await shared(ctx, "air_quality", { lat: pt.lat, lon: pt.lon, pastDays: 7 })) as AirResult;
  if (!r.pm25Daily) throw new Error("air_quality: result has no pm25Daily (tool too old?)");
  const s = pm25Streak(r.pm25Daily, num(p.guideline, WHO_PM25));
  if (!s) throw new Error("air_quality: no full day of PM2.5 data");
  return { pt, s };
}

async function detectAir(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const minDays = num(p.minDays, 3);
  const g = num(p.guideline, WHO_PM25);
  const { pt, s } = await air(ctx, p);
  if (s.days < minDays) return null;
  const values = { pm25_daily_ugm3: s.last.v, days_over: s.days, guideline_ugm3: g, pm25_mean_ugm3: s.mean, pm25_max_ugm3: s.max, times_guideline: round(s.last.v / g, 1) };
  const observedAt = dayStart(s.last.t);
  return {
    title: `${ctx.aoi.name}: fine-particle pollution above the WHO limit ${s.days} days running — ${s.last.v} µg/m³, ${values.times_guideline}× the guideline`.slice(0, 200),
    summary:
      `Modelled PM2.5 near ${pt.lat}, ${pt.lon} averaged ${s.last.v} µg/m³ on ${s.last.t}; every one of the last ${s.days} full days was above the WHO 24-hour guideline of ${g} µg/m³ ` +
      `(mean ${s.mean}, worst day ${s.max}). Fine particles reach deep into the lungs; a later day still above the limit confirms the episode.`,
    observedAt,
    evidence: [
      {
        id: `cams-pm25-${ctx.aoi.id}-${s.last.t}`,
        kind: "series",
        source: "cams-global",
        datetime: observedAt,
        href: "https://open-meteo.com/en/docs/air-quality-api",
        method: method("air_quality", { minDays, guideline: g, lat: pt.lat, lon: pt.lon }),
        summary: `CAMS PM2.5 daily means (UTC, ≥ 18 h): ${s.days} trailing day(s) above ${g} µg/m³, latest ${s.last.t} = ${s.last.v}.`,
        values,
      },
    ],
    values,
    geometry: pointGeom(pt.lat, pt.lon),
    notes: [`Dataset: Copernicus CAMS global forecast/analysis (~40 km) via Open-Meteo, hourly PM2.5 averaged to UTC days; last 7 days, forecast hours excluded.`],
  };
}

async function confirmAir(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const g = num(p.guideline, WHO_PM25);
  const { pt, s } = await air(ctx, p);
  if (s.days < 1 || dayStart(s.last.t) <= c0.observedAt) return null;
  return {
    independence: "revisit",
    signal: {
      id: `cams-pm25-${ctx.aoi.id}-${s.last.t}-persist`,
      kind: "series",
      source: "cams-global",
      datetime: dayStart(s.last.t),
      href: "https://open-meteo.com/en/docs/air-quality-api",
      method: method("air_quality", { guideline: g, lat: pt.lat, lon: pt.lon }),
      summary: `Still above ${g} µg/m³ on ${s.last.t}: ${s.last.v} µg/m³ (${s.days} days running).`,
      values: { pm25_daily_ugm3: s.last.v, days_over: s.days },
    },
  };
}

// ---- ENSO --------------------------------------------------------------------------------

async function detectEnso(ctx: RuleContext, _p: P): Promise<Candidate | null> {
  const r = (await shared(ctx, "enso", { months: 36 })) as EnsoResult;
  if (!r.meetsEventDefinition || r.phase === "Neutral") return null;
  const dir = r.latest.oni >= 0 ? 1 : -1;
  const start = r.series[r.series.length - r.consecutiveSeasons]?.t ?? `${r.latest.year}`;
  const end = r.series[r.series.length - 1]?.t ?? `${r.latest.year}`;
  const values = { oni_c: r.latest.oni, consecutive_seasons: r.consecutiveSeasons, phase_sign: dir };
  const observedAt = dayStart(`${end.slice(0, 7)}-01`.slice(0, 10));
  return {
    title: `${r.phase} is here: the Pacific has been ${dir > 0 ? "warmer" : "cooler"} than normal for ${r.consecutiveSeasons} seasons in a row (ONI ${sign(r.latest.oni)}${Math.abs(r.latest.oni)} °C)`.slice(0, 200),
    summary:
      `NOAA's Oceanic Niño Index was ${sign(r.latest.oni)}${Math.abs(r.latest.oni)} °C for ${r.latest.season} ${r.latest.year}, making ${r.consecutiveSeasons} overlapping 3-month seasons in a row beyond ${dir > 0 ? "+" : "−"}0.5 °C — ` +
      `NOAA's definition of ${r.phase === "El Niño" ? "an El Niño" : "a La Niña"} event. ${r.phase === "El Niño" ? "El Niño years tend to bring drought to Australia, Indonesia and southern Africa, heavier rain to Peru, and coral bleaching." : "La Niña years tend to bring drought to the Horn of Africa and the southern US and floods to Australia and Southeast Asia."} ` +
      `Satellite sea-surface temperature in the Niño3.4 region pointing the same way confirms it.`,
    observedAt,
    evidence: [
      {
        // One id per ONI release, so monthly updates keep the one case per event alive.
        id: `cpc-oni-${dir > 0 ? "elnino" : "lanina"}-${start}-${end}`,
        kind: "series",
        source: "noaa-cpc-oni",
        datetime: observedAt,
        href: "https://origin.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php",
        method: method("enso", {}),
        summary: `ONI ${r.consecutiveSeasons} consecutive seasons beyond ±0.5 °C, ${start}…${end} (season midpoints); latest ${r.latest.season} ${r.latest.year} = ${r.latest.oni} °C.`,
        values,
      },
    ],
    values,
    geometry: { type: "Polygon", coordinates: [[[-170, -5], [-120, -5], [-120, 5], [-170, 5], [-170, -5]]] },
    notes: [`Dataset: NOAA CPC ONI (ERSSTv5 Niño3.4, 3-month running means, 1991–2020 base). Event run ${start}…${end}.`],
    tags: [dir > 0 ? "el-nino" : "la-nina"],
  };
}

async function confirmEnso(ctx: RuleContext, p: P, c0: Pick<Candidate, "values" | "observedAt">): Promise<Confirmation | null> {
  const dir = num(c0.values.phase_sign, 0);
  const need = num(p.confirmAnomalyC, 0.3);
  const a = await sstAnomaly(ctx, NINO34, 90, num(p.baselineYears, 10), Number.POSITIVE_INFINITY);
  if (dir === 0 || a.meanAnomaly * dir < need) return null;
  return {
    independence: "method",
    signal: {
      id: `oisst-nino34-${a.window.from}-${a.window.to}`,
      kind: "series",
      source: "noaa-oisst-v2.1",
      datetime: dayStart(a.window.to),
      href: "https://www.ncei.noaa.gov/products/optimum-interpolation-sst",
      method: method("enso", { confirmAnomalyC: need, lat: NINO34.lat, lon: NINO34.lon }),
      summary: `OISST at the Niño3.4 centre (${a.gridCell.lat}, ${a.gridCell.lon}) averaged ${a.meanAnomaly} °C vs the same season of ${a.baseline.from.slice(0, 4)}–${a.baseline.to.slice(0, 4)}, ${a.window.from}…${a.window.to}.`,
      values: { nino34_point_anomaly_c: a.meanAnomaly },
    },
  };
}

// ---- earthquakes -------------------------------------------------------------------------

async function quakes(ctx: RuleContext, p: P) {
  // Look back to the last successful sweep (+1 day of overlap), bounded to [1, 30] days.
  const sinceDays = ctx.since ? Math.ceil((Date.parse(ctx.now) - Date.parse(ctx.since)) / 86_400_000) + 1 : num(p.days, 7);
  const days = Math.max(1, Math.min(30, sinceDays));
  const minMag = num(p.minMagnitude, 7);
  const r = (await shared(ctx, "quakes", { bbox: ctx.aoi.bbox, minMagnitude: minMag, days, limit: 50 })) as QuakesResult;
  const hits = r.quakes.filter((q) => (q.mag ?? 0) >= minMag).sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0));
  return { r, hits, minMag, days };
}

async function detectQuake(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const { hits, minMag, days } = await quakes(ctx, p);
  const top = hits[0];
  if (!top || top.mag === null) return null;
  const values: Record<string, number> = { magnitude: top.mag, count: hits.length, tsunami: top.tsunami ? 1 : 0 };
  if (top.depthKm !== null) values.depth_km = top.depthKm;
  if (typeof top.sig === "number") values.sig = top.sig;
  const observedAt = top.time.replace(/\.\d+Z$/, "Z");
  return {
    title: `M${top.mag} earthquake — ${top.place || ctx.aoi.name}`.slice(0, 200),
    summary:
      `A magnitude ${top.mag} earthquake struck ${top.place || `inside ${ctx.aoi.name}`} at ${observedAt}${top.depthKm !== null ? `, ${top.depthKm} km deep` : ""}` +
      `${top.tsunami ? "; USGS flagged tsunami potential" : ""}${top.alert ? `; PAGER alert level ${top.alert}` : ""}. ` +
      (hits.length > 1 ? `${hits.length} quakes of M${minMag}+ in the region in the last ${days} days. ` : "") +
      `Confirmation is USGS's own human review of the event — same provider, different check.`,
    observedAt,
    evidence: hits.slice(0, 10).map((q) => ({
      id: q.id,
      kind: "record" as const,
      source: "usgs-comcat",
      datetime: q.time.replace(/\.\d+Z$/, "Z"),
      href: q.url.startsWith("http") ? q.url : undefined,
      method: method("quake", { minMagnitude: minMag, days }),
      summary: `M${q.mag} ${q.place}${q.depthKm !== null ? `, ${q.depthKm} km deep` : ""}; USGS status ${q.status ?? "unknown"}.`,
      values: { magnitude: q.mag ?? 0, ...(q.depthKm !== null ? { depth_km: q.depthKm } : {}), ...(typeof q.sig === "number" ? { sig: q.sig } : {}) },
    })),
    values,
    geometry: pointGeom(top.lat, top.lon),
    notes: [`Dataset: USGS ComCat (FDSN event service). Window: last ${days} day(s), M ≥ ${minMag}, inside the AOI box.`],
    tags: top.tsunami ? ["tsunami-flag"] : [],
  };
}

async function confirmQuake(ctx: RuleContext, p: P, c0: Pick<Candidate, "evidence">): Promise<Confirmation | null> {
  const { hits } = await quakes(ctx, p);
  const minSig = num(p.minSig, 600);
  const ids = new Set(c0.evidence.map((e) => e.id));
  const q = hits.find((h) => ids.has(h.id) && h.status === "reviewed" && (h.sig ?? 0) >= minSig);
  if (!q) return null;
  return {
    independence: "method",
    signal: {
      id: `${q.id}-reviewed`,
      kind: "record",
      source: "usgs-comcat-review",
      datetime: q.time.replace(/\.\d+Z$/, "Z"),
      href: q.url.startsWith("http") ? q.url : undefined,
      method: method("quake", { minSig }),
      summary: `USGS reviewed event ${q.id} (M${q.mag}); significance ${q.sig} ≥ ${minSig}. Same provider as the detection — a human review, not an independent network.`,
      values: { sig: q.sig ?? 0, reviewed: 1 },
    },
  };
}

// ---- the rule ------------------------------------------------------------------------------

const DETECT: Record<IndicatorKind, (ctx: RuleContext, p: P) => Promise<Candidate | null>> = {
  sea_ice: detectSeaIce,
  marine_heatwave: detectHeatwave,
  river_discharge: detectRiver,
  air_quality: detectAir,
  enso: detectEnso,
  quake: detectQuake,
};

/** Blind-spot line prefix per indicator ("All:" lines apply to every indicator). */
const BLIND_PREFIX: Record<IndicatorKind, string> = {
  sea_ice: "Sea ice:",
  marine_heatwave: "Marine heatwave:",
  river_discharge: "River:",
  air_quality: "Air quality:",
  enso: "ENSO:",
  quake: "Earthquakes:",
};

/**
 * Pure: the blind spots that apply to one indicator — its own lines plus the "All:" lines. Also
 * used render-side for older ledger entries, which carry the full list for every indicator.
 * Unknown/missing indicator → the list unchanged (never hide a caveat we cannot attribute).
 */
export function indicatorBlindSpots(spots: readonly string[], indicator: unknown): string[] {
  const own = typeof indicator === "string" ? BLIND_PREFIX[indicator as IndicatorKind] : undefined;
  if (!own) return [...spots];
  const known = Object.values(BLIND_PREFIX);
  return spots.filter((s) => s.startsWith(own) || !known.some((k) => s.startsWith(k)));
}

export const indicatorThreshold = defineRule({
  name: "indicator_threshold",
  version: "1.0",
  tier: 1,
  description: "A planetary indicator (sea ice, sea temperature, river flow, air quality, ENSO, earthquakes) crossed a published threshold at a watched place.",
  blindSpots: [
    "Sea ice: extent is area with ≥ 15% ice, not volume or thickness — thin new ice counts the same as old multi-year ice.",
    "Sea ice: passive microwave misreads melt ponds and coastal cells; the p10 line is 1981–2010, so a warming world crosses it more often.",
    "Marine heatwave: one 0.25° cell stands for a whole reef or sea; the baseline is only the previous 10 years (already warm), sampled every ~10 days.",
    "Marine heatwave: OISST lags ~2 weeks and sees the surface skin only — heat below a few metres, where corals live, is not measured.",
    "River: GloFAS discharge is modelled, not gauged; the cell may miss the main channel, and dams, diversions and levees are poorly represented.",
    "River: the 2× line is against the all-season mean, so monsoon and snowmelt rivers cross it every peak season unless minSeasonalRatio also requires it to be high for the month.",
    "Air quality: CAMS is a ~40 km model, not a monitor; it smooths city hotspots and can misplace dust and smoke plumes.",
    "Air quality: PM2.5 only — ozone, NO₂ and indoor air are not judged, and the WHO guideline is a health line, not a legal limit.",
    "ENSO: ONI is a 3-month running mean released monthly, so an event is declared months after it starts; the confirmation is one OISST point, not the Niño3.4 box.",
    "Earthquakes: magnitude says nothing about damage — depth, building codes and population decide that; USGS review is the same provider checking its own event.",
    "Earthquakes: a sweep more than 30 days late misses older events; only the strongest quake per region per case window leads the case.",
    "All: global zero-key feeds can go stale or be revised; a threshold crossing is a signal to look, not a verdict on cause or impact.",
  ],
  blindSpotsFor(params) {
    return indicatorBlindSpots(this.blindSpots, params.indicator);
  },
  requires: [],
  ringKm: 0,
  defaults: {},

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const { kind, p } = indicatorParams(ctx.params);
    return DETECT[kind](ctx, p);
  },

  async confirm(ctx: RuleContext, c): Promise<Confirmation | null> {
    const { kind, p } = indicatorParams(ctx.params);
    switch (kind) {
      case "sea_ice":
        return confirmSeaIce(ctx, p, c);
      case "marine_heatwave":
        return confirmHeatwave(ctx, p, c);
      case "river_discharge":
        return confirmRiver(ctx, p, c);
      case "air_quality":
        return confirmAir(ctx, p, c);
      case "enso":
        return confirmEnso(ctx, p, c);
      case "quake":
        return confirmQuake(ctx, p, c);
    }
  },
});
