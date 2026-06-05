import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

export interface GeoPlace {
  query: string;
  displayName: string;
  bbox: BBox;
  center: [number, number]; // [lon, lat]
}

/**
 * Resolve a place name to a bbox via OpenStreetMap Nominatim. Free, no key.
 * Nominatim ToS: ≤1 request/second and a descriptive User-Agent — fine for one lookup
 * per tool call. boundingbox order is [south, north, west, east].
 */
export async function geocode(place: string): Promise<GeoPlace> {
  const url = `${NOMINATIM}?${new URLSearchParams({ q: place, format: "json", limit: "1" })}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, "accept-language": "en" } });
  if (!res.ok) {
    throw new OverviewError(`Nominatim geocoding failed (${res.status})`, res.status);
  }
  const arr = (await res.json()) as Array<{
    display_name?: string;
    lat?: string;
    lon?: string;
    boundingbox?: [string, string, string, string];
  }>;
  const r = arr[0];
  if (!r || !r.boundingbox) {
    throw new OverviewError(`No match for "${place}"`);
  }
  const [south, north, west, east] = r.boundingbox.map(Number) as [number, number, number, number];
  return {
    query: place,
    displayName: r.display_name ?? place,
    bbox: [west, south, east, north],
    center: [Number(r.lon), Number(r.lat)],
  };
}
