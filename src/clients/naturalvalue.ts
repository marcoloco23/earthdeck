// Valuing living nature — a sourced registry of what ecosystems (and a few organisms) are
// worth per year *alive*, plus the land-cover lookup that tells us which ecosystems a box
// holds. Research + every number's provenance: docs/research/2026-09-26_valuing-living-nature.md
//
// This is BENEFIT TRANSFER at order-of-magnitude precision. It exists so that "alive" has a
// number next to "cleared" (timber, gold, pasture) — not to put a price tag on a place for
// sale. Every entry carries its source, dollar-year and caveat; if a value could not be
// sourced it is absent, never estimated here.

import { getCopernicus } from "./copernicus.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { round } from "../series.js";

// ---- units ----------------------------------------------------------------------------------

/**
 * 2007 → 2020 US dollars: US CPI-U annual averages, BLS series CUUR0000SA0
 * (2007 = 207.342, 2020 = 258.811). Costanza et al. 2014 and de Groot et al. 2012 report
 * 2007 (Int.) $; we restate them in 2020 USD so all entries share one dollar-year.
 */
export const CPI_2007_TO_2020 = 258.811 / 207.342;
export const DOLLAR_YEAR = 2020;

export type ServiceId = "climate" | "water" | "erosion" | "provisioning" | "habitat" | "cultural" | "regulating" | "unsplit";
export const SERVICE_LABEL: Record<ServiceId, string> = {
  climate: "Climate & air regulation",
  water: "Water regulation & purification",
  erosion: "Erosion control, soil & nutrients",
  provisioning: "Food, water & raw materials",
  habitat: "Habitat, nursery & genetic diversity",
  cultural: "Recreation & cultural",
  regulating: "Other regulating (not split further by the source)",
  unsplit: "Not split by service in the source",
};

export interface Band {
  low: number;
  mid: number;
  high: number;
}

export interface Source {
  cite: string;
  url: string;
  licence?: string;
}

export type BiomeId =
  | "tropical_forest"
  | "temperate_forest"
  | "boreal_forest"
  | "grassland"
  | "cropland"
  | "urban"
  | "wetland"
  | "mangrove"
  | "lakes_rivers"
  | "coral_reef"
  | "coastal"
  | "open_ocean";

export interface BiomeValue {
  id: BiomeId;
  label: string;
  /** USD per hectare per year, 2020 dollars. mid = the source's headline unit value. */
  usdPerHaYr: Band;
  /** Share of the mid value by service bucket (sums to ~1), when the source splits it. */
  serviceShares?: Partial<Record<ServiceId, number>>;
  dollarYear: 2020;
  /** The value as published, before CPI restatement. */
  published: { value: number; dollarYear: number; unit: string };
  source: Source;
  bandSource: string;
  bandRef: Source;
  method: "benefit transfer";
  caveat: string;
}

const COSTANZA_2014: Source = {
  cite: "Costanza R. et al. (2014) Changes in the global value of ecosystem services. Global Environmental Change 26:152–158, Table 3 (2011 unit values)",
  url: "https://doi.org/10.1016/j.gloenvcha.2014.04.002",
};
const DE_GROOT_2012: Source = {
  cite: "de Groot R. et al. (2012) Global estimates of the value of ecosystems and their services in monetary units. Ecosystem Services 1:50–61, Table 3",
  url: "https://doi.org/10.1016/j.ecoser.2012.07.005",
};

const c = (v: number) => Math.round(v * CPI_2007_TO_2020);

/** Pure: build an entry from 2007-$ values (mid, low, high). */
function entry(
  id: BiomeId,
  label: string,
  mid2007: number,
  low2007: number,
  high2007: number,
  bandSource: string,
  caveat: string,
  serviceShares?: Partial<Record<ServiceId, number>>,
  source: Source = COSTANZA_2014,
): BiomeValue {
  return {
    id,
    label,
    usdPerHaYr: { low: c(Math.min(low2007, mid2007)), mid: c(mid2007), high: c(Math.max(high2007, mid2007)) },
    ...(serviceShares ? { serviceShares } : {}),
    dollarYear: 2020,
    published: { value: mid2007, dollarYear: 2007, unit: "USD/ha/yr" },
    source,
    bandSource,
    bandRef: DE_GROOT_2012,
    method: "benefit transfer",
    caveat,
  };
}

const BAND_DG = "de Groot et al. 2012 Table 3 min–max of total value for the matching biome (widened to include the mid where the Costanza value falls outside it)";
const NO_BAND = "no published range for this biome in de Groot et al. 2012 — mid only (low = high = mid); treat as ±1 order of magnitude";
const TRANSFER = "Global mean of a skewed, study-sparse literature, applied here without local calibration.";

/** de Groot 2012 Table 2 service subtotals → shares of the total. */
function shares(parts: Partial<Record<ServiceId, number>>): Partial<Record<ServiceId, number>> {
  const total = Object.values(parts).reduce((a, x) => a + (x ?? 0), 0);
  const out: Partial<Record<ServiceId, number>> = {};
  for (const [k, v] of Object.entries(parts) as [ServiceId, number][]) if (v > 0) out[k] = round(v / total, 4);
  return out;
}

/**
 * Per-biome unit values. mid = Costanza et al. 2014 Table 3, 2011 unit value (2007 $/ha/yr),
 * restated to 2020 USD. Band = de Groot et al. 2012 Table 3 min/max. Service shares = de Groot
 * 2012 Table 2 subtotals for the matching biome, applied proportionally to the mid.
 * NOT valued (no sourced unit value): desert, tundra, ice/rock, bare land — and PEATLAND,
 * which neither source reports as its own biome.
 */
export const BIOMES: Record<BiomeId, BiomeValue> = {
  tropical_forest: entry("tropical_forest", "Tropical forest", 5382, 1581, 20851, BAND_DG,
    `${TRANSFER} Climate regulation (carbon) is ~39 % of the de Groot total; the de Groot median (2,355) is less than half the mean.`,
    shares({ provisioning: 1828, climate: 2044, erosion: 15, regulating: 2529 - 2044 - 15, habitat: 39, cultural: 867 })),
  temperate_forest: entry("temperate_forest", "Temperate forest", 3137, 278, 16406, BAND_DG,
    `${TRANSFER} Costanza reports temperate and boreal forest as one biome.`,
    shares({ provisioning: 671, regulating: 491, habitat: 862, cultural: 990 })),
  boreal_forest: entry("boreal_forest", "Boreal forest", 3137, 278, 16406, "de Groot et al. 2012 temperate-forest min–max (de Groot has no boreal biome)",
    `${TRANSFER} Same unit value as temperate forest (Costanza's combined temperate/boreal biome); deep boreal soil carbon is not reflected.`,
    shares({ provisioning: 671, regulating: 491, habitat: 862, cultural: 990 })),
  grassland: entry("grassland", "Grassland & rangeland", 4166, 124, 5930, BAND_DG,
    `${TRANSFER} Shrubland is valued as grassland (Costanza's grass/rangelands). Land cover cannot tell natural grassland from cattle pasture on cleared forest, which is valued here at the same unit value — that overstates what degraded pasture does.`,
    shares({ provisioning: 1305, regulating: 159, habitat: 1214, cultural: 193 })),
  cropland: entry("cropland", "Cropland", 5567, 5567, 5567, NO_BAND,
    `${TRANSFER} Mostly food provisioning plus pollination/soil services — already-converted land, not a living-ecosystem benchmark.`),
  urban: entry("urban", "Urban", 6661, 6661, 6661, NO_BAND,
    `${TRANSFER} Urban green-space services (Costanza 2014); applied to every built-up pixel it overstates.`),
  wetland: entry("wetland", "Inland wetland (swamps, floodplains)", 25681, 3018, 104924, BAND_DG,
    `${TRANSFER} Water regulation and purification dominate; the de Groot median (16,534) is well below the mean.`,
    shares({ provisioning: 1659, regulating: 17364, habitat: 2455, cultural: 4203 })),
  mangrove: entry("mangrove", "Mangroves & tidal marsh", 193843, 300, 887828, BAND_DG,
    `${TRANSFER} Extremely skewed: the de Groot median (12,163) is ~16× below the mean, which waste treatment (162,125) drives.`,
    shares({ provisioning: 2998, water: 162125, regulating: 171515 - 162125, habitat: 17138, cultural: 2193 })),
  lakes_rivers: entry("lakes_rivers", "Lakes & rivers", 12512, 1446, 7757, BAND_DG,
    `${TRANSFER} Costanza's value is ~3× de Groot's mean (4,267). All permanent water in a box is valued as lakes/rivers, even where it is sea or a reservoir.`,
    shares({ provisioning: 1914, regulating: 187, cultural: 2166 })),
  coral_reef: entry("coral_reef", "Coral reef", 352249, 36794, 2129122, BAND_DG,
    `${TRANSFER} Recreation values span >6 orders of magnitude between sites; erosion/coastal protection (153,214) dominates the mean.`,
    shares({ provisioning: 55724, erosion: 153214, regulating: 171478 - 153214, habitat: 16210, cultural: 108837 })),
  coastal: entry("coastal", "Coastal systems (estuaries, seagrass)", 28916, 26167, 42063, BAND_DG,
    `${TRANSFER} Costanza 2014 estuaries and seagrass/algae beds (28,916 each); shelf is far lower (2,222).`),
  open_ocean: entry("open_ocean", "Open ocean", 660, 85, 1664, BAND_DG,
    `${TRANSFER} Per hectare the ocean is low; its value is in its size.`,
    shares({ provisioning: 102, regulating: 65, habitat: 5, cultural: 319 })),
};
export const BIOME_IDS = Object.keys(BIOMES) as BiomeId[];

export interface OrganismValue {
  id: string;
  label: string;
  usd: Band;
  unit: string;
  dollarYear: number;
  source: Source;
  method: string;
  caveat: string;
}

const STREET_TREE_USD_YR = 110.63;

/**
 * Illustrative anchors — never summed with the per-hectare transfer (the whale and elephant
 * values are carbon-dominated lifetime present values, not annual flows).
 */
export const ORGANISMS: OrganismValue[] = [
  {
    id: "great_whale",
    label: "Great whale (one individual)",
    usd: { low: 2_000_000, mid: 2_000_000, high: 2_000_000 },
    unit: "USD per whale, lifetime present value (published as 'more than $2 million')",
    dollarYear: 2019,
    source: { cite: "Chami R., Cosimano T., Fullenkamp C., Oztosun S. (2019) Nature's Solution to Climate Change. IMF Finance & Development 56(4)", url: "https://www.elibrary.imf.org/view/journals/022/0056/004/article-A011-en.xml" },
    method: "present value of lifetime carbon sequestration (~33 t CO₂ per whale) at market carbon prices + fishery enhancement + ecotourism",
    caveat: "A lower bound as published; >$1 trillion for the current stock (~1.3 M great whales vs 4–5 M before whaling). Carbon-price dependent.",
  },
  {
    id: "forest_elephant",
    label: "African forest elephant (one individual)",
    usd: { low: 1_750_000, mid: 1_750_000, high: 3_750_000 },
    unit: "USD per elephant, present value of carbon-capture services",
    dollarYear: 2020,
    source: { cite: "Chami R., Fullenkamp C., Cosimano T., Berzaghi F. (2020) The Secret Work of Elephants. IMF Finance & Development 57(4)", url: "https://www.imf.org/en/publications/fandd/issues/2020/09/how-african-elephants-fight-climate-change-ralph-chami" },
    method: "elephants thin small trees, raising forest carbon stock; the extra carbon valued at a carbon price over the elephant's lifetime",
    caveat: "High = the paper's scenario if poaching ended ($375 bn for the population vs $176 bn today). Carbon only — no tourism, cultural or intrinsic value.",
  },
  {
    id: "street_tree_yr",
    label: "Street tree (California average), per year",
    usd: { low: STREET_TREE_USD_YR, mid: STREET_TREE_USD_YR, high: STREET_TREE_USD_YR },
    unit: "USD per tree per year",
    dollarYear: 2016,
    source: { cite: "McPherson E.G., van Doorn N., de Goede J. (2016) Structure, function and value of street trees in California, USA. Urban Forestry & Urban Greening 17:104–115 (i-Tree Streets)", url: "https://research.fs.usda.gov/treesearch/50951" },
    method: "i-Tree Streets: energy, CO₂, air quality, stormwater and aesthetic/property value of 9.1 M street trees ($1.0 bn/yr); management costs $19/tree/yr",
    caveat: "Urban street trees in California; aesthetics/property value dominates (~$839 M of $1.0 bn). Not transferable to a forest tree.",
  },
  {
    id: "street_tree_100y",
    label: "Street tree over 100 years (derived)",
    usd: { low: Math.round(STREET_TREE_USD_YR * 43.098), mid: Math.round(STREET_TREE_USD_YR * 100), high: Math.round(STREET_TREE_USD_YR * 100) },
    unit: "USD per tree over 100 years — low = NPV at 2 %, mid/high = undiscounted",
    dollarYear: 2016,
    source: { cite: "Derived from McPherson et al. (2016): $110.63/tree/yr × 100 years (annuity factor 43.10 at 2 %)", url: "https://research.fs.usda.gov/treesearch/50951" },
    method: "derived: constant annual benefit × horizon; a real tree's benefits grow with its canopy",
    caveat: "Assumes the tree lives and is maintained for 100 years at today's average benefit.",
  },
  {
    id: "coral_reefs_flood_protection",
    label: "All coral reefs — flood protection, per year",
    usd: { low: 4.3e9, mid: 4.3e9, high: 4.3e9 },
    unit: "USD per year of flood damage averted worldwide",
    dollarYear: 2018,
    source: { cite: "Beck M.W. et al. (2018) The global flood protection savings provided by coral reefs. Nature Communications 9:2186", url: "https://doi.org/10.1038/s41467-018-04568-z" },
    method: "expected annual flood damage with vs without the top 1 m of reef (damage rises from $3.7 bn to $8 bn/yr)",
    caveat: "One service only; dollar-year given as the publication year (the paper's price base is UNCONFIRMED).",
  },
];

/** Global value of ecosystem services — for the landing-page line. */
export const GLOBAL_NATURE_VALUE = {
  usdPerYear: { low: 1.25e14, high: 1.45e14 },
  dollarYear: 2007,
  usdPerYear2020: { low: Math.round(1.25e14 * CPI_2007_TO_2020), high: Math.round(1.45e14 * CPI_2007_TO_2020) },
  note: "$125 T/yr with 2011 biome areas, $145 T/yr at 1997 areas; loss from land-use change 1997–2011: $4.3–20.2 T/yr (2007 US$). Global GDP 2011: $75.2 T in the same dollars.",
  source: COSTANZA_2014,
} as const;

/**
 * One-off value of a hectare CLEARED in southern Pará (Brazilian Amazon). Journalistic source:
 * shown only as a labelled, low-grade comparator next to tropical forest.
 */
export const CLEARED_COMPARATOR = {
  biome: "tropical_forest" as BiomeId,
  usdPerHaOnce: { low: 1_900, high: 6_800 },
  dollarYear: 2023,
  what: "sale price of cleared land in southern Pará, once (R$10,000–35,000/ha), per a regional land dealer",
  source: { cite: "Mongabay (Feb 2023) The $20m flip: the story of the largest land grab in the Brazilian Amazon", url: "https://news.mongabay.com/2023/02/the-20m-flip-the-story-of-the-largest-land-grab-in-the-brazilian-amazon/" },
  quality: "journalistic quote, not a peer-reviewed land-price series",
} as const;

// ---- valuation math --------------------------------------------------------------------------

/** Present value of a constant annual flow for `years`, discounted at `rate` (year-end flows). */
export function annuityFactor(years: number, rate: number): number {
  if (rate === 0) return years;
  return (1 - Math.pow(1 + rate, -years)) / rate;
}

export interface BiomeShare {
  biome: BiomeId;
  share: number; // 0–1 of the valued area
}

export interface MixValue {
  byBiome: { biome: BiomeId; label: string; sharePct: number; ha: number; annualUsd: Band; source: string }[];
  annualUsd: Band;
  horizon: { years: number; discountRate: number; undiscountedUsd: Band; npvUsd: Band; annuityFactor: number };
  services: { service: ServiceId; label: string; annualUsd: number }[];
}

const scale = (b: Band, k: number): Band => ({ low: b.low * k, mid: b.mid * k, high: b.high * k });
const add = (a: Band, b: Band): Band => ({ low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high });
const roundBand = (b: Band): Band => ({ low: Math.round(b.low), mid: Math.round(b.mid), high: Math.round(b.high) });

/** Pure: value an area given its biome mix. */
export function valueMix(mix: BiomeShare[], areaHa: number, years = 100, rate = 0.02): MixValue {
  let annual: Band = { low: 0, mid: 0, high: 0 };
  const services = new Map<ServiceId, number>();
  const byBiome: MixValue["byBiome"] = [];
  for (const m of mix) {
    const b = BIOMES[m.biome];
    const ha = areaHa * m.share;
    const v = scale(b.usdPerHaYr, ha);
    annual = add(annual, v);
    for (const [s, sh] of Object.entries(b.serviceShares ?? { unsplit: 1 }) as [ServiceId, number][]) services.set(s, (services.get(s) ?? 0) + v.mid * sh);
    byBiome.push({ biome: m.biome, label: b.label, sharePct: round(m.share * 100, 1), ha: Math.round(ha), annualUsd: roundBand(v), source: b.source.cite });
  }
  const af = annuityFactor(years, rate);
  const a = roundBand(annual); // horizons derive from the rounded annual, so they reconcile exactly
  return {
    byBiome,
    annualUsd: a,
    horizon: { years, discountRate: rate, undiscountedUsd: roundBand(scale(a, years)), npvUsd: roundBand(scale(a, af)), annuityFactor: round(af, 2) },
    services: [...services.entries()].sort((a, b) => b[1] - a[1]).map(([service, v]) => ({ service, label: SERVICE_LABEL[service], annualUsd: Math.round(v) })),
  };
}

export interface LivingValue {
  annualUsd: number;
  horizonUsd: number;
  npvUsd: number;
  band: Band;
  sources: string[];
  note: string;
}

/**
 * Pure: what `ha` hectares of `biome` were worth per year alive, and over 100 years
 * (undiscounted and NPV at 2 %). Numbers only — for a finding's flat evidence values.
 */
export function livingValueForFinding(ha: number, biome: BiomeId = "tropical_forest"): LivingValue {
  const b = BIOMES[biome];
  const v = valueMix([{ biome, share: 1 }], ha, 100, 0.02);
  const fmt = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  return {
    annualUsd: v.annualUsd.mid,
    horizonUsd: v.horizon.undiscountedUsd.mid,
    npvUsd: v.horizon.npvUsd.mid,
    band: v.annualUsd,
    sources: [b.source.cite],
    note:
      `Living value (benefit transfer, order of magnitude): ${ha} ha of ${b.label.toLowerCase()} ≈ ${fmt(v.annualUsd.mid)}/yr alive ` +
      `(band ${fmt(v.annualUsd.low)}–${fmt(v.annualUsd.high)}, ${DOLLAR_YEAR} USD), ≈ ${fmt(v.horizon.undiscountedUsd.mid)} over 100 yr ` +
      `(${fmt(v.horizon.npvUsd.mid)} NPV @ 2 %). Source: ${b.source.cite.split(" (")[0]} et al. — a floor for one kind of value, not a price.`,
  };
}

// ---- land cover ---------------------------------------------------------------------------

/**
 * CLMS Global Land Cover 2020, 10 m (LCM-10, v1) on the Copernicus Data Space Sentinel Hub
 * as a BYOC collection. 11 LCCS classes, same legend and palette as ESA WorldCover; numeric
 * codes read from the CDSE colour map (eu-cdse/sentinel-hub-custom-scripts map10.js).
 */
export const LAND_COVER = {
  name: "CLMS Global Land Cover 2020 (raster 10 m, v1) via CDSE Sentinel Hub",
  collection: "byoc-828f6b20-8ffd-48f8-a1da-fefd271456db",
  band: "LCM10",
  year: 2020,
  doi: "10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9",
  licence: "Copernicus full, free and open access (Reg. (EU) 1159/2013) — attribute the source, state modifications",
  classes: {
    10: "Tree cover",
    20: "Shrubland",
    30: "Grassland",
    40: "Cropland",
    50: "Herbaceous wetland",
    60: "Mangroves",
    70: "Moss and lichen",
    80: "Bare / sparse vegetation",
    90: "Built-up",
    100: "Permanent water bodies",
    110: "Snow and ice",
    254: "Unclassifiable",
  } as Record<number, string>,
} as const;

/** Tropics / boreal split for tree cover (Costanza's "temperate/boreal" shares one value). */
export function forestBiome(lat: number): BiomeId {
  const a = Math.abs(lat);
  return a < 23.44 ? "tropical_forest" : a >= 50 ? "boreal_forest" : "temperate_forest";
}

/** Pure: land-cover class → valued biome, or null for classes with no sourced unit value. */
export function biomeForClass(code: number, lat: number): BiomeId | null {
  switch (code) {
    case 10:
      return forestBiome(lat);
    case 20:
    case 30:
      return "grassland";
    case 40:
      return "cropland";
    case 50:
      return "wetland";
    case 60:
      return "mangrove";
    case 90:
      return "urban";
    case 100:
      return "lakes_rivers";
    default:
      return null; // moss/lichen (tundra), bare, snow/ice, unclassifiable: no sourced value
  }
}

export interface LandCoverMix {
  mix: BiomeShare[];
  pixels: number;
  classes: { code: number; label: string; pct: number; biome: BiomeId | null }[];
}

/** Pure: histogram (class → pixels) → biome shares of the WHOLE area (unvalued classes count as 0). */
export function mixFromHistogram(hist: Map<number, number>, lat: number): LandCoverMix {
  const total = [...hist.entries()].filter(([k]) => k !== 254 && k !== 0).reduce((a, [, n]) => a + n, 0);
  if (total === 0) throw new OverviewError("land cover: no classified pixels in this box");
  const shares = new Map<BiomeId, number>();
  const classes: LandCoverMix["classes"] = [];
  for (const [code, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
    if (code === 254 || code === 0) continue;
    const biome = biomeForClass(code, lat);
    classes.push({ code, label: LAND_COVER.classes[code] ?? `class ${code}`, pct: round((n / total) * 100, 1), biome });
    if (biome) shares.set(biome, (shares.get(biome) ?? 0) + n / total);
  }
  return { mix: [...shares.entries()].map(([biome, share]) => ({ biome, share })), pixels: total, classes };
}

/** ≤256 px on the long side, aspect-correct in degrees (latitude-scaled). */
export function statsSize([w, s, e, n]: BBox, max = 256): { width: number; height: number } {
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const wx = (e - w) * Math.cos(lat);
  const hy = n - s;
  return wx >= hy ? { width: max, height: Math.max(8, Math.round((max * hy) / wx)) } : { width: Math.max(8, Math.round((max * wx) / hy)), height: max };
}

/** Class mix of a bbox from the CDSE land-cover raster (needs CDSE creds). */
export async function fetchLandCoverMix(bbox: BBox): Promise<LandCoverMix> {
  const hist = await getCopernicus().classHistogram(bbox, {
    collection: LAND_COVER.collection,
    band: LAND_COVER.band,
    dateFrom: `${LAND_COVER.year}-01-01`,
    dateTo: `${LAND_COVER.year + 1}-12-31`,
    ...statsSize(bbox),
  });
  return mixFromHistogram(hist, (bbox[1] + bbox[3]) / 2);
}

/** Latitude-only fallback when no land cover is available — stated, never silent. */
export function assumeBiome(lat: number): { biome: BiomeId; assumption: string } {
  const biome = forestBiome(lat);
  return {
    biome,
    assumption: `ASSUMPTION: no land-cover measurement; the whole box is treated as ${BIOMES[biome]?.label ?? biome} from its latitude (${round(lat, 2)}°). This overstates value wherever the land is already cleared, farmed or built on — pass \`biome\` or enable CDSE land cover.`,
  };
}
