// improvement@1.0 — cases that open when something gets BETTER. "A watch, not a complaint
// feed." Same evidence standard as every other rule: a detector, an independent or later
// confirmation, and plain words about what it cannot see. Every case is tagged `improvement`
// (the site shows it as good news). One rule, parameterised per AOI by `params.kind`:
//
//   forest_recovery    GFW integrated alerts (ha) in the last `days` ≤ maxShareOfBaseline × the same
//                      window a year earlier, AND the AOI's alert density is below its ring
//                      → confirm: the next `confirmDays` window is still low (revisit), else a
//                        Sentinel-2 median NDVI that held or rose year on year (sensor; CDSE —
//                        deferred, not skipped, when that quota is spent)
//   flaring_decline    VNF annual flared volume in the box fell ≥ minDropPct between the last two
//                      VNF years AND FIRMS night-time hot detections are lower than a year ago
//                      → confirm: the next window is still lower than a year earlier (revisit)
//   bleaching_relief   NOAA CRW Bleaching Alert Area was ≥ minPeakLevel in the last `days` and has
//                      been 0 ("No stress") for ≥ minClearDays → confirm: still 0 on a later day
//   air_quality_clean  CAMS PM2.5: the last 7 full days average below the WHO guideline after ≥ 7
//                      days above it → confirm: a later day's 7-day mean is still below
//   fires_absent       a protected area with fire clusters in the same weeks last year has none
//                      this season so far → confirm: still none on a later sweep
//
// Year-on-year FIRMS comparisons use VIIRS NOAA-21 NRT for BOTH years: it is the only VIIRS NRT
// feed FIRMS keeps back to 2024 (NOAA-20/S-NPP NRT hold ~3 months; their SP archive lags ~3).

import type { Evidence, Geometry } from "../../ledger/schema.js";
import { EOG_VNF_HREF, FIRMS_HREF, VNF_CREDIT, windowChunks } from "../../clients/vnf.js";
import type { FireDetection } from "../../types.js";
import { addDays } from "../../util.js";
import { flarePlace } from "./flaring.js";
import { fitRing } from "./forestLoss.js";
import { bboxArea, dayStart, defineRule, num, ringBBox, type Candidate, type Confirmation, type RuleContext, type ToolCall } from "./types.js";

export const IMPROVEMENT_KINDS = ["forest_recovery", "flaring_decline", "bleaching_relief", "air_quality_clean", "fires_absent"] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];

export const IMPROVEMENT_DEFAULTS: Record<ImprovementKind, Record<string, unknown>> = {
  // lagDays: GFW alerts arrive 1–2 weeks late, so both windows end lagDays before the sweep —
  // otherwise the fresh window is under-counted and every AOI looks like it recovered.
  forest_recovery: { days: 90, lagDays: 14, minConfidence: "high", maxShareOfBaseline: 0.3, minBaselineHa: 20, confirmDays: 30, ndviTolerance: 0.02, minValidPct: 60 },
  flaring_decline: { days: 30, minDropPct: 30, minBaselineBcm: 0.05, minFirmsDropPct: 10, minFrp: 5, source: "VIIRS_NOAA21_NRT" },
  bleaching_relief: { days: 90, minPeakLevel: 1, minClearDays: 14 },
  air_quality_clean: { guideline: 15, window: 7, minDaysAbove: 7 },
  fires_absent: { days: 30, minFrp: 20, clusterMin: 3, cellDeg: 0.05, minHotLastYear: 10, source: "VIIRS_NOAA21_NRT", aliveRingKm: 100, revisitDays: 5 },
};

const TAGS = ["improvement"];
const BAA_LABEL = ["No stress", "Bleaching Watch", "Bleaching Warning", "Alert Level 1", "Alert Level 2"];
const GFW_HREF = "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts";
const CRW_HREF = "https://coralreefwatch.noaa.gov/product/5km/";
const CAMS_HREF = "https://open-meteo.com/en/docs/air-quality-api";

type P = Record<string, unknown>;

/** The kind an AOI asks for, with its defaults merged under the AOI's params. */
export function improvementParams(params: P): { kind: ImprovementKind; p: P } {
  const kind = params.kind as ImprovementKind;
  if (!IMPROVEMENT_KINDS.includes(kind)) throw new Error(`improvement: params.kind must be one of ${IMPROVEMENT_KINDS.join(", ")} (got ${JSON.stringify(params.kind)})`);
  return { kind, p: { ...IMPROVEMENT_DEFAULTS[kind], ...params } };
}

function method(kind: ImprovementKind, params: P): Evidence["method"] {
  return { name: "improvement", version: "1.0", params: { kind, ...params } };
}

const today = (ctx: RuleContext) => ctx.now.slice(0, 10);
const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;
const pct = (v: number) => Math.round(v);
const pointGeom = (lat: number, lon: number): Geometry => ({ type: "Point", coordinates: [round(lon, 3), round(lat, 3)] });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(dayStart(b)) - Date.parse(dayStart(a))) / 86_400_000);

/** The point an AOI is about: explicit params.lat/lon, else the bbox centre. */
function pointOf(ctx: RuleContext, p: P): { lat: number; lon: number } {
  const [w, s, e, n] = ctx.aoi.bbox;
  return { lat: num(p.lat, round((s + n) / 2, 3)), lon: num(p.lon, round((w + e) / 2, 3)) };
}

// One pull per tool+args per sweep (detect and confirm share it). Scoped to the sweep-level
// caller the kernel exposes as `base`, and to the sweep's `now`.
const memo = new WeakMap<ToolCall, { now: string; m: Map<string, Promise<unknown>> }>();
function shared(ctx: RuleContext, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const scope = (ctx.call as ToolCall & { base?: ToolCall }).base ?? ctx.call;
  let slot = memo.get(scope);
  if (!slot || slot.now !== ctx.now) memo.set(scope, (slot = { now: ctx.now, m: new Map() }));
  const key = `${tool} ${JSON.stringify(args)}`;
  let pr = slot.m.get(key);
  if (!pr) {
    pr = ctx.call(tool, args);
    const m = slot.m;
    m.set(key, pr);
    pr.catch(() => m.delete(key));
  }
  return pr;
}

// ---- forest_recovery -----------------------------------------------------------------------

interface AlertsResult {
  window: { from: string; to: string };
  alertCount: number;
  areaHa: number;
}
interface CompareResult {
  validPctA: number;
  validPctB: number;
  delta: { meanChange: number };
  provenanceA?: { scenes?: string[] };
  provenanceB?: { scenes?: string[] };
}

async function detectForest(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const days = num(p.days, 90);
  const end = addDays(today(ctx), -num(p.lagDays, 14));
  const endLy = addDays(end, -365);
  const base = { bbox: ctx.aoi.bbox, days, minConfidence: String(p.minConfidence) };
  const now = (await ctx.call("forest_alerts", { ...base, endDate: end })) as AlertsResult;
  const ly = (await ctx.call("forest_alerts", { ...base, endDate: endLy })) as AlertsResult;
  if (ly.areaHa < num(p.minBaselineHa, 20)) return null; // nothing much to recover from
  const share = now.areaHa / ly.areaHa;
  if (share > num(p.maxShareOfBaseline, 0.3)) return null;
  // Below the neighbourhood too — otherwise the whole region calmed down (rain, a data change).
  const ring = fitRing(ctx.aoi.bbox, 25);
  if (!ring) return null;
  const rr = (await ctx.call("forest_alerts", { ...base, bbox: ring.bbox, endDate: end })) as AlertsResult;
  const aoiValue = now.areaHa / bboxArea(ctx.aoi.bbox);
  const regionalValue = rr.areaHa / bboxArea(ring.bbox);
  if (!(aoiValue < regionalValue)) return null;

  const drop = pct((1 - share) * 100);
  const values = { ha_now: now.areaHa, ha_year_ago: ly.areaHa, alerts_now: now.alertCount, alerts_year_ago: ly.alertCount, share_of_year_ago: round(share, 3), drop_pct: drop, windowDays: days };
  const observedAt = dayStart(end);
  const name = ctx.aoi.name ?? ctx.aoi.id;
  const evidence: Evidence[] = [
    {
      id: `gfw-integrated-${ctx.aoi.id}-${now.window.from}..${now.window.to}-yoy`,
      kind: "alert",
      source: "gfw-integrated-alerts",
      datetime: observedAt,
      href: GFW_HREF,
      method: method("forest_recovery", { ...base, endDate: end, endDateYearAgo: endLy, maxShareOfBaseline: num(p.maxShareOfBaseline, 0.3) }),
      summary:
        `${now.areaHa} ha of alerts (≥ ${String(p.minConfidence)} confidence) in ${now.window.from}…${now.window.to} vs ${ly.areaHa} ha in the same window a year earlier ` +
        `(${ly.window.from}…${ly.window.to}): ${round(share * 100, 1)} % of last year's level.`,
      values,
    },
  ];
  return {
    title: `Forest loss near ${name} fell ${drop} % year on year`.slice(0, 200),
    summary:
      `Good news, if it holds: deforestation alerts near ${name} covered ${now.areaHa} ha in the ${days} days to ${end}, down from ${ly.areaHa} ha in the same weeks a year earlier (−${drop} %), ` +
      `and the area is now quieter than its ${ring.km} km neighbourhood (${round(aoiValue, 1)} vs ${round(regionalValue, 1)} ha per deg²). ` +
      `Alerts can lag and cloud can hide clearing, so this counts only if the next month stays low or satellite greenness held up.`,
    observedAt,
    evidence,
    values,
    baseline: { metric: "alert ha per deg²", ringKm: ring.km, aoiValue: round(aoiValue, 3), regionalValue: round(regionalValue, 3), ratio: regionalValue > 0 ? round(aoiValue / regionalValue, 3) : null },
    notes: [`Case type: improvement — forest loss down ${drop} % year on year (${now.areaHa} ha vs ${ly.areaHa} ha).`],
    tags: TAGS,
  };
}

async function confirmForest(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const end = c0.observedAt.slice(0, 10);
  const maxShare = num(p.maxShareOfBaseline, 0.3);
  const minConfidence = String(p.minConfidence);
  // 1. Persistence: the next window, once it is past the alert lag, is still low year on year.
  const confirmDays = num(p.confirmDays, 30);
  const nextEnd = addDays(end, confirmDays);
  if (addDays(today(ctx), -num(p.lagDays, 14)) >= nextEnd) {
    const args = { bbox: ctx.aoi.bbox, days: confirmDays, minConfidence };
    const now = (await ctx.call("forest_alerts", { ...args, endDate: nextEnd })) as AlertsResult;
    const ly = (await ctx.call("forest_alerts", { ...args, endDate: addDays(nextEnd, -365) })) as AlertsResult;
    if (now.areaHa === 0 || now.areaHa <= maxShare * ly.areaHa) {
      return {
        independence: "revisit",
        signal: {
          id: `gfw-integrated-${ctx.aoi.id}-${now.window.from}..${now.window.to}-yoy-persist`,
          kind: "alert",
          source: "gfw-integrated-alerts",
          datetime: dayStart(nextEnd),
          href: GFW_HREF,
          method: method("forest_recovery", { ...args, endDate: nextEnd }),
          summary: `Still low in the next ${confirmDays} days (${now.window.from}…${now.window.to}): ${now.areaHa} ha vs ${ly.areaHa} ha a year earlier.`,
          values: { ha_now: now.areaHa, ha_year_ago: ly.areaHa },
        },
      };
    }
  }
  // 2. Different sensor: Sentinel-2 median NDVI held or rose, same weeks year on year.
  const dateA = addDays(end, -365);
  const args = { bbox: ctx.aoi.bbox, dateA, dateB: end, index: "NDVI", composite: "median", width: 256 };
  let c: CompareResult;
  try {
    c = (await ctx.call("eo_compare", args)) as CompareResult;
  } catch (err) {
    if ((err as Error).name === "QuotaExceeded") throw err; // the kernel records it as a quota skip
    return null; // no CDSE keys / no scenes: wait for the persistence window
  }
  if (Math.min(c.validPctA, c.validPctB) < num(p.minValidPct, 60)) return null;
  if (c.delta.meanChange < -num(p.ndviTolerance, 0.02)) return null;
  const scenes = [...(c.provenanceA?.scenes ?? []), ...(c.provenanceB?.scenes ?? [])];
  return {
    independence: "sensor",
    signal: {
      id: `s2-ndvi-median-${ctx.aoi.id}-${dateA}..${end}-yoy`,
      kind: "scene",
      source: "sentinel-2-l2a",
      datetime: dayStart(end),
      method: method("forest_recovery", args),
      summary: `Median-composite NDVI held year on year (${c.delta.meanChange >= 0 ? "+" : ""}${c.delta.meanChange.toFixed(3)}, ${dateA} → ${end}); valid pixels ${c.validPctA}% / ${c.validPctB}%.${scenes.length ? ` Scenes: ${scenes.slice(0, 6).join(", ")}` : ""}`,
      values: { deltaNdvi: c.delta.meanChange, validPctA: c.validPctA, validPctB: c.validPctB },
    },
  };
}

// ---- flaring_decline -----------------------------------------------------------------------

interface FlaringResult {
  window: { from: string; to: string; days: number };
  counts: { hotNightDetections: number; persistentClusters: number };
  vnf: { available: boolean; year?: number; bcmTotal?: number; sitesInBbox?: number; previous?: { available: boolean; year?: number; bcmTotal?: number; sitesInBbox?: number } };
}

function firmsArgs(ctx: RuleContext, p: P, endDate: string, days = num(p.days, 30)) {
  return { bbox: ctx.aoi.bbox, days, endDate, minFrp: num(p.minFrp, 5), minNights: 1, sources: [String(p.source)], vnf: false, limit: 1 };
}

async function detectFlaring(ctx: RuleContext, p: P): Promise<Candidate | null> {
  // 1. The registry fact first — one FIRMS transaction, and most fields stop here.
  const reg = (await shared(ctx, "flaring", { bbox: ctx.aoi.bbox, days: 1, sources: [String(p.source)], limit: 1 })) as FlaringResult;
  const prev = reg.vnf.previous;
  if (!reg.vnf.available || !prev?.available || prev.bcmTotal == null || reg.vnf.bcmTotal == null) return null;
  if (prev.bcmTotal < num(p.minBaselineBcm, 0.05)) return null;
  const vnfDrop = ((prev.bcmTotal - reg.vnf.bcmTotal) / prev.bcmTotal) * 100;
  if (vnfDrop < num(p.minDropPct, 30)) return null;
  // 2. And the flares look dimmer now than a year ago (same satellite both years).
  const end = today(ctx);
  const now = (await ctx.call("flaring", firmsArgs(ctx, p, end))) as FlaringResult;
  const ly = (await ctx.call("flaring", firmsArgs(ctx, p, addDays(end, -365)))) as FlaringResult;
  const a = now.counts.hotNightDetections;
  const b = ly.counts.hotNightDetections;
  if (b <= 0) return null;
  const firmsDrop = ((b - a) / b) * 100;
  if (firmsDrop < num(p.minFirmsDropPct, 10)) return null;

  const place = flarePlace(ctx.aoi);
  const observedAt = dayStart(now.window.to);
  const values = {
    vnf_bcm_latest: reg.vnf.bcmTotal,
    vnf_bcm_previous: prev.bcmTotal,
    vnf_drop_pct: pct(vnfDrop),
    vnfYear: reg.vnf.year ?? 0,
    hot_nights_now: a,
    hot_nights_year_ago: b,
    firms_drop_pct: pct(firmsDrop),
    windowDays: now.window.days,
  };
  const sensor = String(p.source).toLowerCase();
  const evidence: Evidence[] = [
    {
      id: `eog-vnf-annual-${prev.year}-${reg.vnf.year}-${ctx.aoi.id}-drop`,
      kind: "record",
      source: "eog-vnf-annual",
      datetime: `${reg.vnf.year}-12-31T00:00:00Z`,
      href: EOG_VNF_HREF,
      method: method("flaring_decline", { minDropPct: num(p.minDropPct, 30), minBaselineBcm: num(p.minBaselineBcm, 0.05) }),
      summary: `VNF annual flared volume of the ${reg.vnf.sitesInBbox ?? "?"} registry sites in the box: ${prev.bcmTotal} BCM in ${prev.year} → ${reg.vnf.bcmTotal} BCM in ${reg.vnf.year} (−${pct(vnfDrop)} %). Credit: ${VNF_CREDIT}.`,
      values: { vnf_bcm_latest: reg.vnf.bcmTotal, vnf_bcm_previous: prev.bcmTotal, vnf_drop_pct: pct(vnfDrop) },
    },
    {
      id: `firms-${sensor}-flaring-yoy-${ctx.aoi.id}-${now.window.from}-${now.window.to}`,
      kind: "alert",
      source: `firms-${sensor}`,
      datetime: observedAt,
      href: FIRMS_HREF,
      method: method("flaring_decline", firmsArgs(ctx, p, end)),
      summary: `${a} night-time detections with FRP ≥ ${num(p.minFrp, 5)} MW in ${now.window.from}…${now.window.to}, vs ${b} in ${ly.window.from}…${ly.window.to} (−${pct(firmsDrop)} %, ${String(p.source)} both years).`,
      values: { hot_nights_now: a, hot_nights_year_ago: b, firms_drop_pct: pct(firmsDrop) },
    },
  ];
  return {
    title: `Gas flaring near ${place} fell ${pct(vnfDrop)} % year on year`.slice(0, 200),
    summary:
      `Good news, if it holds: the registered gas flares near ${place} burned ${reg.vnf.bcmTotal} billion m³ of gas in ${reg.vnf.year}, down from ${prev.bcmTotal} in ${prev.year} (−${pct(vnfDrop)} %, VIIRS Nightfire annual summary), ` +
      `and the satellite sees fewer hot flare nights than a year ago (${a} vs ${b} detections in ${now.window.days} days). ` +
      `A second month still below last year's level confirms it.`,
    observedAt,
    evidence,
    values,
    notes: [`Case type: improvement — flaring down ${pct(vnfDrop)} % year on year (VNF ${prev.year}→${reg.vnf.year}), FIRMS night detections down ${pct(firmsDrop)} %.`],
    tags: TAGS,
  };
}

async function confirmFlaring(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt" | "values">): Promise<Confirmation | null> {
  const days = num(c0.values.windowDays, num(p.days, 30));
  const nextEnd = addDays(c0.observedAt.slice(0, 10), days);
  if (today(ctx) <= nextEnd) return null; // the next window has not fully elapsed
  const now = (await ctx.call("flaring", firmsArgs(ctx, p, nextEnd, days))) as FlaringResult;
  const ly = (await ctx.call("flaring", firmsArgs(ctx, p, addDays(nextEnd, -365), days))) as FlaringResult;
  const a = now.counts.hotNightDetections;
  const b = ly.counts.hotNightDetections;
  if (b <= 0 || ((b - a) / b) * 100 < num(p.minFirmsDropPct, 10)) return null;
  const sensor = String(p.source).toLowerCase();
  return {
    independence: "revisit",
    signal: {
      id: `firms-${sensor}-flaring-yoy-${ctx.aoi.id}-${now.window.from}-${now.window.to}-persist`,
      kind: "alert",
      source: `firms-${sensor}`,
      datetime: dayStart(now.window.to),
      href: FIRMS_HREF,
      method: method("flaring_decline", firmsArgs(ctx, p, nextEnd, days)),
      summary: `Second window still lower: ${a} night-time hot detections in ${now.window.from}…${now.window.to} vs ${b} a year earlier.`,
      values: { hot_nights_now: a, hot_nights_year_ago: b },
    },
  };
}

// ---- bleaching_relief ----------------------------------------------------------------------

interface CoralResult {
  gridCell: { lat: number; lon: number };
  latest: { date: string; dhw: number | null; alertLevel: number | null; alert: string | null };
  window: { strideDays: number };
  series: { t: string; dhw: number | null; baa: number | null }[];
}

/** Pure: when did the reef last have an alert, how bad was the window's peak, how long has it been clear? */
export function bleachingRelief(r: Pick<CoralResult, "latest" | "series" | "window">): { peak: number; peakDhw: number; lastAlert: string; clearDays: number } | null {
  if (r.latest.alertLevel !== 0) return null;
  const pts = r.series.filter((x) => x.baa !== null && x.t <= r.latest.date);
  const alerts = pts.filter((x) => x.baa! >= 1);
  const last = alerts[alerts.length - 1];
  if (!last) return null;
  // A strided series: the true last alert day may sit up to stride−1 days after the sample.
  const clearDays = daysBetween(last.t, r.latest.date) - (Math.max(1, r.window.strideDays) - 1);
  return { peak: Math.max(...alerts.map((x) => x.baa!)), peakDhw: Math.max(0, ...pts.map((x) => x.dhw ?? 0)), lastAlert: last.t, clearDays };
}

async function detectBleaching(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const pt = pointOf(ctx, p);
  const r = (await shared(ctx, "coral_bleaching", { lat: pt.lat, lon: pt.lon, days: num(p.days, 90) })) as CoralResult;
  const s = bleachingRelief(r);
  if (!s || s.peak < num(p.minPeakLevel, 1) || s.clearDays < num(p.minClearDays, 14)) return null;
  const name = ctx.aoi.name ?? ctx.aoi.id;
  const peakLabel = BAA_LABEL[s.peak] ?? `level ${s.peak}`;
  const observedAt = dayStart(r.latest.date);
  const values = { peak_level: s.peak, peak_dhw: s.peakDhw, dhw_now: r.latest.dhw ?? 0, clear_days: s.clearDays, alert_level_now: 0 };
  return {
    title: `Coral heat stress has eased at ${name}: no bleaching alert for ${s.clearDays} days`.slice(0, 200),
    summary:
      `Good news, if it holds: NOAA Coral Reef Watch put the reef cell near ${pt.lat}, ${pt.lon} at "${peakLabel}" within the last ${num(p.days, 90)} days (last on ${s.lastAlert}); ` +
      `since then it has been at "No stress" for ${s.clearDays} days (latest ${r.latest.date}, accumulated heat stress ${r.latest.dhw ?? "n/a"} °C-weeks). ` +
      `Relief means the heat has stopped building — corals that already bleached take months to years to recover, and some die. A later day still clear confirms it.`,
    observedAt,
    evidence: [
      {
        id: `crw-baa-${ctx.aoi.id}-${r.latest.date}-relief`,
        kind: "series",
        source: "noaa-crw-coraltemp",
        datetime: observedAt,
        href: CRW_HREF,
        method: method("bleaching_relief", { lat: pt.lat, lon: pt.lon, days: num(p.days, 90), minPeakLevel: num(p.minPeakLevel, 1), minClearDays: num(p.minClearDays, 14) }),
        summary: `CRW Bleaching Alert Area at (${r.gridCell.lat}, ${r.gridCell.lon}): peak "${peakLabel}" (level ${s.peak}) in the window, last alert sample ${s.lastAlert}, "No stress" through ${r.latest.date} (series every ${r.window.strideDays} d).`,
        values,
      },
    ],
    values,
    geometry: pointGeom(pt.lat, pt.lon),
    notes: [`Case type: improvement — reef heat-stress alert lifted (peak ${peakLabel}, clear ${s.clearDays} days).`],
    tags: TAGS,
  };
}

async function confirmBleaching(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const pt = pointOf(ctx, p);
  const r = (await shared(ctx, "coral_bleaching", { lat: pt.lat, lon: pt.lon, days: num(p.days, 90) })) as CoralResult;
  if (dayStart(r.latest.date) <= c0.observedAt || r.latest.alertLevel !== 0) return null;
  return {
    independence: "revisit",
    signal: {
      id: `crw-baa-${ctx.aoi.id}-${r.latest.date}-relief-persist`,
      kind: "series",
      source: "noaa-crw-coraltemp",
      datetime: dayStart(r.latest.date),
      href: CRW_HREF,
      method: method("bleaching_relief", { lat: pt.lat, lon: pt.lon }),
      summary: `Still "No stress" on ${r.latest.date} (DHW ${r.latest.dhw ?? "n/a"} °C-weeks).`,
      values: { alert_level_now: 0, dhw_now: r.latest.dhw ?? 0 },
    },
  };
}

// ---- air_quality_clean ---------------------------------------------------------------------

interface AirResult {
  pm25Daily?: { t: string; v: number; hours: number }[];
}

/** Pure: mean of the last `window` full days and how many of the `window` full days before were above the guideline. */
export function airClean(daily: { t: string; v: number; hours: number }[], guideline: number, window = 7): { last: string; mean: number; priorAbove: number; priorMean: number } | null {
  const full = daily.filter((d) => d.hours >= 18);
  if (full.length < 2 * window) return null;
  const recent = full.slice(-window);
  const prior = full.slice(-2 * window, -window);
  const avg = (xs: { v: number }[]) => round(xs.reduce((s, d) => s + d.v, 0) / xs.length, 1);
  return { last: recent[recent.length - 1]!.t, mean: avg(recent), priorAbove: prior.filter((d) => d.v > guideline).length, priorMean: avg(prior) };
}

async function air(ctx: RuleContext, p: P) {
  const pt = pointOf(ctx, p);
  const w = num(p.window, 7);
  const r = (await shared(ctx, "air_quality", { lat: pt.lat, lon: pt.lon, pastDays: Math.min(16, 2 * w + 1) })) as AirResult;
  if (!r.pm25Daily) throw new Error("air_quality: result has no pm25Daily (tool too old?)");
  return { pt, s: airClean(r.pm25Daily, num(p.guideline, 15), w) };
}

async function detectAir(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const g = num(p.guideline, 15);
  const w = num(p.window, 7);
  const { pt, s } = await air(ctx, p);
  if (!s || s.mean >= g || s.priorAbove < num(p.minDaysAbove, 7)) return null;
  const name = ctx.aoi.name ?? ctx.aoi.id;
  const observedAt = dayStart(s.last);
  const values = { pm25_mean_ugm3: s.mean, pm25_prior_mean_ugm3: s.priorMean, prior_days_above: s.priorAbove, guideline_ugm3: g, windowDays: w };
  return {
    title: `Cleaner air in ${name}: a week below the WHO fine-particle guideline`.slice(0, 200),
    summary:
      `Good news, if it holds: modelled PM2.5 near ${pt.lat}, ${pt.lon} averaged ${s.mean} µg/m³ over the ${w} days to ${s.last}, below the WHO 24-hour guideline of ${g} µg/m³, ` +
      `after ${s.priorAbove} of the ${w} days before were above it (mean ${s.priorMean}). Rain and wind often clean the air for a while; a later week still below confirms it.`,
    observedAt,
    evidence: [
      {
        id: `cams-pm25-${ctx.aoi.id}-${s.last}-clean`,
        kind: "series",
        source: "cams-global",
        datetime: observedAt,
        href: CAMS_HREF,
        method: method("air_quality_clean", { lat: pt.lat, lon: pt.lon, guideline: g, window: w, minDaysAbove: num(p.minDaysAbove, 7) }),
        summary: `CAMS PM2.5 daily means (UTC, ≥ 18 h): last ${w} full days mean ${s.mean} µg/m³ < ${g}; the ${w} days before: ${s.priorAbove} above (mean ${s.priorMean}).`,
        values,
      },
    ],
    values,
    geometry: pointGeom(pt.lat, pt.lon),
    notes: [`Case type: improvement — ${w}-day PM2.5 mean ${s.mean} µg/m³, under the WHO guideline after a week above it.`],
    tags: TAGS,
  };
}

async function confirmAir(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const g = num(p.guideline, 15);
  const { pt, s } = await air(ctx, p);
  if (!s || dayStart(s.last) <= c0.observedAt || s.mean >= g) return null;
  return {
    independence: "revisit",
    signal: {
      id: `cams-pm25-${ctx.aoi.id}-${s.last}-clean-persist`,
      kind: "series",
      source: "cams-global",
      datetime: dayStart(s.last),
      href: CAMS_HREF,
      method: method("air_quality_clean", { lat: pt.lat, lon: pt.lon, guideline: g }),
      summary: `Still below ${g} µg/m³: ${num(p.window, 7)}-day mean ${s.mean} to ${s.last}.`,
      values: { pm25_mean_ugm3: s.mean },
    },
  };
}

// ---- fires_absent --------------------------------------------------------------------------

interface FiresResult {
  count: number;
  fires: FireDetection[];
}

/** Pure: fire clusters = grid cells (cellDeg) holding ≥ clusterMin detections with FRP ≥ minFrp. */
export function fireClusters(fires: readonly FireDetection[], o: { minFrp: number; clusterMin: number; cellDeg: number }): { hot: number; clusters: number } {
  const cells = new Map<string, number>();
  let hot = 0;
  for (const f of fires) {
    if ((f.frp ?? 0) < o.minFrp) continue;
    hot++;
    const k = `${Math.floor(f.lat / o.cellDeg)}:${Math.floor(f.lon / o.cellDeg)}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  return { hot, clusters: [...cells.values()].filter((n) => n >= o.clusterMin).length };
}

/** FIRMS window ending `end`, ≤5-day chunks, newest first; stops early once a cluster shows up. */
async function firesWindow(ctx: RuleContext, p: P, end: string, days: number, stopOnCluster: boolean) {
  const all: FireDetection[] = [];
  const opts = { minFrp: num(p.minFrp, 20), clusterMin: num(p.clusterMin, 3), cellDeg: num(p.cellDeg, 0.05) };
  for (const c of windowChunks(end, days).reverse()) {
    const r = (await ctx.call("fires_in", { bbox: ctx.aoi.bbox, dayRange: c.dayRange, date: c.date, source: String(p.source) })) as FiresResult;
    all.push(...r.fires);
    if (stopOnCluster && fireClusters(all, opts).clusters > 0) break;
  }
  return { ...fireClusters(all, opts), all: all.length };
}

async function detectFires(ctx: RuleContext, p: P): Promise<Candidate | null> {
  const days = num(p.days, 30);
  const end = today(ctx);
  const now = await firesWindow(ctx, p, end, days, true);
  if (now.clusters > 0) return null;
  const endLy = addDays(end, -365);
  const ly = await firesWindow(ctx, p, endLy, days, false);
  if (ly.clusters < 1 || ly.hot < num(p.minHotLastYear, 10)) return null; // it did not burn last year: nothing to celebrate
  // Sensor alive: the wider region has detections in the last days — else absence may be a feed gap.
  const ring = ringBBox(ctx.aoi.bbox, num(p.aliveRingKm, 100));
  const alive = (await ctx.call("fires_in", { bbox: ring, dayRange: 5, source: String(p.source) })) as FiresResult;
  if (alive.count < 1) return null;

  const name = ctx.aoi.name ?? ctx.aoi.id;
  const from = addDays(end, -(days - 1));
  const observedAt = dayStart(end);
  const minFrp = num(p.minFrp, 20);
  const values = { clusters_now: 0, hot_now: now.hot, detections_now: now.all, clusters_year_ago: ly.clusters, hot_year_ago: ly.hot, windowDays: days, ring_detections: alive.count };
  const sensor = String(p.source).toLowerCase();
  return {
    title: `No fire clusters in ${name} so far this season — ${ly.hot} hot fire detections in the same weeks last year`.slice(0, 200),
    summary:
      `Good news, if it holds: in the ${days} days to ${end} the satellite found no cluster of hot fires (FRP ≥ ${minFrp} MW) in the watch window around ${name}, ` +
      `where the same weeks last year held ${ly.clusters} cluster(s) and ${ly.hot} hot detections. The sensor is working nearby (${alive.count} detections within ${num(p.aliveRingKm, 100)} km in the last 5 days). ` +
      `Rain, cloud or a later fire season can explain a quiet spell; the next sweep still quiet confirms it.`,
    observedAt,
    evidence: [
      {
        id: `firms-${sensor}-absent-${ctx.aoi.id}-${from}-${end}`,
        kind: "alert",
        source: `firms-${sensor}`,
        datetime: observedAt,
        href: FIRMS_HREF,
        method: method("fires_absent", { days, minFrp, clusterMin: num(p.clusterMin, 3), cellDeg: num(p.cellDeg, 0.05), source: String(p.source) }),
        summary:
          `${from}…${end}: ${now.all} detection(s), ${now.hot} with FRP ≥ ${minFrp} MW, 0 clusters (≥ ${num(p.clusterMin, 3)} hot per ${num(p.cellDeg, 0.05)}° cell). ` +
          `${addDays(endLy, -(days - 1))}…${endLy}: ${ly.all} detection(s), ${ly.hot} hot, ${ly.clusters} cluster(s). ${String(p.source)} both years.`,
        values,
      },
    ],
    values,
    notes: [`Case type: improvement — no fire clusters this season so far where ${ly.clusters} burned in the same weeks last year.`],
    tags: TAGS,
  };
}

async function confirmFires(ctx: RuleContext, p: P, c0: Pick<Candidate, "observedAt">): Promise<Confirmation | null> {
  const since = c0.observedAt.slice(0, 10);
  const end = today(ctx);
  const gap = daysBetween(since, end);
  if (gap < num(p.revisitDays, 5)) return null;
  const days = Math.min(num(p.days, 30), gap);
  const r = await firesWindow(ctx, p, end, days, true);
  if (r.clusters > 0) return null;
  const sensor = String(p.source).toLowerCase();
  const from = addDays(end, -(days - 1));
  return {
    independence: "revisit",
    signal: {
      id: `firms-${sensor}-absent-${ctx.aoi.id}-${from}-${end}-persist`,
      kind: "alert",
      source: `firms-${sensor}`,
      datetime: dayStart(end),
      href: FIRMS_HREF,
      method: method("fires_absent", { days, minFrp: num(p.minFrp, 20), source: String(p.source) }),
      summary: `Still no fire cluster on later passes (${from}…${end}: ${r.all} detection(s), ${r.hot} hot).`,
      values: { clusters_now: 0, hot_now: r.hot },
    },
  };
}

// ---- the rule ------------------------------------------------------------------------------

const DETECT: Record<ImprovementKind, (ctx: RuleContext, p: P) => Promise<Candidate | null>> = {
  forest_recovery: detectForest,
  flaring_decline: detectFlaring,
  bleaching_relief: detectBleaching,
  air_quality_clean: detectAir,
  fires_absent: detectFires,
};

export const improvement = defineRule({
  name: "improvement",
  version: "1.0",
  tier: 1,
  description: "Good news, held to the same evidence standard: forest loss, gas flaring, reef heat stress, air pollution or fire at a watched place fell clearly below where it was.",
  blindSpots: [
    "All: an improvement is a measured drop, not a cause — policy, enforcement, rain, market prices or a data change can all produce it, and the case does not say which.",
    "Forest: GFW alerts cover 30°N–30°S only and lag 1–2 weeks; both windows end two weeks before the sweep, but late alerts can still fill in the recent one.",
    "Forest: cloud hides optical alerts and RADD (radar) covers only part of the tropics; a cloudy season can look like less clearing.",
    "Forest: the optical check is a whole-box median NDVI — it rules out broad canopy loss, not small clearings; the stronger confirmation is the next month staying low.",
    "Flaring: the two VNF years come from different satellites (S-NPP 2023, NOAA-20 2024); part of a change can be calibration, not gas.",
    "Flaring: less flaring can mean less oil produced, gas vented cold (invisible to heat sensors) or re-routed to another flare, not gas put to use.",
    "Reefs: one 5 km CRW cell stands for the reef; 'No stress' means the heat stopped building, not that bleached corals recovered or survived.",
    "Air: CAMS is a ~40 km model, not a monitor; a clean week is often weather (monsoon rain, wind), not lower emissions.",
    "Fires: a quiet spell can be rain, cloud, smoke or a late fire season; the box is a watch window, not the legal boundary; VIIRS misses small, short fires between passes.",
    "Fires/flaring: year-on-year FIRMS counts use NOAA-21 only (the one VIIRS feed FIRMS keeps back to 2024); a NOAA-21 outage looks like calm — the fire check requires detections nearby.",
  ],
  requires: [],
  // Only the forest NDVI check spends Copernicus: when that quota is spent, confirmation waits
  // (every kind; detection still runs). Missing keys fall back to the persistence check.
  confirmRequires: ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
  ringKm: 25,
  defaults: {},

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const { kind, p } = improvementParams(ctx.params);
    return DETECT[kind](ctx, p);
  },

  async confirm(ctx: RuleContext, c): Promise<Confirmation | null> {
    const { kind, p } = improvementParams(ctx.params);
    switch (kind) {
      case "forest_recovery":
        return confirmForest(ctx, p, c);
      case "flaring_decline":
        return confirmFlaring(ctx, p, c);
      case "bleaching_relief":
        return confirmBleaching(ctx, p, c);
      case "air_quality_clean":
        return confirmAir(ctx, p, c);
      case "fires_absent":
        return confirmFires(ctx, p, c);
    }
  },
});
