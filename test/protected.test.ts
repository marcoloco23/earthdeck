import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bboxAreaKm2,
  LANDMARK_DATASET,
  landmarkLands,
  landmarkSql,
  osmIsIndigenous,
  overpassProtectedAreas,
  overpassQuery,
  parseLandmarkRows,
  parseOverpass,
} from "../src/clients/protected.js";
import { OverviewError } from "../src/errors.js";
import { resolveAoi } from "../src/tools/attribution.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

// Real Overpass response (2026-09-26) for bbox [-52.2,-7.9,-51.8,-7.6], inside TI Kayapó.
// Note: no `center` on the relation despite `out tags center bb` — the parser must fall back.
const OVERPASS_KAYAPO = {
  version: 0.6,
  elements: [
    {
      type: "relation",
      id: 3542567,
      bounds: { minlat: -8.6936703, minlon: -53.1304243, maxlat: -6.8793984, maxlon: -50.8329424 },
      tags: {
        boundary: "aboriginal_lands",
        name: "Terra Indígena Kayapó",
        operator: "Fundação Nacional dos Povos Indígenas",
        protect_class: "24",
        protection_title: "terra indígena",
        "ref:Funai": "23001",
        type: "boundary",
      },
    },
    { type: "area", id: 3603542567 },
  ],
};

// Real LandMark rows via the GFW Data API (2026-09-26), bbox [-53,-8,-51,-6], point (-52,-7.8).
const LANDMARK_ROWS = [
  {
    landmark_id: "BRA1213",
    name: "Kayapó",
    category: "Tierra Indígena",
    identity: "Indigenous",
    form_rec: "Acknowledged by govt",
    doc_status: "Documented",
    country: "Brazil",
    area_gis: "3285040.20070504",
    gfw_bbox: ["-53.1304243241955", "-8.69289073775748", "-50.8333931261742", "-6.87923826707791"],
    contains_center: true,
  },
  {
    landmark_id: "BRA1057",
    name: "Apyterewa",
    category: "Tierra Indígena",
    identity: "Indigenous",
    form_rec: "Acknowledged by govt",
    doc_status: "Documented",
    country: "Brazil",
    area_gis: "774062.977809595",
    gfw_bbox: ["-52.6895884216029", "-6.03251684261572", "-51.381471827983", "-5.22950896657714"],
    contains_center: false,
  },
];

const SFX: BBox = [-52.4, -6.9, -51.9, -6.4];

test("overpassQuery: bbox in (s,w,n,e) order, is_in(lat,lon), pivots containing areas back", () => {
  const q = overpassQuery(SFX);
  assert.ok(q.includes("(-6.9,-52.4,-6.4,-51.9)"), "Overpass bbox is south,west,north,east");
  assert.ok(q.includes("is_in(-6.65,-52.15)"), "is_in takes lat,lon of the AOI centre");
  assert.ok(q.includes("rel(pivot.hit)") && q.includes("way(pivot.hit)"), "containing territories are included");
  assert.ok(q.includes("out tags center bb") && !q.includes("out geom"), "never asks for geometry");
});

test("parseOverpass: Kayapó → indigenous, contains centroid, coarse centroid from bounds, ODbL", () => {
  const [a, ...rest] = parseOverpass(OVERPASS_KAYAPO);
  assert.equal(rest.length, 0, "area elements are markers, not rows");
  assert.equal(a!.id, "relation/3542567");
  assert.equal(a!.name, "Terra Indígena Kayapó");
  assert.equal(a!.indigenous, true);
  assert.equal(a!.containsAoiCentroid, true);
  assert.equal(a!.designation, "terra indígena");
  assert.match(a!.licence, /ODbL/);
  assert.deepEqual(a!.coarseCentroid, [-52, -7.8], "rounded to 0.1°");
  assert.equal(a!.areaBasis, "bbox-extent-upper-bound");
  assert.ok(a!.approxAreaKm2! > 40_000 && a!.approxAreaKm2! < 60_000);
  assert.equal(a!.url, "https://www.openstreetmap.org/relation/3542567");
});

test("parseOverpass: feature without a matching area id does not contain the centroid", () => {
  const rows = parseOverpass({ elements: [{ ...OVERPASS_KAYAPO.elements[0]!, id: 1 }, { type: "area", id: 2400000007 }] });
  assert.equal(rows[0]!.containsAoiCentroid, false);
  const way = parseOverpass({ elements: [{ type: "way", id: 7, tags: { boundary: "protected_area" }, center: { lat: -6.44, lon: -52.06 } }, { type: "area", id: 2400000007 }] });
  assert.equal(way[0]!.containsAoiCentroid, true, "way area id = 2400000000 + way id");
  assert.equal(way[0]!.indigenous, false);
  assert.deepEqual(way[0]!.coarseCentroid, [-52.1, -6.4]);
});

test("osmIsIndigenous recognises aboriginal_lands, protect_class 24 and titles", () => {
  assert.ok(osmIsIndigenous({ boundary: "aboriginal_lands" }));
  assert.ok(osmIsIndigenous({ boundary: "protected_area", protect_class: "24" }));
  assert.ok(osmIsIndigenous({ boundary: "protected_area", protection_title: "Terra Indígena" }));
  assert.ok(!osmIsIndigenous({ boundary: "protected_area", protect_class: "5", protection_title: "Área de Proteção Ambiental" }));
});

test("bboxAreaKm2 ≈ 1° × 1° at the equator is ~12,364 km²", () => {
  const a = bboxAreaKm2([0, -0.5, 1, 0.5]);
  assert.ok(Math.abs(a - 12_364) < 20, String(a));
});

test("overpassProtectedAreas POSTs form-encoded QL with the User-Agent; 504 → busy error", async (t) => {
  const m = mockFetch(() => jsonResponse(OVERPASS_KAYAPO));
  t.after(m.restore);
  const rows = await overpassProtectedAreas(SFX);
  assert.equal(rows.length, 1);
  const call = m.calls[0]!;
  assert.equal(call.method, "POST");
  assert.match(call.headers["user-agent"]!, /^earthdeck\//);
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(call.body!).get("data"), overpassQuery(SFX));
  m.restore();

  const busy = mockFetch(() => textResponse("<html>too busy</html>", { status: 504 }));
  t.after(busy.restore);
  await assert.rejects(overpassProtectedAreas(SFX), (e: unknown) => e instanceof OverviewError && /busy/.test(e.message) && e.status === 504);
});

test("landmarkSql: ST_MakePoint takes (lon, lat) of the AOI centre", () => {
  const sql = landmarkSql(SFX);
  assert.ok(sql.includes("ST_MakePoint(-52.15, -6.65)"));
  const selected = sql.split("ST_Intersects")[0]!;
  assert.ok(!/\bgeom\b|gfw_geojson/.test(selected), "no geometry column selected");
});

test("parseLandmarkRows: ha → km², coarse centroid from gfw_bbox, licence + containment kept", () => {
  const [k, a] = parseLandmarkRows(LANDMARK_ROWS);
  assert.equal(k!.source, "landmark");
  assert.equal(k!.id, "BRA1213");
  assert.equal(k!.indigenous, true);
  assert.equal(k!.containsAoiCentroid, true);
  assert.equal(k!.approxAreaKm2, 32850.4);
  assert.equal(k!.areaBasis, "gis");
  assert.deepEqual(k!.coarseCentroid, [-52, -7.8]);
  assert.match(k!.licence, /CC BY-SA 4\.0/);
  assert.equal(k!.category, "Indigenous · Acknowledged by govt; Documented");
  assert.equal(a!.containsAoiCentroid, false);
});

test("landmarkLands queries the LandMark dataset with the bbox polygon and GFW key", async (t) => {
  const m = mockFetch(() => jsonResponse({ data: LANDMARK_ROWS, status: "success" }));
  t.after(m.restore);
  const rows = await landmarkLands("KEY", SFX);
  assert.equal(rows.length, 2);
  const call = m.calls[0]!;
  assert.ok(call.url.includes(`/dataset/${LANDMARK_DATASET}/latest/query/json`));
  assert.equal(call.headers["x-api-key"], "KEY");
  const body = JSON.parse(call.body!) as { geometry: { coordinates: number[][][] } };
  assert.deepEqual(body.geometry.coordinates[0]![0], [-52.4, -6.9]);
});

test("resolveAoi: bbox passthrough, point+radius → bbox, cap and missing-AOI errors", () => {
  assert.deepEqual(resolveAoi([-52.4, -6.9, -51.9, -6.4]), SFX);
  const b = resolveAoi(undefined, [-52.15, -6.65], 10);
  assert.ok(Math.abs((b[3] - b[1]) - 20 / 111.32) < 1e-3, "20 km tall");
  assert.ok(b[0] < -52.15 && b[2] > -52.15);
  assert.throws(() => resolveAoi([-60, -10, -50, 0]), /cap/);
  assert.throws(() => resolveAoi(), /bbox|point/);
});
