// Weather map layers — keyless, dependency-free, safe for the static public site (no calls to
// the dashboard API; everything is fetched browser-direct from CORS-open public services).
//
// Interface (small on purpose, so any MapLibre map can wire it in):
//
//   const handle = await addLayer(map, WEATHER_LAYERS.clouds);   // or stormsLayer(geojson), …
//   handle.setVisible(false);  handle.remove();
//   mountLayerToggles(map, containerEl, [WEATHER_LAYERS.clouds, WEATHER_LAYERS.precip, …]);
//
// Every spec carries `attribution` (shown in MapLibre's attribution control) and `publicSafe`:
// false means the provider's terms only cover personal/educational use (RainViewer), so the
// public site must not enable it; the live local dashboard may.
//
// Sources (verified 2026-09-27):
//   clouds  NASA GIBS VIIRS SNPP true colour, latest day ("default" time) — public domain
//   precip  NASA GIBS GPM IMERG precipitation rate, latest 30-min step (~4 h latency) — public domain
//   radar   RainViewer global radar composite — free for personal/educational use, credit required
//   wind    Open-Meteo current 10 m wind on a coarse viewport grid, drawn as arrows — CC BY 4.0
//   storms  GeoJSON from the `storms` tool (NHC/CPHC + GDACS cones, tracks, positions)

import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import { gibsDay } from "./basemap";
import { windArrows, windGrid } from "./windMath";

type FC = GeoJSON.FeatureCollection;

interface BaseSpec {
  id: string;
  title: string;
  attribution: string;
  /** false → the provider's terms don't cover a public website; keep it to the local dashboard. */
  publicSafe: boolean;
  /** One line shown under the toggle: what the layer is and is not. */
  note: string;
}
export interface RasterSpec extends BaseSpec {
  kind: "raster";
  /** Tile URL templates, or a loader for providers whose frame path changes (RainViewer). */
  tiles: string[] | (() => Promise<string[]>);
  maxzoom: number;
  opacity: number;
}
export interface StormsSpec extends BaseSpec {
  kind: "storms";
  data: FC | (() => Promise<FC>);
}
export interface WindSpec extends BaseSpec {
  kind: "wind";
  /** Grid columns × rows sampled over the current view (each point is one Open-Meteo location). */
  cols: number;
  rows: number;
}
export type LayerSpec = RasterSpec | StormsSpec | WindSpec;

export interface LayerHandle {
  id: string;
  setVisible(visible: boolean): void;
  remove(): void;
  /** Storms: replace the GeoJSON (e.g. from a fresh `storms` result). */
  setData?(data: FC): void;
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const GIBS_CREDIT = "NASA EOSDIS GIBS";

export const WEATHER_LAYERS = {
  clouds: {
    kind: "raster",
    id: "wx-clouds",
    title: "Satellite clouds",
    // The last complete day, not GIBS's "default" (today), which stays mostly black until the day's passes are in.
    tiles: [`${GIBS}/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${gibsDay(new Date())}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
    maxzoom: 9,
    opacity: 0.85,
    attribution: `${GIBS_CREDIT} · VIIRS`,
    publicSafe: true,
    note: "VIIRS true colour, the last complete day — one pass per place per day, not live.",
  },
  precip: {
    kind: "raster",
    id: "wx-precip",
    title: "Precipitation (satellite)",
    tiles: [`${GIBS}/IMERG_Precipitation_Rate_30min/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`],
    maxzoom: 6,
    opacity: 0.8,
    attribution: `${GIBS_CREDIT} · NASA GPM IMERG`,
    publicSafe: true,
    note: "GPM IMERG rain rate, latest 30-min step (~4 h behind) — satellite estimate, not radar.",
  },
  radar: {
    kind: "raster",
    id: "wx-radar",
    title: "Rain radar",
    tiles: rainviewerTiles,
    maxzoom: 7,
    opacity: 0.75,
    attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">Weather data by RainViewer</a>',
    publicSafe: false,
    note: "Ground radar composite, ~10 min old; gaps where no radar exists. Personal/educational use only.",
  },
  wind: {
    kind: "wind",
    id: "wx-wind",
    title: "Wind (10 m)",
    cols: 9,
    rows: 6,
    attribution: '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> (CC BY 4.0)',
    publicSafe: true,
    note: "Model wind now on a coarse grid over the view — arrows point downwind, longer = stronger.",
  },
} satisfies Record<string, LayerSpec>;

/** A storms spec from `storms` tool output (`result.geojson`), or a loader returning it. */
export function stormsLayer(data: FC | (() => Promise<FC>)): StormsSpec {
  return {
    kind: "storms",
    id: "wx-storms",
    title: "Tropical cyclones",
    data,
    attribution: "NOAA NHC/CPHC · GDACS",
    publicSafe: true,
    note: "Forecast cones = likely path of the centre, not storm size or impact area.",
  };
}

async function rainviewerTiles(): Promise<string[]> {
  const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
  if (!res.ok) throw new Error(`RainViewer ${res.status}`);
  const j = (await res.json()) as { host: string; radar: { past: { path: string }[] } };
  const last = j.radar.past[j.radar.past.length - 1];
  if (!last) throw new Error("RainViewer: no radar frames");
  // 256 px tiles, colour scheme 2 (universal blue), smoothed, snow coloured.
  return [`${j.host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`];
}

/** Add a layer to `map`. Resolves once the source exists; never throws on a later refresh. */
export async function addLayer(map: MlMap, spec: LayerSpec, opts: { visible?: boolean; beforeId?: string } = {}): Promise<LayerHandle> {
  const visibility = opts.visible === false ? "none" : "visible";
  if (spec.kind === "raster") return addRaster(map, spec, visibility, opts.beforeId);
  if (spec.kind === "storms") return addStorms(map, spec, visibility, opts.beforeId);
  return addWind(map, spec, visibility, opts.beforeId);
}

function handleFor(map: MlMap, id: string, layerIds: string[], cleanup: () => void = () => {}): LayerHandle {
  return {
    id,
    setVisible(v) {
      for (const l of layerIds) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", v ? "visible" : "none");
    },
    remove() {
      cleanup();
      for (const l of layerIds) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(id)) map.removeSource(id);
    },
  };
}

async function addRaster(map: MlMap, spec: RasterSpec, visibility: "visible" | "none", beforeId?: string): Promise<LayerHandle> {
  const tiles = typeof spec.tiles === "function" ? await spec.tiles() : spec.tiles;
  if (!map.getSource(spec.id)) map.addSource(spec.id, { type: "raster", tiles, tileSize: 256, maxzoom: spec.maxzoom, attribution: spec.attribution });
  if (!map.getLayer(spec.id))
    map.addLayer({ id: spec.id, type: "raster", source: spec.id, layout: { visibility }, paint: { "raster-opacity": spec.opacity, "raster-fade-duration": 200 } }, beforeId);
  return handleFor(map, spec.id, [spec.id]);
}

// Saffir–Simpson ramp: tropical storm → cat 5 (cool → hot), matching the dashboard's event hues.
const CATEGORY_COLOR = ["interpolate", ["linear"], ["coalesce", ["get", "peakCategory"], 0], 0, "#38bdf8", 1, "#f2c94c", 3, "#f97316", 5, "#ff4d6d"] as unknown as string;

async function addStorms(map: MlMap, spec: StormsSpec, visibility: "visible" | "none", beforeId?: string): Promise<LayerHandle> {
  const data = typeof spec.data === "function" ? await spec.data() : spec.data;
  const id = spec.id;
  const ids = [`${id}-cone`, `${id}-cone-line`, `${id}-track`, `${id}-pos`];
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data, attribution: spec.attribution });
  const layout = { visibility };
  if (!map.getLayer(ids[0]!))
    map.addLayer({ id: ids[0]!, type: "fill", source: id, filter: ["==", ["get", "part"], "cone"], layout, paint: { "fill-color": CATEGORY_COLOR, "fill-opacity": 0.14 } }, beforeId);
  if (!map.getLayer(ids[1]!))
    map.addLayer({ id: ids[1]!, type: "line", source: id, filter: ["==", ["get", "part"], "cone"], layout, paint: { "line-color": CATEGORY_COLOR, "line-width": 1, "line-opacity": 0.7 } }, beforeId);
  if (!map.getLayer(ids[2]!))
    map.addLayer({ id: ids[2]!, type: "line", source: id, filter: ["==", ["get", "part"], "track"], layout: { ...layout, "line-cap": "round" }, paint: { "line-color": CATEGORY_COLOR, "line-width": 1.6, "line-dasharray": [2, 1.5] } }, beforeId);
  if (!map.getLayer(ids[3]!))
    map.addLayer(
      {
        id: ids[3]!,
        type: "circle",
        source: id,
        filter: ["==", ["get", "part"], "position"],
        layout,
        paint: { "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "category"], 0], 0, 4, 5, 9], "circle-color": CATEGORY_COLOR, "circle-stroke-color": "#07090d", "circle-stroke-width": 1.5 },
      },
      beforeId,
    );
  const h = handleFor(map, id, ids);
  h.setData = (d) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(d);
  return h;
}

// ---- wind: a coarse grid of Open-Meteo "current" wind, drawn as arrows (no particles, no deps)

async function fetchWind(points: Array<[number, number]>): Promise<Array<{ lon: number; lat: number; speedKmh: number; dirDeg: number }>> {
  const q = new URLSearchParams({
    latitude: points.map((p) => p[1]).join(","),
    longitude: points.map((p) => p[0]).join(","),
    current: "wind_speed_10m,wind_direction_10m",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q.toString()}`);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = (await res.json()) as unknown;
  const arr = (Array.isArray(j) ? j : [j]) as Array<{ current?: { wind_speed_10m?: number; wind_direction_10m?: number } }>;
  return arr.flatMap((r, i) => {
    const sp = r.current?.wind_speed_10m;
    const dir = r.current?.wind_direction_10m;
    const p = points[i];
    return p && typeof sp === "number" && typeof dir === "number" ? [{ lon: p[0], lat: p[1], speedKmh: sp, dirDeg: dir }] : [];
  });
}

async function addWind(map: MlMap, spec: WindSpec, visibility: "visible" | "none", beforeId?: string): Promise<LayerHandle> {
  const id = spec.id;
  const empty: FC = { type: "FeatureCollection", features: [] };
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: empty, attribution: spec.attribution });
  if (!map.getLayer(id))
    map.addLayer(
      {
        id,
        type: "line",
        source: id,
        layout: { visibility, "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["interpolate", ["linear"], ["get", "speed"], 0, "#9adfff", 30, "#5cc8ff", 60, "#f2c94c", 90, "#ff7a7a"],
          "line-width": 1.4,
          "line-opacity": 0.9,
        },
      },
      beforeId,
    );
  let visible = visibility === "visible";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const refresh = async () => {
    if (!visible) return;
    const b = map.getBounds();
    const bounds: [number, number, number, number] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const pts = windGrid(bounds, spec.cols, spec.rows);
    const cell = Math.min((Math.min(180, bounds[2]) - Math.max(-180, bounds[0])) / spec.cols, (Math.min(75, bounds[3]) - Math.max(-75, bounds[1])) / spec.rows);
    const mine = ++seq;
    try {
      const samples = await fetchWind(pts);
      if (mine === seq) (map.getSource(id) as GeoJSONSource | undefined)?.setData(windArrows(samples, cell));
    } catch (err) {
      console.warn("wind layer refresh failed:", err);
    }
  };
  const onMove = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 600);
  };
  map.on("moveend", onMove);
  void refresh();
  const h = handleFor(map, id, [id], () => {
    clearTimeout(timer);
    map.off("moveend", onMove);
  });
  const baseSet = h.setVisible;
  h.setVisible = (v) => {
    visible = v;
    baseSet(v);
    if (v) void refresh();
  };
  return h;
}

// ---- toggles -----------------------------------------------------------------------------

/**
 * A small checkbox panel: each layer is added lazily on first check, then shown/hidden.
 * `publicSite: true` drops specs whose terms don't cover a public website.
 */
export function mountLayerToggles(map: MlMap, container: HTMLElement, specs: LayerSpec[], opts: { publicSite?: boolean } = {}): Map<string, LayerHandle> {
  const handles = new Map<string, LayerHandle>();
  const box = document.createElement("div");
  box.className = "wx-toggles";
  const head = document.createElement("div");
  head.className = "wx-toggles-title";
  head.textContent = "Weather";
  box.appendChild(head);
  for (const spec of specs.filter((s) => !opts.publicSite || s.publicSafe)) {
    const row = document.createElement("label");
    row.className = "wx-toggle";
    row.title = spec.note;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const name = document.createElement("span");
    name.textContent = spec.title;
    row.append(cb, name);
    cb.addEventListener("change", async () => {
      const existing = handles.get(spec.id);
      if (existing) return existing.setVisible(cb.checked);
      if (!cb.checked) return;
      row.classList.add("is-loading");
      try {
        handles.set(spec.id, await addLayer(map, spec));
      } catch (err) {
        console.warn(`${spec.title} unavailable:`, err);
        cb.checked = false;
        row.classList.add("is-error");
        row.title = `${spec.note} (unavailable right now)`;
      } finally {
        row.classList.remove("is-loading");
      }
    });
    box.appendChild(row);
  }
  container.appendChild(box);
  return handles;
}
