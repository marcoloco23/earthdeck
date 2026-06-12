import maplibregl from "maplibre-gl";
import type { BBox, Card, EventItem, FireItem, QuakeItem } from "./types";

// NASA GIBS Blue Marble (static, no API key) as a reliable, beautiful basemap.
const GIBS_BASEMAP =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";

let map: maplibregl.Map | null = null;
const overlayIds: string[] = [];
let eventMarkers: maplibregl.Marker[] = [];
const FIRE_LAYER = "fires-src";
const QUAKE_LAYER = "quakes-src";

/**
 * Initialize the MapLibre map. Returns false (without throwing) if the browser can't
 * create a WebGL context, so the rest of the dashboard (the live feed) keeps working.
 */
export function createMap(): boolean {
  try {
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        sources: {
          gibs: {
            type: "raster",
            tiles: [GIBS_BASEMAP],
            tileSize: 256,
            maxzoom: 8,
            attribution: "NASA EOSDIS GIBS",
          },
        },
        layers: [{ id: "gibs", type: "raster", source: "gibs" }],
      },
      center: [0, 20],
      zoom: 1.4,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    return true;
  } catch (err) {
    console.error("map init failed (WebGL unavailable?) — feed still works:", err);
    map = null;
    return false;
  }
}

export function mapReady(): boolean {
  return map !== null;
}

function fitBBox(bbox: BBox, maxZoom = 9): void {
  if (!map) return;
  const [w, s, e, n] = bbox;
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 60, duration: 900, maxZoom },
  );
}

/** Drop a rendered image as a georeferenced overlay and fly to it. */
export function showImagery(card: Card): void {
  if (!map || !card.bbox || !card.imageUrl) return;
  const [w, s, e, n] = card.bbox;
  const id = `ov-${card.id}`;
  if (map.getSource(id)) {
    // Re-click of an already-overlaid card: bring it to the front and fly back to it —
    // returning early here was why clicking imagery cards "didn't navigate".
    if (map.getLayer(id)) map.moveLayer(id);
    fitBBox(card.bbox, 13);
    return;
  }

  map.addSource(id, {
    type: "image",
    url: card.imageUrl,
    coordinates: [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  });
  map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.92, "raster-fade-duration": 300 } });
  overlayIds.push(id);

  // Cap overlays to keep the map light.
  while (overlayIds.length > 12) {
    const old = overlayIds.shift();
    if (old && map.getLayer(old)) map.removeLayer(old);
    if (old && map.getSource(old)) map.removeSource(old);
  }
  // 10 m imagery overlays stay sharp well past the basemap's zoom 8/9 — zoom into them.
  fitBBox(card.bbox, 13);
}

const CATEGORY_COLOR: Record<string, string> = {
  Wildfires: "#f97316",
  "Severe Storms": "#38bdf8",
  Volcanoes: "#ef4444",
  Floods: "#3b82f6",
  "Sea and Lake Ice": "#a5f3fc",
  "Dust and Haze": "#d6b370",
  Earthquakes: "#a78bfa",
  Landslides: "#b45309",
};

/** Plot event points as colored markers, replacing the previous event layer. */
export function showEvents(card: Card): void {
  if (!map) return;
  for (const m of eventMarkers) m.remove();
  eventMarkers = [];

  const events = (card.payload.events as EventItem[] | undefined) ?? [];
  const pts: [number, number][] = [];
  for (const ev of events) {
    if (!ev.coordinates) continue;
    const [lon, lat] = ev.coordinates;
    pts.push([lon, lat]);
    const el = document.createElement("div");
    el.className = "evt-marker";
    el.style.background = CATEGORY_COLOR[ev.category] ?? "#22d3ee";
    const popup = new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(
      `<strong>${escapeHtml(ev.title)}</strong><br><span class="evt-cat">${escapeHtml(ev.category)}</span>` +
        (ev.magnitude ? `<br>${escapeHtml(ev.magnitude)}` : "") +
        (ev.lastDate ? `<br><span class="evt-date">${escapeHtml(ev.lastDate)}</span>` : ""),
    );
    eventMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).setPopup(popup).addTo(map));
  }

  if (card.bbox) {
    fitBBox(card.bbox);
  } else if (pts.length > 0) {
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    map.fitBounds(b, { padding: 80, duration: 900, maxZoom: 6 });
  }
}

/** Overlay the "after" image of a compare card on the map so the location is visible. */
export function showCompare(card: Card): void {
  if (!map || !card.bbox || !card.imageUrls || card.imageUrls.length < 2) return;
  showImagery({ ...card, imageUrl: card.imageUrls[1] });
}

/** Plot fire detections as a GPU circle layer (handles hundreds of points cheaply). */
export function showFires(card: Card): void {
  const m = map;
  if (!m) return;
  const fires = (card.payload.fires as FireItem[] | undefined) ?? [];
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: fires.map((f) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
      properties: { confidence: String(f.confidence ?? ""), frp: f.frp ?? 0, acqDate: f.acqDate },
    })),
  };

  const src = m.getSource(FIRE_LAYER) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
  } else {
    m.addSource(FIRE_LAYER, { type: "geojson", data });
    m.addLayer({
      id: FIRE_LAYER,
      type: "circle",
      source: FIRE_LAYER,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 2.5, 8, 5.5],
        "circle-color": "#f97316",
        "circle-opacity": 0.85,
        "circle-stroke-color": "#fde68a",
        "circle-stroke-width": 0.5,
      },
    });
    m.on("click", FIRE_LAYER, (e) => {
      const feat = e.features?.[0];
      if (!feat || feat.geometry.type !== "Point") return;
      const p = feat.properties ?? {};
      new maplibregl.Popup({ offset: 8, closeButton: false })
        .setLngLat(feat.geometry.coordinates as [number, number])
        .setHTML(
          `<strong>Fire detection</strong><br>confidence: ${escapeHtml(String(p.confidence ?? ""))}` +
            `<br>FRP: ${escapeHtml(String(p.frp ?? ""))} MW` +
            `<br><span class="evt-date">${escapeHtml(String(p.acqDate ?? ""))}</span>`,
        )
        .addTo(m);
    });
  }

  if (card.bbox) fitBBox(card.bbox);
}

/** Plot earthquakes as a GPU circle layer, radius scaled by magnitude. */
export function showQuakes(card: Card): void {
  const m = map;
  if (!m) return;
  const quakes = (card.payload.quakes as QuakeItem[] | undefined) ?? [];
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: quakes.map((q) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [q.lon, q.lat] },
      properties: { mag: q.mag ?? 0, place: q.place, time: q.time, depthKm: q.depthKm ?? 0 },
    })),
  };

  const src = m.getSource(QUAKE_LAYER) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
  } else {
    m.addSource(QUAKE_LAYER, { type: "geojson", data });
    m.addLayer({
      id: QUAKE_LAYER,
      type: "circle",
      source: QUAKE_LAYER,
      paint: {
        // Magnitude is log-energy: emphasize the big ones.
        "circle-radius": ["interpolate", ["linear"], ["get", "mag"], 3, 3, 6, 9, 8, 18],
        "circle-color": "#a78bfa",
        "circle-opacity": 0.6,
        "circle-stroke-color": "#ede9fe",
        "circle-stroke-width": 1,
      },
    });
    m.on("click", QUAKE_LAYER, (e) => {
      const feat = e.features?.[0];
      if (!feat || feat.geometry.type !== "Point") return;
      const p = feat.properties ?? {};
      new maplibregl.Popup({ offset: 8, closeButton: false })
        .setLngLat(feat.geometry.coordinates as [number, number])
        .setHTML(
          `<strong>M${escapeHtml(String(p.mag ?? "?"))}</strong> ${escapeHtml(String(p.place ?? ""))}` +
            `<br>depth ${escapeHtml(String(p.depthKm ?? "?"))} km` +
            `<br><span class="evt-date">${escapeHtml(String(p.time ?? "").slice(0, 16))}</span>`,
        )
        .addTo(m);
    });
  }

  if (card.bbox) {
    fitBBox(card.bbox);
  } else if (quakes.length > 0) {
    const b = new maplibregl.LngLatBounds([quakes[0].lon, quakes[0].lat], [quakes[0].lon, quakes[0].lat]);
    for (const q of quakes) b.extend([q.lon, q.lat]);
    map?.fitBounds(b, { padding: 80, duration: 900, maxZoom: 5 });
  }
}

const SIMILAR_LAYER = "similar-src";
const SIMILAR_REF = "similar-ref";

/** Similarity heatmap: every sampled cell as a color-ramped square + a ring at the ref. */
export function showSimilar(card: Card): void {
  const m = map;
  if (!m) return;
  const heat = (card.payload.heat as Array<{ lon: number; lat: number; sim: number }> | undefined) ?? [];
  const ref = card.payload.ref as { lon: number; lat: number } | undefined;
  const data: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: heat.map((h) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [h.lon, h.lat] },
      properties: { sim: h.sim },
    })),
  };
  const src = m.getSource(SIMILAR_LAYER) as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(data);
  } else {
    m.addSource(SIMILAR_LAYER, { type: "geojson", data });
    m.addLayer({
      id: SIMILAR_LAYER,
      type: "circle",
      source: SIMILAR_LAYER,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.6, 9, 4.5, 12, 9],
        // Cosine similarity ramp: cold blue → dim → hot amber/red near 1.
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "sim"],
          0.0, "#1e3a5f",
          0.6, "#3b5b78",
          0.8, "#caa53d",
          0.9, "#f59e0b",
          0.97, "#ef4444",
        ],
        "circle-opacity": 0.75,
      },
    });
  }
  const refData: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: ref ? [{ type: "Feature", geometry: { type: "Point", coordinates: [ref.lon, ref.lat] }, properties: {} }] : [],
  };
  const refSrc = m.getSource(SIMILAR_REF) as maplibregl.GeoJSONSource | undefined;
  if (refSrc) {
    refSrc.setData(refData);
  } else {
    m.addSource(SIMILAR_REF, { type: "geojson", data: refData });
    m.addLayer({
      id: SIMILAR_REF,
      type: "circle",
      source: SIMILAR_REF,
      paint: {
        "circle-radius": 9,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#f8fafc",
        "circle-stroke-width": 2.5,
      },
    });
  }
  if (card.bbox) fitBBox(card.bbox, 11);
}

/** Fly to a card's bbox without adding an overlay (series cards carry a location). */
export function focusBBox(card: Card): void {
  if (!map || !card.bbox) return;
  fitBBox(card.bbox);
}

export function clearOverlays(): void {
  if (!map) {
    overlayIds.length = 0;
    return;
  }
  for (const id of overlayIds) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  overlayIds.length = 0;
  for (const m of eventMarkers) m.remove();
  eventMarkers = [];
  if (map.getLayer(FIRE_LAYER)) map.removeLayer(FIRE_LAYER);
  if (map.getSource(FIRE_LAYER)) map.removeSource(FIRE_LAYER);
  if (map.getLayer(QUAKE_LAYER)) map.removeLayer(QUAKE_LAYER);
  if (map.getSource(QUAKE_LAYER)) map.removeSource(QUAKE_LAYER);
  for (const id of [SIMILAR_LAYER, SIMILAR_REF]) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
