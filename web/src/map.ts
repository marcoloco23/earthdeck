import maplibregl from "maplibre-gl";
import type { BBox, Card, EventItem, FireItem } from "./types";

// NASA GIBS Blue Marble (static, no API key) as a reliable, beautiful basemap.
const GIBS_BASEMAP =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";

let map: maplibregl.Map | null = null;
const overlayIds: string[] = [];
let eventMarkers: maplibregl.Marker[] = [];
const FIRE_LAYER = "fires-src";

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

function fitBBox(bbox: BBox): void {
  if (!map) return;
  const [w, s, e, n] = bbox;
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: 60, duration: 900, maxZoom: 9 },
  );
}

/** Drop a rendered image as a georeferenced overlay and fly to it. */
export function showImagery(card: Card): void {
  if (!map || !card.bbox || !card.imageUrl) return;
  const [w, s, e, n] = card.bbox;
  const id = `ov-${card.id}`;
  if (map.getSource(id)) return;

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
  fitBBox(card.bbox);
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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
