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

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";

/** Administrative areas around a point — nothing finer, so never a facility, operator or person. */
export interface AdminPlace {
  county?: string;
  state?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, lower case. */
  countryCode?: string;
}

/** Nominatim `reverse` URL. zoom 8 ≈ county, 5 ≈ state; coordinates rounded to 3 dp (~100 m). */
export function reverseGeocodeUrl(lat: number, lon: number, zoom = 8): string {
  const r = (v: number) => String(Math.round(v * 1000) / 1000);
  return `${NOMINATIM_REVERSE}?${new URLSearchParams({ lat: r(lat), lon: r(lon), zoom: String(zoom), format: "jsonv2", addressdetails: "1", "accept-language": "en" })}`;
}

/**
 * Keep only admin levels from a Nominatim `reverse` answer. `name` / `display_name` and every
 * non-admin address key are dropped on purpose: for an industrial point Nominatim can answer
 * with the facility, i.e. an operator's name. No match ({ error }) → {}.
 */
export function parseReverseGeocode(body: unknown): AdminPlace {
  const a = ((body ?? {}) as { address?: Record<string, unknown> }).address ?? {};
  const s = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim() : undefined);
  const out: AdminPlace = {};
  const county = s("county") ?? s("state_district");
  const state = s("state") ?? s("province") ?? s("region");
  if (county) out.county = county;
  if (state) out.state = state;
  if (s("country")) out.country = s("country");
  if (s("country_code")) out.countryCode = s("country_code")!.toLowerCase();
  return out;
}

/** Reverse-geocode a point to its county/state/country. Nominatim ToS: ≤1 req/s — callers pace. */
export async function reverseGeocode(lat: number, lon: number, zoom = 8): Promise<AdminPlace> {
  const res = await fetch(reverseGeocodeUrl(lat, lon, zoom), { headers: { "user-agent": USER_AGENT, "accept-language": "en" } });
  if (!res.ok) throw new OverviewError(`Nominatim reverse geocoding failed (${res.status})`, res.status);
  return parseReverseGeocode(await res.json());
}

/**
 * Drop generic admin words for a readable label: "Dehloran County" → "Dehloran", "Municipio
 * Ezequiel Zamora" → "Ezequiel Zamora", "Delta State" → "Delta". Kept when only a compass word
 * would remain ("Eastern Province").
 */
export function shortAdmin(name: string): string {
  const s = name
    .replace(/\s+\((département|department|province)\)$/i, "")
    .replace(/^(Municipio|Departamento|Partido|Distrito|District de|Département de|Provincia de)\s+/i, "")
    .replace(/\s+(County|District|Province|Governorate|Region|Municipality|Prefecture|Oblast|Krai|Department|Regency|Division|State|Rayon|Ulus)$/i, "")
    .trim();
  return !s || /^(north|south|east|west|central|eastern|western|northern|southern)$/i.test(s) ? name : s;
}

/** "Dehloran, Ilam (Iran)" / "Bayelsa (Nigeria)" / null when nothing usable came back. */
export function adminLabel(p: AdminPlace | null | undefined): string | null {
  if (!p) return null;
  // Nominatim sometimes ignores accept-language=en for small units; a label must be readable.
  const parts = [p.county, p.state].filter((x): x is string => !!x && /[A-Za-z]/.test(x)).map(shortAdmin);
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  if (!uniq.length) return p.country ?? null;
  return p.country ? `${uniq.join(", ")} (${p.country})` : uniq.join(", ");
}
