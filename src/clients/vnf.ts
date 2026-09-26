// Gas flaring, from two open signals:
//  (a) NASA FIRMS VIIRS night-time detections (public domain), clustered to ~1 km and counted
//      per night — persistence across many nights is what separates a flare from a wildfire;
//  (b) the Earth Observation Group (Colorado School of Mines) VIIRS Nightfire ANNUAL global
//      flare summary — a zero-key public KML per year (per-site flared volume, type, clear
//      observations). Annual/monthly aggregates may be redistributed with credit; nightly VNF
//      detections sit behind an account + signed licence and are NOT used here.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox, FireDetection } from "../types.js";
import { addDays, assertBBox, isoDate } from "../util.js";
import { fires } from "./nasa.js";

/** Default FIRMS sensors for flaring. S-NPP science products end on/after 1 Nov 2026 — not a default. */
export const FLARING_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"] as const;
export type FlaringSource = (typeof FLARING_SOURCES)[number];

/** FIRMS area API rejects longer ranges: "Invalid day range. Expects [1..5]" (live, 2026-09-26). */
export const FIRMS_MAX_DAY_RANGE = 5;

export const FIRMS_HREF = "https://firms.modaps.eosdis.nasa.gov/";
export const EOG_VNF_HREF = "https://eogdata.mines.edu/products/vnf/global_gas_flare.html";
export const VNF_CREDIT =
  "Earth Observation Group, Payne Institute for Public Policy, Colorado School of Mines — VIIRS Nightfire global flare summary";

/** Zero-key annual flare summaries linked from EOG's global gas flaring page (checked live 2026-09-26). */
export const VNF_ANNUAL: Readonly<Record<number, { url: string; sensor: string }>> = {
  2024: { url: "https://eogdata.mines.edu/global_flare_data/2024_flare_summary_v20250730_j01.kml", sensor: "VIIRS NOAA-20 (J01)" },
  2023: { url: "https://eogdata.mines.edu/global_flare_data/2023_flare_summary_v20240314_npp.kml", sensor: "VIIRS S-NPP" },
};
export const VNF_DEFAULT_YEAR = 2024;

// ---- FIRMS window --------------------------------------------------------------------------

/** Split an N-day window ending on `end` (inclusive) into FIRMS-sized {date, dayRange} requests. */
export function windowChunks(end: string, days: number, max = FIRMS_MAX_DAY_RANGE): { date: string; dayRange: number }[] {
  const out: { date: string; dayRange: number }[] = [];
  let date = addDays(end, -(days - 1));
  for (let done = 0; done < days; ) {
    const dayRange = Math.min(max, days - done);
    out.push({ date, dayRange });
    done += dayRange;
    date = addDays(date, dayRange);
  }
  return out;
}

export type SourcedDetection = FireDetection & { source: string };

/** Fetch every detection in the window, sequentially (be polite to the FIRMS transaction budget). */
export async function firmsWindow(
  mapKey: string,
  bbox: BBox,
  opts: { days: number; end: string; sources: readonly string[] },
): Promise<{ detections: SourcedDetection[]; requests: number }> {
  const detections: SourcedDetection[] = [];
  let requests = 0;
  for (const source of opts.sources) {
    for (const c of windowChunks(opts.end, opts.days)) {
      const list = await fires(mapKey, bbox, { source, date: c.date, dayRange: c.dayRange });
      requests++;
      for (const f of list) detections.push({ ...f, source });
    }
  }
  return { detections, requests };
}

// ---- persistence math (pure) ---------------------------------------------------------------

/**
 * The local night a detection belongs to, as the date of its evening (YYYY-MM-DD). Uses local
 * solar time (UTC + lon/15 h) shifted back 12 h, so the ~01:30 local NOAA-20/21 passes of one
 * night — which can straddle UTC midnight — count once, whatever the time zone.
 */
export function nightKey(f: Pick<FireDetection, "acqDate" | "acqTime" | "lon">): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.acqDate)) return null;
  const t = (f.acqTime ?? "0000").padStart(4, "0");
  const minutes = Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4));
  if (!Number.isFinite(minutes)) return null;
  const utc = Date.parse(`${f.acqDate}T00:00:00Z`) + minutes * 60_000;
  return new Date(utc + (f.lon / 15) * 3_600_000 - 12 * 3_600_000).toISOString().slice(0, 10);
}

/** Equirectangular distance in km — plenty for ~1 km clustering. */
export function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * 110.57;
  const dx = (lon2 - lon1) * 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export interface FlareCluster {
  lat: number;
  lon: number;
  /** Distinct local nights with ≥1 qualifying detection. */
  nights: number;
  detections: number;
  meanFrp: number;
  maxFrp: number;
  firstNight: string;
  lastNight: string;
  sources: string[];
  vnf?: { id: string; type: string; bcm: number; km: number } | null;
}

/**
 * Night-time (daynight == "N"), FRP ≥ minFrp detections, leader-clustered: sorted by FRP
 * descending, each detection joins the first cluster whose seed is within `clusterKm`, else
 * seeds a new one. Deterministic; the brightest pixel anchors each ~1 km cell.
 */
export function clusterFlares(
  dets: readonly SourcedDetection[],
  opts: { minFrp: number; clusterKm: number },
): { nightDetections: number; hotNightDetections: number; clusters: FlareCluster[] } {
  const night = dets.filter((d) => d.daynight === "N");
  const hot = night
    .filter((d) => (d.frp ?? 0) >= opts.minFrp && nightKey(d) !== null)
    .sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0) || a.lat - b.lat || a.lon - b.lon);

  const groups: { seedLat: number; seedLon: number; members: SourcedDetection[] }[] = [];
  for (const d of hot) {
    const g = groups.find((c) => kmBetween(c.seedLat, c.seedLon, d.lat, d.lon) <= opts.clusterKm);
    if (g) g.members.push(d);
    else groups.push({ seedLat: d.lat, seedLon: d.lon, members: [d] });
  }

  const clusters = groups.map(({ members }): FlareCluster => {
    const nights = [...new Set(members.map((m) => nightKey(m)!))].sort();
    const frps = members.map((m) => m.frp ?? 0);
    return {
      lat: round(members.reduce((a, m) => a + m.lat, 0) / members.length, 4),
      lon: round(members.reduce((a, m) => a + m.lon, 0) / members.length, 4),
      nights: nights.length,
      detections: members.length,
      meanFrp: round(frps.reduce((a, v) => a + v, 0) / frps.length, 2),
      maxFrp: round(Math.max(...frps), 2),
      firstNight: nights[0]!,
      lastNight: nights[nights.length - 1]!,
      sources: [...new Set(members.map((m) => m.source))].sort(),
    };
  });
  clusters.sort((a, b) => b.nights - a.nights || b.maxFrp - a.maxFrp);
  return { nightDetections: night.length, hotNightDetections: hot.length, clusters };
}

// ---- VNF annual flare summary --------------------------------------------------------------

export interface VnfSite {
  id: string;
  country: string;
  type: string;
  lat: number;
  lon: number;
  /** Billion cubic metres flared in the year. */
  bcm: number;
  clearObs: number | null;
  /** EOG "Clear PCT" column, %. */
  clearPct: number | null;
  tAvgK: number | null;
}

/** Parse EOG's annual flare-summary KML (one Placemark per site, attributes in an HTML table). */
export function parseVnfKml(kml: string): VnfSite[] {
  if (!kml.includes("<kml")) throw new OverviewError(`unexpected VNF response (not KML — login wall?): ${kml.slice(0, 120)}`);
  const out: VnfSite[] = [];
  for (const pm of kml.split("<Placemark>").slice(1)) {
    const ll = /Lat=(-?[\d.]+),\s*Lon=(-?[\d.]+)/.exec(pm);
    const bcm = /BCM_total=(-?[\d.]+)/.exec(pm);
    if (!ll || !bcm) continue;
    const lat = Number(ll[1]);
    const lon = Number(ll[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const row = /<tr><td>\d{4}<\/td><td>[-\d.]+<\/td><td>(\d+)<\/td><td>([\d.]+)%/.exec(pm);
    const vector = /Vector: <b>(\d+)<\/b>/.exec(pm)?.[1];
    out.push({
      id: /<name>([^<]+)<\/name>/.exec(pm)?.[1]?.trim() || `vnf-${vector ?? out.length + 1}`,
      country: /Country: <b>([^<]*)<\/b>/.exec(pm)?.[1] ?? "",
      type: /Type: ([^<]+)</.exec(pm)?.[1]?.trim() ?? "unknown",
      lat,
      lon,
      bcm: Number(bcm[1]),
      clearObs: row ? Number(row[1]) : null,
      clearPct: row ? Number(row[2]) : null,
      tAvgK: toNum(/T avg\.=([\d.]+)/.exec(pm)?.[1]),
    });
  }
  return out;
}

const vnfCache = new Map<number, Promise<VnfSite[]>>();

/** The year's global flare summary (≈12 MB KML, fetched once per process and cached). */
export async function vnfAnnual(year = VNF_DEFAULT_YEAR): Promise<{ year: number; sensor: string; url: string; sites: VnfSite[] }> {
  const spec = VNF_ANNUAL[year];
  if (!spec) throw new OverviewError(`no zero-key VNF annual flare summary known for ${year} (have ${Object.keys(VNF_ANNUAL).join(", ")})`);
  let p = vnfCache.get(year);
  if (!p) {
    p = (async () => {
      const res = await fetch(spec.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(90_000) });
      const text = await res.text();
      if (!res.ok) throw new OverviewError(`EOG VNF request failed (${res.status})`, res.status, text.slice(0, 300));
      return parseVnfKml(text);
    })();
    vnfCache.set(year, p);
    p.catch(() => vnfCache.delete(year));
  }
  return { year, sensor: spec.sensor, url: spec.url, sites: await p };
}

export function sitesIn(bbox: BBox, sites: readonly VnfSite[]): VnfSite[] {
  const [w, s, e, n] = bbox;
  return sites.filter((x) => x.lon >= w && x.lon <= e && x.lat >= s && x.lat <= n);
}

export function nearestSite(lat: number, lon: number, sites: readonly VnfSite[], maxKm: number): { site: VnfSite; km: number } | null {
  let best: { site: VnfSite; km: number } | null = null;
  for (const site of sites) {
    const km = kmBetween(lat, lon, site.lat, site.lon);
    if (km <= maxKm && (!best || km < best.km)) best = { site, km };
  }
  return best;
}

// ---- the report the `flaring` tool returns -------------------------------------------------

export interface FlaringOptions {
  days?: number;
  end?: string;
  minFrp?: number;
  minNights?: number;
  clusterKm?: number;
  sources?: readonly string[];
  vnf?: boolean;
  vnfYear?: number;
  limit?: number;
}

export const FLARING_DEFAULTS = { days: 30, minFrp: 3, minNights: 5, clusterKm: 1, vnfYear: VNF_DEFAULT_YEAR, limit: 50 } as const;

export async function flaringReport(mapKey: string, bbox: BBox, o: FlaringOptions = {}) {
  assertBBox(bbox);
  const days = o.days ?? FLARING_DEFAULTS.days;
  const end = o.end ?? isoDate(0);
  const minFrp = o.minFrp ?? FLARING_DEFAULTS.minFrp;
  const minNights = o.minNights ?? FLARING_DEFAULTS.minNights;
  const clusterKm = o.clusterKm ?? FLARING_DEFAULTS.clusterKm;
  const sources = o.sources?.length ? [...o.sources] : [...FLARING_SOURCES];
  const limit = o.limit ?? FLARING_DEFAULTS.limit;
  const matchKm = Math.max(2, clusterKm * 2);

  const { detections, requests } = await firmsWindow(mapKey, bbox, { days, end, sources });
  const c = clusterFlares(detections, { minFrp, clusterKm });
  const persistent = c.clusters.filter((x) => x.nights >= minNights);

  let vnf: Record<string, unknown>;
  if (o.vnf === false) {
    vnf = { available: false, reason: "not requested", href: EOG_VNF_HREF };
  } else {
    try {
      const a = await vnfAnnual(o.vnfYear ?? FLARING_DEFAULTS.vnfYear);
      const local = sitesIn(bbox, a.sites).sort((x, y) => y.bcm - x.bcm);
      for (const cl of persistent) {
        const m = nearestSite(cl.lat, cl.lon, local, matchKm);
        cl.vnf = m ? { id: m.site.id, type: m.site.type, bcm: m.site.bcm, km: round(m.km, 2) } : null;
      }
      vnf = {
        available: true,
        product: "VNF annual global flare summary (aggregate; nightly VNF not used)",
        year: a.year,
        sensor: a.sensor,
        href: EOG_VNF_HREF,
        file: a.url,
        credit: VNF_CREDIT,
        sitesInBbox: local.length,
        bcmTotal: round(local.reduce((s, x) => s + x.bcm, 0), 3),
        matchKm,
        matchedClusters: persistent.filter((x) => x.vnf).length,
        sites: local.slice(0, 20).map(({ id, type, lat, lon, bcm, clearObs, clearPct }) => ({ id, type, lat, lon, bcm, clearObs, clearPct })),
      };
    } catch (err) {
      vnf = { available: false, reason: err instanceof Error ? err.message : String(err), href: EOG_VNF_HREF };
    }
  }

  return {
    bbox,
    window: { from: addDays(end, -(days - 1)), to: end, days },
    thresholds: { minFrp, minNights, clusterKm },
    counts: {
      detections: detections.length,
      nightDetections: c.nightDetections,
      hotNightDetections: c.hotNightDetections,
      clusters: c.clusters.length,
      persistentClusters: persistent.length,
    },
    clusters: persistent.slice(0, limit),
    truncated: persistent.length > limit,
    vnf,
    provenance: {
      dataSource: "NASA FIRMS active fire (VIIRS 375 m), public domain",
      sensors: sources,
      firmsRequests: requests,
      href: FIRMS_HREF,
      method: {
        name: "flaring",
        version: "1.0",
        nightFilter: 'daynight == "N"',
        frpFilter: `frp >= ${minFrp} MW`,
        night: "local solar night (UTC + lon/15 h − 12 h), so one night's passes count once",
        clustering: `leader clustering by descending FRP, radius ${clusterKm} km`,
        persistence: `cluster lit on >= ${minNights} distinct nights of the ${days}-day window`,
        vnfMatch: `nearest VNF annual site within ${matchKm} km of the cluster centroid`,
      },
      retrievedAt: new Date().toISOString(),
      caveat:
        "A persistent night-time heat source is consistent with a gas flare but also with furnaces, kilns, refineries or volcanoes; cloud hides nights; FRP is not a flared-volume estimate.",
    },
  };
}

export type FlaringReport = Awaited<ReturnType<typeof flaringReport>>;

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function toNum(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
