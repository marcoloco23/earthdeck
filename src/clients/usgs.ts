// USGS earthquake catalog (FDSN event service). Free, no key, real-time.
// https://earthquake.usgs.gov/fdsnws/event/1/

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

const USGS_BASE = "https://earthquake.usgs.gov/fdsnws/event/1/query";

export interface Quake {
  id: string;
  mag: number | null;
  place: string;
  time: string; // ISO
  lon: number;
  lat: number;
  depthKm: number | null;
  tsunami: boolean;
  alert: string | null; // PAGER: green/yellow/orange/red
  url: string;
  /** USGS significance 0–1000+ (magnitude, felt reports, PAGER); null when absent. */
  sig: number | null;
  /** "reviewed" (seismologist-checked) or "automatic"; null when absent. */
  status: string | null;
}

interface RawFeature {
  id?: string;
  properties?: {
    mag?: number | null;
    place?: string | null;
    time?: number | null;
    tsunami?: number | null;
    alert?: string | null;
    url?: string | null;
    sig?: number | null;
    status?: string | null;
  };
  geometry?: { coordinates?: unknown };
}

/** Normalize a USGS GeoJSON FeatureCollection into Quake rows (bad features skipped). */
export function parseQuakes(json: unknown): Quake[] {
  const features = (json as { features?: RawFeature[] })?.features;
  if (!Array.isArray(features)) throw new OverviewError("unexpected USGS response shape");
  const out: Quake[] = [];
  for (const f of features) {
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const [lon, lat, depth] = c as number[];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const p = f.properties ?? {};
    out.push({
      id: f.id ?? "",
      mag: typeof p.mag === "number" ? p.mag : null,
      place: p.place ?? "",
      time: p.time != null ? new Date(p.time).toISOString() : "",
      lon,
      lat,
      depthKm: typeof depth === "number" ? Math.round(depth * 10) / 10 : null,
      tsunami: p.tsunami === 1,
      alert: p.alert ?? null,
      url: p.url ?? "",
      sig: typeof p.sig === "number" ? p.sig : null,
      status: p.status ?? null,
    });
  }
  return out;
}

export interface QuakeQuery {
  bbox?: BBox;
  minMagnitude?: number;
  start: string; // YYYY-MM-DD
  end?: string;
  limit?: number;
  orderby?: "time" | "magnitude";
}

export async function quakes(q: QuakeQuery): Promise<Quake[]> {
  const params = new URLSearchParams({
    format: "geojson",
    starttime: q.start,
    orderby: q.orderby ?? "time",
    limit: String(Math.max(1, Math.min(2000, q.limit ?? 200))),
  });
  if (q.end) params.set("endtime", q.end);
  if (q.minMagnitude != null) params.set("minmagnitude", String(q.minMagnitude));
  if (q.bbox) {
    assertBBox(q.bbox);
    const [west, south, east, north] = q.bbox;
    params.set("minlongitude", String(west));
    params.set("maxlongitude", String(east));
    params.set("minlatitude", String(south));
    params.set("maxlatitude", String(north));
  }
  const res = await fetch(`${USGS_BASE}?${params.toString()}`, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`USGS request failed (${res.status})`, res.status, body.slice(0, 300));
  }
  return parseQuakes(await res.json());
}
