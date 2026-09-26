// protected-fires: the largest forested protected areas in the tropics (WDPA via the GFW Data
// API, `wdpa_protected_areas`), IUCN Ia–IV first, watched for fires and forest loss.
//
// Two queries: (1) terrestrial/coastal, non-proposed WDPA sites > 2,000 km², largest first
// (IDs, names, IUCN, km² and GFW's bbox only — never geometry, per the WDPA licence);
// (2) `wdpa_protected_areas__integrated_alerts__daily_alerts`: which WDPA ids had any
// integrated alert in UMD humid-tropical primary forest over the last 365 days — our
// "is it forest?" filter (without it the list fills with Saharan and Arctic reserves).
// International designations (Ramsar, UNESCO-MAB, World Heritage) are dropped — they
// duplicate national parks. Sites whose box is mostly inside an already-chosen site's box
// are skipped (a national park inside a larger reserve). Tropics = bbox centre within
// ±23.44°. Boxes over 4 deg² are tiled (forest_loss cap).

import type { BBox } from "../../types.js";
import { addDays } from "../../util.js";
import type { WatchAoi, Watchlist } from "../watchlist.js";
import { aoiId, bboxArea, overlapOfSmaller, round, slug, snapOut, tileBBox } from "./geo.js";
import { n, type DiscoverHttp } from "./http.js";

export const WDPA_DATASET = "wdpa_protected_areas";
export const WDPA_ALERTS_DATASET = "wdpa_protected_areas__integrated_alerts__daily_alerts";
export const TROPIC_LAT = 23.44;
export const MIN_PA_KM2 = 2000;
const IUCN_STRICT = ["Ia", "Ib", "II", "III", "IV"];

// Sensitive thresholds, as for the Indigenous-land entries in watchlists/amazon.json
// (days 60, minHa 5, minAlerts 50 on a 0.25 deg² box) but scaled to the box: 40 ha/deg² per
// 60 days (≈ 60 % of the controls' 100 ha/deg²/90 d noise floor, pro-rated to 60 d), floor 5 ha.
export const PROTECTED_HA_PER_DEG2 = 40;
export function protectedThresholds(tileDeg2: number): { days: number; minConfidence: "high"; minAlerts: number; minHa: number } {
  const minHa = Math.max(5, Math.ceil(PROTECTED_HA_PER_DEG2 * tileDeg2));
  return { days: 60, minConfidence: "high", minAlerts: Math.max(50, 10 * minHa), minHa };
}
export const PROTECTED_FIRE_PARAMS = { dayRange: 2, minFrp: 20, minDetections: 5 } as const;

export function wdpaListSql(): string {
  return (
    "SELECT site_id, name_eng, name, desig_eng, desig_type, iucn_cat, iso3, gis_area, realm, status, gfw_bbox FROM data " +
    `WHERE gis_area > ${MIN_PA_KM2} AND realm <> 'Marine' AND status <> 'Proposed' ORDER BY gis_area DESC LIMIT 2000`
  );
}

export function wdpaForestSql(from: string): string {
  return (
    "SELECT wdpa_protected_area__id, SUM(alert__count) FROM data " +
    `WHERE gfw_integrated_alerts__date >= '${from}' AND is__umd_regional_primary_forest_2001 = true GROUP BY wdpa_protected_area__id`
  );
}

export interface ProtectedRaw {
  wdpaVersion: string;
  alertsVersion: string;
  forestFrom: string;
  sites: Array<Record<string, unknown>>;
  forestRows: Array<Record<string, unknown>>;
}

export async function fetchProtected(http: DiscoverHttp, today: string): Promise<ProtectedRaw> {
  const [wdpaVersion, alertsVersion] = await Promise.all([http.gfwLatestVersion(WDPA_DATASET), http.gfwLatestVersion(WDPA_ALERTS_DATASET)]);
  const forestFrom = addDays(today, -365);
  const [sites, forestRows] = await Promise.all([
    http.gfwSql(WDPA_DATASET, wdpaVersion, wdpaListSql()),
    http.gfwSql(WDPA_ALERTS_DATASET, alertsVersion, wdpaForestSql(forestFrom)),
  ]);
  return { wdpaVersion, alertsVersion, forestFrom, sites, forestRows };
}

export interface ProtectedSite {
  id: string;
  name: string;
  designation: string;
  iucn: string;
  iso3: string;
  km2: number;
  bbox: BBox;
  indigenous: boolean;
  forestAlerts365d: number;
}

export function rankProtected(raw: ProtectedRaw, max: number): ProtectedSite[] {
  const forest = new Map<string, number>();
  for (const r of raw.forestRows) forest.set(String(r.wdpa_protected_area__id), n(r.sum));
  const candidates: ProtectedSite[] = [];
  for (const r of raw.sites) {
    const bb = Array.isArray(r.gfw_bbox) ? (r.gfw_bbox as unknown[]).map(Number) : [];
    if (bb.length !== 4 || !bb.every(Number.isFinite)) continue;
    const bbox = snapOut(bb as unknown as BBox, 0.01);
    const midLat = (bbox[1] + bbox[3]) / 2;
    if (Math.abs(midLat) > TROPIC_LAT || bbox[2] - bbox[0] > 30 || bbox[0] >= bbox[2]) continue;
    if (String(r.desig_type ?? "") === "International") continue;
    const id = String(r.site_id ?? "");
    const alerts = forest.get(id);
    if (!id || !(alerts! > 0)) continue;
    const desig = String(r.desig_eng ?? "");
    candidates.push({
      id,
      name: String(r.name_eng ?? r.name ?? id),
      designation: desig,
      iucn: String(r.iucn_cat ?? ""),
      iso3: String(r.iso3 ?? "").split(";")[0]!,
      km2: n(r.gis_area),
      bbox,
      indigenous: /indigenous|ind[ií]gena/i.test(desig),
      forestAlerts365d: alerts!,
    });
  }
  const tier = (p: ProtectedSite) => (IUCN_STRICT.includes(p.iucn) ? 0 : 1);
  candidates.sort((a, b) => tier(a) - tier(b) || b.km2 - a.km2 || a.id.localeCompare(b.id));
  const chosen: ProtectedSite[] = [];
  for (const c of candidates) {
    if (chosen.length >= max) break;
    if (chosen.some((p) => overlapOfSmaller(p.bbox, c.bbox) > 0.6)) continue;
    chosen.push(c);
  }
  return chosen;
}

export function buildProtectedFires(raw: ProtectedRaw, max: number, generatedOn: string): { watchlist: Watchlist; sites: ProtectedSite[] } {
  const sites = rankProtected(raw, max);
  const aois: WatchAoi[] = [];
  for (const p of sites) {
    const tiles = tileBBox(p.bbox, 4, 2);
    const base = aoiId("wdpa", p.id);
    for (const t of tiles) {
      const area = bboxArea(t.bbox);
      aois.push({
        id: t.count > 1 ? `${base}-${t.index}` : base,
        name: `${p.name} (${p.iso3})${t.count > 1 ? ` — tile ${t.index}/${t.count}` : ""}`.slice(0, 120),
        bbox: t.bbox,
        tags: [
          ...new Set(
            ["protected-area", "discovered", p.iso3.toLowerCase(), p.iucn ? `iucn-${slug(p.iucn)}` : "", slug(p.designation), p.indigenous ? "indigenous-land" : ""].filter(Boolean),
          ),
        ],
        control: false,
        cooldownDays: 14,
        rules: [
          { name: "fires_in_protected", params: { ...PROTECTED_FIRE_PARAMS } },
          { name: "forest_loss", params: protectedThresholds(area) },
        ],
        notes:
          `Discovered ${generatedOn} from WDPA ${raw.wdpaVersion} (via GFW; IDs/stats only): ${p.designation || "protected area"}, IUCN ${p.iucn || "n/a"}, ` +
          `${Math.round(p.km2).toLocaleString("en-US")} km²; ${p.forestAlerts365d.toLocaleString("en-US")} primary-forest alert pixels since ${raw.forestFrom}. ` +
          (t.count > 1 ? `Tile ${t.index}/${t.count} (${round(area, 2)} deg²). ` : "") +
          `The box is a watch window around the site, not its legal boundary: https://www.protectedplanet.net/${p.id}`,
      });
    }
  }
  return {
    sites,
    watchlist: {
      version: 1,
      name: "Protected areas — fires & forest loss, discovered",
      description:
        `Generated by \`earthdeck discover\` on ${generatedOn}. The ${sites.length} largest tropical protected areas (WDPA ${raw.wdpaVersion}, ` +
        `> ${MIN_PA_KM2} km², IUCN Ia–IV first, national designations) that contain primary forest (GFW integrated alerts in ` +
        `primary forest since ${raw.forestFrom}), tiled to ≤ 4 deg², with sensitive thresholds. Do not hand-edit — re-run discover.`,
      aois,
    },
  };
}
