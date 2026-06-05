import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox, EonetEvent } from "../types.js";
import { assertBBox, clampWidth, heightFor } from "../util.js";

const WORLDVIEW_SNAPSHOT = "https://wvs.earthdata.nasa.gov/api/v1/snapshot";
const EONET_EVENTS = "https://eonet.gsfc.nasa.gov/api/v3/events";

/**
 * Friendly view name → ordered GIBS layer ids (first = bottom). No API key needed.
 * VIIRS layers are preferred over MODIS where possible: VIIRS has a wider daily swath, so
 * single-day snapshots avoid the black "no-data" wedges MODIS leaves at low latitudes.
 */
export const SNAPSHOT_LAYERS: Record<string, string[]> = {
  trueColor: ["VIIRS_SNPP_CorrectedReflectance_TrueColor"],
  trueColorModis: ["MODIS_Terra_CorrectedReflectance_TrueColor"],
  // VIIRS vegetation false-color (M11-I2-I1): healthy vegetation reds/oranges, water dark.
  falseColor: ["VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1"],
  falseColorModis: ["MODIS_Terra_CorrectedReflectance_Bands721"],
  fires: [
    "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    "VIIRS_SNPP_Thermal_Anomalies_375m_All",
  ],
};

export type SnapshotLayer = keyof typeof SNAPSHOT_LAYERS;

export interface SnapshotResult {
  dataBase64: string;
  mimeType: string;
  width: number;
  height: number;
  layers: string[];
  date: string;
  attribution: string;
}

/**
 * Render a true/false-color (or fire-overlay) snapshot from NASA Worldview / GIBS.
 * EPSG:4326 BBOX axis order is `south,west,north,east`.
 */
export async function snapshot(
  bbox: BBox,
  date: string,
  layerKey: string = "trueColor",
  width = 1024,
): Promise<SnapshotResult> {
  assertBBox(bbox);
  const layers = SNAPSHOT_LAYERS[layerKey];
  if (!layers) {
    throw new OverviewError(
      `unknown layer '${layerKey}'. Options: ${Object.keys(SNAPSHOT_LAYERS).join(", ")}`,
    );
  }
  const w = clampWidth(width);
  const h = heightFor(bbox, w);
  const [west, south, east, north] = bbox;

  const params = new URLSearchParams({
    REQUEST: "GetSnapshot",
    TIME: date,
    BBOX: `${south},${west},${north},${east}`,
    CRS: "EPSG:4326",
    LAYERS: layers.join(","),
    FORMAT: "image/jpeg",
    WIDTH: String(w),
    HEIGHT: String(h),
  });

  const url = `${WORLDVIEW_SNAPSHOT}?${params.toString()}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.startsWith("image/")) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(
      `Worldview snapshot failed (${res.status} ${contentType})`,
      res.status,
      body.slice(0, 500),
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    dataBase64: buf.toString("base64"),
    mimeType: "image/jpeg",
    width: w,
    height: h,
    layers,
    date,
    attribution: "NASA EOSDIS GIBS / Worldview",
  };
}

export interface EventsQuery {
  status?: "open" | "closed" | "all";
  category?: string;
  bbox?: BBox;
  days?: number;
  limit?: number;
}

interface RawGeometry {
  date?: string;
  type?: string;
  coordinates?: unknown;
  magnitudeValue?: number | null;
  magnitudeUnit?: string | null;
}
interface RawEvent {
  id: string;
  title: string;
  closed?: string | null;
  link: string;
  categories?: Array<{ id?: string; title?: string }>;
  geometry?: RawGeometry[];
}

/** Fetch and normalize live natural-disaster events from NASA EONET v3. No key needed. */
export async function events(query: EventsQuery = {}): Promise<EonetEvent[]> {
  const params = new URLSearchParams();
  params.set("status", query.status ?? "open");
  if (query.days != null) params.set("days", String(query.days));
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.category) params.set("category", query.category);
  if (query.bbox) {
    assertBBox(query.bbox);
    const [west, south, east, north] = query.bbox;
    // EONET bbox: upper-left (lon,lat), lower-right (lon,lat) → west,north,east,south
    params.set("bbox", `${west},${north},${east},${south}`);
  }

  const url = `${EONET_EVENTS}?${params.toString()}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`EONET request failed (${res.status})`, res.status, body.slice(0, 500));
  }
  const data = (await res.json()) as { events?: RawEvent[] };
  return (data.events ?? []).map(normalizeEvent);
}

function normalizeEvent(e: RawEvent): EonetEvent {
  const geos = e.geometry ?? [];
  const last = geos.length > 0 ? geos[geos.length - 1] : undefined;
  let coordinates: [number, number] | null = null;
  if (last?.type === "Point" && Array.isArray(last.coordinates) && last.coordinates.length >= 2) {
    const [lon, lat] = last.coordinates as number[];
    if (typeof lon === "number" && typeof lat === "number") coordinates = [lon, lat];
  }
  const magnitude =
    last?.magnitudeValue != null
      ? `${last.magnitudeValue}${last.magnitudeUnit ? " " + last.magnitudeUnit : ""}`
      : null;
  return {
    id: e.id,
    title: e.title,
    category: e.categories?.[0]?.title ?? "Unknown",
    closed: e.closed != null,
    lastDate: last?.date ?? null,
    coordinates,
    magnitude,
    link: e.link,
  };
}
