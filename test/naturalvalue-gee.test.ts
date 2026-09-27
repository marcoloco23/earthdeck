// natural_value with Earth Engine land USE: MapBiomas (Brazil) → Dynamic World → CLMS → assumed.
// Fixtures: ONE live value:compute each (test/fixtures/gee-landcover-live-2026-09-27.json) —
// MapBiomas 2024 over São Félix do Xingu and a 6-month Dynamic World mode over Kalimantan.
// The no-GEE path is pinned to a snapshot recorded before this change.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DW_CLASSES, MAPBIOMAS_CLASSES, classShares } from "../src/clients/gee.js";
import {
  BIOMES,
  DW_VALUATION,
  MAPBIOMAS_VALUATION,
  geeDatasetsFor,
  geeLandCoverFromResult,
  insideMapBiomasBrazil,
  mapbiomasConvertedPct,
} from "../src/clients/naturalvalue.js";
import { registerNaturalValueTools } from "../src/tools/naturalvalue.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { parseWatchlist } from "../src/watch/watchlist.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const LIVE = JSON.parse(readFileSync(new URL("./fixtures/gee-landcover-live-2026-09-27.json", import.meta.url), "utf8"));
const SNAP = JSON.parse(readFileSync(new URL("./fixtures/naturalvalue-no-gee-snapshot.json", import.meta.url), "utf8"));
const SFX = LIVE.mapbiomas.bbox as BBox;
const KAL = LIVE.dynamicWorld.bbox as BBox;
const SFX_HIST: [number, number][] = [[10, 1986], [20, 23], [30, 1867], [40, 8], [50, 1], [90, 14], [100, 197]];
const statsResponse = {
  data: [{ interval: { from: "2020-01-01T00:00:00Z", to: "2021-12-31T00:00:00Z" }, outputs: { data: { bands: { B0: { stats: { sampleCount: 4096, noDataCount: 0 }, histogram: { bins: SFX_HIST.map(([v, count]) => ({ lowEdge: v, highEdge: v + 1, count })) } } } } } }],
  status: "OK",
};

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY = JSON.stringify({ client_email: "t@p.iam.gserviceaccount.com", private_key: privateKey, project_id: "p" });

/** Set (or clear, with null) the GEE env for one test. */
function geeEnv(t: TestContext, on: boolean) {
  const saved = { a: process.env.GEE_SERVICE_ACCOUNT_JSON, b: process.env.GEE_PROJECT };
  if (on) {
    process.env.GEE_SERVICE_ACCOUNT_JSON = KEY;
    process.env.GEE_PROJECT = "p";
  } else {
    delete process.env.GEE_SERVICE_ACCOUNT_JSON;
    delete process.env.GEE_PROJECT;
  }
  t.after(() => {
    for (const [k, v] of [["GEE_SERVICE_ACCOUNT_JSON", saved.a], ["GEE_PROJECT", saved.b]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Mock: EE token + value:compute (per dataset), CDSE token + statistics, dashboard push. */
function mockAll(t: TestContext, o: { mapbiomas?: unknown; dw?: unknown; cdseFails?: boolean } = {}) {
  process.env.CDSE_CLIENT_ID ??= "test-id";
  process.env.CDSE_CLIENT_SECRET ??= "test-secret";
  const fm = mockFetch((url, call) => {
    if (url.startsWith("https://oauth2.googleapis.com/token")) return jsonResponse({ access_token: "ee-tok", expires_in: 3600 });
    if (url.includes("value:compute")) {
      const body = call.body ?? "";
      const dw = typeof o.dw === "function" ? (o.dw as (b: string) => unknown)(body) : o.dw;
      const r = body.includes("mapbiomas") ? o.mapbiomas : body.includes("DYNAMICWORLD") ? dw : undefined;
      return r === undefined ? jsonResponse({ error: { code: 400, message: "not scripted" } }, { status: 400 }) : jsonResponse({ result: r });
    }
    if (url.includes("/openid-connect/token")) return jsonResponse({ access_token: "tok", expires_in: 600 });
    if (url.endsWith("/statistics")) return o.cdseFails ? jsonResponse({ error: "boom" }, { status: 500 }) : jsonResponse(statsResponse);
    return new Response("{}", { status: 200 });
  });
  t.after(fm.restore);
  return fm;
}

async function callTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: "t", version: "0" });
  registerNaturalValueTools(server);
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = await client.callTool({ name: "natural_value", arguments: args });
  await client.close();
  await server.close();
  const text = (res.content as { type: string; text: string }[]).find((c) => c.type === "text")!.text;
  return { isError: Boolean(res.isError), body: JSON.parse(text) };
}

test("mapping: every MapBiomas / Dynamic World class is mapped with a basis; pasture & co. are converted and unvalued", () => {
  for (const code of Object.keys(MAPBIOMAS_CLASSES).map(Number).filter((c) => c !== 27)) {
    assert.ok(MAPBIOMAS_VALUATION[code], `mapbiomas ${code} mapped`);
    assert.ok(MAPBIOMAS_VALUATION[code]!.basis.length > 10);
  }
  for (const code of Object.keys(DW_CLASSES).map(Number)) assert.ok(DW_VALUATION[code], `dw ${code} mapped`);
  // pasture, mosaic, mining, other non-vegetated: converted with no value; crops/urban: converted, reference only
  for (const code of [15, 21, 30, 25]) assert.deepEqual([MAPBIOMAS_VALUATION[code]!.use, MAPBIOMAS_VALUATION[code]!.biome], ["converted", null]);
  assert.equal(MAPBIOMAS_VALUATION[39]!.biome, "cropland");
  assert.equal(MAPBIOMAS_VALUATION[24]!.biome, "urban");
  assert.match(MAPBIOMAS_VALUATION[15]!.basis, /no sourced ESV for planted pasture/);
  assert.equal(MAPBIOMAS_VALUATION[12]!.use, "natural");
  for (const code of [4, 6, 7]) assert.equal(DW_VALUATION[code]!.use, "converted");
  // Brazil check
  assert.equal(insideMapBiomasBrazil(SFX), true);
  assert.equal(insideMapBiomasBrazil(KAL), false);
  assert.deepEqual(geeDatasetsFor(SFX), ["mapbiomas", "dynamic-world"]);
  assert.deepEqual(geeDatasetsFor(KAL), ["dynamic-world"]);
});

test("pure: live MapBiomas São Félix histogram → natural vs converted", () => {
  const lc = geeLandCoverFromResult(LIVE.mapbiomas.result, "mapbiomas", SFX, LIVE.mapbiomas.scaleM, { year: 2024 });
  assert.equal(lc.provider, "mapbiomas-ee");
  assert.ok(lc.coveragePct > 95 && lc.coveragePct < 105, String(lc.coveragePct));
  const pasture = lc.classes.find((c) => c.name === "pasture")!;
  assert.equal(pasture.use, "converted");
  assert.equal(pasture.biome, null);
  assert.ok(Math.abs(pasture.sharePct - 56) < 0.5, String(pasture.sharePct));
  assert.ok(!lc.classes.some((c) => c.code === 0), "no-data dropped");
  const areaHa = lc.naturalHa + lc.convertedHa + lc.unmappedHa;
  assert.ok(Math.abs(areaHa - 307_028) <= 3);
  assert.equal(lc.unmappedHa, 0);
  assert.ok(lc.convertedHa > lc.naturalHa);
  const forest = lc.mix.find((m) => m.biome === "tropical_forest")!.share;
  assert.ok(Math.abs(forest - 0.371) < 0.002, String(forest)); // forest formation + floodable forest
  assert.ok(!lc.mix.some((m) => m.biome === "cropland" || m.biome === "urban"), "converted never in the natural mix");
  assert.deepEqual(lc.convertedReferenceMix.map((m) => m.biome).sort(), ["cropland", "urban"]);
  // gee_query-shaped classes → converted % (same live result)
  const pct = mapbiomasConvertedPct(classShares(LIVE.mapbiomas.result, "classification", MAPBIOMAS_CLASSES));
  assert.ok(pct !== null && Math.abs(pct - 57.1) < 0.3, String(pct));
  // Border box: too little MapBiomas coverage → throws (caller falls through to Dynamic World)
  assert.throws(() => geeLandCoverFromResult({ classification: { "3": 10 } }, "mapbiomas", SFX, 30), /cover 0 %/);
});

test("pure: live Dynamic World Kalimantan histogram → all natural forest", () => {
  const lc = geeLandCoverFromResult(LIVE.dynamicWorld.result, "dynamic-world", KAL, LIVE.dynamicWorld.scaleM);
  assert.equal(lc.provider, "dynamicworld-ee");
  assert.deepEqual(lc.mix, [{ biome: "tropical_forest", share: 1 }]);
  assert.equal(lc.convertedHa, 0);
});

test("tool without GEE: output identical to the pre-change snapshot (CLMS and assumed paths)", async (t) => {
  geeEnv(t, false);
  mockAll(t);
  const clms = (await callTool({ bbox: SFX })).body;
  assert.equal(clms.landCover.provider, "clms-cdse");
  delete clms.landCover.provider;
  assert.deepStrictEqual(clms, SNAP.clms);
});

test("tool without GEE: assumed fallback identical to the snapshot", async (t) => {
  geeEnv(t, false);
  const fm = mockAll(t, { cdseFails: true });
  const assumed = (await callTool({ bbox: SFX })).body;
  assert.equal(assumed.landCover.provider, "assumed");
  delete assumed.landCover.provider;
  assert.deepStrictEqual(assumed, SNAP.assumed);
  assert.ok(!fm.calls.some((c) => c.url.includes("googleapis")), "no Earth Engine call without GEE env");
});

test("tool with GEE: MapBiomas over São Félix values natural land only and reports converted ha", async (t) => {
  geeEnv(t, true);
  const fm = mockAll(t, { mapbiomas: LIVE.mapbiomas.result });
  const { isError, body } = await callTool({ bbox: SFX });
  assert.equal(isError, false, JSON.stringify(body));
  assert.equal(body.landCover.provider, "mapbiomas-ee");
  assert.equal(body.landCover.year, 2024);
  assert.ok(body.landCover.convertedHa > 170_000);
  assert.equal(body.converted.byClass[0].name, "pasture");
  assert.ok(body.converted.referenceAnnualUsd.mid > 0);
  assert.ok(!body.byBiome.some((b: { biome: string; sharePct: number }) => b.biome === "grassland" && b.sharePct > 5), "pasture is not valued as grassland");
  // Far below the CLMS total, which valued pasture at the grassland rate.
  assert.ok(body.annualUsd.mid < SNAP.clms.annualUsd.mid * 0.8, `${body.annualUsd.mid} vs ${SNAP.clms.annualUsd.mid}`);
  const forest = body.byBiome.find((b: { biome: string }) => b.biome === "tropical_forest");
  assert.ok(Math.abs(forest.annualUsd.mid - forest.ha * BIOMES.tropical_forest.usdPerHaYr.mid) <= BIOMES.tropical_forest.usdPerHaYr.mid);
  assert.match(body.summary, /converted land \(mostly pasture\) and is not valued/);
  assert.match(body.method.formula, /NATURAL/);
  assert.ok(body.method.blindSpots.some((b: string) => /MapBiomas Brazil Collection 10 for 2024/.test(b)));
  assert.ok(!body.method.blindSpots.some((b: string) => /^Pasture is not grassland/.test(b)));
  assert.ok(!fm.calls.some((c) => c.url.endsWith("/statistics")), "CDSE not called");
});

test("tool with GEE: Dynamic World outside Brazil; MapBiomas gap falls through; EE down falls to CLMS", async (t) => {
  geeEnv(t, true);
  // DW over SFX: a synthetic all-trees histogram big enough to cover the box at its ~18 m scale.
  const dw = (body: string) => (body.includes("-52.4") ? { label: { "1": 1e7, "2": 1e6 } } : LIVE.dynamicWorld.result);
  mockAll(t, { dw, mapbiomas: { classification: { "3": 5 } } });
  const kal = (await callTool({ bbox: KAL })).body;
  assert.equal(kal.landCover.provider, "dynamicworld-ee");
  assert.equal(kal.landCover.window.to.length, 10);
  assert.equal(kal.byBiome[0].biome, "tropical_forest");
  assert.ok(kal.method.blindSpots.some((b: string) => /probabilistic/.test(b)));
  // SFX: MapBiomas coverage too low → Dynamic World, with the reason kept.
  const sfx = (await callTool({ bbox: SFX })).body;
  assert.equal(sfx.landCover.provider, "dynamicworld-ee");
  assert.match(sfx.landCover.fallbacks[0], /^mapbiomas: .*cover/);
});

test("tool with GEE: every EE dataset failing → CLMS with the failures listed", async (t) => {
  geeEnv(t, true);
  mockAll(t, {});
  const { body } = await callTool({ bbox: SFX });
  assert.equal(body.landCover.provider, "clms-cdse");
  assert.equal(body.landCover.fallbacks.length, 2);
  assert.equal(body.annualUsd.mid, SNAP.clms.annualUsd.mid);
});

test("forest_loss: with GEE, the case notes how much of the watch area MapBiomas calls converted", async (t) => {
  const aoi = { id: "br-sfx", name: "São Félix do Xingu", bbox: SFX, rules: [{ name: "forest_loss", params: { minAlerts: 100, minHa: 10 } }] };
  const alerts = { window: { from: "2026-06-28", to: "2026-09-26" }, alertCount: 420, areaHa: 38.2, byConfidence: { high: { alertCount: 420, areaHa: 38.2 } } };
  const script: Record<string, (a: Record<string, unknown>) => unknown> = {
    forest_alerts: () => alerts,
    eo_compare: () => ({ dateA: "2026-05-14", dateB: "2026-09-26", validPctA: 95, validPctB: 95, delta: { meanChange: -0.2 } }),
    gee_query: (a) => {
      assert.equal(a.dataset, "mapbiomas");
      return { classes: classShares(LIVE.mapbiomas.result, "classification", MAPBIOMAS_CLASSES) };
    },
  };
  const run = async () => {
    const dir = mkdtempSync(join(tmpdir(), "nv-gee-"));
    const ledger = Ledger.open(dir);
    const call: ToolCall = async (tool, args) => {
      const fn = script[tool];
      if (!fn) throw new ToolError(tool, "not scripted");
      return fn(args);
    };
    const wl = parseWatchlist({ version: 1, name: "t", aois: [aoi] });
    const r = await sweep({ watchlists: [wl], rules: RULES, ledger, journal: new Journal(join(dir, "watch")), call, now: "2026-09-26T12:00:00Z", hasKey: () => true });
    return ledger.get(r.created[0]!)!;
  };
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);

  geeEnv(t, true);
  const f = await run();
  const values = f.evidence[0]!.values!;
  assert.ok(Math.abs(values.watch_area_converted_pct! - 57.1) < 0.3);
  for (const v of Object.values(values)) assert.equal(typeof v, "number");
  assert.equal(values.living_value_usd_yr, Math.round(38.2 * BIOMES.tropical_forest.usdPerHaYr.mid), "lost area still valued as forest");
  assert.match(f.context?.notes?.join(" ") ?? "", /The watch area is 57\.\d % converted land \(MapBiomas 2024/);

  delete process.env.GEE_SERVICE_ACCOUNT_JSON;
  const g = await run();
  assert.equal(g.evidence[0]!.values!.watch_area_converted_pct, undefined);
  assert.doesNotMatch(g.context?.notes?.join(" ") ?? "", /converted land/);
});
