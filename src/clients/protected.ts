// Protected areas + Indigenous/community lands intersecting an AOI (`protected_areas`).
//
// Two republishable sources, each row carrying its own licence:
// - OSM via Overpass: `boundary=protected_area|national_park|aboriginal_lands` (ODbL).
//   Zero-key. We ask for tags + centre + bounds only (never full geometry — relations like
//   Indigenous territories are huge), plus an `is_in` lookup for exact point-in-polygon of
//   the AOI centroid.
// - LandMark (Indigenous & community lands) via the GFW Data API vector dataset
//   `landmark_ip_lc_and_indicative_poly` (LandMark's own map only exposes MVT tiles; the GFW
//   mirror is the queryable endpoint). Needs the same free GFW_API_KEY as forest_alerts;
//   without it the source is skipped cleanly. Licence per GFW metadata: CC BY-SA 4.0.
// - WDPA via the GFW Data API dataset `wdpa_protected_areas` (same GFW_API_KEY): IDs, names,
//   designation, IUCN category, reported area and containment only — never geometry, per the
//   WDPA licence.
//
// Indigenous lands are never returned as precise pins: every centroid here is rounded to
// 0.1° (~11 km), and nothing returns polygons.

import { overpassUrl, USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { bboxCenter } from "../util.js";
import { bboxToPolygon, gfwQuery } from "./gfw.js";

export const OSM_LICENCE = "ODbL 1.0 — © OpenStreetMap contributors";
export const LANDMARK_LICENCE = "CC BY-SA 4.0 — LandMark (landmarkmap.org), via Global Forest Watch Data API";
export const LANDMARK_DATASET = "landmark_ip_lc_and_indicative_poly";

const BOUNDARY_RE = "^(protected_area|national_park|aboriginal_lands)$";

export interface ProtectedArea {
  source: "osm" | "landmark" | "wdpa";
  id: string;
  name: string | null;
  designation: string | null;
  category: string | null;
  indigenous: boolean;
  licence: string;
  /** Approximate area in km²; see `areaBasis` for what it measures. */
  approxAreaKm2: number | null;
  areaBasis: "gis" | "bbox-extent-upper-bound" | null;
  /** [lon, lat] rounded to 0.1° — deliberately coarse. */
  coarseCentroid: [number, number] | null;
  /** Does the polygon contain the AOI bbox centroid? null = unknown. */
  containsAoiCentroid: boolean | null;
  url: string | null;
}

const coarse = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Area of a lon/lat box in km² (spherical, good enough for an upper-bound extent). */
export function bboxAreaKm2(bbox: BBox): number {
  const [w, s, e, n] = bbox;
  const R = 6371.0088;
  const rad = Math.PI / 180;
  return R * R * (e - w) * rad * Math.abs(Math.sin(n * rad) - Math.sin(s * rad));
}

// ---------------------------------------------------------------- OSM / Overpass

/**
 * Overpass QL. A bbox filter only matches a relation through members inside the bbox, so
 * a huge territory that *contains* the whole AOI would be missed (verified live near
 * Kayapó). Hence: features with members in the bbox ∪ features whose area contains the
 * AOI centroid (`is_in` → `pivot` back to the way/relation). Output: tags + centre +
 * bounds for all, then the containing area ids (drive `containsAoiCentroid`).
 */
export function overpassQuery(bbox: BBox): string {
  const [w, s, e, n] = bbox;
  const [lon, lat] = bboxCenter(bbox);
  return (
    `[out:json][timeout:60];\n` +
    `wr["boundary"~"${BOUNDARY_RE}"](${s},${w},${n},${e})->.inbox;\n` +
    `is_in(${lat},${lon})->.a;\n` +
    `area.a["boundary"~"${BOUNDARY_RE}"]->.hit;\n` +
    `(rel(pivot.hit);way(pivot.hit);)->.contain;\n` +
    `(.inbox;.contain;);\n` +
    `out tags center bb;\n` +
    `.hit out ids;`
  );
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

/** Is an OSM feature an Indigenous territory? (aboriginal_lands, or protect_class 24, or the title says so.) */
export function osmIsIndigenous(tags: Record<string, string>): boolean {
  if (tags.boundary === "aboriginal_lands" || tags.protect_class === "24") return true;
  const title = `${tags.protection_title ?? ""} ${tags.designation ?? ""}`.toLowerCase();
  return /ind[ií]gena|indigenous|aboriginal/.test(title);
}

/**
 * Parse an Overpass response from `overpassQuery`. Features come first (with tags); the
 * trailing `area` elements (ids only) mark which features contain the AOI centroid —
 * area id = 2400000000 + way id, 3600000000 + relation id.
 */
export function parseOverpass(json: { elements?: OsmElement[] }): ProtectedArea[] {
  const els = json.elements ?? [];
  const containing = new Set<string>();
  for (const el of els) {
    if (el.type !== "area") continue;
    if (el.id >= 3_600_000_000) containing.add(`relation/${el.id - 3_600_000_000}`);
    else if (el.id >= 2_400_000_000) containing.add(`way/${el.id - 2_400_000_000}`);
  }
  const out: ProtectedArea[] = [];
  for (const el of els) {
    if (el.type !== "way" && el.type !== "relation") continue;
    const tags = el.tags ?? {};
    const key = `${el.type}/${el.id}`;
    const b = el.bounds;
    const extent = b ? bboxAreaKm2([b.minlon, b.minlat, b.maxlon, b.maxlat]) : null;
    // Live Overpass omits `center` for relations under `out tags center bb` → fall back to
    // the bounds' centre (it's coarsened to 0.1° anyway).
    const c = el.center ?? (b ? { lon: (b.minlon + b.maxlon) / 2, lat: (b.minlat + b.maxlat) / 2 } : undefined);
    out.push({
      source: "osm",
      id: key,
      name: tags.name ?? tags["name:en"] ?? null,
      designation: tags.protection_title ?? tags.designation ?? (tags.boundary === "national_park" ? "National park" : null),
      category: tags.protect_class ? `protect_class ${tags.protect_class}` : (tags.boundary ?? null),
      indigenous: osmIsIndigenous(tags),
      licence: OSM_LICENCE,
      approxAreaKm2: extent == null ? null : Math.round(extent),
      areaBasis: extent == null ? null : "bbox-extent-upper-bound",
      coarseCentroid: c ? [coarse(c.lon), coarse(c.lat)] : null,
      // The is_in pass ran, so absence from it is a real "no" (for closed areas).
      containsAoiCentroid: containing.has(key),
      url: `https://www.openstreetmap.org/${key}`,
    });
  }
  return out;
}

/** POST the query to Overpass. 429/504 = shared instance busy → clear, non-hammering error. */
export async function overpassProtectedAreas(bbox: BBox): Promise<ProtectedArea[]> {
  const res = await fetch(overpassUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT,
      accept: "application/json",
    },
    body: new URLSearchParams({ data: overpassQuery(bbox) }).toString(),
  });
  const text = await res.text();
  if (res.status === 429 || res.status === 504) {
    throw new OverviewError(
      `Overpass is busy (HTTP ${res.status}) — retry in a minute, or point EARTHDECK_OVERPASS_URL at another instance`,
      res.status,
    );
  }
  if (!res.ok) throw new OverviewError(`Overpass query failed (${res.status})`, res.status, text.slice(0, 300));
  try {
    return parseOverpass(JSON.parse(text) as { elements?: OsmElement[] });
  } catch {
    throw new OverviewError("Overpass returned non-JSON", res.status, text.slice(0, 300));
  }
}

// ---------------------------------------------------------------- LandMark (via GFW)

/** SQL for LandMark lands intersecting the query geometry, with a point-in-polygon flag. */
export function landmarkSql(bbox: BBox): string {
  const [lon, lat] = bboxCenter(bbox);
  return (
    "SELECT landmark_id, name, category, identity, form_rec, doc_status, country, area_gis, gfw_bbox, " +
    `ST_Intersects(geom, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)) AS contains_center FROM results`
  );
}

/** Parse LandMark rows (numbers arrive as strings; `area_gis` is hectares). */
export function parseLandmarkRows(rows: Array<Record<string, unknown>>): ProtectedArea[] {
  return rows.map((r) => {
    const ha = r.area_gis == null ? NaN : Number(r.area_gis);
    const bb = Array.isArray(r.gfw_bbox) ? r.gfw_bbox.map(Number) : [];
    const centroid: [number, number] | null =
      bb.length === 4 && bb.every(Number.isFinite)
        ? [coarse((bb[0]! + bb[2]!) / 2), coarse((bb[1]! + bb[3]!) / 2)]
        : null;
    const identity = r.identity == null ? "" : String(r.identity);
    const status = [r.form_rec, r.doc_status].filter((v) => v != null && v !== "").join("; ");
    return {
      source: "landmark" as const,
      id: String(r.landmark_id ?? ""),
      name: r.name == null ? null : String(r.name),
      designation: r.category == null ? null : String(r.category),
      category: [identity, status].filter(Boolean).join(" · ") || null,
      indigenous: /indigenous/i.test(identity),
      licence: LANDMARK_LICENCE,
      approxAreaKm2: Number.isFinite(ha) ? round2(ha / 100) : null,
      areaBasis: Number.isFinite(ha) ? ("gis" as const) : null,
      coarseCentroid: centroid,
      containsAoiCentroid: typeof r.contains_center === "boolean" ? r.contains_center : null,
      url: "https://landmarkmap.org/map",
    };
  });
}

export async function landmarkLands(apiKey: string, bbox: BBox): Promise<ProtectedArea[]> {
  const rows = await gfwQuery(apiKey, LANDMARK_DATASET, landmarkSql(bbox), bboxToPolygon(bbox));
  return parseLandmarkRows(rows);
}

// ---------------------------------------------------------------- WDPA (via GFW)
// WDPA's licence forbids redistributing its data as a downloadable service, so we take IDs
// and intersection stats only — never geometry — and deep-link to Protected Planet.

export const WDPA_LICENCE = "WDPA terms — IDs/stats only, no geometry redistributed (UNEP-WCMC & IUCN, Protected Planet)";
export const WDPA_DATASET = "wdpa_protected_areas";

/** SQL for WDPA sites intersecting the query geometry (no geometry columns), with a point-in-polygon flag. */
export function wdpaSql(bbox: BBox): string {
  const [lon, lat] = bboxCenter(bbox);
  return (
    "SELECT site_id, name, desig_eng, iucn_cat, gis_area, status, iso3, gfw_bbox, " +
    `ST_Intersects(geom, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)) AS contains_center FROM results`
  );
}

/** Parse WDPA rows (`gis_area` is km²; numbers arrive as strings). */
export function parseWdpaRows(rows: Array<Record<string, unknown>>): ProtectedArea[] {
  return rows.map((r) => {
    const km2 = r.gis_area == null ? NaN : Number(r.gis_area);
    const bb = Array.isArray(r.gfw_bbox) ? r.gfw_bbox.map(Number) : [];
    const centroid: [number, number] | null =
      bb.length === 4 && bb.every(Number.isFinite)
        ? [coarse((bb[0]! + bb[2]!) / 2), coarse((bb[1]! + bb[3]!) / 2)]
        : null;
    const desig = r.desig_eng == null ? "" : String(r.desig_eng);
    const iucn = r.iucn_cat == null ? "" : String(r.iucn_cat);
    const id = String(r.site_id ?? "");
    return {
      source: "wdpa" as const,
      id,
      name: r.name == null ? null : String(r.name),
      designation: desig || null,
      category: [iucn && `IUCN ${iucn}`, r.status == null ? "" : String(r.status)].filter(Boolean).join(" · ") || null,
      indigenous: /indigenous/i.test(desig),
      licence: WDPA_LICENCE,
      approxAreaKm2: Number.isFinite(km2) ? round2(km2) : null,
      areaBasis: Number.isFinite(km2) ? ("gis" as const) : null,
      coarseCentroid: centroid,
      containsAoiCentroid: typeof r.contains_center === "boolean" ? r.contains_center : null,
      url: id ? `https://www.protectedplanet.net/${id}` : null,
    };
  });
}

export async function wdpaAreas(apiKey: string, bbox: BBox): Promise<ProtectedArea[]> {
  const rows = await gfwQuery(apiKey, WDPA_DATASET, wdpaSql(bbox), bboxToPolygon(bbox));
  return parseWdpaRows(rows);
}
