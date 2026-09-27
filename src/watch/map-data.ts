// `api/map.json` — the one file the public site's interactive map reads. A compact projection of
// the ledger: per case its plain headline, status group, case type, a point, its outline and the
// dates the evidence overlays need; plus the watched places for the map's keyless search. The
// map loads it lazily (never before the reader touches the map or the page goes idle), so the
// landing stays light. Shapes mirror web/src/site/map/model.ts (MapCase, MapPlace, MapData).
//
// Deliberately coarse where the rules are: a fire case is its cluster centroid only — no
// detection points — because the people nearest a fire in Indigenous land must not get a
// precise public pin (see src/watch/rules/firesInProtected.ts).

import { PUBLIC_STATUSES, type Finding, type Geometry } from "../ledger/schema.js";
import { livingValueOf } from "./export.js";
import { areaHaOf, fmtUsd, PLAIN_STATUS, plainArea, plainTitle } from "./site-render.js";

export type MapGroup = "published" | "checking" | "dropped";
export type MapKind = "forest" | "fire" | "flaring" | "flaring-stopped" | "methane" | "other";

export interface MapCase {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  group: MapGroup;
  kind: MapKind;
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
    cases.push({
      id: f.findingId,
      title: plainTitle(f),
      status: f.status,
      statusLabel: PLAIN_STATUS[f.status] ?? f.status.replace(/_/g, " "),
      group: groupOf(f.status),
      kind: KIND_BY_RULE[f.rule.name] ?? "other",
      place,
      meta: [place, ha !== null ? plainArea(ha) : "", lv !== null ? `nature’s work worth ≈ ${fmtUsd(lv)} a year` : ""].filter(Boolean).join(" · "),
      lon: r4((w + e) / 2),
      lat: r4((s + n) / 2),
      bbox: [r4(w), r4(s), r4(e), r4(n)],
      observedAt: f.observedAt,
      firstSeen: ev[0] ?? f.observedAt,
      geometry: f.geometry,
      ...(pts ? { points: pts } : {}),
    });
    if (f.aoi && place) {
      const p = places.get(f.aoi.id);
      const b: [number, number, number, number] = p ? [Math.min(p.bbox[0], w), Math.min(p.bbox[1], s), Math.max(p.bbox[2], e), Math.max(p.bbox[3], n)] : [w, s, e, n];
      places.set(f.aoi.id, { id: f.aoi.id, name: place, lon: r4((b[0] + b[2]) / 2), lat: r4((b[1] + b[3]) / 2), bbox: b.map(r4) as MapPlace["bbox"] });
    }
  }
  cases.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return { v: 1, generatedAt: now.toISOString(), cases, places: [...places.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
