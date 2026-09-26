// forest-hotspots: the sub-national (GADM level-2) areas with the most GFW integrated
// deforestation alerts in the last 30 days, straight from GFW's precomputed summary table —
// no raster query, three small SQL calls whatever N is.
//
// Source table `gadm__integrated_alerts__adm2_daily_alerts` (daily, one row per
// iso/adm1/adm2 × date × confidence × context flags; `alert__count` = alert pixels,
// `alert_area__ha`; covers the last ~2 years). `adm1`/`adm2` are GADM 4.1 positional
// integers: `BRA`,14,8 ↔ gid_2 `BRA.14.8_2` (Altamira, Pará) — the `_n` suffix varies, so we
// look up both `_1` and `_2`. Filters (why):
// - confidence high|highest — matches the forest_loss rule's `minConfidence: high`;
// - `is__umd_regional_primary_forest_2001 = true` — without it the ranking is dominated by
//   Sahel/Sudan dryland alerts (≈415 M alert pixels/30 d in "Unknown" non-tree-cover land vs
//   ~7 M in tree cover, live 2026-09-26) that are not deforestation. Cost: frontiers in
//   secondary forest/cerrado/chaco rank lower. Documented in the README.
// Window: the 30 days ending on the table's newest alert date (alerts lag ~2 days).

import type { BBox } from "../../types.js";
import { addDays } from "../../util.js";
import type { WatchAoi, Watchlist } from "../watchlist.js";
import { aoiId, bboxArea, round, slug, snapOut, tileBBox } from "./geo.js";
import { n, type DiscoverHttp } from "./http.js";

export const ADM2_ALERTS_DATASET = "gadm__integrated_alerts__adm2_daily_alerts";
export const GADM_DATASET = "gadm_administrative_boundaries";
export const FOREST_WINDOW_DAYS = 30;
/** The forest_loss tool caps a bbox at 4 deg²; we also cap a side at 2° so rings stay useful. */
export const FOREST_TILE_MAX_DEG2 = 4;
export const FOREST_TILE_MAX_SIDE = 2;
/**
 * Share of an area's alerts inside strict protected areas (WDPA IUCN Ia/Ib/II — the table's
 * "Category Ia/b or II") or LandMark Indigenous & community lands that earns the
 * `protected-or-indigenous` tag (district-level: a tile carries it even if its own box
 * misses the land). "Other Category" is excluded: in Brazil it is dominated by APAs
 * (environmental protection areas over farmland) — with it, 250 of 303 tiles got the tag
 * at a 5 % share (live 2026-09-26). At 25 %, 63 of 150 districts carry it: "a quarter or
 * more of the clearing is on protected or Indigenous land" (at 10 %: 93, at 50 %: 34).
 */
export const PROTECTED_SHARE_TAG = 0.25;

// ---- thresholds ----------------------------------------------------------------------------
//
// Calibration points (live, 2026-09-26):
//   loud   — São Félix do Xingu watch box: 232 ha / 0.25 deg² / 90 d  ≈ 928 ha/deg²/90 d;
//   noise  — control cores (Jaú, Salonga) drew 15–19 ha / 0.25 deg² / 90 d of high-confidence
//            alerts with nothing happening; controls.json sets the floor at 25 ha / 0.25 deg²
//            = 100 ha/deg²/90 d.
// Formula: minHa = max(25, ceil(100 × tileDeg²)) — the control noise floor scaled to the tile
// (≈ 11 % of São Félix-level density), never below the controls' absolute 25 ha.
// minAlerts = 10 × minHa (the São Félix entry's 200 alerts : 20 ha ratio).
// Deliberately NOT a function of the 30-day count: thresholds then depend only on geometry,
// so a re-run doesn't move the bar under an open case, and a hot district still fires
// because its density is far above the floor.
export const HOTSPOT_NOISE_HA_PER_DEG2 = 100;
export const HOTSPOT_MIN_HA = 25;

export function hotspotThresholds(tileDeg2: number): { days: number; minConfidence: "high"; minAlerts: number; minHa: number } {
  const minHa = Math.max(HOTSPOT_MIN_HA, Math.ceil(HOTSPOT_NOISE_HA_PER_DEG2 * tileDeg2));
  return { days: 90, minConfidence: "high", minAlerts: 10 * minHa, minHa };
}

// ---- SQL -----------------------------------------------------------------------------------

const DATE = "gfw_integrated_alerts__date";
const CONF = "gfw_integrated_alerts__confidence";

export function forestWhere(from: string): string {
  return `${DATE} >= '${from}' AND (${CONF} = 'high' OR ${CONF} = 'highest') AND is__umd_regional_primary_forest_2001 = true`;
}

/** Top areas. One SUM only (see http.ts): alerts = SUM(count), ha = AVG(area) × COUNT(*). */
export function topAreasSql(from: string, limit: number): string {
  return (
    `SELECT iso, adm1, adm2, SUM(alert__count), AVG(alert_area__ha), COUNT(*) FROM data WHERE ${forestWhere(from)} ` +
    `GROUP BY iso, adm1, adm2 ORDER BY SUM(alert_area__ha) DESC LIMIT ${limit}`
  );
}

/** Alerts per area that fell inside a strict (IUCN Ia/Ib/II) WDPA area or LandMark Indigenous/community land. */
export function protectedAlertsSql(from: string): string {
  return (
    `SELECT iso, adm1, adm2, SUM(alert__count) FROM data WHERE ${forestWhere(from)} ` +
    `AND (wdpa_protected_areas__iucn_cat = 'Category Ia/b or II' OR is__landmark_indigenous_and_community_lands = true) GROUP BY iso, adm1, adm2`
  );
}

export function gadmSql(keys: readonly AreaKey[]): string {
  const ors = keys.flatMap((k) => [1, 2].map((s) => `gid_2 = '${k.iso}.${k.adm1}.${k.adm2}_${s}'`)).join(" OR ");
  return `SELECT gid_2, name_0, name_1, name_2, gfw_bbox FROM data WHERE adm_level = '2' AND (${ors})`;
}

// ---- fetch ---------------------------------------------------------------------------------

export interface AreaKey {
  iso: string;
  adm1: number;
  adm2: number;
}

export interface ForestRaw {
  alertsVersion: string;
  gadmVersion: string;
  window: { from: string; to: string };
  top: Array<Record<string, unknown>>;
  protectedRows: Array<Record<string, unknown>>;
  gadm: Array<Record<string, unknown>>;
}

export async function fetchForest(http: DiscoverHttp, limit: number): Promise<ForestRaw> {
  const [alertsVersion, gadmVersion] = await Promise.all([http.gfwLatestVersion(ADM2_ALERTS_DATASET), http.gfwLatestVersion(GADM_DATASET)]);
  const maxRow = await http.gfwSql(ADM2_ALERTS_DATASET, alertsVersion, `SELECT MAX(${DATE}) FROM data`);
  const to = String(maxRow[0]?.max ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error(`forest: no newest alert date in ${ADM2_ALERTS_DATASET}/${alertsVersion}`);
  const from = addDays(to, -(FOREST_WINDOW_DAYS - 1));
  const [top, protectedRows] = await Promise.all([
    http.gfwSql(ADM2_ALERTS_DATASET, alertsVersion, topAreasSql(from, limit)),
    http.gfwSql(ADM2_ALERTS_DATASET, alertsVersion, protectedAlertsSql(from)),
  ]);
  const keys = top.map(areaKey).filter((k): k is AreaKey => k !== null);
  const gadm: Array<Record<string, unknown>> = [];
  for (let i = 0; i < keys.length; i += 40) {
    gadm.push(...(await http.gfwSql(GADM_DATASET, gadmVersion, gadmSql(keys.slice(i, i + 40)))));
  }
  return { alertsVersion, gadmVersion, window: { from, to }, top, protectedRows, gadm };
}

// ---- build (pure) --------------------------------------------------------------------------

function areaKey(r: Record<string, unknown>): AreaKey | null {
  const iso = String(r.iso ?? "");
  const adm1 = n(r.adm1);
  const adm2 = n(r.adm2);
  if (!/^[A-Z]{3}$/.test(iso) || !Number.isInteger(adm1) || !Number.isInteger(adm2)) return null;
  return { iso, adm1, adm2 };
}
const keyStr = (k: AreaKey) => `${k.iso}.${k.adm1}.${k.adm2}`;

export interface HotspotArea extends AreaKey {
  rank: number;
  alerts: number;
  ha: number;
  protectedShare: number;
  gid: string;
  country: string;
  adm1Name: string;
  adm2Name: string;
  bbox: BBox;
}

/** Join the three tables into ranked areas (deterministic: ha desc, then key). */
export function hotspotAreas(raw: ForestRaw): { areas: HotspotArea[]; skipped: string[] } {
  const skipped: string[] = [];
  const gadmByKey = new Map<string, Record<string, unknown>>();
  for (const g of [...raw.gadm].sort((a, b) => String(a.gid_2).localeCompare(String(b.gid_2)))) {
    const m = /^([A-Z]{3})\.(\d+)\.(\d+)_\d+$/.exec(String(g.gid_2 ?? ""));
    if (m && !gadmByKey.has(`${m[1]}.${m[2]}.${m[3]}`)) gadmByKey.set(`${m[1]}.${m[2]}.${m[3]}`, g);
  }
  const prot = new Map<string, number>();
  for (const r of raw.protectedRows) {
    const k = areaKey(r);
    if (k) prot.set(keyStr(k), n(r.sum));
  }
  const rows = raw.top
    .map((r) => ({ k: areaKey(r), alerts: n(r.sum), ha: n(r.avg) * n(r.count) }))
    .filter((r): r is { k: AreaKey; alerts: number; ha: number } => r.k !== null && Number.isFinite(r.ha) && Number.isFinite(r.alerts))
    .sort((a, b) => b.ha - a.ha || keyStr(a.k).localeCompare(keyStr(b.k)));
  const areas: HotspotArea[] = [];
  rows.forEach((r, i) => {
    const g = gadmByKey.get(keyStr(r.k));
    const bb = Array.isArray(g?.gfw_bbox) ? (g!.gfw_bbox as unknown[]).map(Number) : [];
    if (!g || bb.length !== 4 || !bb.every(Number.isFinite)) {
      skipped.push(`${keyStr(r.k)}: no GADM 4.1 boundary`);
      return;
    }
    const bbox = snapOut(bb as unknown as BBox, 0.01);
    if (bbox[2] - bbox[0] > 30 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      skipped.push(`${keyStr(r.k)}: bbox ${JSON.stringify(bb)} crosses the antimeridian or is degenerate`);
      return;
    }
    areas.push({
      ...r.k,
      rank: i + 1,
      alerts: r.alerts,
      ha: round(r.ha, 1),
      protectedShare: r.alerts > 0 ? round((prot.get(keyStr(r.k)) ?? 0) / r.alerts, 3) : 0,
      gid: String(g.gid_2),
      country: String(g.name_0 ?? r.k.iso),
      adm1Name: String(g.name_1 ?? r.k.adm1),
      adm2Name: String(g.name_2 ?? r.k.adm2),
      bbox,
    });
  });
  return { areas, skipped };
}

export function buildForestHotspots(raw: ForestRaw, generatedOn: string): { watchlist: Watchlist; areas: HotspotArea[]; skipped: string[] } {
  const { areas, skipped } = hotspotAreas(raw);
  const aois: WatchAoi[] = [];
  const { from, to } = raw.window;
  for (const a of areas) {
    const tiles = tileBBox(a.bbox, FOREST_TILE_MAX_DEG2, FOREST_TILE_MAX_SIDE);
    const baseId = aoiId(a.iso, a.adm1, a.adm2);
    const tags = [
      "forest-hotspot",
      "discovered",
      a.iso.toLowerCase(),
      slug(a.country),
      slug(a.adm1Name),
      slug(a.adm2Name),
      ...(a.protectedShare >= PROTECTED_SHARE_TAG ? ["protected-or-indigenous"] : []),
    ].filter(Boolean);
    for (const t of tiles) {
      const area = bboxArea(t.bbox);
      const th = hotspotThresholds(area);
      const tileNote = t.count > 1 ? ` Tile ${t.index}/${t.count} of the district bbox (${round(area, 2)} deg²).` : ` Whole district bbox (${round(area, 2)} deg²).`;
      aois.push({
        id: t.count > 1 ? `${baseId}-${t.index}` : baseId,
        name: `${a.adm2Name}, ${a.adm1Name} (${a.country})${t.count > 1 ? ` — tile ${t.index}/${t.count}` : ""}`.slice(0, 120),
        bbox: t.bbox,
        tags: [...new Set(tags)],
        control: false,
        cooldownDays: 30,
        rules: [{ name: "forest_loss", params: th }],
        notes:
          `Discovered ${generatedOn}: rank ${a.rank} by GFW integrated alerts (high+ confidence, primary forest), ` +
          `${a.alerts.toLocaleString("en-US")} alerts / ${Math.round(a.ha).toLocaleString("en-US")} ha in ${from}…${to} (GADM ${a.gid}; ` +
          `${Math.round(a.protectedShare * 100)}% inside strict protected or Indigenous/community land).${tileNote} ` +
          `Thresholds: minHa = max(25, 100 ha/deg² × area) = ${th.minHa}; a bbox is a watch window, not the legal boundary.`,
      });
    }
  }
  const watchlist: Watchlist = {
    version: 1,
    name: "Forest hotspots — discovered",
    description:
      `Generated by \`earthdeck discover\` on ${generatedOn}. The ${areas.length} GADM level-2 areas with the most GFW integrated ` +
      `deforestation alerts (high+ confidence, in UMD humid-tropical primary forest) in ${from}…${to}, from GFW's precomputed ` +
      `${ADM2_ALERTS_DATASET} (${raw.alertsVersion}); boxes from ${GADM_DATASET} ${raw.gadmVersion}, tiled to ≤ ${FOREST_TILE_MAX_DEG2} deg². ` +
      `Do not hand-edit — re-run discover.`,
    aois,
  };
  return { watchlist, areas, skipped };
}
