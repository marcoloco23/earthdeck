// flaring-fields: flare "fields" from the EOG VIIRS Nightfire ANNUAL flare summary (one
// zero-key KML, ~14k sites, parsed by src/clients/vnf.ts). Sites within FIELD_KM of each
// other chain into one field (single linkage — a field is a string of flares), fields are
// ranked by summed flared volume (BCM), and each becomes a padded-bbox AOI for the `flaring`
// rule. A field too large for the flaring tool's 25 deg² cap is split into grid cells, each
// cell's AOI hugging only the sites inside it.

import type { BBox } from "../../types.js";
import { adminLabel, type AdminPlace } from "../../clients/geo.js";
import { parseVnfKml, VNF_ANNUAL, VNF_DEFAULT_YEAR, type VnfSite } from "../../clients/vnf.js";
import type { WatchAoi, Watchlist } from "../watchlist.js";
import { aoiId, bboxArea, clusterSingleLinkage, coordToken, padKm, pointsBBox, round, snapOut } from "./geo.js";
import type { DiscoverHttp } from "./http.js";

export const FIELD_KM = 15;
export const FIELD_PAD_KM = 10;
/** src/tools/flaring.ts rejects bboxes over 25 deg². */
export const FLARING_MAX_DEG2 = 25;
/** Grid cell for splitting an oversized field: 4.5° + 2 × 10 km pad stays under 25 deg² up to ~45° lat. */
const SPLIT_CELL_DEG = 4.5;
export const FLARING_PARAMS = { days: 30, minFrp: 5, minNights: 5, clusterKm: 1 } as const;

export interface FlaringRaw {
  year: number;
  sensor: string;
  url: string;
  sites: VnfSite[];
}

export async function fetchFlaring(http: DiscoverHttp, year = VNF_DEFAULT_YEAR): Promise<FlaringRaw> {
  const spec = VNF_ANNUAL[year];
  if (!spec) throw new Error(`no VNF annual summary for ${year}`);
  const kml = await http.text("eog-vnf", spec.url);
  return { year, sensor: spec.sensor, url: spec.url, sites: parseVnfKml(kml) };
}

export interface FlareField {
  sites: VnfSite[];
  bcm: number;
  /** Largest site — names and keys the field. */
  lead: VnfSite;
  country: string;
}

/** Cluster + rank (deterministic: input sorted by site id first; ties by lead id). */
export function flareFields(sites: readonly VnfSite[], km = FIELD_KM): FlareField[] {
  const pts = sites.filter((s) => s.bcm > 0 && Number.isFinite(s.lat) && Number.isFinite(s.lon)).sort((a, b) => a.id.localeCompare(b.id));
  const fields = clusterSingleLinkage(pts, km).map((idx) => {
    const members = idx.map((i) => pts[i]!);
    const lead = [...members].sort((a, b) => b.bcm - a.bcm || a.id.localeCompare(b.id))[0]!;
    const bcm = members.reduce((s, m) => s + m.bcm, 0);
    // Country: the one holding most of the field's volume (fields straddle borders).
    const byCountry = new Map<string, number>();
    for (const m of members) byCountry.set(m.country, (byCountry.get(m.country) ?? 0) + m.bcm);
    const country = [...byCountry.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    return { sites: members, bcm, lead, country };
  });
  return fields.sort((a, b) => b.bcm - a.bcm || a.lead.id.localeCompare(b.lead.id));
}

/** A field's AOI boxes: one padded bbox, or grid-cell pieces when it would exceed the cap. */
export function fieldBoxes(f: FlareField): { index: number; bbox: BBox; sites: number; bcm: number }[] {
  const whole = snapOut(padKm(pointsBBox(f.sites), FIELD_PAD_KM), 0.01);
  if (bboxArea(whole) <= FLARING_MAX_DEG2) return [{ index: 0, bbox: whole, sites: f.sites.length, bcm: f.bcm }];
  const cells = new Map<string, VnfSite[]>();
  const [w0, s0] = pointsBBox(f.sites);
  const cols = Math.ceil((pointsBBox(f.sites)[2] - w0) / SPLIT_CELL_DEG + 1e-9) || 1;
  for (const s of f.sites) {
    const cx = Math.min(cols - 1, Math.floor((s.lon - w0) / SPLIT_CELL_DEG));
    const cy = Math.floor((s.lat - s0) / SPLIT_CELL_DEG);
    const k = `${cy}:${cx}`;
    const list = cells.get(k);
    if (list) list.push(s);
    else cells.set(k, [s]);
  }
  return [...cells.entries()]
    .map(([k, list]) => {
      const [cy, cx] = k.split(":").map(Number) as [number, number];
      return { index: cy * cols + cx + 1, bbox: snapOut(padKm(pointsBBox(list), FIELD_PAD_KM), 0.01), sites: list.length, bcm: list.reduce((s, m) => s + m.bcm, 0) };
    })
    .sort((a, b) => a.index - b.index);
}

/** BCM-weighted centroid of a field — the point it is named after. */
export function fieldCentroid(f: FlareField): { lat: number; lon: number } {
  return { lat: f.sites.reduce((s, m) => s + m.lat * m.bcm, 0) / f.bcm, lon: f.sites.reduce((s, m) => s + m.lon * m.bcm, 0) / f.bcm };
}

/** "Flare field near Dehloran, Ilam (Iran) — 5 registered sites"; coordinates only when no place is known. */
export function fieldName(f: FlareField, place: AdminPlace | null, part?: number): string {
  const c = fieldCentroid(f);
  const where = adminLabel(place) ?? `${round(c.lat, 2)}, ${round(c.lon, 2)} (${f.country})`;
  const n = `${f.sites.length} registered site${f.sites.length === 1 ? "" : "s"}`;
  return `Flare field near ${where} — ${n}${part ? ` (part ${part})` : ""}`.slice(0, 120);
}

/** VNF site name minus year/version: "IRQ_UPS_2024_47.1036E_30.5649N_v0.2" → "irq_ups_47.1036e_30.5649n". */
export function siteTag(id: string): string {
  return id
    .toLowerCase()
    .replace(/_(19|20)\d{2}_/, "_")
    .replace(/_v[\d.]+$/, "")
    .slice(0, 40);
}

export function buildFlaringFields(
  raw: FlaringRaw,
  max: number,
  generatedOn: string,
  placeAt: (lat: number, lon: number) => AdminPlace | null = () => null,
): { watchlist: Watchlist; fields: FlareField[] } {
  const fields = flareFields(raw.sites).slice(0, max);
  const aois: WatchAoi[] = [];
  for (const f of fields) {
    const base = aoiId("flare", f.country, coordToken(f.lead.lat, "n", "s"), coordToken(f.lead.lon, "e", "w"));
    const boxes = fieldBoxes(f);
    const c = fieldCentroid(f);
    const place = placeAt(c.lat, c.lon);
    for (const b of boxes) {
      const split = boxes.length > 1 || b.index > 0;
      aois.push({
        id: split ? `${base}-${b.index}` : base,
        name: fieldName(f, place, split ? b.index : undefined),
        bbox: b.bbox,
        tags: [...new Set(["flaring", "oil-gas", "discovered", f.country.toLowerCase(), siteTag(f.lead.id)])],
        control: false,
        cooldownDays: 30,
        rules: [
          { name: "flaring", params: { ...FLARING_PARAMS } },
          { name: "flaring_stopped", params: { ...FLARING_PARAMS } },
        ],
        notes:
          `Discovered ${generatedOn} from the EOG VIIRS Nightfire ${raw.year} annual flare summary (${raw.sensor}): ` +
          `${round(f.bcm, 3)} BCM flared across ${f.sites.length} site(s) chained within ${FIELD_KM} km` +
          (split ? `; this part holds ${b.sites} site(s), ${round(b.bcm, 3)} BCM` : "") +
          `. Largest site ${f.lead.id} (${f.lead.type}, ${f.lead.bcm} BCM). Box = sites + ${FIELD_PAD_KM} km.` +
          (place ? ` Place: Nominatim reverse at the BCM-weighted centroid ${round(c.lat, 3)}, ${round(c.lon, 3)} (admin levels only; © OpenStreetMap contributors).` : ""),
      });
    }
  }
  return {
    fields,
    watchlist: {
      version: 1,
      name: "Flaring fields — discovered",
      description:
        `Generated by \`earthdeck discover\` on ${generatedOn}. The top ${fields.length} gas-flaring fields by flared volume: VIIRS ` +
        `Nightfire ${raw.year} annual sites (EOG, Colorado School of Mines; ${raw.sites.length} sites) chained within ${FIELD_KM} km, ` +
        `boxes padded ${FIELD_PAD_KM} km and kept ≤ ${FLARING_MAX_DEG2} deg². Do not hand-edit — re-run discover.`,
      aois,
    },
  };
}
