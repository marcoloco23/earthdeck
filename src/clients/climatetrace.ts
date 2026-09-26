// Climate TRACE API client (`emitters`), pinned to v7 via `climateTraceBase()`. Zero-key.
//
// v7 `/sources` has no bbox filter (a `bbox` param is silently ignored — verified live), so
// a bbox query is two steps: `/admins?bbox=…&level=2` finds the GADM level-2 areas (e.g.
// municipalities) whose extent intersects the AOI, then `/sources?gadmId=…` lists each
// area's sources ranked by emissions. Point sources are kept when their centroid falls in
// the bbox; `gadm-aggregation` sources (area-wide totals, centroid = area centroid) are
// returned separately as context, never as located assets. CH4 comes from a second
// `/sources` call with `gas=ch4`, merged by source id. Licence: CC BY 4.0.

import { climateTraceBase, USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { bboxContains } from "../util.js";

export const CLIMATETRACE_LICENCE = "CC BY 4.0 — Climate TRACE (climatetrace.org)";
export const CLIMATETRACE_SECTORS = [
  "power",
  "fossil-fuel-operations",
  "manufacturing",
  "mineral-extraction",
  "waste",
  "agriculture",
  "buildings",
  "transportation",
  "forestry-and-land-use",
  "fluorinated-gases",
] as const;
export type ClimateTraceSector = (typeof CLIMATETRACE_SECTORS)[number];

/** Page size per admin area; if a page comes back full we flag the result as truncated. */
export const SOURCES_PAGE = 1000;

export interface CtAdmin {
  id: string;
  name: string;
  fullName: string;
}

export interface CtSource {
  sourceId: number;
  name: string;
  sector: string;
  subsector: string;
  sourceType: string; // "point-source" | "gadm-aggregation" | …
  country: string;
  lon: number | null;
  lat: number | null;
  year: number | null;
  /** tonnes CO2e (100-yr GWP, AR6); negative = net sink. */
  co2e100yrT: number | null;
  /** tonnes CH4; null = not reported / not requested. */
  ch4T: number | null;
  gadmId: string;
  licence: string;
}

async function ctGet(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const url = `${climateTraceBase()}${path}${qs.size ? `?${qs}` : ""}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  const text = await res.text();
  if (res.status === 429) throw new OverviewError("Climate TRACE rate limit hit (429) — retry later", 429);
  if (!res.ok) throw new OverviewError(`Climate TRACE ${path} failed (${res.status})`, res.status, text.slice(0, 300));
  try {
    return JSON.parse(text);
  } catch {
    throw new OverviewError(`Climate TRACE ${path} returned non-JSON`, res.status, text.slice(0, 300));
  }
}

export function parseAdmins(json: unknown): CtAdmin[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string")
    .map((a) => ({ id: String(a.id), name: String(a.name ?? a.id), fullName: String(a.full_name ?? a.name ?? a.id) }));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse a `/sources` page (gas = co2e_100yr) into normalized rows. */
export function parseSources(json: unknown, gadmId: string): CtSource[] {
  if (!Array.isArray(json)) return [];
  const out: CtSource[] = [];
  for (const s of json as Array<Record<string, unknown>>) {
    const id = num(s.id);
    if (id == null) continue;
    const c = (s.centroid ?? {}) as { longitude?: unknown; latitude?: unknown };
    out.push({
      sourceId: id,
      name: String(s.name ?? ""),
      sector: String(s.sector ?? ""),
      subsector: String(s.subsector ?? ""),
      sourceType: String(s.sourceType ?? ""),
      country: String(s.country ?? ""),
      lon: num(c.longitude),
      lat: num(c.latitude),
      year: num(s.year),
      co2e100yrT: num(s.emissionsQuantity),
      ch4T: null,
      gadmId,
      licence: CLIMATETRACE_LICENCE,
    });
  }
  return out;
}

/** Map a gas=ch4 `/sources` page to sourceId → tonnes CH4. */
export function parseCh4(json: unknown): Map<number, number> {
  const m = new Map<number, number>();
  if (!Array.isArray(json)) return m;
  for (const s of json as Array<Record<string, unknown>>) {
    const id = num(s.id);
    const q = num(s.emissionsQuantity);
    if (id != null && q != null) m.set(id, q);
  }
  return m;
}

/** Keep located point sources inside the bbox; split off area-wide aggregates. */
export function splitSources(sources: CtSource[], bbox: BBox): { assets: CtSource[]; aggregates: CtSource[] } {
  const assets: CtSource[] = [];
  const aggregates: CtSource[] = [];
  const seen = new Set<number>();
  for (const s of sources) {
    if (seen.has(s.sourceId)) continue;
    seen.add(s.sourceId);
    if (s.sourceType === "point-source") {
      if (s.lon != null && s.lat != null && bboxContains(bbox, s.lon, s.lat)) assets.push(s);
    } else {
      aggregates.push(s);
    }
  }
  const byEmissions = (a: CtSource, b: CtSource) => Math.abs(b.co2e100yrT ?? 0) - Math.abs(a.co2e100yrT ?? 0);
  return { assets: assets.sort(byEmissions), aggregates: aggregates.sort(byEmissions) };
}

export async function adminsInBBox(bbox: BBox): Promise<CtAdmin[]> {
  return parseAdmins(await ctGet("/admins", { bbox: bbox.join(","), level: 2, limit: 100 }));
}

/** All sources for one admin area (CO2e + CH4 merged). */
export async function sourcesForAdmin(
  gadmId: string,
  opts: { sector?: ClimateTraceSector; year?: number },
): Promise<{ sources: CtSource[]; truncated: boolean }> {
  const base = { gadmId, sectors: opts.sector, year: opts.year, limit: SOURCES_PAGE };
  const [co2e, ch4] = await Promise.all([
    ctGet("/sources", { ...base, gas: "co2e_100yr" }),
    ctGet("/sources", { ...base, gas: "ch4" }),
  ]);
  const sources = parseSources(co2e, gadmId);
  const ch4Map = parseCh4(ch4);
  for (const s of sources) s.ch4T = ch4Map.get(s.sourceId) ?? null;
  return { sources, truncated: Array.isArray(co2e) && co2e.length >= SOURCES_PAGE };
}
