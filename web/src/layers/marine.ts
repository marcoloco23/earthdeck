// Marine map layers — same small interface as ./weather.ts (`addLayer(map, spec)` → handle).
// Both read static JSON the runner exported (src/watch/marine-export.ts); the secrets behind
// them (GFW token, aisstream key) never reach the browser. When a file is missing (runner has
// no key, or the local dashboard) `addLayer` rejects and toggles show "unavailable".
//
//   fishing  api/marine/fishing.json — Global Fishing Watch apparent fishing hours per 0.1° cell,
//            last 30 days, around the watched marine reserves → heatmap (circles when zoomed in)
//   ships    api/marine/ships.json   — vessels per 0.1° cell from one ≤ 20 s aisstream.io sample
//            over busy straits + a few reserves → density circles. Never individual ships/tracks.
//
// For the site's Live mode: `registerLayerGroup()` returns { id: "marine", label, layers };
// pass your registry's own register function to have it called with the group.

import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";
import type { LayerHandle } from "./weather";

type FC = GeoJSON.FeatureCollection;

export interface MarineSpec {
  kind: "fishing" | "ships";
  id: string;
  title: string;
  /** Relative to the page (the site passes its depth prefix, e.g. "../"). */
  url: string;
  attribution: string;
  publicSafe: boolean;
  note: string;
}

export function marineLayers(base = ""): { fishing: MarineSpec; ships: MarineSpec } {
  return {
    fishing: {
      kind: "fishing",
      id: "marine-fishing",
      title: "Fishing effort (30 days)",
      url: `${base}api/marine/fishing.json`,
      attribution: '<a href="https://globalfishingwatch.org/" target="_blank" rel="noopener">Global Fishing Watch</a> (CC BY-NC 4.0)',
      publicSafe: true,
      note: "Apparent fishing hours from AIS around watched marine reserves — vessels without AIS are invisible; ~4 days behind.",
    },
    ships: {
      kind: "ships",
      id: "marine-ships",
      title: "Ship density (AIS sample)",
      url: `${base}api/marine/ships.json`,
      attribution: '<a href="https://aisstream.io/" target="_blank" rel="noopener">aisstream.io</a>',
      publicSafe: true,
      note: "Vessels per 0.1° cell from a 20-second AIS sample over busy straits — coastal receivers only; open ocean looks empty.",
    },
  };
}

export const MARINE_LAYERS = marineLayers();

export interface LayerGroup {
  id: string;
  label: string;
  layers: MarineSpec[];
}

/** The marine layer group; `register` (the host's registry) is called with it when given. */
export function registerLayerGroup(register?: (g: LayerGroup) => void, base = ""): LayerGroup {
  const l = marineLayers(base);
  const group: LayerGroup = { id: "marine", label: "Oceans & ships", layers: [l.fishing, l.ships] };
  register?.(group);
  return group;
}

async function loadFC(url: string): Promise<FC> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const j = (await res.json()) as FC;
  if (j?.type !== "FeatureCollection" || !Array.isArray(j.features)) throw new Error(`${url}: not a FeatureCollection`);
  return { type: "FeatureCollection", features: j.features };
}

export async function addLayer(map: MlMap, spec: MarineSpec, opts: { visible?: boolean; beforeId?: string } = {}): Promise<LayerHandle> {
  const data = await loadFC(spec.url);
  const visibility = opts.visible === false ? "none" : "visible";
  const id = spec.id;
  if (!map.getSource(id)) map.addSource(id, { type: "geojson", data, attribution: spec.attribution });
  const ids = spec.kind === "fishing" ? [`${id}-heat`, `${id}-cell`] : [`${id}-dot`];
  if (spec.kind === "fishing") {
    if (!map.getLayer(ids[0]!))
      map.addLayer(
        {
          id: ids[0]!,
          type: "heatmap",
          source: id,
          maxzoom: 7,
          layout: { visibility },
          paint: {
            "heatmap-weight": ["interpolate", ["linear"], ["get", "hours"], 0, 0, 50, 1],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 1, 4, 6, 18],
            "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.85, 7, 0],
            "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "#1f6f8b", 0.5, "#2ec4b6", 0.8, "#f2c94c", 1, "#ff7a45"],
          },
        },
        opts.beforeId,
      );
    if (!map.getLayer(ids[1]!))
      map.addLayer(
        {
          id: ids[1]!,
          type: "circle",
          source: id,
          minzoom: 5,
          layout: { visibility },
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2, 9, 8],
            "circle-color": ["interpolate", ["linear"], ["get", "hours"], 0, "#2ec4b6", 20, "#f2c94c", 100, "#ff7a45"],
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0, 7, 0.8],
          },
        },
        opts.beforeId,
      );
  } else if (!map.getLayer(ids[0]!)) {
    map.addLayer(
      {
        id: ids[0]!,
        type: "circle",
        source: id,
        layout: { visibility },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 3, 10, 7, 40, 12],
          "circle-color": "#8ab4ff",
          "circle-opacity": 0.55,
          "circle-stroke-color": "#07090d",
          "circle-stroke-width": 0.5,
        },
      },
      opts.beforeId,
    );
  }
  return {
    id,
    setVisible(v) {
      for (const l of ids) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", v ? "visible" : "none");
    },
    remove() {
      for (const l of ids) if (map.getLayer(l)) map.removeLayer(l);
      if (map.getSource(id)) map.removeSource(id);
    },
    setData(d) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(d);
    },
  };
}
