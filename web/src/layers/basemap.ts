// The zoom-dependent basemap shared by the public site's map (web/src/site/map/explore.ts) and the
// live dashboard map (web/src/map.ts): today's NASA imagery (filling in over yesterday's) when zoomed out, a sharp 10 m
// cloud-free Sentinel-2 mosaic when zoomed in, and light OpenStreetMap place names + roads on top.
//
//   new maplibregl.Map({ style: basemapStyle(), … });   // sources + layers + glyphs, globe
//   mountBasemapCaption(map);                            // "what am I looking at" note, per zoom
//
// Keyless only by default. Sources (verified live 2026-09-27):
//   z0–9   NASA GIBS VIIRS SNPP Corrected Reflectance true colour, one day (Level9 = 375 m) — public
//          domain. Yesterday UTC (two days back before 06 UTC): "today" is mostly black until the
//          day's passes are processed, and a JPEG can't be transparent where there is no data yet.
//          Live on top (`live: true`): the newer days' passes so far (VIIRS SNPP + NOAA-20), fetched
//          through the `gibs-live://` protocol, which turns GIBS's no-data black transparent in the
//          browser — so the globe fills in with today as the satellites pass, no deploy or job needed.
//   z6–14  EOxCloudless (Sentinel-2 cloudless) 2025, 10 m, whole Earth — CC BY-NC-SA 4.0, free for
//          non-commercial use with the attribution below, verbatim (https://cloudless.eox.at/license-non-commercial).
//          The 2016 layer (`s2cloudless_3857`) is CC BY 4.0 if the site ever becomes commercial.
//          Fades in over GIBS across z6–8 (raster-opacity by zoom, no pop).
//   labels OpenFreeMap vector tiles (OpenMapTiles schema, OSM data, ODbL) — only the `place` and
//          `transportation` layers are drawn; no basemap style is fetched (one TileJSON + tiles + glyphs).
//
// Hook for keyed imagery: `BASEMAPS` entries may carry `requiresKey: "<NAME>"`. `availableBasemaps`
// drops them unless `keys[NAME]` is non-empty, and substitutes `{key}` in the tile URL. The Esri
// World Imagery entry (z14+) is wired this way behind `ARCGIS_API_KEY` and is skipped today.

import type { ExpressionSpecification, IControl, LayerSpecification, Map as MlMap, SourceSpecification, StyleSpecification } from "maplibre-gl";

export interface BasemapEntry {
  id: string;
  /** Tile URL templates; `{key}` is replaced with the value of `requiresKey`. */
  tiles: string[];
  /** Deepest zoom the provider has real tiles for — MapLibre overzooms past it instead of requesting 404s. */
  maxzoom: number;
  /** Zoom span over which this layer fades in over the one below. Absent = the base, always opaque. */
  fadeIn?: [number, number];
  attribution: string;
  /** Map-corner note while this layer is the one you see — so a mosaic is never taken for today. */
  caption: string;
  /** Name of a key this layer needs (env / config); the layer is skipped when it is absent. */
  requiresKey?: string;
  /** Partial newer-day layers drawn right above this one (bottom → top), same zoom span. */
  overlays?: { id: string; tiles: string[] }[];
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const EOX_YEAR = 2025;
const OFM = "https://tiles.openfreemap.org";
const DAY_MS = 86_400_000;

/** The GIBS day to show: the last UTC day whose passes are all in (yesterday; two days back before 06 UTC). */
export function gibsDay(now: Date): string {
  const back = now.getUTCHours() < 6 ? 2 : 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - back * DAY_MS).toISOString().slice(0, 10);
}

const fmtDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** URL scheme whose tiles get GIBS's no-data black made transparent (see `registerLiveImagery`). */
export const LIVE_SCHEME = "gibs-live";
const LIVE_SATS = ["VIIRS_SNPP", "VIIRS_NOAA20"] as const;
const gibsTile = (sat: string, day: string, scheme = "https") =>
  `${scheme}://${GIBS.slice("https://".length)}/${sat}_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;

/** The UTC days after the complete base day, up to today (oldest first): today's passes, and yesterday's
 *  too before 06 UTC — the partial days drawn over the base. */
export function liveDays(now: Date): string[] {
  const out: string[] = [];
  const today = now.toISOString().slice(0, 10);
  for (let t = Date.parse(`${gibsDay(now)}T00:00:00Z`) + DAY_MS; ; t += DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(d);
    if (d >= today) return out;
  }
}

/** Bottom → top. Later entries fade in over earlier ones as you zoom in. `live` adds today's passes. */
export function basemaps(now: Date = new Date(), live = false): BasemapEntry[] {
  const day = gibsDay(now);
  const overlays = live ? liveDays(now).flatMap((d) => LIVE_SATS.map((sat) => ({ id: `bm-live-${d}-${sat}`, tiles: [gibsTile(sat, d, LIVE_SCHEME)] }))) : undefined;
  return [
    {
      id: "bm-gibs",
      tiles: [gibsTile("VIIRS_SNPP", day)],
      maxzoom: 9,
      attribution: live ? `NASA EOSDIS GIBS · VIIRS ${day} + today` : `NASA EOSDIS GIBS · VIIRS ${day}`,
      caption: live ? `Satellite view today (NASA), rest from ${fmtDay(day)}` : `Daily satellite view, ${fmtDay(day)} (NASA)`,
      ...(overlays ? { overlays } : {}),
    },
    {
      id: "bm-eox",
      tiles: [`https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`],
      maxzoom: 14,
      fadeIn: [6, 8],
      attribution: `<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})</a> · CC BY-NC-SA 4.0`,
      caption: `Cloud-free mosaic, Sentinel-2 ${EOX_YEAR} (EOX)`,
    },
    {
      // Optional, keyed — skipped unless ARCGIS_API_KEY is provided. UNCONFIRMED: URL, attribution
      // and terms are for whoever wires the key to verify (ArcGIS Location Platform basemap tiles).
      id: "bm-esri",
      tiles: ["https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token={key}"],
      maxzoom: 19,
      fadeIn: [13, 15],
      attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      caption: "Esri World Imagery (image dates vary by place)",
      requiresKey: "ARCGIS_API_KEY",
    },
  ];
}

/** Entries usable with the keys at hand (keyless ones always), with `{key}` filled in. */
export function availableBasemaps(list: BasemapEntry[], keys: Record<string, string | undefined> = {}): BasemapEntry[] {
  return list.flatMap((b) => {
    if (!b.requiresKey) return [b];
    const key = keys[b.requiresKey]?.trim();
    return key ? [{ ...b, tiles: b.tiles.map((t) => t.replaceAll("{key}", encodeURIComponent(key))) }] : [];
  });
}

/** raster-opacity for an entry: a zoom ramp from 0 to 1 over its fade span, or 1 for the base. */
export function opacityFor(b: BasemapEntry): number | ExpressionSpecification {
  return b.fadeIn ? ["interpolate", ["linear"], ["zoom"], b.fadeIn[0], 0, b.fadeIn[1], 1] : 1;
}

/** Which entry you are mostly looking at: the topmost one past the middle of its fade. */
export function activeAt(zoom: number, list: BasemapEntry[]): BasemapEntry | undefined {
  let on = list[0];
  for (const b of list) if (b.fadeIn && zoom >= (b.fadeIn[0] + b.fadeIn[1]) / 2) on = b;
  return on;
}

export const captionAt = (zoom: number, list: BasemapEntry[]): string => activeAt(zoom, list)?.caption ?? "";

/** Raster layers: each drawn from its fade start, and dropped (no more fetching) once the next one is opaque.
 *  An entry's overlays sit right above it with the same zoom span. */
function rasterLayers(list: BasemapEntry[]): LayerSpecification[] {
  return list.flatMap((b, i) => {
    const next = list[i + 1];
    const layer = (id: string): LayerSpecification => {
      const l: LayerSpecification = { id, type: "raster", source: id, paint: { "raster-opacity": opacityFor(b), "raster-fade-duration": 200 } };
      if (b.fadeIn) l.minzoom = b.fadeIn[0];
      if (next?.fadeIn) l.maxzoom = next.fadeIn[1] + 1;
      return l;
    };
    return [layer(b.id), ...(b.overlays ?? []).map((o) => layer(o.id))];
  });
}

/** Make GIBS's no-data (pure black, give or take JPEG noise) transparent, in place. Returns pixels changed. */
export function knockOutNoData(rgba: Uint8ClampedArray, max = 8): number {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i]! <= max && rgba[i + 1]! <= max && rgba[i + 2]! <= max) {
      rgba[i + 3] = 0;
      n++;
    }
  }
  return n;
}

// Browser canvas APIs, typed locally: the test build has no DOM lib.
interface Bmp { width: number; height: number; close(): void }
interface Ctx2d {
  drawImage(b: Bmp, x: number, y: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  putImageData(d: { data: Uint8ClampedArray }, x: number, y: number): void;
}
interface Canvas { width: number; height: number; getContext(k: "2d", o: object): Ctx2d | null; convertToBlob(o: { type: string }): Promise<Blob> }
const web = globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => Canvas; createImageBitmap?: (b: Blob) => Promise<Bmp> };

/** Can this browser run the `gibs-live://` protocol? (OffscreenCanvas + createImageBitmap.) */
export const liveImagerySupported = (): boolean => !!web.OffscreenCanvas && !!web.createImageBitmap;

type AddProtocol = (name: string, load: (req: { url: string }, abort: AbortController) => Promise<{ data: ArrayBuffer }>) => void;
let registered = false;

/**
 * Register `gibs-live://` once: fetch the https tile, make its no-data black transparent, hand MapLibre a
 * PNG. Returns whether live imagery can be used (pass it to basemapStyle/mountBasemapCaption as `live`).
 */
export function registerLiveImagery(ml: { addProtocol: AddProtocol }): boolean {
  if (!liveImagerySupported()) return false;
  if (registered) return true;
  registered = true;
  ml.addProtocol(LIVE_SCHEME, async (req, abort) => {
    const res = await fetch(`https${req.url.slice(LIVE_SCHEME.length)}`, { signal: abort.signal });
    if (!res.ok) throw new Error(`${res.status} ${req.url}`);
    const bmp = await web.createImageBitmap!(await res.blob());
    const canvas = new web.OffscreenCanvas!(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    knockOutNoData(img.data);
    ctx.putImageData(img, 0, 0);
    return { data: await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer() };
  });
  return true;
}

// ---- labels + roads (OpenFreeMap, OpenMapTiles schema) --------------------------------------------------

const LABEL_SRC = "bm-ofm";
/** Insert per-case overlays below this layer so roads and names stay on top. */
export const BASEMAP_LABELS_BELOW = "bm-roads";
const NAME: ExpressionSpecification = ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]];
const FG_1 = "#e7ecf3"; // --fg-1
const FG_2 = "#c3cbd6"; // between --fg-1 and --fg-2: secondary, still legible over bright imagery
const HALO = "rgba(7, 9, 13, 0.85)"; // --bg-0
const text = { "text-color": FG_1, "text-halo-color": HALO, "text-halo-width": 1.4, "text-halo-blur": 0.4 };
const place = (id: string, cls: string[], minzoom: number, maxzoom: number, font: string, size: ExpressionSpecification, extra: Record<string, unknown> = {}): LayerSpecification =>
  ({
    id,
    type: "symbol",
    source: LABEL_SRC,
    "source-layer": "place",
    minzoom,
    maxzoom,
    filter: ["in", ["get", "class"], ["literal", cls]],
    layout: { "text-field": NAME, "text-font": [font], "text-size": size, "text-max-width": 8, "symbol-sort-key": ["coalesce", ["get", "rank"], 99], ...extra },
    paint: text,
  }) as LayerSpecification;

function labelLayers(): LayerSpecification[] {
  const z = (...stops: number[]) => ["interpolate", ["linear"], ["zoom"], ...stops] as ExpressionSpecification;
  return [
    {
      id: BASEMAP_LABELS_BELOW,
      type: "line",
      source: LABEL_SRC,
      "source-layer": "transportation",
      minzoom: 10,
      filter: ["all", ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"]]], ["!=", ["get", "brunnel"], "tunnel"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": FG_1,
        "line-opacity": z(10, 0.25, 13, 0.45),
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, ["match", ["get", "class"], ["motorway", "trunk"], 0.9, 0.4], 16, ["match", ["get", "class"], ["motorway", "trunk", "primary"], 2.4, 1.2]],
      },
    },
    place("bm-village", ["village"], 11, 24, "Noto Sans Regular", z(11, 10.5, 15, 13)),
    place("bm-town", ["town"], 8, 24, "Noto Sans Regular", z(8, 11, 14, 14)),
    place("bm-city", ["city"], 3.5, 24, "Noto Sans Regular", z(4, 11, 10, 16)),
    { ...place("bm-state", ["state"], 4, 8, "Noto Sans Italic", z(4, 10, 7, 12), { "text-transform": "uppercase", "text-letter-spacing": 0.08 }), paint: { ...text, "text-color": FG_2 } } as LayerSpecification,
    place("bm-country", ["country"], 1.5, 7, "Noto Sans Bold", z(2, 10, 6, 14), { "text-transform": "uppercase", "text-letter-spacing": 0.1 }),
  ];
}

export interface BasemapOptions {
  now?: Date;
  /** Draw today's passes over the base day (needs `registerLiveImagery` to have returned true). */
  live?: boolean;
  /** Keys for optional keyed layers, by name (e.g. { ARCGIS_API_KEY: "…" }). */
  keys?: Record<string, string | undefined>;
}

/** A complete globe style: imagery stack + OpenFreeMap names/roads. Callers may spread extra fields (sky). */
export function basemapStyle(opts: BasemapOptions = {}): StyleSpecification {
  const list = availableBasemaps(basemaps(opts.now, opts.live), opts.keys);
  const sources: Record<string, SourceSpecification> = {};
  for (const b of list) {
    sources[b.id] = { type: "raster", tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    for (const o of b.overlays ?? []) sources[o.id] = { type: "raster", tiles: o.tiles, tileSize: 256, maxzoom: b.maxzoom };
  }
  sources[LABEL_SRC] = {
    type: "vector",
    url: `${OFM}/planet`, // TileJSON → dated tile path; its attribution: OpenFreeMap © OpenMapTiles, OpenStreetMap
  };
  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: `${OFM}/fonts/{fontstack}/{range}.pbf`,
    sources,
    layers: [...rasterLayers(list), ...labelLayers()],
  };
}

/**
 * A small map-corner note naming the imagery in view ("Daily satellite view, Sep 26 (NASA)" /
 * "Cloud-free mosaic, Sentinel-2 2025 (EOX)"), updated as the zoom crosses a fade midpoint.
 */
export function mountBasemapCaption(map: MlMap, opts: BasemapOptions = {}): IControl {
  const list = availableBasemaps(basemaps(opts.now, opts.live), opts.keys);
  const box = map.getContainer().ownerDocument.createElement("div"); // (no DOM lib in the test build)
  box.className = "maplibregl-ctrl bm-caption";
  const sync = () => {
    const t = captionAt(map.getZoom(), list);
    if (box.textContent !== t) box.textContent = t;
  };
  const ctrl: IControl = {
    onAdd() {
      sync();
      map.on("zoom", sync);
      return box;
    },
    onRemove() {
      map.off("zoom", sync);
      box.remove();
    },
  };
  map.addControl(ctrl, "bottom-right");
  return ctrl;
}
