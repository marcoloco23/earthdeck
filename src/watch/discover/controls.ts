// controls-generated: expected-quiet cores inside the largest tropical Intact Forest
// Landscapes (IFL 2020, Potapov et al.; GFW dataset `ifl_intact_forest_landscapes` v2021 —
// the newest version with a vector table; `latest` = v2025 is raster-only). An IFL is by
// definition ≥ 500 km² of unfragmented forest with no roads or settlements, so its deepest
// interior is the best "nothing should happen here" place we can derive from data.
//
// Two queries: the largest IFL polygons (> 5,000 km²) with their bboxes; then, for the N + 15
// picked (round-robin across SAM / AFR / SEA so one continent can't fill the list), the
// centre + radius of each polygon's maximum inscribed circle (PostGIS
// ST_MaximumInscribedCircle on a 0.01°-simplified geometry; ~25 s server-side). The control box is a
// 0.5° square on that centre (as in watchlists/controls.json), shrunk to fit the circle.

import type { BBox } from "../../types.js";
import type { WatchAoi, Watchlist } from "../watchlist.js";
import { aoiId, boxAround, overlapOfSmaller, round, snapOut } from "./geo.js";
import { n, type DiscoverHttp } from "./http.js";

export const IFL_DATASET = "ifl_intact_forest_landscapes";
export const IFL_VERSION = "v2021";
export const CONTROL_SIDE = 0.5;
/** Extra candidates whose interior may prove too narrow (radius < ~0.14°) or that touch a hotspot tile — skipped in order. */
export const CONTROL_SPARES = 15;
/** Integrated alerts cover 30°S–30°N; stay inside the tropics like the other lists. */
const LAT_LIMIT = 23.44;
const REGION_NAMES: Record<string, string> = { SAM: "South America", AFR: "Central Africa", SEA: "Southeast Asia & New Guinea" };

// The thresholds of watchlists/controls.json, verbatim — a control must be judged by the same bar.
export const CONTROL_RULES = [
  { name: "forest_loss", params: { days: 90, minConfidence: "high", minAlerts: 300, minHa: 25 } },
  { name: "fires_in_protected", params: { dayRange: 2, minFrp: 20, minDetections: 5 } },
];

export function iflListSql(): string {
  return "SELECT ifl_id, gfw_area__ha, gfw_bbox FROM data WHERE year = 2020 AND gfw_area__ha > 500000 ORDER BY gfw_area__ha DESC LIMIT 400";
}

export function iflCoreSql(ids: readonly string[]): string {
  const mic = "ST_MaximumInscribedCircle(ST_SimplifyPreserveTopology(geom, 0.01))";
  return (
    `SELECT ifl_id, ST_X((${mic}).center), ST_Y((${mic}).center), (${mic}).radius FROM data ` +
    `WHERE year = 2020 AND (${ids.map((id) => `ifl_id = '${id}'`).join(" OR ")})`
  );
}

export interface IflPick {
  id: string;
  region: string;
  ha: number;
  bbox: BBox;
}

/** Tropical IFLs, largest first, interleaved by region prefix (SAM, AFR, SEA, …). */
export function pickIfl(rows: Array<Record<string, unknown>>, max: number): IflPick[] {
  const byRegion = new Map<string, IflPick[]>();
  for (const r of rows) {
    const bb = Array.isArray(r.gfw_bbox) ? (r.gfw_bbox as unknown[]).map(Number) : [];
    const id = String(r.ifl_id ?? "");
    if (!id || bb.length !== 4 || !bb.every(Number.isFinite)) continue;
    if (Math.abs((bb[1]! + bb[3]!) / 2) > LAT_LIMIT) continue;
    const region = id.split("_")[0]!;
    const list = byRegion.get(region) ?? [];
    list.push({ id, region, ha: n(r.gfw_area__ha), bbox: bb as unknown as BBox });
    byRegion.set(region, list);
  }
  for (const list of byRegion.values()) list.sort((a, b) => b.ha - a.ha || a.id.localeCompare(b.id));
  const order = [...byRegion.keys()].sort((a, b) => (byRegion.get(b)![0]!.ha - byRegion.get(a)![0]!.ha) || a.localeCompare(b));
  const out: IflPick[] = [];
  for (let i = 0; out.length < max; i++) {
    let any = false;
    for (const reg of order) {
      const p = byRegion.get(reg)![i];
      if (p && out.length < max) {
        out.push(p);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

export interface ControlsRaw {
  list: Array<Record<string, unknown>>;
  cores: Array<Record<string, unknown>>;
  picks: IflPick[];
}

export async function fetchControls(http: DiscoverHttp, max: number): Promise<ControlsRaw> {
  const list = await http.gfwSql(IFL_DATASET, IFL_VERSION, iflListSql());
  const picks = pickIfl(list, max + CONTROL_SPARES);
  const cores = picks.length ? await http.gfwSql(IFL_DATASET, IFL_VERSION, iflCoreSql(picks.map((p) => p.id))) : [];
  return { list, cores, picks };
}

/**
 * `avoid`: boxes a control must not touch — the forest-hotspot tiles of the same run, so a
 * "should be quiet" box never sits inside an active frontier's watch window (4 of 20 did on
 * the first live run). Without them (e.g. `--only controls-generated`) nothing is avoided.
 */
export function buildControls(raw: ControlsRaw, max: number, generatedOn: string, avoid: readonly BBox[] = []): { watchlist: Watchlist; skipped: string[] } {
  const picks = pickIfl(raw.list, max + CONTROL_SPARES);
  const core = new Map<string, { lon: number; lat: number; r: number }>();
  for (const c of raw.cores) core.set(String(c.ifl_id), { lon: n(c.st_x), lat: n(c.st_y), r: n(c.radius) });
  const skipped: string[] = [];
  const aois: WatchAoi[] = [];
  for (const p of picks) {
    if (aois.length >= max) break;
    const c = core.get(p.id);
    if (!c || ![c.lon, c.lat, c.r].every(Number.isFinite)) {
      skipped.push(`${p.id}: no inscribed circle`);
      continue;
    }
    // A square of side s fits in a circle of radius r when s ≤ r·√2; keep ≥ 0.2°.
    const side = Math.min(CONTROL_SIDE, Math.floor(c.r * Math.SQRT2 * 20) / 20);
    if (side < 0.2) {
      skipped.push(`${p.id}: interior too narrow (r = ${round(c.r, 3)}°)`);
      continue;
    }
    const bbox = snapOut(boxAround(round(c.lon, 2), round(c.lat, 2), side), 0.01);
    if (avoid.some((b) => overlapOfSmaller(b, bbox) > 0)) {
      skipped.push(`${p.id}: core box overlaps a forest-hotspot tile`);
      continue;
    }
    aois.push({
      id: aoiId("ctl", "ifl", p.id),
      name: `Intact forest core ${p.id} (${REGION_NAMES[p.region] ?? p.region})`,
      bbox,
      tags: ["control", "intact-forest", "discovered", p.region.toLowerCase()],
      control: true,
      cooldownDays: 30,
      rules: CONTROL_RULES.map((r) => ({ name: r.name, params: { ...r.params } })),
      notes:
        `Discovered ${generatedOn}: ${side}° box on the deepest interior point of Intact Forest Landscape ${p.id} ` +
        `(IFL 2020, ${Math.round(p.ha / 100).toLocaleString("en-US")} km²; inscribed-circle radius ${round(c.r, 2)}° ≈ ${Math.round(c.r * 111)} km from any IFL edge). ` +
        "Expected quiet: every finding here counts against the rule's error rate. Seasonal floodplain radar alerts are a known noise source (see controls.json).",
    });
  }
  return {
    skipped,
    watchlist: {
      version: 1,
      name: "Controls — intact forest cores, discovered",
      description:
        `Generated by \`earthdeck discover\` on ${generatedOn}. ${aois.length} expected-quiet boxes at the deepest interior of the largest ` +
        `tropical Intact Forest Landscapes (IFL 2020 via GFW ${IFL_DATASET} ${IFL_VERSION}), interleaved across continents, with the ` +
        "thresholds of watchlists/controls.json. Do not hand-edit — re-run discover.",
      aois,
    },
  };
}
