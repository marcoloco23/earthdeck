// GBIF — the Global Biodiversity Information Facility. Zero-key, open API
// (https://techdocs.gbif.org/en/openapi/). Occurrence records carry a per-dataset licence
// (CC0 1.0 / CC BY 4.0 / CC BY-NC 4.0), so we always report the licence facet alongside
// the numbers. Etiquette: descriptive User-Agent, facets instead of paging, small limits.
//
// Live-verified 2026-09-26: bbox filter via decimalLatitude/decimalLongitude ranges; facets
// kingdomKey / speciesKey / license / iucnRedListCategory all work together in one call
// (limit=0); `speciesKey.facetLimit` overrides the per-field cap; the IUCN category filter
// accepts repeated values; /species/{key}/iucnRedListCategory returns {category, code}.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

export const GBIF_API = "https://api.gbif.org/v1";

/** GBIF backbone kingdom keys (stable ids). Fungi is a kingdom here, not a footnote. */
export const KINGDOM_KEYS = {
  Animalia: 1,
  Archaea: 2,
  Bacteria: 3,
  Chromista: 4,
  Fungi: 5,
  Plantae: 6,
  Protozoa: 7,
  Viruses: 8,
} as const;
export type Kingdom = keyof typeof KINGDOM_KEYS;
export const KINGDOMS = Object.keys(KINGDOM_KEYS) as Kingdom[];

export function kingdomName(key: string | number): string {
  const k = Number(key);
  return KINGDOMS.find((n) => KINGDOM_KEYS[n] === k) ?? "incertae sedis";
}

/** IUCN categories GBIF reports; the three "threatened" ones are CR, EN, VU. */
export const THREATENED = ["CR", "EN", "VU"] as const;
export const IUCN_LABEL: Record<string, string> = {
  EX: "Extinct",
  EW: "Extinct in the wild",
  CR: "Critically endangered",
  EN: "Endangered",
  VU: "Vulnerable",
  NT: "Near threatened",
  LC: "Least concern",
  DD: "Data deficient",
  NE: "Not evaluated",
  CD: "Conservation dependent",
};

/** Normalize GBIF licence enums / URLs to a short SPDX-ish label. */
export function licenceLabel(raw: string | null | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("cc0") || s.includes("publicdomain/zero")) return "CC0 1.0";
  if (s.includes("by_nc") || s.includes("by-nc")) return "CC BY-NC 4.0";
  if (s.includes("cc_by") || s.includes("licenses/by/")) return "CC BY 4.0";
  return raw ? raw : "unspecified";
}

export interface OccurrenceQuery {
  bbox: BBox;
  kingdom?: Kingdom;
  /** GBIF backbone taxon key (any rank) — from speciesMatch(). */
  taxonKey?: number;
  yearFrom?: number;
  yearTo?: number;
}

/** Shared occurrence filter: present, georeferenced without known issues, in the bbox. */
export function occurrenceParams(q: OccurrenceQuery): URLSearchParams {
  assertBBox(q.bbox);
  const [w, s, e, n] = q.bbox;
  const p = new URLSearchParams({
    decimalLatitude: `${s},${n}`,
    decimalLongitude: `${w},${e}`,
    occurrenceStatus: "PRESENT",
    hasGeospatialIssue: "false",
  });
  if (q.kingdom) p.set("kingdomKey", String(KINGDOM_KEYS[q.kingdom]));
  if (q.taxonKey != null) p.set("taxonKey", String(q.taxonKey));
  if (q.yearFrom != null || q.yearTo != null) p.set("year", `${q.yearFrom ?? 1600},${q.yearTo ?? new Date().getUTCFullYear()}`);
  return p;
}

async function gbifJson(path: string, params?: URLSearchParams, notFoundOk = false): Promise<unknown> {
  const url = `${GBIF_API}${path}${params ? `?${params.toString()}` : ""}`;
  // accept-language picks the vernacularName language (live-verified: Node's default `*`
  // yields none; "en" yields "jaguar").
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json", "accept-language": "en" } });
  if (notFoundOk && res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint = res.status === 429 ? " — rate limited by GBIF; wait a minute and retry" : "";
    throw new OverviewError(`GBIF ${path} failed (${res.status})${hint}`, res.status, body.slice(0, 300));
  }
  return res.json();
}

export type FacetCounts = Record<string, Array<{ name: string; count: number }>>;

/** Parse GBIF's `facets` array into { kingdomKey: [...], speciesKey: [...], … }. */
export function parseFacets(json: unknown): { count: number; facets: FacetCounts } {
  const j = json as { count?: unknown; facets?: Array<{ field?: string; counts?: Array<{ name?: unknown; count?: unknown }> }> };
  if (typeof j?.count !== "number" || !Array.isArray(j.facets)) throw new OverviewError("unexpected GBIF facet response shape");
  const facets: FacetCounts = {};
  for (const f of j.facets) {
    if (!f.field || !Array.isArray(f.counts)) continue;
    // SPECIES_KEY → speciesKey
    const key = f.field.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    facets[key] = f.counts
      .filter((c) => typeof c.count === "number")
      .map((c) => ({ name: String(c.name), count: c.count as number }));
  }
  return { count: j.count, facets };
}

/** Distinct-species facet cap: also where the richness score saturates (10⁴ species). */
export const SPECIES_FACET_LIMIT = 10_000;

export interface OccurrenceSummary {
  occurrences: number;
  byKingdom: Array<{ kingdom: string; count: number }>;
  licences: Array<{ licence: string; count: number }>;
  iucn: Array<{ category: string; count: number }>;
  /** Distinct species (speciesKey facet), sorted by occurrence count. */
  species: Array<{ key: number; count: number }>;
  speciesCapped: boolean;
}

/** One facet call: kingdoms, licences, IUCN categories (occurrence counts) and species. */
export async function occurrenceSummary(q: OccurrenceQuery): Promise<OccurrenceSummary> {
  const p = occurrenceParams(q);
  p.set("limit", "0");
  for (const f of ["kingdomKey", "license", "iucnRedListCategory", "speciesKey"]) p.append("facet", f);
  p.set("facetLimit", "20");
  p.set("speciesKey.facetLimit", String(SPECIES_FACET_LIMIT));
  const { count, facets } = parseFacets(await gbifJson("/occurrence/search", p));
  const species = (facets.speciesKey ?? []).map((c) => ({ key: Number(c.name), count: c.count }));
  return {
    occurrences: count,
    byKingdom: (facets.kingdomKey ?? []).map((c) => ({ kingdom: kingdomName(c.name), count: c.count })),
    licences: (facets.license ?? []).map((c) => ({ licence: licenceLabel(c.name), count: c.count })),
    iucn: (facets.iucnRedListCategory ?? []).map((c) => ({ category: c.name, count: c.count })),
    species,
    speciesCapped: species.length >= SPECIES_FACET_LIMIT,
  };
}

/** Distinct IUCN-threatened (CR/EN/VU) species in the query, by occurrence count. */
export async function threatenedSpecies(q: OccurrenceQuery): Promise<{ occurrences: number; species: Array<{ key: number; count: number }> }> {
  const p = occurrenceParams(q);
  p.set("limit", "0");
  for (const c of THREATENED) p.append("iucnRedListCategory", c);
  p.set("facet", "speciesKey");
  p.set("speciesKey.facetLimit", "2000");
  const { count, facets } = parseFacets(await gbifJson("/occurrence/search", p));
  return { occurrences: count, species: (facets.speciesKey ?? []).map((c) => ({ key: Number(c.name), count: c.count })) };
}

export interface Occurrence {
  key: number;
  lat: number;
  lon: number;
  date: string | null;
  scientificName: string;
  species: string | null;
  kingdom: string | null;
  iucn: string | null;
  basisOfRecord: string | null;
  dataset: string | null;
  licence: string;
  url: string;
}

/** Normalize an occurrence search page (records without coordinates are skipped). */
export function parseOccurrences(json: unknown): Occurrence[] {
  const results = (json as { results?: Array<Record<string, unknown>> })?.results;
  if (!Array.isArray(results)) throw new OverviewError("unexpected GBIF occurrence response shape");
  const out: Occurrence[] = [];
  for (const r of results) {
    const lat = r.decimalLatitude;
    const lon = r.decimalLongitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    out.push({
      key: Number(r.key),
      lat,
      lon,
      date: str(r.eventDate)?.slice(0, 10) ?? null,
      scientificName: str(r.scientificName) ?? "",
      species: str(r.species),
      kingdom: str(r.kingdom),
      iucn: str(r.iucnRedListCategory),
      basisOfRecord: str(r.basisOfRecord),
      dataset: str(r.datasetName),
      licence: licenceLabel(str(r.license)),
      url: `https://www.gbif.org/occurrence/${String(r.key)}`,
    });
  }
  return out;
}

/**
 * A small sample of recent records for map markers. GBIF search has no sort, so "recent"
 * = restricted to the last two years of the window, falling back to the whole window.
 */
export async function occurrenceSample(q: OccurrenceQuery, limit = 20): Promise<Occurrence[]> {
  const to = q.yearTo ?? new Date().getUTCFullYear();
  const recentFrom = Math.max(q.yearFrom ?? 0, to - 1);
  const get = async (qq: OccurrenceQuery) => {
    const p = occurrenceParams(qq);
    p.set("limit", String(Math.max(1, Math.min(50, limit))));
    return parseOccurrences(await gbifJson("/occurrence/search", p));
  };
  const recent = await get({ ...q, yearFrom: recentFrom, yearTo: to });
  return recent.length > 0 ? recent : get(q);
}

// ── Species ────────────────────────────────────────────────────────────────────────

export interface SpeciesMatch {
  usageKey: number;
  scientificName: string;
  canonicalName: string;
  rank: string;
  status: string;
  matchType: string;
  confidence: number;
  /** kingdom → species (only ranks the match carries), each with its backbone key. */
  breadcrumb: Array<{ rank: string; name: string; key: number | null }>;
}

const RANKS = ["kingdom", "phylum", "class", "order", "family", "genus", "species"] as const;

/** Parse /species/match (or /species/{key}) into a match + taxonomy breadcrumb. */
export function parseSpeciesMatch(json: unknown): SpeciesMatch {
  const j = json as Record<string, unknown>;
  const usageKey = (j?.usageKey ?? j?.key) as unknown;
  if (typeof usageKey !== "number" || j.matchType === "NONE") {
    throw new OverviewError("GBIF found no backbone match for that name — check the spelling or pass a kingdom");
  }
  const breadcrumb: SpeciesMatch["breadcrumb"] = [];
  for (const rank of RANKS) {
    const name = j[rank];
    if (typeof name !== "string" || !name) continue;
    const key = j[`${rank}Key`];
    breadcrumb.push({ rank, name, key: typeof key === "number" ? key : null });
  }
  return {
    usageKey,
    scientificName: String(j.scientificName ?? ""),
    canonicalName: String(j.canonicalName ?? j.scientificName ?? ""),
    rank: String(j.rank ?? ""),
    status: String(j.status ?? j.taxonomicStatus ?? ""),
    matchType: String(j.matchType ?? "EXACT"),
    confidence: typeof j.confidence === "number" ? j.confidence : 100,
    breadcrumb,
  };
}

/** Match a scientific name against the GBIF backbone (optionally within a kingdom). */
export async function speciesMatch(name: string, kingdom?: Kingdom): Promise<SpeciesMatch> {
  const p = new URLSearchParams({ name });
  if (kingdom) p.set("kingdom", kingdom);
  return parseSpeciesMatch(await gbifJson("/species/match", p));
}

export interface SpeciesInfo {
  key: number;
  scientificName: string;
  canonicalName: string;
  vernacularName: string | null;
  kingdom: string | null;
  rank: string;
}

export async function speciesByKey(key: number): Promise<SpeciesInfo> {
  const j = (await gbifJson(`/species/${key}`)) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    key,
    scientificName: str(j.scientificName) ?? String(key),
    canonicalName: str(j.canonicalName) ?? str(j.scientificName) ?? String(key),
    vernacularName: str(j.vernacularName),
    kingdom: str(j.kingdom),
    rank: str(j.rank) ?? "",
  };
}

/** Resolve many keys politely (5 at a time); failures degrade to the bare key. */
export async function speciesNames(keys: number[]): Promise<Map<number, SpeciesInfo>> {
  const out = new Map<number, SpeciesInfo>();
  const uniq = [...new Set(keys)];
  for (let i = 0; i < uniq.length; i += 5) {
    const batch = uniq.slice(i, i + 5);
    const got = await Promise.allSettled(batch.map((k) => speciesByKey(k)));
    got.forEach((r, j) => {
      if (r.status === "fulfilled") out.set(batch[j]!, r.value);
    });
  }
  return out;
}

/** IUCN Red List category as mirrored by GBIF; null when GBIF has none (404). */
export async function iucnCategory(key: number): Promise<{ code: string; category: string; iucnTaxonId: string | null } | null> {
  const j = (await gbifJson(`/species/${key}/iucnRedListCategory`, undefined, true)) as Record<string, unknown> | null;
  if (!j || typeof j.code !== "string") return null;
  return { code: j.code, category: String(j.category ?? IUCN_LABEL[j.code] ?? j.code), iucnTaxonId: typeof j.iucnTaxonID === "string" ? j.iucnTaxonID : null };
}

/** First English vernacular name (GBIF aggregates many checklists; duplicates are common). */
export async function englishName(key: number): Promise<string | null> {
  const j = (await gbifJson(`/species/${key}/vernacularNames`, new URLSearchParams({ limit: "100" }))) as {
    results?: Array<{ vernacularName?: string; language?: string }>;
  };
  const hit = (j.results ?? []).find((r) => r.language === "eng" && r.vernacularName);
  return hit?.vernacularName ?? null;
}

/** Occurrence count for a taxon, worldwide or in a bbox (limit=0, no records transferred). */
export async function occurrenceCount(taxonKey: number, bbox?: BBox): Promise<number> {
  const p = bbox ? occurrenceParams({ bbox, taxonKey }) : new URLSearchParams({ taxonKey: String(taxonKey), occurrenceStatus: "PRESENT" });
  p.set("limit", "0");
  return parseFacets({ facets: [], ...((await gbifJson("/occurrence/search", p)) as object) }).count;
}
