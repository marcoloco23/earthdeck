// weather_extreme@1.0 — three weather hazards at a watched city or region, each with its own
// independent second signal. One rule (so one finding per AOI at a time); `hazards` picks
// which are evaluated, and when several trip at once the most severe leads and the others ride
// along as notes.
//
//   heat    primary: Open-Meteo forecast-API daily max ≥ absC (42 °C) or ≥ anomalyC (+8 °C) over
//           the ERA5 1991–2020 normal, for ≥ minDays (2) consecutive days ending today.
//           confirm: ERA5 reanalysis (models=era5 — a different model and provider) agrees on
//           ≥ minDays of those days (provider), or a later elapsed day is still hot (revisit).
//   cyclone primary: an NHC/CPHC (or GDACS, outside NHC's basins) storm whose current or forecast
//           peak category ≥ minCategory (1) and whose forecast cone touches the AOI.
//           confirm: a NASA EONET "Severe Storms" event for the same storm (provider).
//   rain    primary: a day's precipitation ≥ mm (150) yesterday or today.
//           confirm: GloFAS discharge at the nearest river cell ≥ dischargeRatio (2×) its 2-year
//           mean (provider), or a later elapsed day again ≥ mm (revisit).
//
// Tier 0: a natural hazard names no party. Heat and rain read the AOI's centre point.

import type { Evidence, Geometry } from "../../ledger/schema.js";
import { addDays, bboxCenter } from "../../util.js";
import { bboxPolygon, dayStart, defineRule, num, type Candidate, type Confirmation, type RuleContext } from "./types.js";

export const HAZARD_CODE = { heat: 1, cyclone: 2, rain: 3 } as const;
type Hazard = keyof typeof HAZARD_CODE;
/** Lead-hazard order when several trip in one sweep. */
const SEVERITY: Hazard[] = ["cyclone", "heat", "rain"];

interface Day {
  date: string;
  kind: "past" | "today" | "forecast";
  tmaxC: number | null;
  precipMm: number | null;
  tmaxNormalC: number | null;
  tmaxAnomalyC: number | null;
}
interface WeatherNow {
  today: string;
  days: Day[];
  era5: { date: string; tmaxC: number | null; precipMm: number | null }[];
  normals?: { period: string };
}
interface StormOut {
  id: string;
  name: string;
  source: string;
  basin: string;
  classification: string;
  maxWindKt: number | null;
  category: number | null;
  peakCategory: number | null;
  position: { lat: number; lon: number } | null;
  advisory: { number: string | null; issued: string | null; url: string | null };
  cone: Geometry | null;
}
interface EventOut {
  id: string;
  title: string;
  category: string;
  lastDate: string | null;
  coordinates: [number, number] | null;
  link: string;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;
const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

function hazardsOf(p: Record<string, unknown>): Hazard[] {
  const raw = Array.isArray(p.hazards) ? p.hazards : [p.hazards];
  const hs = raw.filter((h): h is Hazard => typeof h === "string" && h in HAZARD_CODE);
  return hs.length ? hs : ["heat", "rain"];
}

/** RFC 3339 with whole seconds and Z (the ledger's contract). */
function rfc3339(s: string | null | undefined, fallback: string): string {
  const ms = s ? Date.parse(s) : NaN;
  return (Number.isFinite(ms) ? new Date(ms) : new Date(fallback)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function place(ctx: RuleContext): { lat: number; lon: number } {
  const [lon, lat] = bboxCenter(ctx.aoi.bbox);
  return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
}

function weatherArgs(ctx: RuleContext, pastDays: number, normals: boolean) {
  return { ...place(ctx), place: ctx.aoi.name, pastDays, forecastDays: 7, normals };
}

function forecastHref(lat: number, lon: number, daily: string): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=${daily}&past_days=7&timezone=auto`;
}

// ---- heat --------------------------------------------------------------------------------

interface HeatParams {
  absC: number;
  anomalyC: number;
  minDays: number;
}
const isHot = (tmax: number | null, anom: number | null, p: HeatParams) => (tmax != null && tmax >= p.absC) || (anom != null && anom >= p.anomalyC);

function heatCandidate(ctx: RuleContext, w: WeatherNow, p: HeatParams, args: Record<string, unknown>): Candidate | null {
  const elapsed = w.days.filter((d) => d.kind !== "forecast");
  let run = 0;
  for (let i = elapsed.length - 1; i >= 0 && isHot(elapsed[i]!.tmaxC, elapsed[i]!.tmaxAnomalyC, p); i--) run++;
  if (run < p.minDays) return null;
  const peak = elapsed[elapsed.length - 1]!;
  const runStart = elapsed[elapsed.length - run]!.date;
  let ahead = 0;
  for (const d of w.days.filter((x) => x.kind === "forecast")) {
    if (!isHot(d.tmaxC, d.tmaxAnomalyC, p)) break;
    ahead++;
  }
  const a = peak.tmaxAnomalyC;
  const anomText = a == null ? "" : `, ${fmt(Math.abs(a))} °C ${a >= 0 ? "above" : "below"} normal`;
  const title = `Heatwave in ${ctx.aoi.name}: ${fmt(peak.tmaxC!)} °C${anomText}, ${ordinal(run)} day`;
  const { lat, lon } = place(ctx);
  const values: Record<string, number> = { hazardCode: HAZARD_CODE.heat, tmaxC: peak.tmaxC!, runDays: run, forecastHotDaysAhead: ahead, absC: p.absC, anomalyThresholdC: p.anomalyC };
  if (a != null) values.anomalyC = a;
  if (peak.tmaxNormalC != null) values.normalC = peak.tmaxNormalC;
  const evidence: Evidence[] = [
    {
      id: `openmeteo-tmax-${ctx.aoi.id}-${runStart}..${peak.date}`,
      kind: "series",
      source: "open-meteo-forecast",
      collection: "best_match",
      datetime: dayStart(peak.date),
      href: forecastHref(lat, lon, "temperature_2m_max"),
      method: { name: "weather_now", version: "1.0", params: args },
      summary:
        `Daily max ${elapsed.slice(-run).map((d) => `${d.date} ${d.tmaxC} °C${d.tmaxAnomalyC != null ? ` (${d.tmaxAnomalyC >= 0 ? "+" : ""}${d.tmaxAnomalyC})` : ""}`).join(", ")} ` +
        `at ${lat}, ${lon}; thresholds ≥ ${p.absC} °C or ≥ +${p.anomalyC} °C vs the ERA5 ${w.normals?.period ?? "1991–2020"} normal.` +
        (ahead ? ` Forecast: ${ahead} more day(s) over threshold.` : ""),
      values,
    },
  ];
  return {
    title,
    summary:
      `Model daily maximum at the centre of ${ctx.aoi.name} has been over the heat threshold for ${run} consecutive day(s) ` +
      `(${runStart} → ${peak.date}), peaking today at ${fmt(peak.tmaxC!)} °C${anomText}` +
      (ahead ? `; the forecast keeps it there ${ahead} more day(s)` : "") +
      ". Forecast-model values, not station readings — awaiting ERA5 reanalysis or a further hot day to confirm.",
    observedAt: dayStart(peak.date),
    evidence,
    values,
  };
}

async function confirmHeat(ctx: RuleContext, c: Pick<Candidate, "observedAt" | "values">, p: HeatParams): Promise<Confirmation | null> {
  const lastDay = c.observedAt.slice(0, 10);
  const runDays = Math.max(1, num(c.values.runDays, p.minDays));
  const today = ctx.now.slice(0, 10);
  const pastDays = Math.min(14, Math.max(7, daysBetween(lastDay, today) + runDays));
  const args = weatherArgs(ctx, pastDays, true);
  const w = (await ctx.call("weather_now", args)) as WeatherNow;
  const normal = new Map(w.days.map((d) => [d.date, d.tmaxNormalC]));
  const runFirst = addDays(lastDay, -(runDays - 1));

  // (1) ERA5 — independent reanalysis — agrees on ≥ minDays of the flagged days.
  const era = w.era5.filter((d) => d.date >= runFirst && d.date <= lastDay && d.tmaxC != null);
  const eraHot = era.filter((d) => {
    const n = normal.get(d.date);
    return isHot(d.tmaxC, n != null ? d.tmaxC! - n : null, p);
  });
  if (eraHot.length >= Math.min(p.minDays, runDays)) {
    const peak = [...eraHot].sort((x, y) => y.tmaxC! - x.tmaxC!)[0]!;
    return {
      independence: "provider",
      signal: {
        id: `era5-tmax-${ctx.aoi.id}-${runFirst}..${lastDay}`,
        kind: "series",
        source: "ecmwf-era5",
        collection: "reanalysis-era5-single-levels",
        datetime: dayStart(peak.date),
        href: `https://archive-api.open-meteo.com/v1/archive?latitude=${args.lat}&longitude=${args.lon}&start_date=${runFirst}&end_date=${lastDay}&daily=temperature_2m_max&models=era5&timezone=auto`,
        method: { name: "weather_now", version: "1.0", params: args },
        summary: `ERA5 reanalysis (0.25°) daily max over threshold on ${eraHot.length} of ${era.length} flagged day(s): ${eraHot.map((d) => `${d.date} ${d.tmaxC} °C`).join(", ")}.`,
        values: { era5HotDays: eraHot.length, era5PeakTmaxC: peak.tmaxC! },
      },
    };
  }

  // (2) Persistence — a later elapsed day is still over threshold.
  const later = w.days.filter((d) => d.kind !== "forecast" && d.date > lastDay && isHot(d.tmaxC, d.tmaxAnomalyC, p));
  if (later.length === 0) return null;
  const d = later[later.length - 1]!;
  return {
    independence: "revisit",
    signal: {
      id: `openmeteo-tmax-${ctx.aoi.id}-${d.date}`,
      kind: "series",
      source: "open-meteo-forecast",
      collection: "best_match",
      datetime: dayStart(d.date),
      href: forecastHref(args.lat, args.lon, "temperature_2m_max"),
      method: { name: "weather_now", version: "1.0", params: args },
      summary: `Heat persisted after the flagged run: ${later.map((x) => `${x.date} ${x.tmaxC} °C${x.tmaxAnomalyC != null ? ` (${x.tmaxAnomalyC >= 0 ? "+" : ""}${x.tmaxAnomalyC})` : ""}`).join(", ")}.`,
      values: { laterHotDays: later.length, tmaxC: d.tmaxC! },
    },
  };
}

// ---- rain --------------------------------------------------------------------------------

function rainCandidate(ctx: RuleContext, w: WeatherNow, mm: number, args: Record<string, unknown>): Candidate | null {
  const recent = w.days.filter((d) => d.kind !== "forecast").slice(-2);
  const wettest = [...recent].filter((d) => d.precipMm != null).sort((a, b) => b.precipMm! - a.precipMm!)[0];
  if (!wettest || wettest.precipMm! < mm) return null;
  const { lat, lon } = place(ctx);
  const values = { hazardCode: HAZARD_CODE.rain, precipMm: wettest.precipMm!, thresholdMm: mm };
  return {
    title: `Extreme rain in ${ctx.aoi.name}: ${fmt(wettest.precipMm!)} mm in one day`,
    summary:
      `Model precipitation at the centre of ${ctx.aoi.name} reached ${fmt(wettest.precipMm!)} mm on ${wettest.date} ` +
      `(threshold ${mm} mm/day). Local-day total from a forecast model, not a rain gauge — awaiting river response ` +
      `(GloFAS) or a further extreme day to confirm.`,
    observedAt: dayStart(wettest.date),
    evidence: [
      {
        id: `openmeteo-precip-${ctx.aoi.id}-${wettest.date}`,
        kind: "series",
        source: "open-meteo-forecast",
        collection: "best_match",
        datetime: dayStart(wettest.date),
        href: forecastHref(lat, lon, "precipitation_sum"),
        method: { name: "weather_now", version: "1.0", params: args },
        summary: `Daily precipitation ${recent.map((d) => `${d.date} ${d.precipMm ?? "?"} mm`).join(", ")} at ${lat}, ${lon}.`,
        values,
      },
    ],
    values,
  };
}

interface DischargeOut {
  latest: { t: string; v: number | null } | null;
  latestVsMean: number | null;
  stats: { mean: number | null };
}

async function confirmRain(ctx: RuleContext, c: Pick<Candidate, "observedAt">, mm: number, ratio: number): Promise<Confirmation | null> {
  const day = c.observedAt.slice(0, 10);
  const { lat, lon } = place(ctx);
  // (1) GloFAS river discharge — a hydrological model, a different product and provider.
  try {
    const dArgs = { lat, lon };
    const r = (await ctx.call("river_discharge", dArgs)) as DischargeOut;
    if (r.latest?.v != null && r.latest.t >= day && r.latestVsMean != null && r.latestVsMean >= ratio) {
      return {
        independence: "provider",
        signal: {
          id: `glofas-${ctx.aoi.id}-${r.latest.t}`,
          kind: "series",
          source: "glofas",
          collection: "cems-glofas-historical",
          datetime: dayStart(r.latest.t.slice(0, 10)),
          href: `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lon}&daily=river_discharge`,
          method: { name: "river_discharge", version: "1.0", params: dArgs },
          summary: `GloFAS discharge at the nearest river cell ${r.latest.v} m³/s on ${r.latest.t}, ${r.latestVsMean}× its 2-year mean (≥ ${ratio}×).`,
          values: { dischargeM3s: r.latest.v, dischargeVsMean: r.latestVsMean },
        },
      };
    }
  } catch {
    /* no river cell nearby, or GloFAS down — fall through to persistence */
  }
  // (2) Persistence — another extreme day after the flagged one.
  const args = weatherArgs(ctx, 7, false);
  const w = (await ctx.call("weather_now", args)) as WeatherNow;
  const later = w.days.filter((d) => d.kind !== "forecast" && d.date > day && (d.precipMm ?? 0) >= mm);
  if (later.length === 0) return null;
  const d = later[later.length - 1]!;
  return {
    independence: "revisit",
    signal: {
      id: `openmeteo-precip-${ctx.aoi.id}-${d.date}`,
      kind: "series",
      source: "open-meteo-forecast",
      collection: "best_match",
      datetime: dayStart(d.date),
      href: forecastHref(lat, lon, "precipitation_sum"),
      method: { name: "weather_now", version: "1.0", params: args },
      summary: `Extreme rain again after ${day}: ${later.map((x) => `${x.date} ${x.precipMm} mm`).join(", ")}.`,
      values: { laterExtremeDays: later.length, precipMm: d.precipMm! },
    },
  };
}

// ---- cyclone -----------------------------------------------------------------------------

/** Plain-language storm noun: hurricane (Atlantic/E+C Pacific), typhoon (NW Pacific), cyclone elsewhere. */
export function stormNoun(s: Pick<StormOut, "basin" | "position" | "category" | "classification">): string {
  const cat = Math.max(s.category ?? 0, 0);
  if (cat < 1) return /TD|depression/i.test(s.classification) ? "Tropical depression" : "Tropical storm";
  if (["AL", "EP", "CP"].includes(s.basin)) return "Hurricane";
  const lon = s.position?.lon;
  const lat = s.position?.lat ?? 0;
  if (lon != null && lat > 0 && lon >= 100) return "Typhoon";
  if (lon != null && lon < -30) return "Hurricane";
  return "Cyclone";
}

function validGeometry(g: Geometry | null): g is Geometry {
  if (!g) return false;
  if (g.type === "Polygon") return (g.coordinates[0]?.length ?? 0) >= 4;
  if (g.type === "MultiPolygon") return g.coordinates.length > 0 && g.coordinates.every((p) => (p[0]?.length ?? 0) >= 4);
  return false;
}

async function cycloneCandidate(ctx: RuleContext, minCategory: number): Promise<Candidate | null> {
  const args = { bbox: ctx.aoi.bbox, minCategory, eonet: false };
  const r = (await ctx.call("storms", args)) as { storms: StormOut[] };
  const storms = (r.storms ?? []).filter((s) => Math.max(s.category ?? 0, s.peakCategory ?? 0) >= minCategory);
  if (storms.length === 0) return null;
  const s = [...storms].sort((a, b) => (b.peakCategory ?? 0) - (a.peakCategory ?? 0) || (b.maxWindKt ?? 0) - (a.maxWindKt ?? 0))[0]!;
  const noun = stormNoun(s);
  const cat = s.category ?? 0;
  const peak = s.peakCategory ?? cat;
  const catText = cat >= 1 ? `category ${cat}` : noun.toLowerCase();
  const peakText = peak > cat ? `, forecast to reach category ${peak}` : "";
  const observedAt = rfc3339(s.advisory.issued, ctx.now);
  const values: Record<string, number> = { hazardCode: HAZARD_CODE.cyclone, category: cat, peakCategory: peak };
  if (s.maxWindKt != null) values.maxWindKt = s.maxWindKt;
  return {
    title: `${noun} ${s.name} (${catText}${peakText}): forecast cone over ${ctx.aoi.name}`,
    summary:
      `${noun} ${s.name} — ${s.maxWindKt ?? "?"} kt, ${catText}${peakText} — has a forecast cone touching ${ctx.aoi.name} ` +
      `(${s.source === "noaa-nhc" ? "NHC/CPHC" : "GDACS"} advisory ${s.advisory.number ?? "?"}, ${observedAt}). The cone is the likely ` +
      `path of the centre, not a landfall forecast or the extent of impacts.` +
      (storms.length > 1 ? ` ${storms.length - 1} other qualifying storm(s) also touch the region.` : ""),
    observedAt,
    evidence: [
      {
        id: `${s.id}@adv-${s.advisory.number ?? "na"}`,
        kind: "record",
        source: s.source,
        collection: s.source === "noaa-nhc" ? "nhc-tropical-weather-summary" : "gdacs-tc",
        datetime: observedAt,
        ...(s.advisory.url ? { href: s.advisory.url } : {}),
        method: { name: "storms", version: "1.0", params: args },
        summary: `${s.name}: ${s.classification}, ${s.maxWindKt ?? "?"} kt at ${s.position ? `${s.position.lat}, ${s.position.lon}` : "?"}; forecast-peak category ${peak}; cone intersects the AOI.`,
        values,
      },
    ],
    values,
    geometry: validGeometry(s.cone) ? s.cone : bboxPolygon(ctx.aoi.bbox),
    notes: storms.slice(1, 4).map((o) => `Also touching: ${o.name} (${o.classification}, ${o.maxWindKt ?? "?"} kt)`),
  };
}

async function confirmCyclone(ctx: RuleContext, c: Pick<Candidate, "evidence" | "values">): Promise<Confirmation | null> {
  const stormId = c.evidence.find((e) => e.method.name === "storms")?.id.split("@")[0];
  if (!stormId) return null;
  const sr = (await ctx.call("storms", { bbox: ctx.aoi.bbox, minCategory: 0, eonet: false })) as { storms: StormOut[] };
  const storm = (sr.storms ?? []).find((s) => s.id === stormId);
  if (!storm) return null;
  const args = { category: "severeStorms", status: "open", days: 30, limit: 100 };
  const ev = (await ctx.call("events", args)) as { events: EventOut[] };
  const name = storm.name.toLowerCase();
  const byName = (ev.events ?? []).find((e) => name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(e.title));
  if (!byName) return null;
  return {
    independence: "provider",
    signal: {
      id: byName.id,
      kind: "record",
      source: "nasa-eonet",
      collection: "severeStorms",
      datetime: rfc3339(byName.lastDate, ctx.now),
      ...(byName.link ? { href: byName.link } : {}),
      method: { name: "events", version: "1.0", params: args },
      summary: `NASA EONET lists "${byName.title}" as an open severe-storm event${byName.coordinates ? ` (latest ${byName.coordinates[1]}, ${byName.coordinates[0]})` : ""}.`,
      values: {},
    },
  };
}

// ---- the rule ----------------------------------------------------------------------------

export const weatherExtreme = defineRule({
  name: "weather_extreme",
  version: "1.0",
  tier: 0,
  description:
    "Extreme weather at a watched place: heat (daily max ≥ 42 °C or ≥ +8 °C over the 1991–2020 normal for ≥ 2 days, confirmed by ERA5 or persistence), " +
    "tropical cyclones (category ≥ 1 with a forecast cone over the AOI, confirmed by NASA EONET), extreme rain (≥ 150 mm/day, confirmed by GloFAS river discharge ≥ 2× or persistence).",
  blindSpots: [
    "Heat and rain are read from forecast-model analyses at one grid point (the AOI centre, ~2–11 km cell), not station observations: urban heat islands, sea breezes and convective downpours can differ sharply over a few km.",
    "Station sparsity: ERA5 and the forecast models are only as good as the observations assimilated into them, which are thin across much of Africa, South Asia and the tropics — exactly where heat risk is highest.",
    "Anomalies compare a ~2–11 km forecast grid with a 0.25° ERA5 normal, so they carry ~1–2 °C of grid/elevation bias; ERA5 also smooths extreme daily rainfall, so it is not used to confirm rain.",
    "Temperature alone is not heat stress: humidity (wet-bulb), night-time minima and who is exposed decide the harm, and none of these gate this rule.",
    "A cyclone cone is the likely path of the storm's centre (~2/3 of past errors), not a landfall forecast or the footprint of wind, surge and rain — impacts extend beyond it, and a cone over the AOI does not mean it will be hit.",
    "Outside the Atlantic and eastern/central Pacific, storms come from GDACS, whose winds may be 10-minute averages (reads ~1 category lower than NHC's 1-minute).",
    "EONET republishes NHC/JTWC advisories, so the cyclone confirmation is an independent pipeline over largely the same forecast-centre source, not an independent observation.",
    "A daily precipitation total is a local-calendar-day sum (today's includes the forecast for the rest of the day), not a rolling 24 h window; GloFAS discharge responds to basin-wide rain, so a city storm on a small catchment may never show at the nearest GloFAS cell.",
  ],
  requires: [],
  ringKm: 0,
  defaults: { hazards: ["heat", "rain"], absC: 42, anomalyC: 8, minDays: 2, minCategory: 1, mm: 150, dischargeRatio: 2 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...weatherExtreme.defaults, ...ctx.params };
    const hz = hazardsOf(p);
    const heat: HeatParams = { absC: num(p.absC, 42), anomalyC: num(p.anomalyC, 8), minDays: Math.max(1, num(p.minDays, 2)) };
    const found = new Map<Hazard, Candidate>();
    if (hz.includes("cyclone")) {
      const c = await cycloneCandidate(ctx, num(p.minCategory, 1));
      if (c) found.set("cyclone", c);
    }
    if (hz.includes("heat") || hz.includes("rain")) {
      // heat + rain share one weather_now call (normals only when heat is watched).
      const args = weatherArgs(ctx, 7, hz.includes("heat"));
      const w = (await ctx.call("weather_now", args)) as WeatherNow;
      const heatC = hz.includes("heat") ? heatCandidate(ctx, w, heat, args) : null;
      const rainC = hz.includes("rain") ? rainCandidate(ctx, w, num(p.mm, 150), args) : null;
      if (heatC) found.set("heat", heatC);
      if (rainC) found.set("rain", rainC);
    }
    const [lead, ...rest] = SEVERITY.flatMap((h) => (found.has(h) ? [found.get(h)!] : []));
    if (!lead) return null;
    return rest.length ? { ...lead, notes: [...(lead.notes ?? []), ...rest.map((r) => `Also over threshold: ${r.title}`)] } : lead;
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...weatherExtreme.defaults, ...ctx.params };
    const code = num(candidate.values.hazardCode, 0);
    if (code === HAZARD_CODE.cyclone) return confirmCyclone(ctx, candidate);
    if (code === HAZARD_CODE.heat)
      return confirmHeat(ctx, candidate, { absC: num(p.absC, 42), anomalyC: num(p.anomalyC, 8), minDays: Math.max(1, num(p.minDays, 2)) });
    if (code === HAZARD_CODE.rain) return confirmRain(ctx, candidate, num(p.mm, 150), num(p.dischargeRatio, 2));
    return null;
  },
});
