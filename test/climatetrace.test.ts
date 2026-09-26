import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adminsInBBox,
  parseAdmins,
  parseCh4,
  parseSources,
  sourcesForAdmin,
  splitSources,
} from "../src/clients/climatetrace.js";
import { OverviewError } from "../src/errors.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

const SFX: BBox = [-52.4, -6.9, -51.9, -6.4];

// Real v7 responses (2026-09-26), trimmed to a few rows.
const ADMINS = [
  { id: "BRA.14.8_2", name: "Altamira Municipality", full_name: "Altamira Municipality, Pará State, BRA", level: 2, level_0_id: "BRA", level_1_id: "BRA.14_1", level_2_id: "BRA.14.8_2" },
  { id: "BRA.14.120_2", name: "São Félix do Xingu Municipality", full_name: "São Félix do Xingu Municipality, Pará State, BRA", level: 2, level_0_id: "BRA", level_1_id: "BRA.14_1", level_2_id: "BRA.14.120_2" },
];

const SOURCES_CO2E = [
  { id: 8172593, name: "São Félix do Xingu Municipality", sector: "forestry-and-land-use", subsector: "forest-land-fires", country: "BRA", assetType: "", sourceType: "gadm-aggregation", centroid: { longitude: -52.462040878054744, latitude: -7.4614655154999525, srid: 4326 }, gas: "co2e_100yr", emissionsQuantity: 9242792.11, year: 2025 },
  { id: 45279088, name: "BRA_OtherBeefCattle_14162", sector: "agriculture", subsector: "enteric-fermentation-cattle-operation", country: "BRA", assetType: "enteric_fermentation_otherbeefcattle", sourceType: "point-source", centroid: { longitude: -52.322424, latitude: -6.617583, srid: 4326 }, gas: "co2e_100yr", emissionsQuantity: 8844.2363592609, year: 2025 },
  { id: 56934145, name: "BRA_OtherBeefCattle_19472", sector: "agriculture", subsector: "enteric-fermentation-cattle-operation", country: "BRA", assetType: "enteric_fermentation_otherbeefcattle", sourceType: "point-source", centroid: { longitude: -52.211763, latitude: -6.416438, srid: 4326 }, gas: "co2e_100yr", emissionsQuantity: 8844.2363592609, year: 2025 },
  { id: 45287112, name: "BRA_OtherBeefCattle_5600", sector: "agriculture", subsector: "enteric-fermentation-cattle-operation", country: "BRA", assetType: "enteric_fermentation_otherbeefcattle", sourceType: "point-source", centroid: { longitude: -51.403512, latitude: -5.917532, srid: 4326 }, gas: "co2e_100yr", emissionsQuantity: 8844.236359260902, year: 2025 },
];
const SOURCES_CH4 = [
  { id: 45279088, gas: "ch4", emissionsQuantity: 327.5643096024 },
  { id: 45287112, gas: "ch4", emissionsQuantity: 327.5643096024 },
  { id: 8172593, gas: "ch4", emissionsQuantity: 0 },
];

test("parseAdmins keeps id + full name", () => {
  const a = parseAdmins(ADMINS);
  assert.equal(a.length, 2);
  assert.deepEqual(a[1], { id: "BRA.14.120_2", name: "São Félix do Xingu Municipality", fullName: "São Félix do Xingu Municipality, Pará State, BRA" });
  assert.deepEqual(parseAdmins({ error: "x" }), []);
});

test("parseSources normalizes centroid → lon/lat and emissions, tagged with gadmId + licence", () => {
  const s = parseSources(SOURCES_CO2E, "BRA.14.120_2");
  assert.equal(s.length, 4);
  assert.equal(s[1]!.sourceId, 45279088);
  assert.equal(s[1]!.lon, -52.322424);
  assert.equal(s[1]!.lat, -6.617583);
  assert.equal(s[1]!.co2e100yrT, 8844.2363592609);
  assert.equal(s[1]!.year, 2025);
  assert.equal(s[1]!.gadmId, "BRA.14.120_2");
  assert.match(s[1]!.licence, /CC BY 4\.0/);
  assert.equal(s[1]!.ch4T, null);
});

test("splitSources: only in-bbox point sources are assets; aggregates split off; dedup by id", () => {
  const s = parseSources([...SOURCES_CO2E, SOURCES_CO2E[1]], "BRA.14.120_2");
  const { assets, aggregates } = splitSources(s, SFX);
  assert.deepEqual(assets.map((a) => a.sourceId).sort(), [45279088, 56934145], "BRA_OtherBeefCattle_5600 is outside the bbox");
  assert.deepEqual(aggregates.map((a) => a.sourceId), [8172593]);
});

test("parseCh4 maps id → tonnes CH4 (zero kept)", () => {
  const m = parseCh4(SOURCES_CH4);
  assert.equal(m.get(45279088), 327.5643096024);
  assert.equal(m.get(8172593), 0);
  assert.equal(m.size, 3);
});

test("adminsInBBox asks /v7/admins with bbox=w,s,e,n and level 2", async (t) => {
  const m = mockFetch(() => jsonResponse(ADMINS));
  t.after(m.restore);
  const a = await adminsInBBox(SFX);
  assert.equal(a.length, 2);
  const u = new URL(m.calls[0]!.url);
  assert.equal(u.origin + u.pathname, "https://api.climatetrace.org/v7/admins");
  assert.equal(u.searchParams.get("bbox"), "-52.4,-6.9,-51.9,-6.4");
  assert.equal(u.searchParams.get("level"), "2");
  assert.match(m.calls[0]!.headers["user-agent"]!, /^earthdeck\//);
});

test("sourcesForAdmin: CO2e + CH4 calls, merged by id; sector/year passed; base overridable", async (t) => {
  process.env.EARTHDECK_CLIMATETRACE_BASE = "https://ct.example/v7";
  t.after(() => delete process.env.EARTHDECK_CLIMATETRACE_BASE);
  const m = mockFetch((url) => jsonResponse(new URL(url).searchParams.get("gas") === "ch4" ? SOURCES_CH4 : SOURCES_CO2E));
  t.after(m.restore);
  const r = await sourcesForAdmin("BRA.14.120_2", { sector: "agriculture", year: 2025 });
  assert.equal(m.calls.length, 2);
  for (const c of m.calls) {
    const u = new URL(c.url);
    assert.equal(u.origin + u.pathname, "https://ct.example/v7/sources");
    assert.equal(u.searchParams.get("gadmId"), "BRA.14.120_2");
    assert.equal(u.searchParams.get("sectors"), "agriculture");
    assert.equal(u.searchParams.get("year"), "2025");
  }
  assert.deepEqual(m.calls.map((c) => new URL(c.url).searchParams.get("gas")).sort(), ["ch4", "co2e_100yr"]);
  const byId = new Map(r.sources.map((s) => [s.sourceId, s]));
  assert.equal(byId.get(45279088)!.ch4T, 327.5643096024);
  assert.equal(byId.get(56934145)!.ch4T, null, "missing from the CH4 page → null, not 0");
  assert.equal(r.truncated, false);
});

test("Climate TRACE errors surface as OverviewError with status", async (t) => {
  const m = mockFetch(() => textResponse("slow down", { status: 429 }));
  t.after(m.restore);
  await assert.rejects(adminsInBBox(SFX), (e: unknown) => e instanceof OverviewError && e.status === 429);
});
