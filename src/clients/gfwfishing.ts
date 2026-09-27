// Global Fishing Watch (NOT Global *Forest* Watch — that is ./gfw.ts) — apparent fishing
// effort from the 4Wings report API. Aggregated only: hours per grid cell, per day, per flag
// state and per gear type. Vessel identities are never requested (no VESSEL_ID group-by)
// and the parser keeps only an allow-list of fields, so nothing vessel-level can leak even
// if the upstream response grows new columns. The per-cell `vesselIDs` field GFW returns is
// a distinct-vessel *count* — we drop it too (summing it across cells double-counts anyway).
//
// Request shape (verified live 2026-09-27, API v3):
//   POST https://gateway.api.globalfishingwatch.org/v3/4wings/report
//        ?spatial-resolution=LOW|HIGH          (LOW = 0.1°, HIGH = 0.01° cells; MEDIUM → 422)
//        &temporal-resolution=DAILY|MONTHLY|ENTIRE
//        &group-by=FLAG|GEARTYPE               (one dimension per request)
//        &datasets[0]=public-global-fishing-effort:latest   (resolved to :v4.0 in the reply)
//        &date-range=YYYY-MM-DD,YYYY-MM-DD
//        &format=JSON
//   Authorization: Bearer <GFW_FISHING_TOKEN>
//   body: {"geojson": <Polygon>}  or  {"region": {"dataset": "public-mpa-all", "id": "<WDPA site_pid>"}}
//   reply: {"total":1, "entries":[{"public-global-fishing-effort:v4.0":[{date, flag|geartype, hours, lat, lon, vesselIDs}]}]}
// Quirks: data lags ~4 days (a 30-day window ending today holds ~26 days); ENTIRE rows carry
// date "from,to"; `public-mpa-all` region ids are WDPA site_pids (strings, e.g. "555556875_1"),
// unknown ids → 422 "Region not found"; one dimension per group-by, so flag + gear = two
// requests (made sequentially — GFW limits concurrent reports per token, UNCONFIRMED how hard).
// PRIVACY QUIRK: with NO group-by the report defaults to per-vessel rows (callsign, ship name,
// MMSI, entry/exit timestamps — seen live). So `group-by` is mandatory here, always FLAG or
// GEARTYPE, and the allow-list parser is the second line of defence.
//
// Terms: data CC BY-NC 4.0, API non-commercial; attribution "Global Fishing Watch, <year>.
// www.globalfishingwatch.org" rides in every result's provenance.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { addDays } from "../util.js";

export const GFW_FISHING_API = "https://gateway.api.globalfishingwatch.org/v3";
export const FISHING_DATASET = "public-global-fishing-effort:latest";
export const MPA_REGION_DATASET = "public-mpa-all";
export const FISHING_LICENCE = "CC BY-NC 4.0 (data) — Global Fishing Watch API terms: non-commercial use only";
export const FISHING_SOURCE = "Global Fishing Watch 4Wings — apparent fishing effort (AIS, model-inferred)";

/** GFW's required attribution line. */
export function fishingAttribution(year: number): string {
  return `Global Fishing Watch, ${year}. www.globalfishingwatch.org`;
}

export type SpatialRes = "LOW" | "HIGH";
export type TemporalRes = "DAILY" | "MONTHLY" | "ENTIRE";
export type GroupBy = "FLAG" | "GEARTYPE";
export type FishingArea = { bbox: BBox } | { mpaId: string };

export const CELL_DEG: Record<SpatialRes, number> = { LOW: 0.1, HIGH: 0.01 };

export function gfwFishingToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GFW_FISHING_TOKEN?.trim() || null;
}

/** The report URL (query string only — the area goes in the body). */
export function reportUrl(o: { from: string; to: string; spatial: SpatialRes; temporal: TemporalRes; groupBy: GroupBy }): string {
  if (o.groupBy !== "FLAG" && o.groupBy !== "GEARTYPE") throw new Error("gfwfishing: group-by must be FLAG or GEARTYPE (no group-by = per-vessel rows)");
  const q = [
    `spatial-resolution=${o.spatial}`,
    `temporal-resolution=${o.temporal}`,
    `group-by=${o.groupBy}`,
    `datasets[0]=${FISHING_DATASET}`,
    `date-range=${o.from},${o.to}`,
    "format=JSON",
  ];
  return `${GFW_FISHING_API}/4wings/report?${q.join("&")}`;
}

export function reportBody(area: FishingArea): string {
  if ("mpaId" in area) return JSON.stringify({ region: { dataset: MPA_REGION_DATASET, id: area.mpaId } });
  const [w, s, e, n] = area.bbox;
  return JSON.stringify({ geojson: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
}

/** One aggregated effort cell. Allow-listed fields only — see the header. */
export interface EffortRow {
  date: string;
  lat: number;
  lon: number;
  hours: number;
  flag?: string;
  gear?: string;
}

/** Parse a report reply into allow-listed rows + the resolved dataset version. */
export function parseReport(json: unknown): { dataset: string; rows: EffortRow[] } {
  const entries = (json as { entries?: Array<Record<string, unknown>> })?.entries;
  if (!Array.isArray(entries)) throw new OverviewError("GFW 4Wings report: unexpected reply (no entries[])", undefined, JSON.stringify(json).slice(0, 300));
  let dataset = FISHING_DATASET;
  const rows: EffortRow[] = [];
  for (const entry of entries) {
    for (const [key, list] of Object.entries(entry ?? {})) {
      dataset = key;
      if (!Array.isArray(list)) continue;
      for (const r of list as Array<Record<string, unknown>>) {
        const hours = Number(r.hours);
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        if (![hours, lat, lon].every(Number.isFinite)) continue;
        const row: EffortRow = { date: String(r.date ?? ""), lat, lon, hours };
        if (typeof r.flag === "string") row.flag = r.flag || "UNK";
        if (typeof r.geartype === "string") row.gear = r.geartype || "unknown";
        rows.push(row);
      }
    }
  }
  return { dataset, rows };
}

async function report(token: string, area: FishingArea, o: Parameters<typeof reportUrl>[0]): Promise<{ dataset: string; rows: EffortRow[] }> {
  const res = await fetch(reportUrl(o), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: reportBody(area),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new OverviewError(`Global Fishing Watch rejected the token (${res.status}) — check GFW_FISHING_TOKEN`, res.status, text.slice(0, 300));
  if (res.status === 429) throw new OverviewError("Global Fishing Watch rate limit (429) — too many requests; retry later", 429, text.slice(0, 300));
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { messages?: { title?: string; detail?: string }[] };
      if (j.messages?.length) detail = j.messages.map((m) => `${m.title ?? ""}: ${m.detail ?? ""}`).join("; ");
    } catch {
      /* keep raw */
    }
    throw new OverviewError(`Global Fishing Watch report failed (${res.status}): ${detail}`, res.status, text.slice(0, 300));
  }
  try {
    return parseReport(JSON.parse(text));
  } catch (e) {
    if (e instanceof OverviewError) throw e;
    throw new OverviewError("Global Fishing Watch returned non-JSON", res.status, text.slice(0, 300));
  }
}

export interface FishingQuery {
  area: FishingArea;
  from: string;
  to: string;
  resolution?: SpatialRes;
  /** Second request grouped by gear type (default true). */
  byGear?: boolean;
  /** Also sum the hours of cells whose centre lies inside this box. */
  clip?: BBox;
  /** Top cells by hours to return (default 0 — totals only). */
  maxCells?: number;
}

export interface FishingSummary {
  dataset: string;
  area: { kind: "bbox"; bbox: BBox } | { kind: "mpa"; regionDataset: string; id: string };
  from: string;
  to: string;
  resolution: SpatialRes;
  cellDeg: number;
  totalHours: number;
  /** Distinct grid cells with any effort. */
  cells: number;
  activeDays: number;
  lastDataDate: string | null;
  byFlag: { flag: string; hours: number }[];
  byGear: { gear: string; hours: number }[] | null;
  /** One row per calendar day from `from` to the last day with data (zero-filled). */
  daily: { date: string; hours: number }[];
  clip: { bbox: BBox; hours: number; share: number | null } | null;
  grid: { lon: number; lat: number; hours: number }[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const cellKey = (lon: number, lat: number) => `${lon.toFixed(3)},${lat.toFixed(3)}`;
export const inBBox = (b: BBox, lon: number, lat: number) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/** Aggregate DAILY+FLAG rows (and optional ENTIRE+GEARTYPE rows) into the tool's summary. */
export function summarize(q: FishingQuery, dataset: string, flagRows: EffortRow[], gearRows: EffortRow[] | null): FishingSummary {
  const resolution = q.resolution ?? "LOW";
  const sumBy = (rows: EffortRow[], key: (r: EffortRow) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.hours);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const total = flagRows.reduce((a, r) => a + r.hours, 0);
  const days = new Map(sumBy(flagRows, (r) => r.date.slice(0, 10)));
  const dates = [...days.keys()].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const lastDataDate = dates.at(-1) ?? null;
  const daily: { date: string; hours: number }[] = [];
  if (lastDataDate) for (let d = q.from; d <= lastDataDate; d = addDays(d, 1)) daily.push({ date: d, hours: r1(days.get(d) ?? 0) });
  const cellHours = new Map<string, { lon: number; lat: number; hours: number }>();
  for (const r of flagRows) {
    const k = cellKey(r.lon, r.lat);
    const c = cellHours.get(k) ?? { lon: r.lon, lat: r.lat, hours: 0 };
    c.hours += r.hours;
    cellHours.set(k, c);
  }
  let clip: FishingSummary["clip"] = null;
  if (q.clip) {
    const h = [...cellHours.values()].filter((c) => inBBox(q.clip!, c.lon, c.lat)).reduce((a, c) => a + c.hours, 0);
    clip = { bbox: q.clip, hours: r1(h), share: total > 0 ? Math.round((h / total) * 1000) / 1000 : null };
  }
  const grid = [...cellHours.values()]
    .sort((a, b) => b.hours - a.hours || a.lon - b.lon || a.lat - b.lat)
    .slice(0, Math.max(0, q.maxCells ?? 0))
    .map((c) => ({ lon: c.lon, lat: c.lat, hours: r1(c.hours) }));
  return {
    dataset,
    area: "mpaId" in q.area ? { kind: "mpa", regionDataset: MPA_REGION_DATASET, id: q.area.mpaId } : { kind: "bbox", bbox: q.area.bbox },
    from: q.from,
    to: q.to,
    resolution,
    cellDeg: CELL_DEG[resolution],
    totalHours: r1(total),
    cells: cellHours.size,
    activeDays: dates.filter((d) => (days.get(d) ?? 0) > 0).length,
    lastDataDate,
    byFlag: sumBy(flagRows, (r) => r.flag ?? "UNK").map(([flag, hours]) => ({ flag, hours: r1(hours) })),
    byGear: gearRows ? sumBy(gearRows, (r) => r.gear ?? "unknown").map(([gear, hours]) => ({ gear, hours: r1(hours) })) : null,
    daily,
    clip,
    grid,
  };
}

/** Apparent fishing effort in a bbox or a WDPA MPA over [from, to]: 1 request (+1 for gear). */
export async function fishingEffort(token: string, q: FishingQuery): Promise<FishingSummary> {
  const spatial = q.resolution ?? "LOW";
  const flag = await report(token, q.area, { from: q.from, to: q.to, spatial, temporal: "DAILY", groupBy: "FLAG" });
  const gear = q.byGear === false ? null : await report(token, q.area, { from: q.from, to: q.to, spatial: "LOW", temporal: "ENTIRE", groupBy: "GEARTYPE" });
  return summarize(q, flag.dataset, flag.rows, gear?.rows ?? null);
}

/**
 * Per-cell totals over [from, to] (ENTIRE, grouped by flag and summed per cell — never
 * ungrouped, see the header) — for the public map's coarse effort grid.
 */
export async function effortGrid(token: string, area: FishingArea, from: string, to: string, spatial: SpatialRes = "LOW"): Promise<{ dataset: string; cells: { lon: number; lat: number; hours: number }[] }> {
  const r = await report(token, area, { from, to, spatial, temporal: "ENTIRE", groupBy: "FLAG" });
  const m = new Map<string, { lon: number; lat: number; hours: number }>();
  for (const row of r.rows) {
    const k = cellKey(row.lon, row.lat);
    const c = m.get(k) ?? { lon: row.lon, lat: row.lat, hours: 0 };
    c.hours += row.hours;
    m.set(k, c);
  }
  return { dataset: r.dataset, cells: [...m.values()].map((c) => ({ ...c, hours: r1(c.hours) })).filter((c) => c.hours > 0) };
}
