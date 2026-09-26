// The life layer: GBIF (biodiversity + species), Open Tree of Life, NOAA Coral Reef Watch.
// Fixtures are trimmed from live responses recorded 2026-09-26 (Manaus bbox
// [-60.3,-3.3,-59.7,-2.8], Great Barrier Reef -18.3/147.5) — no network here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  iucnCategory,
  kingdomName,
  licenceLabel,
  occurrenceParams,
  occurrenceSample,
  occurrenceSummary,
  parseFacets,
  parseOccurrences,
  parseSpeciesMatch,
  speciesMatch,
  threatenedSpecies,
} from "../src/clients/gbif.js";
import { ottMatch, parseTnrs } from "../src/clients/opentree.js";
import { baaLabel, crwArea, crwSeries, crwStride, parseCrw, summarizeCrwGrid } from "../src/clients/coralreefwatch.js";
import { bboxAreaKm2, biodiversityScore } from "../src/tools/biodiversity.js";
import { interpretDhw } from "../src/tools/coral.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const MANAUS: BBox = [-60.3, -3.3, -59.7, -2.8];

// Live facet response (all kingdoms), species facet trimmed to 5 of 10,000 entries.
const FACETS_ALL = {
  offset: 0,
  limit: 0,
  endOfRecords: false,
  count: 343587,
  results: [],
  facets: [
    { field: "SPECIES_KEY", counts: [{ name: "2481942", count: 4701 }, { name: "2488602", count: 4300 }, { name: "5229662", count: 4171 }, { name: "2482755", count: 3796 }, { name: "9436876", count: 3372 }] },
    { field: "LICENSE", counts: [{ name: "CC_BY_4_0", count: 268729 }, { name: "CC_BY_NC_4_0", count: 50586 }, { name: "CC0_1_0", count: 24272 }] },
    { field: "KINGDOM_KEY", counts: [{ name: "1", count: 264464 }, { name: "6", count: 69027 }, { name: "3", count: 7367 }, { name: "5", count: 2287 }, { name: "7", count: 156 }, { name: "4", count: 23 }, { name: "8", count: 5 }, { name: "0", count: 3 }] },
    { field: "IUCN_RED_LIST_CATEGORY", counts: [{ name: "LC", count: 224574 }, { name: "VU", count: 2111 }, { name: "NT", count: 1294 }, { name: "EN", count: 1038 }, { name: "DD", count: 709 }, { name: "CR", count: 289 }, { name: "CD", count: 154 }, { name: "EX", count: 29 }] },
  ],
};

const FUNGI_RECORDS = {
  offset: 0,
  limit: 2,
  count: 156,
  results: [
    { key: 6130168958, decimalLatitude: -3.007433, decimalLongitude: -59.940256, eventDate: "2026-01-09T14:46:56", scientificName: "Marasmius haematocephalus (Mont.) Fr.", species: "Marasmius haematocephalus", kingdom: "Fungi", basisOfRecord: "HUMAN_OBSERVATION", datasetName: "iNaturalist research-grade observations", license: "http://creativecommons.org/licenses/by-nc/4.0/legalcode" },
    { key: 6131573472, decimalLatitude: -2.930164, decimalLongitude: -59.975165, eventDate: "2026-01-15T17:01:38", scientificName: "Paraisaria amazonica (Henn.) Luangsa-ard, Mongkols. & Samson", species: "Paraisaria amazonica", kingdom: "Fungi", basisOfRecord: "HUMAN_OBSERVATION", datasetName: "iNaturalist research-grade observations", license: "http://creativecommons.org/licenses/by-nc/4.0/legalcode" },
    { key: 1, scientificName: "no coordinates — skipped" },
  ],
};

test("gbif: kingdom keys, licence labels, facet parsing", () => {
  assert.equal(kingdomName(5), "Fungi");
  assert.equal(kingdomName("1"), "Animalia");
  assert.equal(kingdomName(0), "incertae sedis");
  assert.equal(licenceLabel("CC_BY_NC_4_0"), "CC BY-NC 4.0");
  assert.equal(licenceLabel("http://creativecommons.org/publicdomain/zero/1.0/legalcode"), "CC0 1.0");
  assert.equal(licenceLabel("http://creativecommons.org/licenses/by/4.0/legalcode"), "CC BY 4.0");
  const { count, facets } = parseFacets(FACETS_ALL);
  assert.equal(count, 343587);
  assert.deepEqual(Object.keys(facets).sort(), ["iucnRedListCategory", "kingdomKey", "license", "speciesKey"]);
  assert.throws(() => parseFacets({ nope: 1 }), /unexpected GBIF facet/);
});

test("gbif: occurrence filter — bbox ranges, Fungi kingdom key, years, presence only", () => {
  const p = occurrenceParams({ bbox: MANAUS, kingdom: "Fungi", yearFrom: 2000, yearTo: 2026 });
  assert.equal(p.get("decimalLatitude"), "-3.3,-2.8");
  assert.equal(p.get("decimalLongitude"), "-60.3,-59.7");
  assert.equal(p.get("kingdomKey"), "5");
  assert.equal(p.get("year"), "2000,2026");
  assert.equal(p.get("occurrenceStatus"), "PRESENT");
  assert.throws(() => occurrenceParams({ bbox: [10, 0, 5, 1] }), /west/);
});

test("gbif: occurrenceSummary — one facet call, Fungi in the kingdom breakdown", async (t) => {
  const fm = mockFetch(() => jsonResponse(FACETS_ALL));
  t.after(fm.restore);
  const s = await occurrenceSummary({ bbox: MANAUS });
  assert.equal(fm.calls.length, 1);
  const url = new URL(fm.calls[0]!.url);
  assert.equal(url.searchParams.get("limit"), "0");
  assert.deepEqual(url.searchParams.getAll("facet"), ["kingdomKey", "license", "iucnRedListCategory", "speciesKey"]);
  assert.equal(url.searchParams.get("speciesKey.facetLimit"), "10000");
  assert.ok(fm.calls[0]!.headers["user-agent"]?.startsWith("earthdeck/"));
  assert.equal(s.occurrences, 343587);
  assert.deepEqual(s.byKingdom.find((k) => k.kingdom === "Fungi"), { kingdom: "Fungi", count: 2287 });
  assert.equal(s.licences[0]!.licence, "CC BY 4.0");
  assert.equal(s.species[0]!.key, 2481942);
  assert.equal(s.speciesCapped, false);
});

test("gbif: threatened species filter repeats CR/EN/VU; sample parses records and licences", async (t) => {
  const fm = mockFetch((url) =>
    url.includes("iucnRedListCategory=")
      ? jsonResponse({ count: 3438, facets: [{ field: "SPECIES_KEY", counts: [{ name: "5230625", count: 362 }, { name: "2436470", count: 210 }] }] })
      : jsonResponse(FUNGI_RECORDS),
  );
  t.after(fm.restore);
  const th = await threatenedSpecies({ bbox: MANAUS });
  assert.deepEqual(new URL(fm.calls[0]!.url).searchParams.getAll("iucnRedListCategory"), ["CR", "EN", "VU"]);
  assert.equal(th.species.length, 2);
  const recs = await occurrenceSample({ bbox: MANAUS, kingdom: "Fungi", yearTo: 2026 }, 5);
  assert.equal(new URL(fm.calls[1]!.url).searchParams.get("year"), "2025,2026"); // recent window first
  assert.equal(recs.length, 2); // record without coordinates skipped
  assert.deepEqual(recs[0], {
    key: 6130168958,
    lat: -3.007433,
    lon: -59.940256,
    date: "2026-01-09",
    scientificName: "Marasmius haematocephalus (Mont.) Fr.",
    species: "Marasmius haematocephalus",
    kingdom: "Fungi",
    iucn: null,
    basisOfRecord: "HUMAN_OBSERVATION",
    dataset: "iNaturalist research-grade observations",
    licence: "CC BY-NC 4.0",
    url: "https://www.gbif.org/occurrence/6130168958",
  });
  assert.throws(() => parseOccurrences({}), /unexpected GBIF occurrence/);
});

test("gbif: sample falls back to the whole window when the recent years are empty", async (t) => {
  const fm = mockFetch((url) => jsonResponse(url.includes("year=2025%2C2026") ? { results: [] } : FUNGI_RECORDS));
  t.after(fm.restore);
  const recs = await occurrenceSample({ bbox: MANAUS, yearFrom: 1990, yearTo: 2026 });
  assert.equal(fm.calls.length, 2);
  assert.equal(new URL(fm.calls[1]!.url).searchParams.get("year"), "1990,2026");
  assert.equal(recs.length, 2);
});

// Live /species/match responses — an animal, a plant, and a fungus.
const MATCH = {
  "Amanita muscaria": { usageKey: 8168319, scientificName: "Amanita muscaria (L.) Lam.", canonicalName: "Amanita muscaria", rank: "SPECIES", status: "ACCEPTED", confidence: 97, matchType: "EXACT", kingdom: "Fungi", phylum: "Basidiomycota", order: "Agaricales", family: "Amanitaceae", genus: "Amanita", species: "Amanita muscaria", kingdomKey: 5, phylumKey: 34, classKey: 186, orderKey: 1499, familyKey: 4171, genusKey: 6005964, speciesKey: 8168319, class: "Agaricomycetes" },
  "Panthera onca": { usageKey: 5219426, scientificName: "Panthera onca (Linnaeus, 1758)", canonicalName: "Panthera onca", rank: "SPECIES", status: "ACCEPTED", confidence: 99, matchType: "EXACT", kingdom: "Animalia", phylum: "Chordata", order: "Carnivora", family: "Felidae", genus: "Panthera", species: "Panthera onca", kingdomKey: 1, phylumKey: 44, classKey: 359, orderKey: 732, familyKey: 9703, genusKey: 2435194, speciesKey: 5219426, class: "Mammalia" },
  "Sequoia sempervirens": { usageKey: 2683909, scientificName: "Sequoia sempervirens (D.Don) Endl.", canonicalName: "Sequoia sempervirens", rank: "SPECIES", status: "ACCEPTED", confidence: 99, matchType: "EXACT", kingdom: "Plantae", phylum: "Tracheophyta", order: "Pinales", family: "Cupressaceae", genus: "Sequoia", species: "Sequoia sempervirens", kingdomKey: 6, phylumKey: 7707728, classKey: 194, orderKey: 640, familyKey: 8144, genusKey: 2683908, speciesKey: 2683909, class: "Pinopsida" },
};

test("species: breadcrumb kingdom → species for a fungus, an animal and a plant", () => {
  const fungus = parseSpeciesMatch(MATCH["Amanita muscaria"]);
  assert.equal(fungus.usageKey, 8168319);
  assert.deepEqual(
    fungus.breadcrumb.map((b) => b.name),
    ["Fungi", "Basidiomycota", "Agaricomycetes", "Agaricales", "Amanitaceae", "Amanita", "Amanita muscaria"],
  );
  assert.deepEqual(fungus.breadcrumb[0], { rank: "kingdom", name: "Fungi", key: 5 });
  assert.equal(parseSpeciesMatch(MATCH["Panthera onca"]).breadcrumb[2]!.name, "Mammalia");
  assert.equal(parseSpeciesMatch(MATCH["Sequoia sempervirens"]).breadcrumb.at(-2)!.name, "Sequoia");
  assert.throws(() => parseSpeciesMatch({ matchType: "NONE", confidence: 100 }), /no backbone match/);
});

test("species: match passes the kingdom hint; IUCN via GBIF, 404 → null", async (t) => {
  const fm = mockFetch((url) => {
    if (url.includes("/species/match")) return jsonResponse(MATCH["Amanita muscaria"]);
    if (url.includes("/5219426/iucnRedListCategory")) return jsonResponse({ category: "NEAR_THREATENED", usageKey: 176685209, scientificName: "Panthera onca (Linnaeus, 1758)", taxonomicStatus: "ACCEPTED", iucnTaxonID: "15953", code: "NT" });
    return new Response("not found", { status: 404 });
  });
  t.after(fm.restore);
  const m = await speciesMatch("Amanita muscaria", "Fungi");
  assert.equal(new URL(fm.calls[0]!.url).searchParams.get("kingdom"), "Fungi");
  assert.equal(fm.calls[0]!.headers["accept-language"], "en"); // vernacular names need it
  assert.equal(m.canonicalName, "Amanita muscaria");
  assert.deepEqual(await iucnCategory(5219426), { code: "NT", category: "NEAR_THREATENED", iucnTaxonId: "15953" });
  assert.equal(await iucnCategory(1), null);
});

// Live TNRS response, synonyms trimmed.
const TNRS = {
  context: "Basidiomycetes",
  matched_names: ["Amanita muscaria"],
  results: [{ matches: [{ is_approximate_match: false, is_synonym: false, matched_name: "Amanita muscaria", nomenclature_code: "ICN", score: 1.0, search_string: "amanita muscaria", taxon: { flags: ["sibling_higher"], is_suppressed: false, name: "Amanita muscaria", ott_id: 75257, rank: "species", source: "ott3.7draft3", synonyms: ["Agaricus muscarius"] } }], name: "Amanita muscaria" }],
};

test("opentree: TNRS match → OTT id; POST body; no match → null", async (t) => {
  assert.deepEqual(parseTnrs(TNRS), { ottId: 75257, name: "Amanita muscaria", rank: "species", score: 1, isSynonym: false, url: "https://tree.opentreeoflife.org/taxonomy/browse?id=75257" });
  assert.equal(parseTnrs({ results: [{ matches: [] }] }), null);
  assert.throws(() => parseTnrs({}), /unexpected OpenTree/);
  const fm = mockFetch(() => jsonResponse(TNRS));
  t.after(fm.restore);
  assert.equal((await ottMatch("Amanita muscaria"))?.ottId, 75257);
  assert.equal(fm.calls[0]!.method, "POST");
  assert.deepEqual(JSON.parse(fm.calls[0]!.body!), { names: ["Amanita muscaria"], do_approximate_matching: false });
});

test("biodiversity score: components, weights, Fungi-filter renormalization", () => {
  const area = bboxAreaKm2(MANAUS);
  assert.ok(Math.abs(area - 3704) < 5, `area ${area}`); // ~0.6° × 0.5° at the equator
  const summary = {
    occurrences: 343587,
    byKingdom: [
      { kingdom: "Animalia", count: 264464 },
      { kingdom: "Plantae", count: 69027 },
      { kingdom: "Bacteria", count: 7367 },
      { kingdom: "Fungi", count: 2287 },
    ],
    licences: [],
    iucn: [{ category: "LC", count: 224574 }, { category: "VU", count: 2111 }, { category: "EN", count: 1038 }, { category: "CR", count: 289 }],
    species: Array.from({ length: 10_000 }, (_, i) => ({ key: i, count: 1 })),
    speciesCapped: true,
  };
  const s = biodiversityScore(summary, area, false);
  assert.equal(s.label, "sampling-effort dependent");
  assert.equal(s.components.richness.score, 100);
  assert.ok(s.components.density.score! > 70 && s.components.density.score! < 80); // ~93 records/km²
  assert.equal(s.components.threatened.value, 1); // 3438 / 343587 ≈ 1.0 %
  assert.ok(s.components.kingdomBalance.value! > 0.4 && s.components.kingdomBalance.value! < 0.5);
  assert.equal(s.score, 66); // matches the live Manaus run
  assert.ok(s.method.blindSpots.some((b) => /roads/.test(b)));
  // Fungi-only query: balance is n/a and the remaining weights renormalize.
  const fungi = biodiversityScore({ ...summary, occurrences: 2287, byKingdom: [{ kingdom: "Fungi", count: 2287 }], iucn: [], species: summary.species.slice(0, 588), speciesCapped: false }, area, true);
  assert.equal(fungi.components.kingdomBalance.score, null);
  const expected = (fungi.components.richness.score! * 0.4 + fungi.components.density.score! * 0.2) / 0.8;
  assert.equal(fungi.score, Math.round(expected));
});

// Live NOAA_DHW rows (GBR, weekly stride) incl. float noise, plus a land cell (all null).
const CRW = {
  table: {
    columnNames: ["time", "latitude", "longitude", "CRW_DHW", "CRW_SSTANOMALY", "CRW_BAA", "CRW_SST"],
    rows: [
      ["2026-02-25T12:00:00Z", -18.275, 147.525, 1.8900000000000001, 1.23, 2, 29.52],
      ["2026-03-04T12:00:00Z", -18.275, 147.525, 2.5500000000000003, 1.31, 1, 29.47],
      ["2026-09-24T12:00:00Z", -18.275, 147.525, 0, -0.1, 0, 24.72],
      ["2026-09-25T12:00:00Z", -18.275, 147.525, null, null, 251, null],
    ],
  },
};

test("coral: parse DHW/anomaly/BAA/SST rows; fill values → null; labels and thresholds", () => {
  const r = parseCrw(CRW);
  assert.equal(r.gridLat, -18.275);
  assert.deepEqual(r.points[1], { t: "2026-03-04", dhw: 2.55, sstAnomaly: 1.31, baa: 1, sst: 29.47 });
  assert.deepEqual(r.points[3], { t: "2026-09-25", dhw: null, sstAnomaly: null, baa: null, sst: null });
  assert.equal(baaLabel(1), "Bleaching Watch");
  assert.equal(baaLabel(4), "Alert Level 2");
  assert.equal(baaLabel(null), null);
  assert.match(interpretDhw(9.14), /severe/);
  assert.match(interpretDhw(4), /bleaching likely/);
  assert.match(interpretDhw(0), /no accumulated/);
  assert.equal(crwStride(365), 7);
  assert.equal(crwStride(30), 1);
});

test("coral: series URL is strided and follows the NOAA ERDDAP redirect; area stats", async (t) => {
  const grid = {
    table: {
      columnNames: ["time", "latitude", "longitude", "CRW_DHW", "CRW_BAA"],
      rows: [
        ["2024-03-07T12:00:00Z", -18.975, 147.025, 9.14, 4],
        ["2024-03-07T12:00:00Z", -18.975, 147.225, 3.2, 2],
        ["2024-03-07T12:00:00Z", -18.975, 147.425, null, null],
      ],
    },
  };
  const fm = mockFetch((url) => jsonResponse(url.includes("CRW_SST") ? CRW : grid));
  t.after(fm.restore);
  const s = await crwSeries(-18.3, 147.5, "2025-09-24", "2026-09-24");
  assert.equal(s.strideDays, 7);
  assert.ok(fm.calls[0]!.url.startsWith("https://coastwatch.pfeg.noaa.gov/erddap/griddap/NOAA_DHW.json?CRW_DHW%5B(2025-09-24T12:00:00Z):7:(2026-09-24T12:00:00Z)%5D"));
  const a = await crwArea([146, -20, 149, -16]);
  assert.deepEqual(a, { date: "2024-03-07", cells: 2, maxDhw: 9.14, meanDhw: 6.17, maxBaa: 4, alertSharePct: 50 });
  assert.deepEqual(summarizeCrwGrid(grid), a);
  await assert.rejects(crwArea([140, -30, 155, -10]), /too large/);
});
