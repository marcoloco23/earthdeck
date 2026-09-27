// `api/map.json` — the one file the public site's interactive map reads. A compact projection of
// the ledger: per case its plain headline, status group, case type, topic, whether it is about the
// whole planet, a point, its outline and the dates the evidence overlays need; plus the watched
// places for the map's keyless search. Shapes mirror web/src/site/map/model.ts (MapCase, MapPlace,
// MapData).
//
// Deliberately coarse where the rules are: a fire case is its cluster centroid only — no
// detection points — because the people nearest a fire in Indigenous land must not get a
// precise public pin (see src/watch/rules/firesInProtected.ts).

import { PUBLIC_STATUSES, type Finding, type Geometry } from "../ledger/schema.js";
import { livingValueOf } from "./export.js";
import { areaHaOf, fmtUsd, PLAIN_STATUS, plainArea, plainTitle } from "./site-render.js";

export type MapGroup = "published" | "checking" | "dropped";
export type MapKind = "forest" | "fire" | "flaring" | "flaring-stopped" | "methane" | "other";
/** What a case is about, in a reader's words — the Cases filter chips and the marker ring. */
export type MapTopic = "forest" | "fire" | "flaring" | "methane" | "ocean" | "ice" | "air" | "weather" | "trend" | "other";

export interface MapCase {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  group: MapGroup;
  kind: MapKind;
  topic: MapTopic;
  /** About the whole planet (world trend, sea ice, ENSO): shown in the Planet panel, never as a map marker. */
  global: boolean;
  place: string | null;
  /** Place · size · value of nature at stake — the same words the case rows use. */
  meta: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
  observedAt: string;
  /** Earliest evidence datetime — the "before" side of the imagery overlay. */
  firstSeen: string;
  geometry: Geometry;
  /** The watched indicator (indicator rules only) — ties a planet case to its world-pulse row. */
  indicator?: string;
  /** Extra public points (registry sites where flaring stopped). Never fire detections. */
  points?: [number, number][];
}

export interface MapPlace {
  id: string;
  name: string;
  lon: number;
  lat: number;
  bbox: [number, number, number, number];
}

export interface MapData {
  v: 1;
  generatedAt: string;
  cases: MapCase[];
  places: MapPlace[];
}

const KIND_BY_RULE: Record<string, MapKind> = {
  forest_loss: "forest",
  fires_in_protected: "fire",
  flaring: "flaring",
  flaring_stopped: "flaring-stopped",
  methane_anomaly: "methane",
};

const TOPIC_BY_RULE: Record<string, MapTopic> = {
  forest_loss: "forest",
  fires_in_protected: "fire",
  flaring: "flaring",
  flaring_stopped: "flaring",
  methane_anomaly: "methane",
  weather_extreme: "weather",
  indicator_trend: "trend",
};
const TOPIC_BY_INDICATOR: Record<string, MapTopic> = {
  sea_ice: "ice",
  marine_heatwave: "ocean",
  enso: "ocean",
  air_quality: "air",
  river_discharge: "weather",
  quake: "other",
};
/** Indicators whose "place" stands for the whole planet. */
const GLOBAL_INDICATORS = new Set(["sea_ice", "enso"]);

/** The indicator an indicator rule watched (`params.indicator` on its evidence), if any. */
export function indicatorOf(f: Pick<Finding, "evidence">): string | null {
  for (const e of f.evidence) {
    const v = e.method.params?.indicator;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** Pure: a case's topic from its rule and, for threshold rules, the indicator it watched. */
export function topicOf(rule: string, indicator: string | null): MapTopic {
  if (rule === "indicator_threshold") return (indicator ? TOPIC_BY_INDICATOR[indicator] : undefined) ?? "other";
  return TOPIC_BY_RULE[rule] ?? "other";
}

/**
 * Pure: is a case about the whole planet rather than a place? World-trend AOIs (`wp-…`), any box
 * spanning half the globe or more (sea ice), and planet-scale indicators (ENSO).
 */
export function isGlobalCase(x: { bbox: readonly number[]; aoiId?: string | null; indicator?: string | null }): boolean {
  if (x.aoiId?.startsWith("wp-")) return true;
  if (x.indicator && GLOBAL_INDICATORS.has(x.indicator)) return true;
  const [w, , e] = x.bbox;
  return typeof w === "number" && typeof e === "number" && e - w >= 180;
}

export function groupOf(status: string): MapGroup {
  if ((PUBLIC_STATUSES as readonly string[]).includes(status)) return "published";
  if (status === "candidate" || status === "confirmed") return "checking";
  return "dropped";
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const finite = (b: readonly number[]) => b.length === 4 && b.every(Number.isFinite);

function stoppedSites(f: Finding): [number, number][] | undefined {
  const raw = f.evidence.find((e) => e.method.name === "flaring_stopped")?.method.params?.stoppedSites;
  if (!Array.isArray(raw)) return undefined;
  const pts = raw.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)));
  return pts.length ? pts.slice(0, 200).map(([x, y]) => [r4(x), r4(y)]) : undefined;
}

/** Pure: the map's data file from the ledger's findings. */
export function mapData(findings: readonly Finding[], now = new Date()): MapData {
  const cases: MapCase[] = [];
  const places = new Map<string, MapPlace>();
  for (const f of findings) {
    if (!finite(f.bbox)) continue;
    const [w, s, e, n] = f.bbox;
    const ha = areaHaOf(f);
    const lv = livingValueOf(f);
    const place = f.aoi?.name ?? null;
    const ev = [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])].map((x) => x.datetime).filter(Boolean).sort();
    const pts = f.rule.name === "flaring_stopped" ? stoppedSites(f) : undefined;
    const indicator = indicatorOf(f);
    const global = isGlobalCase({ bbox: f.bbox, aoiId: f.aoi?.id, indicator });
    cases.push({
      id: f.findingId,
      title: plainTitle(f),
      status: f.status,
      statusLabel: PLAIN_STATUS[f.status] ?? f.status.replace(/_/g, " "),
      group: groupOf(f.status),
      kind: KIND_BY_RULE[f.rule.name] ?? "other",
      topic: topicOf(f.rule.name, indicator),
      global,
      place,
      meta: [place, ha !== null ? plainArea(ha) : "", lv !== null ? `nature’s work worth ≈ ${fmtUsd(lv)} a year` : ""].filter(Boolean).join(" · "),
      lon: r4((w + e) / 2),
      lat: r4((s + n) / 2),
      bbox: [r4(w), r4(s), r4(e), r4(n)],
      observedAt: f.observedAt,
      firstSeen: ev[0] ?? f.observedAt,
      geometry: f.geometry,
      ...(indicator ? { indicator } : {}),
      ...(pts ? { points: pts } : {}),
    });
    // Search places are places: a world-trend "AOI" is not somewhere to fly to.
    if (f.aoi && place && !global) {
      const p = places.get(f.aoi.id);
      const b: [number, number, number, number] = p ? [Math.min(p.bbox[0], w), Math.min(p.bbox[1], s), Math.max(p.bbox[2], e), Math.max(p.bbox[3], n)] : [w, s, e, n];
      places.set(f.aoi.id, { id: f.aoi.id, name: place, lon: r4((b[0] + b[2]) / 2), lat: r4((b[1] + b[3]) / 2), bbox: b.map(r4) as MapPlace["bbox"] });
    }
  }
  cases.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return { v: 1, generatedAt: now.toISOString(), cases, places: [...places.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
