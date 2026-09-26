// NOAA Coral Reef Watch (CRW) — daily global 5 km coral-bleaching heat-stress products
// (CoralTemp v3.1: SST, SST anomaly, HotSpot, Degree Heating Weeks, Bleaching Alert Area),
// 1985-04-01 → ~2 days ago. Zero-key via ERDDAP griddap dataset `NOAA_DHW`.
//
// Live-verified 2026-09-26: coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW 302-redirects
// to PacIOOS (pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km); fetch follows it.
// Daily multi-year point queries are SLOW upstream (365 daily steps ≈ 80 s; 2 years timed
// out) while strided ones are fast (weekly over a year ≈ 5 s) — so series are strided to
// ≤ ~60 time steps. DHW is itself a 12-week accumulation, so weekly sampling loses little.
// Licence: "available for use without restriction" — credit NOAA Coral Reef Watch.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { SeriesPoint } from "../series.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";
import { parseErddapSeries } from "./erddap.js";

export const CRW_BASE = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW";
export const CRW_START = "1985-04-01";
export const CRW_VARS = ["CRW_DHW", "CRW_SSTANOMALY", "CRW_BAA", "CRW_SST"] as const;

/** Bleaching Alert Area levels as this dataset defines them (flag_values 0–4). */
export const BAA_LABEL = ["No stress", "Bleaching Watch", "Bleaching Warning", "Alert Level 1", "Alert Level 2"] as const;

export function baaLabel(level: number | null): string | null {
  return level === null ? null : (BAA_LABEL[level] ?? null);
}

export interface CrwPoint {
  t: string;
  dhw: number | null; // °C-weeks
  sstAnomaly: number | null; // °C
  baa: number | null; // 0–4
  sst: number | null; // °C
}

export interface CrwResult {
  points: CrwPoint[];
  gridLat: number;
  gridLon: number;
}

/** Fill values / out-of-range → null; round away float noise (2.5500000000000003). */
const clean = (v: number | null, lo: number, hi: number) => (v === null || v < lo || v > hi ? null : Math.round(v * 100) / 100);

/** Parse a multi-variable NOAA_DHW griddap JSON table into per-time rows (fill values → null). */
export function parseCrw(json: unknown): CrwResult {
  const series = Object.fromEntries(CRW_VARS.map((v) => [v, parseErddapSeries(json, v)])) as Record<(typeof CRW_VARS)[number], SeriesPoint[]>;
  const t = (json as { table: { columnNames: string[]; rows: unknown[][] } }).table;
  const iLat = t.columnNames.indexOf("latitude");
  const iLon = t.columnNames.indexOf("longitude");
  const points = series.CRW_DHW.map((p, i) => ({
    t: p.t,
    dhw: clean(p.v, 0, 100),
    sstAnomaly: clean(series.CRW_SSTANOMALY[i]?.v ?? null, -20, 20),
    baa: clean(series.CRW_BAA[i]?.v ?? null, 0, 4),
    sst: clean(series.CRW_SST[i]?.v ?? null, -5, 45),
  }));
  return { points, gridLat: Number(t.rows[0]?.[iLat] ?? NaN), gridLon: Number(t.rows[0]?.[iLon] ?? NaN) };
}

async function crwJson(query: string): Promise<unknown> {
  const res = await fetch(`${CRW_BASE}.json?${query}`, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`NOAA Coral Reef Watch (ERDDAP) request failed (${res.status})`, res.status, body.slice(0, 300));
  }
  return res.json();
}

const enc = (s: string) => `%5B${s}%5D`;

function checkPoint(lat: number, lon: number): void {
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw new OverviewError(`lat/lon out of range: ${lat}, ${lon}`);
}

/** Latest available day at the nearest 5 km cell. */
export async function crwLatest(lat: number, lon: number): Promise<CrwResult> {
  checkPoint(lat, lon);
  const dims = `${enc("(last)")}${enc(`(${lat})`)}${enc(`(${lon})`)}`;
  return parseCrw(await crwJson(CRW_VARS.map((v) => `${v}${dims}`).join(",")));
}

/** Pure: stride (days) so a window yields at most `maxSteps` samples. */
export function crwStride(days: number, maxSteps = 60): number {
  return Math.max(1, Math.ceil(days / maxSteps));
}

/** Strided series from `start` to `end` (YYYY-MM-DD) at the nearest cell. */
export async function crwSeries(lat: number, lon: number, start: string, end: string, maxSteps = 60): Promise<CrwResult & { strideDays: number }> {
  checkPoint(lat, lon);
  const from = start < CRW_START ? CRW_START : start;
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000));
  const stride = crwStride(days, maxSteps);
  const dims = `${enc(`(${from}T12:00:00Z):${stride}:(${end}T12:00:00Z)`)}${enc(`(${lat})`)}${enc(`(${lon})`)}`;
  return { ...parseCrw(await crwJson(CRW_VARS.map((v) => `${v}${dims}`).join(","))), strideDays: stride };
}

export interface CrwArea {
  date: string;
  cells: number; // ocean cells with data
  maxDhw: number | null;
  meanDhw: number | null;
  maxBaa: number | null;
  /** Share of sampled ocean cells at Alert Level 1 or higher. */
  alertSharePct: number | null;
}

/** Pure: summarize a DHW+BAA grid for one day. */
export function summarizeCrwGrid(json: unknown): CrwArea {
  const dhw = parseErddapSeries(json, "CRW_DHW");
  const baa = parseErddapSeries(json, "CRW_BAA");
  const d = dhw.map((p) => clean(p.v, 0, 100)).filter((v): v is number => v !== null);
  const b = baa.map((p) => clean(p.v, 0, 4)).filter((v): v is number => v !== null);
  return {
    date: dhw[0]?.t ?? "",
    cells: d.length,
    maxDhw: d.length ? Math.max(...d) : null,
    meanDhw: d.length ? Math.round((d.reduce((a, v) => a + v, 0) / d.length) * 100) / 100 : null,
    maxBaa: b.length ? Math.max(...b) : null,
    alertSharePct: b.length ? Math.round((b.filter((v) => v >= 3).length / b.length) * 1000) / 10 : null,
  };
}

/** Latest-day DHW/BAA over a box (≤ 10° per side), strided to ≤ ~40×40 cells. */
export async function crwArea(bbox: BBox): Promise<CrwArea> {
  assertBBox(bbox);
  const [w, s, e, n] = bbox;
  if (e - w > 10 || n - s > 10) throw new OverviewError("coral bbox too large — keep it within 10° per side");
  const cells = (deg: number) => Math.max(1, Math.ceil(deg / 0.05 / 40));
  const dims = `${enc("(last)")}${enc(`(${n}):${cells(n - s)}:(${s})`)}${enc(`(${w}):${cells(e - w)}:(${e})`)}`;
  return summarizeCrwGrid(await crwJson(`CRW_DHW${dims},CRW_BAA${dims}`));
}
