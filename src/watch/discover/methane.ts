// methane-basins: oil & gas CH₄ source clusters from Climate TRACE v7.
//
// v7 `/sources` has no bbox filter, but WITHOUT a gadmId it ranks sources globally: one call
// per subsector (`subsectors=oil-and-gas-production|refining|transport&gas=ch4&limit=1000`)
// returns every located source with its CH₄ tonnes (live 2026-09-26: 733 / 728 / 733 rows,
// all `point-source`, year 2025 — under the page size, so complete). Production/transport
// "sources" are basin × resource-type aggregates placed at a basin centroid
// ("Iraq_Widyan - North Arabian Gulf_Conventional onshore"); refineries are facilities.
// Dropped: `…_OtherBasins_…` (a national residual placed at an arbitrary point — not a place)
// and deepwater/offshore rows (TROPOMI has almost no CH₄ retrievals over open water). Sources within
// BASIN_KM chain into one cluster, ranked by summed CH₄.
//
// Names: basin names only. Facility names (refineries) carry operator names — never used for
// names or tags; a cluster is named after its largest production/transport basin, or
// generically. No person is ever named.

import { adminLabel, type AdminPlace } from "../../clients/geo.js";
import { climateTraceBase } from "../../config.js";
import type { BBox } from "../../types.js";
import type { WatchAoi, Watchlist } from "../watchlist.js";
import { aoiId, bboxArea, boxAround, clusterSingleLinkage, padKm, pointsBBox, round, slug, snapOut } from "./geo.js";
import type { DiscoverHttp } from "./http.js";

export const CT_SUBSECTORS = ["oil-and-gas-production", "oil-and-gas-refining", "oil-and-gas-transport"] as const;
export const BASIN_KM = 50;
/** Half a degree of padding: a lone basin centroid becomes a 1°×1° box, like watchlists/methane.json. */
export const BASIN_PAD_KM = 55;
/** S5P anomaly boxes stay ≤ 2°×2°: bigger boxes average the signal away and cost more CDSE units. */
export const METHANE_MAX_SIDE = 2;
export const METHANE_PARAMS = { windowDays: 14, baselineDays: 90, minAnomalyPpb: 20, minValidPct: 40 } as const;

export interface CtRow {
  id: number;
  name: string;
  subsector: string;
  country: string;
  lat: number;
  lon: number;
  ch4T: number;
  year: number | null;
}

export interface MethaneRaw {
  base: string;
  bySubsector: Record<string, unknown>;
}

export async function fetchMethane(http: DiscoverHttp): Promise<MethaneRaw> {
  const base = climateTraceBase();
  const bySubsector: Record<string, unknown> = {};
  for (const sub of CT_SUBSECTORS) {
    bySubsector[sub] = await http.json("climatetrace", `${base}/sources?subsectors=${sub}&gas=ch4&limit=1000`, { headers: { accept: "application/json" } });
  }
  return { base, bySubsector };
}

export function parseCtRows(raw: MethaneRaw): { rows: CtRow[]; dropped: { otherBasins: number; deepwater: number; zero: number } } {
  const rows: CtRow[] = [];
  const dropped = { otherBasins: 0, deepwater: 0, zero: 0 };
  for (const sub of CT_SUBSECTORS) {
    const list = raw.bySubsector[sub];
    if (!Array.isArray(list)) continue;
    for (const s of list as Array<Record<string, unknown>>) {
      const c = (s.centroid ?? {}) as { latitude?: unknown; longitude?: unknown };
      const lat = Number(c.latitude);
      const lon = Number(c.longitude);
      const ch4T = Number(s.emissionsQuantity);
      const name = String(s.name ?? "");
      if (typeof s.id !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!(ch4T > 0)) {
        dropped.zero++;
        continue;
      }
      if (/_OtherBasins_/i.test(name)) {
        dropped.otherBasins++;
        continue;
      }
      if (/deepwater|deep water|offshore/i.test(name)) {
        dropped.deepwater++;
        continue;
      }
      rows.push({ id: s.id, name, subsector: sub, country: String(s.country ?? ""), lat, lon, ch4T, year: typeof s.year === "number" ? s.year : null });
    }
  }
  rows.sort((a, b) => a.id - b.id || a.subsector.localeCompare(b.subsector));
  return { rows, dropped };
}

const FLUIDS = /\s+(?:Other\s+)?(?:Dry Gas|Wet Gas|Coal-bed Gas|Ultra-Light Oil|Extra-Heavy Oil|Light Oil|Heavy Oil|Medium Oil|Condensate)$/;

/**
 * A readable basin/play name. Global rows: "Iraq_Widyan - North Arabian Gulf_Conventional
 * onshore" → "Widyan - North Arabian Gulf". US rows ("<play> <fluid> <state>"): "Permian
 * Spraberry Lower Lower Spraberry Lower Light Oil TX" → "Permian Spraberry Lower (TX)";
 * "Haynesville-Bossier-Bossier Haynesville-Bossier Wet Gas TX" → "Haynesville-Bossier (TX)".
 */
export function basinName(name: string): string {
  const parts = name.split("_");
  if (parts.length >= 3) return parts.slice(1, -1).join(" ").trim();
  let rest = name.trim();
  const st = /\s([A-Z]{2})$/.exec(rest);
  if (st) rest = rest.slice(0, -3);
  rest = rest.replace(FLUIDS, "").replace(/\s+Other$/, "");
  const seen = new Set<string>();
  const words = rest
    .split(/\s+/)
    .map((w) => (w === "-" ? w : [...new Set(w.split("-"))].join("-")))
    .filter((w) => w === "-" || (!seen.has(w) && !!seen.add(w)));
  const out = words.join(" ").replace(/\s+-\s*$/, "");
  return st ? `${out} (${st[1]})` : out;
}

export interface Basin {
  rows: CtRow[];
  ch4T: number;
  lead: CtRow;
  name: string;
  country: string;
  centroid: { lat: number; lon: number };
}

export function methaneBasins(rows: readonly CtRow[], km = BASIN_KM): Basin[] {
  const basins = clusterSingleLinkage(rows, km).map((idx) => {
    const members = idx.map((i) => rows[i]!);
    const ch4T = members.reduce((s, m) => s + m.ch4T, 0);
    const byId = (a: CtRow, b: CtRow) => b.ch4T - a.ch4T || a.id - b.id;
    const lead = [...members].sort(byId)[0]!;
    const named = [...members].filter((m) => m.subsector !== "oil-and-gas-refining").sort(byId)[0];
    const byCountry = new Map<string, number>();
    for (const m of members) byCountry.set(m.country, (byCountry.get(m.country) ?? 0) + m.ch4T);
    const country = [...byCountry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    const w = members.reduce((s, m) => s + m.ch4T, 0);
    const centroid = { lat: members.reduce((s, m) => s + m.lat * m.ch4T, 0) / w, lon: members.reduce((s, m) => s + m.lon * m.ch4T, 0) / w };
    return { rows: members, ch4T, lead, name: named ? basinName(named.name) : "Refining cluster", country, centroid };
  });
  return basins.sort((a, b) => b.ch4T - a.ch4T || a.lead.id - b.lead.id);
}

/** Padded cluster bbox, shrunk to a METHANE_MAX_SIDE box on the CH₄-weighted centroid if it would be larger. */
export function basinBox(b: Basin): BBox {
  const padded = padKm(pointsBBox(b.rows), BASIN_PAD_KM);
  const tooWide = padded[2] - padded[0] > METHANE_MAX_SIDE || padded[3] - padded[1] > METHANE_MAX_SIDE;
  return snapOut(tooWide ? boxAround(b.centroid.lon, b.centroid.lat, METHANE_MAX_SIDE) : padded, 0.01);
}

/** "Oil & gas basin: Central Sub-basin - West Siberia, Russia"; refineries: "Oil & gas refining near Ector, Texas (United States)". */
export function basinTitle(b: Basin, place: AdminPlace | null): string {
  const country = place?.country ?? b.country;
  if (b.name !== "Refining cluster") return `Oil & gas basin: ${b.name}, ${country}`.slice(0, 120);
  return `Oil & gas refining near ${adminLabel(place) ?? `${round(b.centroid.lat, 2)}, ${round(b.centroid.lon, 2)} (${b.country})`}`.slice(0, 120);
}

export function buildMethaneBasins(
  raw: MethaneRaw,
  max: number,
  generatedOn: string,
  placeAt: (lat: number, lon: number) => AdminPlace | null = () => null,
): { watchlist: Watchlist; basins: Basin[]; dropped: ReturnType<typeof parseCtRows>["dropped"] } {
  const { rows, dropped } = parseCtRows(raw);
  const basins = methaneBasins(rows).slice(0, max);
  const years = [...new Set(rows.map((r) => r.year).filter((y): y is number => y != null))].sort();
  const aois: WatchAoi[] = basins.map((b) => {
    const bbox = basinBox(b);
    const subs = [...new Set(b.rows.map((r) => r.subsector.replace("oil-and-gas-", "")))].sort();
    return {
      id: aoiId("ch4", b.country, "ct", b.lead.id),
      name: basinTitle(b, placeAt(b.centroid.lat, b.centroid.lon)),
      bbox,
      tags: [...new Set(["methane", "oil-gas", "discovered", b.country.toLowerCase(), slug(b.name)].filter(Boolean))],
      control: false,
      cooldownDays: 30,
      rules: [{ name: "methane_anomaly", params: { ...METHANE_PARAMS } }],
      notes:
        `Discovered ${generatedOn} from Climate TRACE v7 (CC BY 4.0, ${years.join("/") || "year n/a"}): ` +
        `${Math.round(b.ch4T).toLocaleString("en-US")} t CH₄/yr from ${b.rows.length} source record(s) (${subs.join(", ")}) chained within ${BASIN_KM} km. ` +
        `Climate TRACE places basin-level estimates at a basin centroid, so this box (${round(bboxArea(bbox), 2)} deg²) is a watch window around that point, not the basin outline.`,
    };
  });
  return {
    basins,
    dropped,
    watchlist: {
      version: 1,
      name: "Methane — oil & gas basins, discovered",
      description:
        `Generated by \`earthdeck discover\` on ${generatedOn}. The top ${basins.length} oil & gas CH₄ clusters from Climate TRACE v7 ` +
        `(${CT_SUBSECTORS.join(", ")}), sources chained within ${BASIN_KM} km, ranked by t CH₄/yr; national "OtherBasins" residuals and ` +
        `deepwater basins dropped. Do not hand-edit — re-run discover.`,
      aois,
    },
  };
}
