// Methane: the area signal (Sentinel-5P TROPOMI CH₄ via the CDSE Statistics API) and the
// point signal (NASA JPL EMIT plume complexes). Parsers and the anomaly math are pure so
// they are tested offline against recorded fixtures.
//
// Source quirks (verified live 2026-09-26):
// - S5P on CDSE Sentinel Hub: collection type `sentinel-5p-l2`, band `CH4` (ppb, ~1900),
//   `dataFilter.timeliness: "OFFL"` (CH₄ is an offline product), `processing.minQa: 50`.
//   ORBIT mosaicking works; one Statistics request with P<n>D buckets returns the whole
//   baseline + recent series. Pixels are ~7×5.5 km, so the request raster is sized to that.
// - EMIT: the public JPL MMGIS layer (no auth, public domain) is ONE GeoJSON of every plume
//   complex (~7 MB, Point + Polygon per plume; "NA" strings for missing rates). It is
//   fetched once per process (TTL cache). As of 2026-09-26 its latest plume is 2025-09-22,
//   matching the CMR EMITL2BCH4PLM v002 collection end — recent windows can be empty.
// - UNEP MARS (Eye on Methane): API requires authorization by email and the download page
//   sits behind a Cloudflare challenge → not fetchable unattended; reported as unavailable.
// - Carbon Mapper: NC + revocable licence → link only, never fetched.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import type { DataSourceSpec, StatsBucket } from "./copernicus.js";

export const S5P_MIN_QA = 50;

export const S5P_CH4_SOURCE: DataSourceSpec = {
  collection: "sentinel-5p-l2",
  dataFilter: { timeliness: "OFFL" },
  processing: { minQa: S5P_MIN_QA },
};

/** Request raster size for a bbox at ~5.5 km/pixel (S5P native), clamped to [8, 128]. */
export function s5pRasterSize(bbox: BBox): { width: number; height: number } {
  const [w, s, e, n] = bbox;
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const clamp = (v: number) => Math.min(128, Math.max(8, Math.round(v)));
  return { width: clamp(((e - w) * 111 * Math.cos(lat)) / 5.5), height: clamp(((n - s) * 111) / 5.5) };
}

export interface Ch4Bucket {
  from: string;
  to: string;
  meanPpb: number | null;
  validPct: number;
}

export interface Ch4Anomaly {
  recentPpb: number;
  baselinePpb: number;
  /** recent − baseline, ppb. */
  deltaPpb: number;
  /** Std-dev of the baseline bucket means (temporal variability), ppb; null with < 3 buckets. */
  baselineSdPpb: number | null;
  /** deltaPpb / baselineSdPpb — a z-ish score against the AOI's own recent variability. */
  z: number | null;
  validPct: number;
  baselineValidPct: number;
  bucketsUsed: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function toCh4Buckets(series: StatsBucket[]): Ch4Bucket[] {
  return series.map((b) => ({ from: b.from.slice(0, 10), to: b.to.slice(0, 10), meanPpb: b.stats ? r1(b.stats.mean) : null, validPct: b.stats?.validPct ?? 0 }));
}

/**
 * Anomaly of the recent bucket vs the baseline buckets. Baseline buckets count only when at
 * least `minBucketValidPct` of pixels had a retrieval (sparse buckets are noise). Returns
 * null when the recent bucket or every baseline bucket is empty.
 */
export function ch4Anomaly(recent: Ch4Bucket, baseline: Ch4Bucket[], minBucketValidPct = 20): Ch4Anomaly | null {
  if (recent.meanPpb == null) return null;
  const used = baseline.filter((b) => b.meanPpb != null && b.validPct >= minBucketValidPct);
  if (used.length === 0) return null;
  const means = used.map((b) => b.meanPpb!);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const sd = means.length >= 3 ? Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / (means.length - 1)) : null;
  const delta = recent.meanPpb - mean;
  return {
    recentPpb: r1(recent.meanPpb),
    baselinePpb: r1(mean),
    deltaPpb: r1(delta),
    baselineSdPpb: sd != null ? r1(sd) : null,
    z: sd != null && sd > 0 ? r2(delta / sd) : null,
    validPct: recent.validPct,
    baselineValidPct: Math.round(used.reduce((a, b) => a + b.validPct, 0) / used.length),
    bucketsUsed: used.length,
  };
}

// ---- EMIT plumes ------------------------------------------------------------------------

export const EMIT_PLUMES_URL = "https://earth.jpl.nasa.gov/emit-mmgis-lb/Missions/EMIT/Layers/coverage/combined_plume_metadata.json";
export const EMIT_LICENCE = "Public domain (NASA/JPL EMIT, EMITL2BCH4PLM v002, doi:10.5067/EMIT/EMITL2BCH4PLM.002)";
export const CARBON_MAPPER_URL = "https://data.carbonmapper.org/";

export interface Plume {
  source: "EMIT";
  id: string;
  datetime: string;
  lat: number;
  lon: number;
  emissionRateKgHr: number | null;
  emissionRateUncertaintyKgHr: number | null;
  maxConcentrationPpmM: number | null;
  href: string | null;
  licence: string;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface EmitFeature {
  geometry?: { type?: string; coordinates?: number[] };
  properties?: Record<string, unknown>;
}

/** All EMIT plume points in the feed (Polygon outlines are skipped; points carry the numbers). */
export function parseEmitPlumes(json: unknown): Plume[] {
  const feats = (json as { features?: EmitFeature[] })?.features;
  if (!Array.isArray(feats)) throw new OverviewError("unexpected EMIT plume feed shape");
  const out: Plume[] = [];
  for (const f of feats) {
    if (f.geometry?.type !== "Point" || !Array.isArray(f.geometry.coordinates)) continue;
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry.coordinates;
    const dt = p["UTC Time Observed"];
    if (typeof lon !== "number" || typeof lat !== "number" || typeof dt !== "string") continue;
    out.push({
      source: "EMIT",
      id: String(p["Plume ID"] ?? ""),
      datetime: dt,
      lat,
      lon,
      emissionRateKgHr: numOrNull(p["Emissions Rate Estimate (kg/hr)"]),
      emissionRateUncertaintyKgHr: numOrNull(p["Emissions Rate Estimate Uncertainty (kg/hr)"]),
      maxConcentrationPpmM: numOrNull(p["Max Plume Concentration (ppm m)"]),
      href: typeof p["Data Download"] === "string" ? (p["Data Download"] as string) : null,
      licence: EMIT_LICENCE,
    });
  }
  return out;
}

/** Plumes inside the bbox with datetime in [from, to] (dates YYYY-MM-DD, inclusive), newest first. */
export function plumesIn(plumes: Plume[], bbox: BBox, from: string, to: string): Plume[] {
  const [w, s, e, n] = bbox;
  const lo = `${from}T00:00:00Z`;
  const hi = `${to}T23:59:59Z`;
  return plumes
    .filter((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n && p.datetime >= lo && p.datetime <= hi)
    .sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
}

const EMIT_TTL_MS = 6 * 3600_000;
let emitCache: { at: number; plumes: Plume[] } | null = null;

/** Every EMIT plume point (one ~7 MB fetch per process per 6 h). */
export async function emitPlumes(): Promise<Plume[]> {
  if (emitCache && Date.now() - emitCache.at < EMIT_TTL_MS) return emitCache.plumes;
  const res = await fetch(EMIT_PLUMES_URL, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) throw new OverviewError(`EMIT plume feed failed (${res.status})`, res.status, (await res.text().catch(() => "")).slice(0, 300));
  const plumes = parseEmitPlumes(await res.json());
  emitCache = { at: Date.now(), plumes };
  return plumes;
}

/** Test hook: forget the cached feed. */
export function _resetEmitCache(): void {
  emitCache = null;
}
