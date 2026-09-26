import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  englishName,
  iucnCategory,
  IUCN_LABEL,
  KINGDOMS,
  occurrenceCount,
  occurrenceSample,
  occurrenceSummary,
  speciesByKey,
  speciesMatch,
  speciesNames,
  threatenedSpecies,
  THREATENED,
  type Kingdom,
  type OccurrenceQuery,
  type OccurrenceSummary,
} from "../clients/gbif.js";
import { geocode } from "../clients/geo.js";
import { ottMatch } from "../clients/opentree.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import { round } from "../series.js";
import type { BBox } from "../types.js";
import { assertBBox, newId, nowIso } from "../util.js";

const GBIF_SOURCE = "GBIF.org occurrence & backbone taxonomy API (per-dataset licences: CC0 1.0 / CC BY 4.0 / CC BY-NC 4.0)";
const OTT_SOURCE = "Open Tree of Life TNRS (OpenTree Taxonomy, CC0)";

/** Spherical area of a lon/lat box in km². */
export function bboxAreaKm2([w, s, e, n]: BBox): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  return R * R * (e - w) * rad * Math.abs(Math.sin(n * rad) - Math.sin(s * rad));
}

const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

export interface ScoreComponent {
  value: number | null;
  unit: string;
  score: number | null; // 0–100
  weight: number;
}

export interface BiodiversityScore {
  score: number;
  label: "sampling-effort dependent";
  components: {
    richness: ScoreComponent;
    density: ScoreComponent;
    threatened: ScoreComponent;
    kingdomBalance: ScoreComponent;
  };
  method: { formula: string; components: Record<string, string>; blindSpots: string[] };
}

/**
 * Pure: a small, explainable 0–100 composite for a box. It measures what GBIF *knows*
 * about the place — richness, record density, share of threatened records, and how
 * evenly animals, plants, fungi and the rest are documented — NOT ecosystem health.
 */
export function biodiversityScore(s: OccurrenceSummary, areaKm2: number, kingdomFiltered: boolean): BiodiversityScore {
  const S = s.species.length;
  const density = areaKm2 > 0 ? s.occurrences / areaKm2 : 0;
  const threatOcc = s.iucn.filter((c) => (THREATENED as readonly string[]).includes(c.category)).reduce((a, c) => a + c.count, 0);
  const threatPct = s.occurrences > 0 ? (threatOcc / s.occurrences) * 100 : 0;
  // Kingdom evenness over four buckets: Animalia, Plantae, Fungi, everything else.
  const bucket = (k: string) => (k === "Animalia" || k === "Plantae" || k === "Fungi" ? k : "other");
  const sums = new Map<string, number>();
  for (const k of s.byKingdom) sums.set(bucket(k.kingdom), (sums.get(bucket(k.kingdom)) ?? 0) + k.count);
  const total = [...sums.values()].reduce((a, b) => a + b, 0);
  let evenness: number | null = null;
  if (!kingdomFiltered && total > 0) {
    const H = -[...sums.values()].filter((c) => c > 0).reduce((a, c) => a + (c / total) * Math.log(c / total), 0);
    evenness = H / Math.log(4);
  }
  const components = {
    richness: { value: S, unit: s.speciesCapped ? `species (≥, facet capped at ${S})` : "distinct species", score: round(clamp100(25 * Math.log10(Math.max(1, S))), 1), weight: 0.4 },
    density: { value: round(density, 2), unit: "occurrence records / km²", score: density > 0 ? round(clamp100(25 * (Math.log10(density) + 1)), 1) : 0, weight: 0.2 },
    threatened: { value: round(threatPct, 2), unit: "% of records that are IUCN CR/EN/VU species", score: round(clamp100(threatPct * 10), 1), weight: 0.2 },
    kingdomBalance: { value: evenness === null ? null : round(evenness, 3), unit: "Shannon evenness (0–1) over Animalia/Plantae/Fungi/other", score: evenness === null ? null : round(evenness * 100, 1), weight: 0.2 },
  };
  const parts = Object.values(components).filter((c) => c.score !== null);
  const wsum = parts.reduce((a, c) => a + c.weight, 0);
  const score = wsum > 0 ? round(parts.reduce((a, c) => a + (c.score as number) * c.weight, 0) / wsum, 0) : 0;
  return {
    score,
    label: "sampling-effort dependent",
    components,
    method: {
      formula: "weighted mean of component scores: 0.4·richness + 0.2·density + 0.2·threatened + 0.2·kingdomBalance (weights renormalized when a component is n/a, e.g. kingdom balance under a kingdom filter)",
      components: {
        richness: "25·log10(distinct GBIF species keys) → 10 spp = 25, 100 = 50, 1,000 = 75, ≥10,000 = 100",
        density: "25·(log10(records per km²) + 1) → 0.1/km² = 0, 1 = 25, 10 = 50, 100 = 75, ≥1,000 = 100",
        threatened: "10 × % of records belonging to IUCN CR/EN/VU species (≥10 % = 100) — conservation significance, not a penalty",
        kingdomBalance: "100 × Shannon evenness of record counts across Animalia / Plantae / Fungi / other kingdoms",
      },
      blindSpots: [
        "Sampling effort, not biology: GBIF records cluster along roads, rivers, cities, research stations and birding hotspots — a well-visited park outscores a remote, richer forest.",
        "Taxonomic bias: birds and flowering plants dominate; fungi, insects and microbes are heavily under-recorded, so kingdom balance mostly measures who went looking.",
        "Records ≠ individuals ≠ abundance; one survey dataset can dominate a box.",
        "IUCN coverage is uneven (most fungi and invertebrates are Not Evaluated), so the threatened share understates risk for those groups.",
        "Richness is distinct GBIF species keys, capped at the facet limit; bigger boxes score higher (species–area relationship).",
        "Not a measure of ecosystem integrity or trend — compare places of similar size and survey history, or use world_pulse (Living Planet Index, Red List Index) for global trends.",
      ],
    },
  };
}

async function resolveBBox(bbox: number[] | undefined, place: string | undefined): Promise<{ bbox: BBox; place?: string }> {
  if (bbox) {
    assertBBox(bbox as BBox);
    return { bbox: bbox as BBox };
  }
  if (place) {
    const g = await geocode(place);
    return { bbox: g.bbox, place: g.displayName };
  }
  throw new OverviewError("pass a bbox [west, south, east, north] or a place name");
}

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const kingdomSchema = z.enum(KINGDOMS as [Kingdom, ...Kingdom[]]);

/** Register the life layer's GBIF tools: biodiversity (per place) and species (per taxon). */
export function registerBiodiversityTools(server: McpServer): void {
  server.registerTool(
    "biodiversity",
    {
      title: "Biodiversity in a place (GBIF)",
      description:
        "What lives here, per GBIF's ~3 billion open occurrence records (zero-key): for a bbox or " +
        "place, occurrence counts by kingdom (Animalia, Plantae, Fungi, Bacteria, Chromista, …), " +
        "distinct species and the most-recorded ones, IUCN-threatened (CR/EN/VU) species present, " +
        "the licence mix of the records, a sample of recent records for the map, and a 0–100 " +
        "biodiversity score with its components and exact method. The score is SAMPLING-EFFORT " +
        "DEPENDENT (records cluster near roads, cities and birders) — read the blind spots before " +
        "comparing places. Filter by kingdom (e.g. Fungi), a taxon name (any rank) and years. " +
        "Posts a summary card and a marker card to the dashboard.",
      inputSchema: {
        bbox: bboxSchema.optional().describe("Bounding box [west, south, east, north] in degrees."),
        place: z.string().min(1).optional().describe("Place name, resolved via OpenStreetMap (used when bbox is omitted)."),
        kingdom: kingdomSchema.optional().describe("Only this kingdom, e.g. Fungi, Animalia, Plantae (default: all)."),
        taxon: z.string().min(1).optional().describe("Only this taxon (scientific name, any rank — e.g. 'Aves', 'Amanita', 'Panthera onca')."),
        yearFrom: z.number().int().min(1600).max(2100).optional().describe("Earliest record year (default: all years)."),
        yearTo: z.number().int().min(1600).max(2100).optional().describe("Latest record year (default: this year)."),
        sample: z.number().int().min(0).max(50).optional().describe("Recent records to return as map markers (default 20)."),
      },
    },
    async ({ bbox, place, kingdom, taxon, yearFrom, yearTo, sample }) =>
      safe(async () => {
        const where = await resolveBBox(bbox, place);
        const match = taxon ? await speciesMatch(taxon, kingdom) : null;
        const q: OccurrenceQuery = { bbox: where.bbox, kingdom, taxonKey: match?.usageKey, yearFrom, yearTo };
        const n = sample ?? 20;
        const [summary, threatened, records] = await Promise.all([
          occurrenceSummary(q),
          threatenedSpecies(q),
          n > 0 ? occurrenceSample(q, n) : Promise.resolve([]),
        ]);
        const topKeys = summary.species.slice(0, 8).map((s) => s.key);
        const threatKeys = threatened.species.slice(0, 5).map((s) => s.key);
        const names = await speciesNames([...topKeys, ...threatKeys]);
        const threatCat = new Map<number, string | null>();
        await Promise.all(threatKeys.map(async (k) => threatCat.set(k, (await iucnCategory(k).catch(() => null))?.code ?? null)));
        const named = (s: { key: number; count: number }) => ({
          key: s.key,
          name: names.get(s.key)?.canonicalName ?? String(s.key),
          vernacular: names.get(s.key)?.vernacularName ?? null,
          kingdom: names.get(s.key)?.kingdom ?? null,
          occurrences: s.count,
        });
        const areaKm2 = bboxAreaKm2(where.bbox);
        const score = biodiversityScore(summary, areaKm2, Boolean(kingdom));
        const pct = (c: number) => (summary.occurrences ? round((c / summary.occurrences) * 100, 1) : 0);
        const byKingdom = summary.byKingdom.map((k) => ({ ...k, sharePct: pct(k.count) }));
        const fungi = byKingdom.find((k) => k.kingdom === "Fungi");
        const top = summary.species.slice(0, 8).map(named);
        // Records are tagged with the category current when GBIF indexed them; iucnNow is the
        // species' category today (they can differ, e.g. a since-downlisted tree shows LC).
        const topThreatened = threatened.species.slice(0, 5).map((s) => ({ ...named(s), iucnNow: threatCat.get(s.key) ?? null }));
        const filterText = [kingdom, match?.canonicalName, yearFrom || yearTo ? `${yearFrom ?? "…"}–${yearTo ?? "now"}` : null].filter(Boolean).join(" · ");
        const summaryText =
          `${summary.occurrences.toLocaleString("en-US")} records, ${summary.speciesCapped ? "≥" : ""}${summary.species.length.toLocaleString("en-US")} species` +
          ` (${threatened.species.length} IUCN-threatened) over ${Math.round(areaKm2).toLocaleString("en-US")} km²` +
          (filterText ? ` [${filterText}]` : "") +
          `. By kingdom: ${[
            ...byKingdom.filter((k) => k.kingdom !== "Fungi").slice(0, 3).map((k) => `${k.kingdom} ${k.sharePct}%`),
            // Fungi are always named, even at 0 % — their absence is itself a finding.
            ...(!kingdom || kingdom === "Fungi" ? [`Fungi ${fungi?.sharePct ?? 0}% (${(fungi?.count ?? 0).toLocaleString("en-US")} records)`] : []),
          ].join(", ")}. Score ${score.score}/100 (sampling-effort dependent).`;

        const title = `Biodiversity${where.place ? ` · ${where.place.split(",")[0]}` : ""}${filterText ? ` · ${filterText}` : ""}`;
        const pushedSummary = await pushCard({
          id: newId(),
          type: "pulse",
          ts: nowIso(),
          title: `${title} · score ${score.score}`,
          bbox: where.bbox,
          payload: {
            metrics: [
              { label: "Score (effort-dependent)", value: String(score.score), sub: "0–100 · see method" },
              { label: "Records", value: summary.occurrences.toLocaleString("en-US") },
              { label: "Species", value: `${summary.speciesCapped ? "≥" : ""}${summary.species.length.toLocaleString("en-US")}` },
              { label: "Threatened spp.", value: String(threatened.species.length), sub: "IUCN CR/EN/VU" },
              ...byKingdom.slice(0, 5).map((k) => ({ label: k.kingdom, value: k.count.toLocaleString("en-US"), sub: `${k.sharePct}%` })),
              ...(top[0] ? [{ label: "Most recorded", value: top[0].name, sub: top[0].vernacular ?? undefined }] : []),
            ],
            summary: summaryText,
            source: GBIF_SOURCE,
          },
        });
        const pushedMarkers =
          records.length > 0
            ? await pushCard({
                id: newId(),
                type: "events",
                ts: nowIso(),
                title: `${records.length} recent GBIF record(s)${filterText ? ` · ${filterText}` : ""}`,
                bbox: where.bbox,
                payload: {
                  events: records.map((r) => ({
                    id: String(r.key),
                    title: r.species ?? r.scientificName,
                    category: r.kingdom ?? "unknown",
                    coordinates: [r.lon, r.lat],
                    lastDate: r.date,
                    magnitude: `${r.licence}${r.iucn && r.iucn !== "NE" ? ` · IUCN ${r.iucn}` : ""}`,
                    link: r.url,
                  })),
                  source: GBIF_SOURCE,
                },
              })
            : false;

        return {
          source: GBIF_SOURCE,
          area: { bbox: where.bbox, place: where.place ?? null, km2: Math.round(areaKm2) },
          filter: { kingdom: kingdom ?? null, taxon: match ? { name: match.canonicalName, rank: match.rank, key: match.usageKey, matchType: match.matchType } : null, yearFrom: yearFrom ?? null, yearTo: yearTo ?? null },
          occurrences: summary.occurrences,
          byKingdom,
          species: { distinct: summary.species.length, capped: summary.speciesCapped, top },
          threatened: {
            note: "species whose records GBIF tagged IUCN CR/EN/VU at indexing time",
            species: threatened.species.length,
            occurrences: threatened.occurrences,
            top: topThreatened,
          },
          iucnRecordsByCategory: summary.iucn.map((c) => ({ ...c, label: IUCN_LABEL[c.category] ?? c.category })),
          licences: summary.licences,
          score,
          summary: summaryText,
          sample: records,
          dashboard: pushedSummary || pushedMarkers ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "species",
    {
      title: "Species profile (GBIF + IUCN + Open Tree of Life)",
      description:
        "Look up any organism — animal, plant or fungus — by scientific name (zero-key): GBIF " +
        "backbone match with the taxonomy breadcrumb (kingdom → species), English common name, " +
        "IUCN Red List category (as mirrored by GBIF), GBIF occurrence counts worldwide and " +
        "optionally inside a bbox, and the Open Tree of Life OTT id (join key into the tree of " +
        "life). Pass a kingdom to disambiguate homonyms. Posts a card to the dashboard.",
      inputSchema: {
        name: z.string().min(2).describe("Scientific name, e.g. 'Amanita muscaria', 'Panthera onca', 'Sequoia sempervirens'."),
        kingdom: kingdomSchema.optional().describe("Kingdom hint for ambiguous names (e.g. Fungi)."),
        bbox: bboxSchema.optional().describe("Optional [west, south, east, north] to also count records in this box."),
      },
    },
    async ({ name, kingdom, bbox }) =>
      safe(async () => {
        if (bbox) assertBBox(bbox as BBox);
        const m = await speciesMatch(name, kingdom);
        const [info, iucn, eng, worldwide, inBbox, ott] = await Promise.all([
          speciesByKey(m.usageKey).catch(() => null),
          iucnCategory(m.usageKey).catch(() => null),
          englishName(m.usageKey).catch(() => null),
          occurrenceCount(m.usageKey),
          bbox ? occurrenceCount(m.usageKey, bbox as BBox) : Promise.resolve(null),
          ottMatch(m.canonicalName).catch(() => null),
        ]);
        const vernacular = info?.vernacularName ?? eng;
        const breadcrumbText = m.breadcrumb.map((b) => b.name).join(" › ");
        const summary =
          `${m.canonicalName}${vernacular ? ` (${vernacular})` : ""} — ${breadcrumbText}. ` +
          `IUCN: ${iucn ? `${iucn.category.replace(/_/g, " ").toLowerCase()} (${iucn.code})` : "no category in GBIF"}. ` +
          `${worldwide.toLocaleString("en-US")} GBIF records worldwide` +
          (inBbox !== null ? `, ${inBbox.toLocaleString("en-US")} in the bbox` : "") +
          (ott ? `. OTT ${ott.ottId}.` : ".");
        const pushed = await pushCard({
          id: newId(),
          type: "pulse",
          ts: nowIso(),
          title: `${m.canonicalName}${vernacular ? ` · ${vernacular}` : ""}${iucn ? ` · ${iucn.code}` : ""}`,
          ...(bbox ? { bbox: bbox as BBox } : {}),
          payload: {
            metrics: [
              ...m.breadcrumb.slice(0, -1).map((b) => ({ label: b.rank, value: b.name })),
              { label: "IUCN", value: iucn?.code ?? "—", sub: iucn ? (IUCN_LABEL[iucn.code] ?? iucn.category) : "not in GBIF" },
              { label: "GBIF records", value: worldwide.toLocaleString("en-US"), sub: "worldwide" },
              ...(inBbox !== null ? [{ label: "In bbox", value: inBbox.toLocaleString("en-US") }] : []),
              ...(ott ? [{ label: "OpenTree", value: `ott${ott.ottId}` }] : []),
            ],
            summary,
            source: `${GBIF_SOURCE}; ${OTT_SOURCE}`,
          },
        });
        return {
          source: `${GBIF_SOURCE}; ${OTT_SOURCE}`,
          query: name,
          match: { key: m.usageKey, scientificName: m.scientificName, canonicalName: m.canonicalName, rank: m.rank, status: m.status, matchType: m.matchType, confidence: m.confidence },
          vernacularName: vernacular,
          breadcrumb: m.breadcrumb,
          breadcrumbText,
          iucn: iucn ? { ...iucn, label: IUCN_LABEL[iucn.code] ?? iucn.category, via: "GBIF /species/{key}/iucnRedListCategory" } : null,
          occurrences: { worldwide, inBbox },
          openTree: ott,
          links: { gbif: `https://www.gbif.org/species/${m.usageKey}`, ...(ott ? { openTree: ott.url } : {}) },
          summary,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
