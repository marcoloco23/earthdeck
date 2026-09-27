// The landing's interactive globe — the lazy chunk with MapLibre, started as soon as the page loads
// (web/src/site/main.ts) and laid over the static night image in the same box. It shares one state
// with the panel (web/src/site/hub.ts): the panel filters, opens cases and switches modes; the map
// clusters and colours the cases, flies to what is selected, draws the case outline and its
// evidence overlay, and runs the live layers.
//
// Keyless only: the shared zoom-dependent basemap (web/src/layers/basemap.ts); per-case evidence
// overlays from GFW (forest alerts) and GIBS HLS (30 m before/after); live layers from any module in
// web/src/layers/ that registers a group (weather.ts here; others register themselves). Every
// overlay is decoration: when a source fails, the map just shows less. Ledger text is public input —
// everything below is built with textContent, never innerHTML.

import maplibregl, { type GeoJSONSource, type MapLayerMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./explore.css";
import { el, reducedMotion } from "../../ui";
import { BASEMAP_LABELS_BELOW, basemaps, basemapStyle, captionAt, mountBasemapCaption } from "../../layers/basemap";
import { addLayer, stormsLayer, WEATHER_LAYERS, type LayerHandle, type RasterSpec } from "../../layers/weather";
import { layerGroups, onLayerGroup, registerLayerGroup, type LayerGroup, type RegisteredLayer } from "../../layers/registry";
import type { Hub } from "../hub";
import {
  CLUSTER_PROPERTIES,
  EASE_IN_OUT,
  WINDOWS,
  caseFeatures,
  dayOf,
  defaultOverlays,
  endMsOf,
  firstDay,
  isGlobal,
  isVisible,
  search,
  topicOfCase,
  windowRange,
  windowStats,
  type Hit,
  type Kind,
  type MapCase,
  type MapData,
  type Metrics,
  type View,
  type Win,
} from "./model";

// Every module in web/src/layers/ runs once, so a layer group registers itself just by existing there.
import.meta.glob(["../../layers/*.ts", "!../../layers/*.test.ts"], { eager: true });

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const HLS = (day: string) => `${GIBS}/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/${day}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png`;
const GFW = (from: string, to: string) =>
  `https://tiles.globalforestwatch.org/gfw_integrated_alerts/latest/dynamic/{z}/{x}/{y}.png?render_type=true_color&start_date=${from}&end_date=${to}`;
const FALLBACK_STYLE = "https://tiles.openfreemap.org/styles/dark";
/** Sea-surface temperature against normal, GIBS "default" = the latest complete day (verified 2026-09-27). */
const SST_ANOMALY: RasterSpec = {
  kind: "raster",
  id: "cl-sst",
  title: "Ocean heat vs. normal",
  tiles: [`${GIBS}/GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png`],
  maxzoom: 7,
  opacity: 0.7,
  attribution: "NASA EOSDIS GIBS · GHRSST MUR (JPL)",
  publicSafe: true,
  note: "Sea-surface temperature compared with the usual for the date, latest day (about a day behind) — red warmer, blue cooler.",
};

const DAY_MS = 86_400_000;
const WIN_LABEL: Record<Win, string> = { 30: "30 d", 90: "90 d", 365: "1 yr", 0: "All" };
/** How close fly-to gets, per case type: fires stay coarse (the pin is a cluster centroid on purpose). */
const MAX_ZOOM: Record<Kind, number> = { forest: 11.5, fire: 7.5, flaring: 9, "flaring-stopped": 9, methane: 7, other: 8 };
const WORLD = { center: [-20, 12] as [number, number] };
/** The link named a camera (`#map:…&c=…`): keep it rather than fitting the globe to the screen. */
const decodedCamera = () => location.hash.startsWith("#map:") && /[&:]c=/.test(location.hash);

// Colours mirror the CSS tokens (styles.css: --st-*; site.css: --tp-*).
const ST = { published: "#ff9f5a", checking: "#9aa6b8", dropped: "#5d6878" };
const TP: Record<string, string> = {
  forest: "#4ade9b",
  fire: "#ff6b3d",
  flaring: "#f2c94c",
  methane: "#c4a5ff",
  ocean: "#38bdf8",
  ice: "#e0f2fe",
  air: "#a8a29e",
  weather: "#7dd3fc",
  trend: "#2dd4bf",
  good: "#bef264",
  quake: "#fb7185",
  other: "#9aa6b8",
};
const INK = "#07090d";

const fmtDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const shift = (iso: string, days: number) => dayOf(Date.parse(iso) + days * DAY_MS);

interface Options {
  figure: HTMLElement;
  data: MapData;
  hub: Hub;
}

export function mountExplorer({ figure, data, hub }: Options): void {
  const cases = data.cases.filter((c) => /^[A-Za-z0-9-]{1,64}$/.test(c.id) && Number.isFinite(c.lon) && Number.isFinite(c.lat));
  const byId = new Map(cases.map((c) => [c.id, c]));
  const local = cases.filter((c) => !isGlobal(c));
  const root = hub.root;
  const latestDay = dayOf(Date.parse(data.generatedAt) || Date.now());
  const startDay = firstDay(local) ?? latestDay;
  let only: Set<string> | null = null;
  const v0 = hub.get();

  // ---- DOM shell ----------------------------------------------------------------------------------
  const xp = el("div", "xp");
  xp.tabIndex = 0;
  xp.setAttribute("role", "region");
  xp.setAttribute("aria-label", "Map of the cases. Arrow keys move between cases, Enter opens one, Escape closes.");
  const mapBox = el("div", "xp-map");
  const top = el("div", "xp-top");
  const bar = el("div", "xp-time");
  const tip = el("div", "xp-tip");
  tip.hidden = true;
  const live = el("p", "sr-only");
  live.setAttribute("aria-live", "polite");
  xp.append(mapBox, top, bar, tip, live);
  figure.classList.add("is-live");
  figure.appendChild(xp);

  let map: maplibregl.Map;
  try {
    map = new maplibregl.Map({
      container: mapBox,
      style: { ...basemapStyle(), sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 4, 0.5, 7, 0] } },
      center: v0.center,
      zoom: v0.zoom,
      pitch: v0.pitch,
      bearing: v0.bearing,
      maxPitch: 60,
      keyboard: false, // arrows cycle cases instead (see the keyboard section)
      attributionControl: { compact: true },
      fadeDuration: 150,
    });
  } catch {
    xp.remove(); // no WebGL: the static image and its pins stay
    figure.classList.remove("is-live");
    return;
  }
  // Test hook (browser tests project a case to screen pixels); read-only use, nothing secret.
  (xp as HTMLElement & { xpMap?: maplibregl.Map }).xpMap = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  let caption = mountBasemapCaption(map);
  const capList = basemaps();
  const capBox = document.getElementById("imagery-cap");
  const syncCap = () => {
    if (capBox) capBox.textContent = `Base imagery here: ${captionAt(map.getZoom(), capList)}.`;
  };
  map.on("zoomend", syncCap);
  syncCap();

  // Basemap fallback: GIBS failing before any tile arrives → OpenFreeMap (keyless vector).
  let baseLoaded = false;
  let baseErrors = 0;
  let fellBack = false;
  map.on("sourcedata", (e) => {
    if (e.sourceId === "bm-gibs" && e.isSourceLoaded) baseLoaded = true;
  });
  map.on("error", (e) => {
    const src = (e as unknown as { sourceId?: string }).sourceId;
    if (!src) console.warn("map:", e.error?.message ?? e); // style/expression problems; tile misses stay quiet
    if (src === "bm-gibs" && !baseLoaded && !fellBack && ++baseErrors >= 4) {
      fellBack = true;
      map.removeControl(caption);
      map.setStyle(FALLBACK_STYLE);
      map.once("style.load", () => {
        try {
          map.setProjection({ type: "globe" });
        } catch {
          /* mercator is fine */
        }
        addCaseLayers();
        drawOverlays();
        for (const [id, on] of liveState) if (on) void setLive(id, true, true);
      });
    }
  });
  void caption;

  // ---- the cases: clustered at low zoom, coloured by status, ringed by topic ---------------------------
  const all = caseFeatures(local); // stable numeric ids, so hover/selection survive re-filtering
  const fidOf = new Map(all.features.map((f) => [f.properties.id, f.id]));
  const visible = () => {
    const end = endMsOf(hub.get(), data.generatedAt);
    return local.filter((c) => isVisible(c, hub.get(), end, only));
  };
  function addCaseLayers(): void {
    if (map.getSource("cases")) return;
    const vis = new Set(visible().map((c) => c.id));
    map.addSource("cases", {
      type: "geojson",
      data: { type: "FeatureCollection", features: all.features.filter((f) => vis.has(f.properties.id)) } as GeoJSON.FeatureCollection,
      cluster: true,
      clusterRadius: 42,
      clusterMaxZoom: 6,
      clusterProperties: CLUSTER_PROPERTIES as unknown as Record<string, unknown>,
    });
    const clusterColor = ["case", [">", ["get", "pub"], 0], ST.published, [">", ["get", "chk"], 0], ST.checking, ST.dropped] as unknown as string;
    map.addLayer({
      id: "cl",
      type: "circle",
      source: "cases",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": clusterColor,
        "circle-opacity": 0.9,
        "circle-radius": ["step", ["get", "point_count"], 13, 10, 16, 50, 20, 200, 25],
        "circle-stroke-color": ["case", ["boolean", ["feature-state", "hover"], false], "#e7ecf3", "rgba(7, 9, 13, 0.85)"],
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "cl-n",
      type: "symbol",
      source: "cases",
      filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Bold"], "text-size": 11.5, "text-allow-overlap": true },
      paint: { "text-color": INK },
    });
    const hot = ["boolean", ["feature-state", "hover"], false];
    map.addLayer({
      id: "pt",
      type: "circle",
      source: "cases",
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": ["+", ["case", ["==", ["get", "pub"], 1], 6.5, 4.5], ["case", hot, 2.5, 0]] as unknown as number,
        "circle-color": ["match", ["get", "g"], "published", ST.published, "checking", ST.checking, "rgba(0,0,0,0)"] as unknown as string,
        "circle-stroke-color": ["match", ["get", "t"], ...Object.entries(TP).flat(), TP.other] as unknown as string,
        "circle-stroke-width": ["case", ["==", ["get", "g"], "dropped"], 1.5, 2] as unknown as number,
        "circle-stroke-opacity": 0.95,
      },
    });
    map.addLayer({
      id: "pt-sel",
      type: "circle",
      source: "cases",
      filter: ["==", ["get", "id"], hub.get().sel ?? ""],
      paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#e7ecf3", "circle-stroke-width": 2 },
    });
  }
  function applyFilter(): void {
    const vis = visible();
    const ids = new Set(vis.map((c) => c.id));
    (map.getSource("cases") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: all.features.filter((f) => ids.has(f.properties.id)) } as GeoJSON.FeatureCollection);
    syncStats();
    timeLabel.textContent = `${hub.get().win ? `${fmtDay(dayOf(windowRange(hub.get().win, endMs())[0]! + 1))} – ` : "Up to "}${fmtDay(dayOf(endMs()))} · ${vis.length} case${vis.length === 1 ? "" : "s"}`;
  }

  // Hover: the headline in a small tip; the panel row lights up too.
  let hovered: { src: string; id: number } | null = null;
  const setHover = (h: { src: string; id: number } | null) => {
    if (hovered) map.setFeatureState({ source: "cases", id: hovered.id }, { hover: false });
    hovered = h;
    if (h) map.setFeatureState({ source: "cases", id: h.id }, { hover: true });
  };
  const showTip = (e: MapLayerMouseEvent, text: string) => {
    tip.textContent = text;
    tip.hidden = false;
    tip.style.transform = `translate(${Math.round(e.point.x)}px, ${Math.round(e.point.y) - 14}px) translate(-50%, -100%)`;
  };
  // Hit-testing in screen space. MapLibre's own circle hit-test on the globe shrinks toward the
  // limb (a dot drawn 13 px wide took clicks only ~6 px from its centre at zoom 2), and the drawn
  // dots are small anyway. So: the nearest visible dot within HIT_PX of the pointer wins, else a
  // cluster whose drawn disc (+4 px) holds the pointer. Dots behind the globe are skipped.
  const HIT_PX = 12;
  const clusterR = (n: number) => (n >= 200 ? 25 : n >= 50 ? 20 : n >= 10 ? 16 : 13) + 4;
  type MarkerHit = { kind: "pt" | "cl"; f: maplibregl.MapGeoJSONFeature };
  function pick(pt: maplibregl.Point): MarkerHit | null {
    if (!map.getLayer("pt")) return null;
    let best: MarkerHit | null = null;
    let bestD = Infinity;
    const pad = 28;
    for (const f of map.queryRenderedFeatures([[pt.x - pad, pt.y - pad], [pt.x + pad, pt.y + pad]], { layers: ["pt", "cl"] })) {
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      const p = map.project([lon, lat]);
      const back = map.unproject(p);
      if (Math.abs(back.lat - lat) > 0.5 || Math.abs(((back.lng - lon + 540) % 360) - 180) > 0.5) continue; // far side
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      const isCl = f.layer.id === "cl";
      const reach = isCl ? clusterR(Number(f.properties?.point_count ?? 0)) : HIT_PX;
      if (d > reach) continue;
      // Dots beat clusters; nearer beats farther.
      const score = isCl ? d + 1000 : d;
      if (score < bestD) {
        bestD = score;
        best = { kind: isCl ? "cl" : "pt", f };
      }
    }
    return best;
  }
  const clearHover = () => {
    if (!hovered) return;
    map.getCanvas().style.cursor = "";
    setHover(null);
    tip.hidden = true;
    hub.emit("hot", { id: null });
  };
  map.on("mousemove", (e) => {
    const h = pick(e.point);
    const f = h?.f;
    if (!h || !f || typeof f.id !== "number") return clearHover();
    map.getCanvas().style.cursor = "pointer";
    if (hovered?.id !== f.id) setHover({ src: h.kind, id: f.id });
    if (h.kind === "pt") {
      showTip(e, String(f.properties?.title ?? ""));
      hub.emit("hot", { id: String(f.properties?.id ?? "") });
    } else {
      const n = Number(f.properties?.point_count ?? 0);
      const pub = Number(f.properties?.pub ?? 0);
      showTip(e, `${n} cases${pub ? ` · ${pub} published` : ""} — click to zoom in`);
    }
  });
  map.getCanvas().addEventListener("mouseleave", clearHover);
  map.on("click", (e) => {
    const h = pick(e.point);
    if (h?.kind === "pt") {
      const id = String(h.f.properties?.id ?? "");
      if (byId.has(id)) open(id);
      return;
    }
    if (h?.kind === "cl") {
      const cid = h.f.properties?.cluster_id;
      if (typeof cid !== "number") return;
      void (map.getSource("cases") as GeoJSONSource)
        .getClusterExpansionZoom(cid)
        .then((z) => map.easeTo({ center: (h.f.geometry as GeoJSON.Point).coordinates as [number, number], zoom: Math.max(z + 0.3, map.getZoom() + 1.5), duration: reducedMotion() ? 0 : 700, easing: EASE_IN_OUT }))
        .catch(() => {});
      return;
    }
    const v = hub.get();
    if (v.sel && !v.open) hub.set({ sel: null });
  });
  // The panel's rows light the marker.
  let rowHot: number | null = null;
  hub.on("hot", ({ id }) => {
    if (rowHot !== null) map.setFeatureState({ source: "cases", id: rowHot }, { hover: false });
    rowHot = id ? (fidOf.get(id) ?? null) : null;
    if (rowHot !== null && map.getSource("cases")) map.setFeatureState({ source: "cases", id: rowHot }, { hover: true });
  });

  function open(id: string): void {
    hub.touch();
    const c = byId.get(id);
    hub.set({ sel: id, open: true, overlays: c ? defaultOverlays(c) : [] }, { push: !hub.get().open });
  }

  // ---- stats chips follow the time window ------------------------------------------------------------
  const endMs = () => endMsOf(hub.get(), data.generatedAt);
  const statNodes = [...document.querySelectorAll<HTMLElement>(".nums [data-stat]")].map((n) => ({
    n,
    v: n.querySelector<HTMLElement>("dd"),
    k: n.querySelector<HTMLElement>("dt"),
    html: n.querySelector<HTMLElement>("dd")?.innerHTML ?? "",
    label: n.querySelector<HTMLElement>("dt")?.textContent ?? "",
  }));
  function syncStats(): void {
    const v = hub.get();
    const whole = v.win === 0 && v.end === null;
    const st = windowStats(local, v.win, endMs());
    for (const s of statNodes) {
      if (!s.v) continue;
      if (whole) s.v.innerHTML = s.html; // our own server-rendered markup, restored verbatim
      else if (s.n.dataset.stat === "published") s.v.textContent = String(st.published);
      else if (s.n.dataset.stat === "fp") {
        s.v.textContent = String(st.falsePositives);
        if (st.decided) s.v.append(el("span", "num-of", ` of ${st.decided}`));
      }
      if (s.k) {
        s.k.textContent = s.label;
        // The changing part sits in a fixed-width slot so the chips don't shuffle during replay.
        if (!whole) s.k.append(el("span", "num-when", `· ${v.win ? WIN_LABEL[v.win] : `to ${fmtDay(dayOf(endMs()))}`}`));
      }
    }
  }

  // ---- camera: follow the camera into the URL; fly where the panel points -------------------------------
  map.on("moveend", () => {
    const c = map.getCenter();
    hub.set({ center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }, { origin: "camera" });
  });
  for (const ev of ["pointerdown", "wheel", "keydown"] as const) xp.addEventListener(ev, () => hub.touch(), { passive: true });

  /**
   * What the chrome covers — the panel (or the phone's sheet), the chips and search on top, the time
   * bar below — as the map's own padding, so the globe sits in the part you can see and every
   * fly-to lands there.
   */
  function insets(): maplibregl.PaddingOptions {
    const panel = document.getElementById("panel");
    const w = xp.clientWidth;
    const h = xp.clientHeight;
    if (w < 900) {
      const sheetTop = panel ? panel.getBoundingClientRect().top - xp.getBoundingClientRect().top : h;
      return { top: 84, left: 0, right: 0, bottom: Math.max(0, Math.min(h * 0.8, h - sheetTop)) };
    }
    const folded = !hub.get().panel || !panel;
    return { top: 96, left: 0, bottom: 64, right: folded ? 0 : Math.min(w * 0.5, (panel?.offsetWidth ?? 0) + 24) };
  }
  /** Whole-Earth zoom for the visible area: the globe about 90 % of it (≈142 px across at zoom 0). */
  function worldZoom(): number {
    const p = insets();
    const d = 0.9 * Math.min(xp.clientWidth - (p.left ?? 0) - (p.right ?? 0), xp.clientHeight - (p.top ?? 0) - (p.bottom ?? 0));
    return Math.max(0.6, Math.min(3, Math.log2(Math.max(120, d) / 142)));
  }
  const world = () => ({ center: WORLD.center, zoom: worldZoom(), pitch: 0, bearing: 0 });
  const syncInsets = (animate: boolean) => (animate && !reducedMotion() ? map.easeTo({ padding: insets(), duration: 300, easing: EASE_IN_OUT }) : map.setPadding(insets()));
  map.setPadding(insets());
  if (!decodedCamera() && !v0.open) map.jumpTo({ zoom: worldZoom() });
  addEventListener("resize", () => syncInsets(false));
  hub.on("inset", () => syncInsets(true));

  function fly(t: { bbox?: [number, number, number, number]; maxZoom?: number; center?: [number, number]; zoom?: number; pitch?: number; bearing?: number }): void {
    const duration = reducedMotion() ? 0 : 1400; // camera travel, not UI: long enough to keep your bearings
    if (t.bbox) {
      const [w, s, e, n] = t.bbox;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { padding: 32, maxZoom: t.maxZoom ?? 9, duration, easing: EASE_IN_OUT, pitch: map.getPitch(), bearing: map.getBearing() },
      );
    } else {
      // Only the fields we mean to change: an explicit `undefined` pitch breaks the globe transform.
      const o: maplibregl.FlyToOptions = { center: t.center ?? map.getCenter(), duration, easing: EASE_IN_OUT };
      if (t.zoom !== undefined) o.zoom = t.zoom;
      if (t.pitch !== undefined) o.pitch = t.pitch;
      if (t.bearing !== undefined) o.bearing = t.bearing;
      map.flyTo(o);
    }
  }
  const flyToCase = (c: MapCase) => (isGlobal(c) ? fly(world()) : fly({ bbox: c.bbox, maxZoom: MAX_ZOOM[c.kind] }));
  hub.on("fit", ({ bbox, maxZoom }) => fly({ bbox, maxZoom }));

  // ---- toolbar: search · whole Earth · copy link ------------------------------------------------------------
  const searchBox = el("div", "xp-search");
  const input = el("input", "xp-input");
  input.type = "search";
  input.placeholder = matchMedia("(max-width: 899px)").matches ? "Search places" : "Search a place or lat, lon";
  input.setAttribute("aria-label", "Search watched places, cases or coordinates");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.autocomplete = "off";
  input.spellcheck = false;
  const results = el("ul", "xp-results");
  results.id = "xp-results";
  results.setAttribute("role", "listbox");
  results.hidden = true;
  input.setAttribute("aria-controls", results.id);
  searchBox.append(input, results);

  let hits: Hit[] = [];
  let active = -1;
  function renderHits(): void {
    results.replaceChildren();
    hits.forEach((h, i) => {
      const li = el("li", `xp-hit${i === active ? " is-active" : ""}`);
      li.setAttribute("role", "option");
      li.id = `${results.id}-${i}`;
      li.setAttribute("aria-selected", String(i === active));
      li.append(el("span", "xp-hit-l", h.label), el("span", "xp-hit-s", h.sub));
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        go(h);
      });
      results.appendChild(li);
    });
    if (input.value.trim().length >= 2 && !hits.length) results.appendChild(el("li", "xp-hit xp-hit--none", "No watched place or case by that name"));
    results.hidden = input.value.trim().length < 2;
    input.setAttribute("aria-expanded", String(!results.hidden));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${results.id}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }
  function go(h: Hit): void {
    hub.touch();
    input.value = h.label;
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    if (h.kind === "case" && h.id) return open(h.id);
    if (h.bbox) fly({ bbox: h.bbox, maxZoom: 9 });
    else fly({ center: [h.lon, h.lat], zoom: 8 });
    announce(`Moved to ${h.label}`);
  }
  input.addEventListener("input", () => {
    hits = search(input.value, data.places, cases);
    active = hits.length ? 0 : -1;
    renderHits();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!hits.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      renderHits();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = hits[active] ?? hits[0];
      if (h) go(h);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (!results.hidden) {
        results.hidden = true;
        input.setAttribute("aria-expanded", "false");
      } else xp.focus();
    }
  });
  input.addEventListener("blur", () => {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
  });

  const btn = (cls: string, label: string, title: string) => {
    const b = el("button", `xp-btn ${cls}`, label);
    b.type = "button";
    b.title = title;
    return b;
  };
  const worldBtn = btn("xp-btn--world", "Whole Earth", "Back out to the whole planet");
  const shareBtn = btn("xp-btn--share", "Copy link", "Copy a link to exactly this view");
  const tools = el("div", "xp-tools");
  tools.append(worldBtn, shareBtn);
  top.append(searchBox, tools);
  worldBtn.addEventListener("click", () => {
    hub.touch();
    if (hub.get().open) hub.set({ open: false });
    fly(world());
  });
  let copyTimer = 0;
  shareBtn.addEventListener("click", () => {
    hub.touch();
    const c = map.getCenter();
    hub.set({ center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }, { origin: "camera" });
    window.setTimeout(() => {
      void navigator.clipboard?.writeText(location.href).then(
        () => {
          shareBtn.textContent = "Copied";
          clearTimeout(copyTimer);
          copyTimer = window.setTimeout(() => (shareBtn.textContent = "Copy link"), 1400);
        },
        () => (shareBtn.textContent = "Copy failed"),
      );
    }, 300); // after the hub has written the URL
  });

  // ---- time: window · scrubber · replay ----------------------------------------------------------------
  const seg = el("div", "xp-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "Time window");
  const segBtns = WINDOWS.map((w) => {
    const b = el("button", "xp-seg-b", WIN_LABEL[w]);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      hub.touch();
      stopReplay();
      hub.set({ win: w });
    });
    seg.appendChild(b);
    return [w, b] as const;
  });
  const span = Math.max(1, Math.round((Date.parse(latestDay) - Date.parse(startDay)) / DAY_MS));
  const range = el("input", "xp-range");
  range.type = "range";
  range.min = "0";
  range.max = String(span);
  range.step = "1";
  range.setAttribute("aria-label", "Show cases seen up to this day");
  const dayAt = (i: number) => shift(startDay, i);
  range.addEventListener("input", () => {
    hub.touch();
    stopReplay();
    const i = Number(range.value);
    hub.set({ end: i >= span ? null : dayAt(i) });
  });
  const replayBtn = btn("xp-btn--replay", "Replay", "Play the cases in the order they were seen");
  const timeLabel = el("span", "xp-time-l");
  bar.append(seg, range, replayBtn, timeLabel);
  function syncTime(v: View): void {
    for (const [w, b] of segBtns) b.setAttribute("aria-checked", String(v.win === w));
    const i = v.end ? Math.round((Date.parse(v.end) - Date.parse(startDay)) / DAY_MS) : span;
    range.value = String(Math.max(0, Math.min(span, i)));
    range.setAttribute("aria-valuetext", fmtDay(v.end ?? latestDay));
  }
  let replay = 0;
  function stopReplay(): void {
    if (!replay) return;
    cancelAnimationFrame(replay);
    replay = 0;
    replayBtn.textContent = "Replay";
  }
  replayBtn.addEventListener("click", () => {
    hub.touch();
    if (replay) return stopReplay();
    // Linear on purpose: it is time passing, not an object moving. ~6 s whatever the span.
    const win = hub.get().win;
    const from = win ? Math.min(span, Math.round(win / 2)) : 0;
    const t0 = performance.now();
    const dur = 6000;
    replayBtn.textContent = "Pause";
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const i = Math.round(from + (span - from) * k);
      hub.set({ end: i >= span ? null : dayAt(i) });
      if (k < 1) replay = requestAnimationFrame(step);
      else stopReplay();
    };
    replay = requestAnimationFrame(step);
  });

  // ---- the selected case: outline + evidence overlays --------------------------------------------------------
  function announce(t: string): void {
    live.textContent = t;
  }
  /** HLS days: the "after" stack ends on the observation day, the "before" stack a month before first evidence. */
  function imageryDays(c: MapCase): [string[], string[]] {
    const obs = c.observedAt.slice(0, 10);
    const first = c.firstSeen.slice(0, 10);
    const stack = (end: string) => [0, 2, 4, 6, 8, 10].map((d) => shift(end, -d));
    return [stack(shift(first < obs ? first : obs, -30)), stack(obs)];
  }
  let afterOpacity = 1;
  let hlsAfterIds: string[] = [];
  const ovLayers: string[] = [];
  hub.on("fade", ({ value }) => {
    afterOpacity = value;
    for (const id of hlsAfterIds) if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", afterOpacity);
  });
  function clearOverlays(): void {
    for (const id of ovLayers.splice(0)) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    hlsAfterIds = [];
  }
  const below = () => (map.getLayer("cl") ? "cl" : map.getLayer(BASEMAP_LABELS_BELOW) ? BASEMAP_LABELS_BELOW : undefined);
  function addRaster(id: string, tiles: string, bounds: [number, number, number, number], maxzoom: number, opacity: number, attribution: string): void {
    map.addSource(id, { type: "raster", tiles: [tiles], tileSize: 256, minzoom: 5, maxzoom, bounds, attribution });
    map.addLayer({ id, type: "raster", source: id, minzoom: 5, paint: { "raster-opacity": opacity, "raster-fade-duration": 200 } }, map.getLayer(BASEMAP_LABELS_BELOW) ? BASEMAP_LABELS_BELOW : undefined);
    ovLayers.push(id);
  }
  let caseWeather = false; // the rain layer was switched on by a weather case, not by the reader
  function drawOverlays(): void {
    if (!map.isStyleLoaded()) {
      map.once("idle", drawOverlays);
      return;
    }
    clearOverlays();
    const v = hub.get();
    const c = v.sel ? byId.get(v.sel) : undefined;
    if (map.getLayer("pt-sel")) map.setFilter("pt-sel", ["==", ["get", "id"], v.sel ?? ""]);
    const wantRain = !!c && v.overlays.includes("weather") && topicOfCase(c) === "weather";
    if (wantRain && !liveState.get(WEATHER_LAYERS.precip.id)) {
      caseWeather = true;
      void setLive(WEATHER_LAYERS.precip.id, true, true);
    } else if (!wantRain && caseWeather) {
      caseWeather = false;
      void setLive(WEATHER_LAYERS.precip.id, false, true);
    }
    if (!c || isGlobal(c)) return;
    const [w, s, e, n] = c.bbox;
    const pad = Math.max(0.05, (e - w) * 1.5, (n - s) * 1.5);
    const bounds: [number, number, number, number] = [Math.max(-180, w - pad), Math.max(-85, s - pad), Math.min(180, e + pad), Math.min(85, n + pad)];
    try {
      if (v.overlays.includes("imagery") && c.kind !== "fire" && c.kind !== "methane") {
        const [before, after] = imageryDays(c);
        // Oldest first so the newest day paints on top; empty days are transparent.
        [...before].reverse().forEach((d, i) => addRaster(`hls-b-${i}`, HLS(d), bounds, 12, 1, "NASA HLS (Sentinel-2 / Landsat) via GIBS"));
        [...after].reverse().forEach((d, i) => {
          addRaster(`hls-a-${i}`, HLS(d), bounds, 12, afterOpacity, "NASA HLS (Sentinel-2 / Landsat) via GIBS");
          hlsAfterIds.push(`hls-a-${i}`);
        });
      }
      if (v.overlays.includes("alerts") && c.kind === "forest") {
        const from = shift(c.firstSeen.slice(0, 10), -90);
        addRaster("gfw", GFW(from, latestDay), bounds, 12, 0.9, "Global Forest Watch integrated alerts (CC BY 4.0)");
      }
      // The case's own outline (and public registry points), always on for the selection.
      const feats: GeoJSON.Feature[] = [{ type: "Feature", geometry: c.geometry as GeoJSON.Geometry, properties: {} }];
      for (const p of c.points ?? []) feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { site: 1 } });
      map.addSource("sel", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
      const poly = ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]] as unknown as maplibregl.FilterSpecification;
      map.addLayer({ id: "sel-fill", type: "fill", source: "sel", filter: poly, paint: { "fill-color": "#ff9f5a", "fill-opacity": 0.1 } }, below());
      map.addLayer({ id: "sel-line", type: "line", source: "sel", filter: poly, paint: { "line-color": "#ffb784", "line-width": 2 } }, below());
      map.addLayer({ id: "sel-pts", type: "circle", source: "sel", filter: ["==", ["get", "site"], 1], paint: { "circle-radius": 4, "circle-color": "#4ade9b", "circle-stroke-color": INK, "circle-stroke-width": 1 } }, below());
      ovLayers.push("sel-fill", "sel-line", "sel-pts", "sel");
    } catch {
      /* an overlay that can't be added is an overlay not shown */
    }
  }

  // ---- live layers: every registered group, as toggles in the Live panel ----------------------------------------
  registerLayerGroup({
    id: "weather",
    label: "Weather",
    order: 10,
    layers: [
      WEATHER_LAYERS.clouds,
      WEATHER_LAYERS.precip,
      WEATHER_LAYERS.wind,
      stormsLayer(async () => {
        const r = await fetch(`${root}api/storms.json`);
        if (!r.ok) throw new Error("no cyclone snapshot in this export");
        const j = (await r.json()) as GeoJSON.FeatureCollection;
        if (!Array.isArray(j.features)) throw new Error("bad cyclone snapshot");
        return { type: "FeatureCollection", features: j.features };
      }),
    ],
  });
  registerLayerGroup({ id: "climate", label: "Climate", order: 20, layers: [SST_ANOMALY] });
  const handles = new Map<string, LayerHandle>();
  const liveState = new Map<string, boolean>();
  const specs = new Map<string, RegisteredLayer>();
  const rows = new Map<string, { cb: HTMLInputElement; row: HTMLElement }>();
  /** Show or hide one live layer, adding it on first use. `quiet` = not the reader's choice (no URL). */
  async function setLive(id: string, on: boolean, quiet = false): Promise<void> {
    liveState.set(id, on);
    const r = rows.get(id);
    if (r) r.cb.checked = on;
    if (!quiet) {
      hub.touch();
      const l = hub.get().layers.filter((x) => x !== id);
      hub.set({ layers: on ? [...l, id] : l });
    }
    const spec = specs.get(id);
    if (!spec) return;
    const h = handles.get(id);
    if (h) return h.setVisible(on);
    if (!on) return;
    r?.row.classList.add("is-loading");
    try {
      if (!map.isStyleLoaded()) await new Promise((res) => map.once("idle", res));
      const beforeId = map.getLayer("cl") ? "cl" : undefined;
      handles.set(id, spec.kind === "custom" ? await spec.add(map, { beforeId }) : await addLayer(map, spec, { beforeId }));
      if (!liveState.get(id)) handles.get(id)?.setVisible(false);
    } catch (err) {
      console.warn(`${spec.title} unavailable:`, err);
      liveState.set(id, false);
      if (r) {
        r.cb.checked = false;
        r.row.classList.add("is-error");
        r.row.querySelector(".lg-note")!.textContent = `${spec.note} — unavailable right now.`;
      }
    } finally {
      r?.row.classList.remove("is-loading");
    }
  }
  const groupsBox = document.getElementById("layer-groups");
  function renderGroup(g: LayerGroup): void {
    if (!groupsBox) return;
    groupsBox.querySelector(".pane-note")?.remove();
    groupsBox.querySelector(`[data-group="${CSS.escape(g.id)}"]`)?.remove();
    const fs = el("fieldset", "lg-group");
    fs.dataset.group = g.id;
    fs.appendChild(el("legend", "pane-sub", g.label));
    for (const spec of g.layers.filter((s) => s.publicSafe)) {
      specs.set(spec.id, spec);
      const row = el("label", "lg-row");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = liveState.get(spec.id) ?? false;
      cb.addEventListener("change", () => void setLive(spec.id, cb.checked));
      const txt = el("span", "lg-txt");
      txt.append(el("span", "lg-title", spec.title), el("span", "lg-note", spec.note));
      row.append(cb, txt);
      fs.appendChild(row);
      rows.set(spec.id, { cb, row });
    }
    // Keep the groups in their declared order.
    const order = layerGroups().map((x) => x.id);
    const after = [...groupsBox.querySelectorAll<HTMLElement>("[data-group]")].find((n) => order.indexOf(n.dataset.group!) > order.indexOf(g.id));
    groupsBox.insertBefore(fs, after ?? null);
  }
  for (const g of layerGroups()) renderGroup(g);
  onLayerGroup(renderGroup);

  // Planet mode suggests the climate view: whole Earth, the ocean's heat against normal.
  let planetSst = false;
  function enterMode(v: View, prev: View | null): void {
    if (v.mode === "planet" && prev && prev.mode !== "planet") {
      if (!v.open) fly(world());
      if (!liveState.get(SST_ANOMALY.id)) {
        planetSst = true;
        void setLive(SST_ANOMALY.id, true, true);
      }
    } else if (prev?.mode === "planet" && v.mode !== "planet" && planetSst) {
      planetSst = false;
      if (!v.layers.includes(SST_ANOMALY.id)) void setLive(SST_ANOMALY.id, false, true);
    }
  }

  // ---- react to the shared state ---------------------------------------------------------------------------------------
  let saved: { center: [number, number]; zoom: number; pitch: number; bearing: number } | null = null;
  hub.subscribe((v, prev, origin) => {
    if (origin === "camera") return;
    if (v.groups !== prev.groups || v.topics !== prev.topics || v.win !== prev.win || v.end !== prev.end) {
      syncTime(v);
      applyFilter();
    }
    if (v.metric !== prev.metric) void resolveMetric(v).then(applyFilter);
    if (v.mode !== prev.mode) enterMode(v, prev);
    if (v.layers !== prev.layers && origin === "url") for (const id of specs.keys()) void setLive(id, v.layers.includes(id), true);
    if (v.sel !== prev.sel || v.overlays !== prev.overlays) drawOverlays();
    // Opening a case: remember where you were, then fly there. Closing: fly back.
    if (v.open && v.sel && (v.sel !== prev.sel || !prev.open)) {
      if (!prev.open) {
        const c = map.getCenter();
        saved = { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
      }
      const c = byId.get(v.sel);
      if (c) {
        flyToCase(c);
        announce(`${c.statusLabel}: ${c.title}`);
      }
    } else if (!v.open && prev.open) {
      if (saved) fly(saved);
      saved = null;
      xp.focus({ preventScroll: true });
    } else if (v.sel && v.sel !== prev.sel) {
      const c = byId.get(v.sel);
      if (c) {
        flyToCase(c);
        announce(`${c.statusLabel}: ${c.title}. Press Enter to open the case.`);
      }
    } else if (origin === "url" && !v.open && (v.center[0] !== prev.center[0] || v.zoom !== prev.zoom)) fly({ center: v.center, zoom: v.zoom, pitch: v.pitch, bearing: v.bearing });
  });
  async function resolveMetric(v: View): Promise<void> {
    if (!v.metric) {
      only = null;
      return;
    }
    const m: Metrics | null = await hub.metrics();
    const hit = m?.stake.find((s) => s.key === v.metric);
    only = hit ? new Set(hit.caseIds) : null;
  }

  // ---- keyboard: arrows cycle cases, Enter opens, Esc closes the innermost thing --------------------------------------------
  xp.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const v = hub.get();
    if (e.key === "Escape") {
      if (v.open) return; // the panel closes the case (and pops the history entry)
      if (v.sel) {
        hub.set({ sel: null });
        e.preventDefault();
      }
      return;
    }
    if (t !== xp && !t.classList.contains("maplibregl-canvas")) return; // inputs, sliders and buttons keep their keys
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      hub.touch();
      const vis = visible();
      if (!vis.length) return announce("No cases in this view — widen the time window or switch a filter on.");
      const i = vis.findIndex((c) => c.id === v.sel);
      const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
      const next = vis[i < 0 ? (fwd ? 0 : vis.length - 1) : (i + (fwd ? 1 : vis.length - 1)) % vis.length]!;
      if (v.open) open(next.id);
      else hub.set({ sel: next.id });
    } else if (e.key === "Enter" && v.sel && !v.open) {
      e.preventDefault();
      open(v.sel);
    }
  });

  // ---- go --------------------------------------------------------------------------------------------------
  map.on("load", () => {
    // Credits stay one tap away (ⓘ) instead of a two-line strip over the map; the footer lists them all too.
    const attrib = xp.querySelector<HTMLDetailsElement>("details.maplibregl-ctrl-attrib");
    attrib?.classList.remove("maplibregl-compact-show");
    attrib?.removeAttribute("open");
    addCaseLayers();
    applyFilter();
    drawOverlays();
    for (const id of v0.layers) void setLive(id, true, true);
    const v = hub.get();
    if (v.mode === "planet") enterMode(v, { ...v, mode: "cases" });
    if (v.sel) {
      const c = byId.get(v.sel);
      if (c) {
        if (v.open && !v.overlays.length) hub.set({ overlays: defaultOverlays(c) }, { origin: "init" });
        if (v.open) saved = world();
        if (!decodedCamera()) flyToCase(c);
      }
    }
  });
  syncTime(hub.get());
  void resolveMetric(hub.get()).then(() => map.getSource("cases") && applyFilter());
}
