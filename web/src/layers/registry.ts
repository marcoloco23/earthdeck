// Extra map layers, by group — the public site's Live panel lists every registered group as a set of
// toggles. A layer module registers itself when it is imported:
//
//   import { registerLayerGroup } from "./registry";
//   registerLayerGroup({ id: "marine", label: "Ships & fishing", layers: [shipsSpec, fishingSpec] });
//
// The site map (web/src/site/map/explore.ts) imports every module in web/src/layers/ eagerly, so a
// new file here shows up in the panel without touching the map. A layer is either a weather-style
// LayerSpec (added with weather.ts's addLayer) or a self-adding entry with its own `add(map)`.
// Specs with `publicSafe: false` never appear on the public site.

import type { Map as MlMap } from "maplibre-gl";
import type { LayerHandle, LayerSpec } from "./weather";

export interface CustomLayer {
  kind: "custom";
  id: string;
  title: string;
  /** One line under the toggle: what it is, how fresh, what it is not. */
  note: string;
  attribution?: string;
  publicSafe: boolean;
  add(map: MlMap, opts?: { visible?: boolean; beforeId?: string }): Promise<LayerHandle>;
}
export type RegisteredLayer = LayerSpec | CustomLayer;

export interface LayerGroup {
  id: string;
  label: string;
  layers: RegisteredLayer[];
  /** Lower first; weather is 10. */
  order?: number;
}

const groups = new Map<string, LayerGroup>();
const listeners = new Set<(g: LayerGroup) => void>();

/** Add (or replace, by id) a group of layers. Listeners — the Live panel — hear about it at once. */
export function registerLayerGroup(g: LayerGroup): void {
  groups.set(g.id, g);
  for (const fn of listeners) fn(g);
}

export function layerGroups(): LayerGroup[] {
  return [...groups.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.label.localeCompare(b.label));
}

/** Hear about groups registered later (a module that loads after the map). Returns an unsubscribe. */
export function onLayerGroup(fn: (g: LayerGroup) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
