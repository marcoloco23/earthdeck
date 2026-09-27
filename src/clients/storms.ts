// Active tropical cyclones, keyless, from two public feeds (endpoints verified live 2026-09-27):
//
// - NOAA NHC / CPHC — authoritative for the Atlantic and eastern/central North Pacific.
//   `CurrentStorms.json` (status, intensity, advisory links) + the NWS tropical weather summary
//   ArcGIS MapServer (layer 5 forecast points, layer 7 forecast cone) queried as GeoJSON.
//   U.S. public data (weather.gov/disclaimer). NHC sends no CORS header → server-side only.
// - GDACS (UN OCHA / EC JRC) — every basin, incl. the Bay of Bengal, West Pacific, South Indian
//   Ocean and Australia, which NHC does not cover. Event list + per-event geometry (uncertainty
//   cone polygon, track lines). Provided "as is", automatic, not human-reviewed.
//
// NHC wins where both cover a storm (deduped by name). Wind speeds are normalized to knots and
// the Saffir–Simpson category is derived from them (1-min sustained for NHC/JTWC; other RSMCs
// use 10-min winds, which reads ~1 category low — a stated blind spot of the rule).

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox, EonetEvent } from "../types.js";
import { addDays } from "../util.js";

export const NHC_CURRENT = "https://www.nhc.noaa.gov/CurrentStorms.json";
export const NHC_GIS = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer";
export const GDACS_LIST = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";

type Position = [number, number];
export type ConeGeometry = { type: "Polygon"; coordinates: Position[][] } | { type: "MultiPolygon"; coordinates: Position[][][] };

export interface TrackPoint {
  lat: number;
  lon: number;
  /** Valid time (RFC 3339) when known. */
  t: string | null;
  /** Hours ahead of the advisory (0 = analysis). */
  tauH: number | null;
  maxWindKt: number | null;
  category: number | null;
}

export interface Storm {
  id: string;
  name: string;
  source: "noaa-nhc" | "gdacs";
  basin: string;
  /** Classification as the source states it (TD, TS, HU, STS, "Tropical Storm", …). */
  classification: string;
  maxWindKt: number | null;
  /** Saffir–Simpson category from the current wind (0 = below hurricane force). */
  category: number | null;
  /** Highest category anywhere on the forecast track (≥ current). */
  peakCategory: number | null;
  pressureMb: number | null;
  position: { lat: number; lon: number } | null;
  advisory: { number: string | null; issued: string | null; url: string | null };
  track: TrackPoint[];
  cone: ConeGeometry | null;
  /** [west, south, east, north] over the cone + track + position. */
  bbox: BBox | null;
}

/** Saffir–Simpson category from 1-min sustained wind in knots (0 below hurricane force). */
export function saffirSimpson(kt: number | null): number | null {
  if (kt == null || !Number.isFinite(kt)) return null;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  if (kt >= 64) return 1;
  return 0;
}

export function categoryLabel(cat: number | null, classification = ""): string {
  if (cat != null && cat >= 1) return `category ${cat}`;
  if (/TD|depression/i.test(classification)) return "tropical depression";
  return "tropical storm";
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`storm feed request failed (${res.status}) ${url.split("?")[0]}`, res.status, body.slice(0, 300));
  }
  return (await res.json()) as T;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// ---- geometry ---------------------------------------------------------------------------

function rings(g: ConeGeometry): Position[][] {
  return g.type === "Polygon" ? [g.coordinates[0] ?? []] : g.coordinates.map((p) => p[0] ?? []);
}

export function geometryBBox(points: Position[]): BBox | null {
  if (points.length === 0) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    w = Math.min(w, x); e = Math.max(e, x);
    s = Math.min(s, y); n = Math.max(n, y);
  }
  return [w, s, e, n];
}

function pointInRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: Position, b: Position, c: Position, d: Position): boolean {
  const o = (p: Position, q: Position, r: Position) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Does a cone (outer rings) touch a bbox? Vertex-in-box, box-corner-in-cone, or edges cross. */
export function coneIntersectsBBox(cone: ConeGeometry, bbox: BBox): boolean {
  const [w, s, e, n] = bbox;
  const corners: Position[] = [[w, s], [e, s], [e, n], [w, n]];
  const edges: [Position, Position][] = [[corners[0]!, corners[1]!], [corners[1]!, corners[2]!], [corners[2]!, corners[3]!], [corners[3]!, corners[0]!]];
  for (const ring of rings(cone)) {
    if (ring.some(([x, y]) => x >= w && x <= e && y >= s && y <= n)) return true;
    if (corners.some(([x, y]) => pointInRing(x, y, ring))) return true;
    for (let i = 1; i < ring.length; i++) for (const [p, q] of edges) if (segmentsCross(ring[i - 1]!, ring[i]!, p, q)) return true;
  }
  return false;
}

/** A storm "touches" a bbox if its cone intersects it, or (no cone) a track point/position lies in it. */
export function stormTouchesBBox(storm: Storm, bbox: BBox): boolean {
  if (storm.cone && coneIntersectsBBox(storm.cone, bbox)) return true;
  const [w, s, e, n] = bbox;
  const pts = [...storm.track, ...(storm.position ? [storm.position] : [])];
  return pts.some((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n);
}

function finishStorm(s: Omit<Storm, "bbox" | "peakCategory">): Storm {
  const pts: Position[] = [];
  if (s.cone) for (const r of rings(s.cone)) pts.push(...r);
  for (const p of s.track) pts.push([p.lon, p.lat]);
  if (s.position) pts.push([s.position.lon, s.position.lat]);
  const cats = [s.category, ...s.track.map((p) => p.category)].filter((c): c is number => c != null);
  return { ...s, peakCategory: cats.length ? Math.max(...cats) : null, bbox: geometryBBox(pts) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
function roundGeom(g: ConeGeometry): ConeGeometry {
  return g.type === "Polygon"
    ? { type: "Polygon", coordinates: g.coordinates.map((r) => r.map(([x, y]) => [round3(x), round3(y)] as Position)) }
    : { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((r) => r.map(([x, y]) => [round3(x), round3(y)] as Position))) };
}

// ---- NHC / CPHC --------------------------------------------------------------------------

interface NhcActive {
  id: string;
  name: string;
  classification: string;
  intensity: string;
  pressure: string;
  latitudeNumeric: number;
  longitudeNumeric: number;
  lastUpdate?: string;
  publicAdvisory?: { advNum?: string; issuance?: string; url?: string };
}
interface GeoJsonFC {
  features?: Array<{ geometry: { type: string; coordinates: unknown } | null; properties: Record<string, unknown> }>;
}

/** NHC `validtime` "DD/HHMM" → RFC 3339, anchored on the advisory month (rolls over month end). */
export function nhcValidTime(validtime: unknown, issued: string | null): string | null {
  if (typeof validtime !== "string" || !issued) return null;
  const m = /^(\d{2})\/(\d{2})(\d{2})$/.exec(validtime);
  if (!m) return null;
  const base = new Date(issued);
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Number(m[1]), Number(m[2]), Number(m[3])));
  if (d.getTime() < base.getTime() - 5 * 86_400_000) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function gisQuery(layer: number, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ where: "1=1", outFields: "*", returnGeometry: "true", f: "geojson", outSR: "4326", ...extra });
  return `${NHC_GIS}/${layer}/query?${p.toString()}`;
}

export async function nhcStorms(): Promise<Storm[]> {
  const current = await getJson<{ activeStorms?: NhcActive[] }>(NHC_CURRENT);
  const active = current.activeStorms ?? [];
  if (active.length === 0) return [];
  // Cone generalized server-side (~0.05°) so a whole basin's cones stay a few KB.
  const [points, cones] = await Promise.all([
    getJson<GeoJsonFC>(gisQuery(5)).catch(() => ({ features: [] }) as GeoJsonFC),
    getJson<GeoJsonFC>(gisQuery(7, { maxAllowableOffset: "0.05", geometryPrecision: "3" })).catch(() => ({ features: [] }) as GeoJsonFC),
  ]);
  // GIS features carry `idp_source` like "al062026-028_5day_pts" → storm id "al062026".
  const sid = (p: Record<string, unknown>) => String(p.idp_source ?? "").split("-")[0]!.toLowerCase();
  return active.map((a) => {
    const id = a.id.toLowerCase();
    const issued = a.publicAdvisory?.issuance ?? a.lastUpdate ?? null;
    const kt = num(a.intensity);
    const track: TrackPoint[] = (points.features ?? [])
      .filter((f) => sid(f.properties) === id && f.geometry?.type === "Point")
      .map((f) => {
        const [lon, lat] = f.geometry!.coordinates as number[];
        const w = num(f.properties.maxwind);
        return { lat: round3(lat!), lon: round3(lon!), t: nhcValidTime(f.properties.validtime, issued), tauH: num(f.properties.tau), maxWindKt: w, category: saffirSimpson(w) };
      })
      .sort((x, y) => (x.tauH ?? 0) - (y.tauH ?? 0));
    const coneF = (cones.features ?? []).find((f) => sid(f.properties) === id && (f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon"));
    return finishStorm({
      id,
      name: a.name,
      source: "noaa-nhc",
      basin: id.slice(0, 2).toUpperCase(),
      classification: a.classification,
      maxWindKt: kt,
      category: saffirSimpson(kt),
      pressureMb: num(a.pressure),
      position: { lat: a.latitudeNumeric, lon: a.longitudeNumeric },
      advisory: { number: a.publicAdvisory?.advNum ?? null, issued, url: a.publicAdvisory?.url ?? null },
      track,
      cone: coneF ? roundGeom(coneF.geometry as ConeGeometry) : null,
    });
  });
}

// ---- GDACS -------------------------------------------------------------------------------

interface GdacsEvent {
  geometry: { type: string; coordinates: number[] };
  properties: {
    eventid: number;
    episodeid: number;
    eventname?: string;
    name?: string;
    iscurrent?: string | boolean;
    todate?: string;
    alertlevel?: string;
    source?: string;
    severitydata?: { severity?: number; severityunit?: string; severitytext?: string };
    url?: { geometry?: string; report?: string };
  };
}

/** "SURIGAE-26" → "Surigae" (GDACS names carry a year suffix and are upper-case). */
export function gdacsStormName(eventname: string | undefined): string {
  const base = (eventname ?? "").replace(/-\d{2}$/, "");
  return base.charAt(0) + base.slice(1).toLowerCase();
}

function kmhToKt(v: number | null): number | null {
  return v == null ? null : Math.round(v / 1.852);
}

export async function gdacsStorms(today: string, maxEvents = 12): Promise<Storm[]> {
  const params = new URLSearchParams({ eventlist: "TC", fromdate: addDays(today, -10), todate: today, alertlevel: "green;orange;red" });
  const list = await getJson<{ features?: GdacsEvent[] }>(`${GDACS_LIST}?${params.toString()}`);
  const current = (list.features ?? []).filter((f) => String(f.properties.iscurrent) === "true").slice(0, maxEvents);
  return Promise.all(
    current.map(async (f) => {
      const p = f.properties;
      const sev = p.severitydata;
      const kt = sev?.severityunit === "km/h" ? kmhToKt(num(sev.severity)) : null;
      let cone: ConeGeometry | null = null;
      const track: TrackPoint[] = [];
      if (p.url?.geometry) {
        try {
          const g = await getJson<GeoJsonFC>(p.url.geometry);
          for (const feat of g.features ?? []) {
            const cls = String(feat.properties.Class ?? "");
            if (cls === "Poly_Cones" && (feat.geometry?.type === "Polygon" || feat.geometry?.type === "MultiPolygon")) cone = roundGeom(feat.geometry as ConeGeometry);
            // Track segments are LineStrings labelled with the stage (TD/TS/HU …).
            if (cls.startsWith("Line_") && feat.geometry?.type === "LineString") {
              for (const [lon, lat] of feat.geometry.coordinates as number[][]) {
                const last = track[track.length - 1];
                if (last && last.lon === round3(lon!) && last.lat === round3(lat!)) continue;
                track.push({ lat: round3(lat!), lon: round3(lon!), t: null, tauH: null, maxWindKt: null, category: null });
              }
            }
          }
        } catch {
          /* list entry still stands without geometry */
        }
      }
      const [lon, lat] = f.geometry.coordinates;
      return finishStorm({
        id: `gdacs-tc-${p.eventid}`,
        name: gdacsStormName(p.eventname),
        source: "gdacs" as const,
        basin: "global",
        classification: sev?.severitytext?.split(" (")[0] ?? "Tropical cyclone",
        maxWindKt: kt,
        category: saffirSimpson(kt),
        pressureMb: null,
        position: lat != null && lon != null ? { lat, lon } : null,
        advisory: { number: String(p.episodeid), issued: p.todate ? `${p.todate.slice(0, 19)}Z` : null, url: p.url?.report ?? null },
        track,
        cone,
      });
    }),
  );
}

export interface StormsResult {
  storms: Storm[];
  sources: { nhc: "ok" | string; gdacs: "ok" | string };
}

/** NHC first, then GDACS for everything NHC does not already cover (deduped by name). */
export async function activeStorms(today: string): Promise<StormsResult> {
  const sources: StormsResult["sources"] = { nhc: "ok", gdacs: "ok" };
  const [nhc, gd] = await Promise.all([
    nhcStorms().catch((e: unknown) => ((sources.nhc = e instanceof Error ? e.message : String(e)), [] as Storm[])),
    gdacsStorms(today).catch((e: unknown) => ((sources.gdacs = e instanceof Error ? e.message : String(e)), [] as Storm[])),
  ]);
  if (sources.nhc !== "ok" && sources.gdacs !== "ok") throw new OverviewError(`both storm feeds failed — NHC: ${sources.nhc}; GDACS: ${sources.gdacs}`);
  const names = new Set(nhc.map((s) => s.name.toLowerCase()));
  return { storms: [...nhc, ...gd.filter((s) => !names.has(s.name.toLowerCase()))], sources };
}

// ---- EONET cross-check ------------------------------------------------------------------

type EonetLike = Pick<EonetEvent, "id" | "title" | "coordinates">;

/** EONET severe-storm events that plausibly are this storm: same name, or within `km`. */
export function matchEonet(storm: Pick<Storm, "name" | "position">, events: EonetLike[], km = 500): EonetLike | null {
  const name = storm.name.trim().toLowerCase();
  const byName = name.length >= 3 ? events.find((e) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(e.title)) : undefined;
  if (byName) return byName;
  if (!storm.position) return null;
  const { lat, lon } = storm.position;
  let best: { e: EonetLike; d: number } | null = null;
  for (const e of events) {
    if (!e.coordinates) continue;
    const d = haversineKm(lat, lon, e.coordinates[1], e.coordinates[0]);
    if (d <= km && (!best || d < best.d)) best = { e, d };
  }
  return best?.e ?? null;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

