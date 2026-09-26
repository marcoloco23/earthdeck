// natural_value: the sourced registry, the NPV math, land-cover class → biome mapping, the
// finding helper, and the tool end to end against a mocked CDSE Statistics histogram
// (shape recorded live 2026-09-26 over São Félix do Xingu [-52.4,-6.9,-51.9,-6.4], 64×64 px).

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BIOME_IDS,
  BIOMES,
  CPI_2007_TO_2020,
  GLOBAL_NATURE_VALUE,
  LAND_COVER,
  ORGANISMS,
  annuityFactor,
  assumeBiome,
  biomeForClass,
  livingValueForFinding,
  mixFromHistogram,
  statsSize,
  valueMix,
} from "../src/clients/naturalvalue.js";
import { registerNaturalValueTools, usd } from "../src/tools/naturalvalue.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const SFX = [-52.4, -6.9, -51.9, -6.4] as [number, number, number, number];
// Live histogram (non-zero bins) of LCM10 at 64×64 px over SFX.
const SFX_HIST: [number, number][] = [[10, 1986], [20, 23], [30, 1867], [40, 8], [50, 1], [90, 14], [100, 197]];
const statsResponse = (hist: [number, number][]) => ({
  data: [
    {
      interval: { from: "2020-01-01T00:00:00Z", to: "2021-12-31T00:00:00Z" },
      outputs: { data: { bands: { B0: { stats: { sampleCount: 4096, noDataCount: 0 }, histogram: { bins: hist.map(([v, count]) => ({ lowEdge: v, highEdge: v + 1, count })) } } } } },
    },
  ],
  status: "OK",
});

test("registry: every biome and organism is sourced, dated, banded low ≤ mid ≤ high", () => {
  assert.ok(BIOME_IDS.length >= 10);
  for (const id of BIOME_IDS) {
    const b = BIOMES[id];
    assert.equal(b.id, id);
    assert.match(b.source.url, /^https:\/\//, `${id} url`);
    assert.ok(b.source.cite.length > 20, `${id} cite`);
    assert.ok(b.caveat.length > 10, `${id} caveat`);
    assert.ok(b.bandSource.length > 10, `${id} bandSource`);
    assert.equal(b.method, "benefit transfer");
    const { low, mid, high } = b.usdPerHaYr;
    assert.ok(low >= 0 && low <= mid && mid <= high, `${id} band ordered ${low} ${mid} ${high}`);
    assert.equal(mid, Math.round(b.published.value * (b.published.dollarYear === 2007 ? CPI_2007_TO_2020 : 1)), `${id} CPI restatement`);
    if (b.serviceShares) {
      const sum = Object.values(b.serviceShares).reduce((a, x) => a + x, 0);
      assert.ok(Math.abs(sum - 1) < 0.02, `${id} shares sum ${sum}`);
    }
  }
  assert.ok(ORGANISMS.length >= 3);
  for (const o of ORGANISMS) {
    assert.match(o.source.url, /^https:\/\//, `${o.id} url`);
    assert.ok(o.usd.low <= o.usd.mid && o.usd.mid <= o.usd.high, `${o.id} band`);
    assert.ok(o.caveat.length > 10);
  }
  assert.ok(GLOBAL_NATURE_VALUE.usdPerYear.low < GLOBAL_NATURE_VALUE.usdPerYear.high);
  assert.ok(Math.abs(CPI_2007_TO_2020 - 1.2482) < 0.001);
});

test("math: annuity factor and horizon values", () => {
  assert.equal(annuityFactor(100, 0), 100);
  assert.ok(Math.abs(annuityFactor(100, 0.02) - 43.098) < 0.01);
  assert.ok(Math.abs(annuityFactor(100, 0.07) - 14.269) < 0.01);
  assert.ok(Math.abs(annuityFactor(1, 0.05) - 1 / 1.05) < 1e-9);
  const v = valueMix([{ biome: "tropical_forest", share: 1 }], 1, 100, 0.02);
  const mid = BIOMES.tropical_forest.usdPerHaYr.mid;
  assert.equal(v.annualUsd.mid, mid);
  assert.equal(v.horizon.undiscountedUsd.mid, mid * 100);
  assert.equal(v.horizon.npvUsd.mid, Math.round(mid * annuityFactor(100, 0.02)));
  // A mix is area-weighted; unvalued share (e.g. bare) contributes nothing.
  const half = valueMix([{ biome: "tropical_forest", share: 0.5 }], 10);
  assert.equal(half.annualUsd.mid, Math.round(mid * 5));
});

test("land cover: WorldCover-legend classes → biomes, histogram → mix", () => {
  assert.equal(biomeForClass(10, -6.6), "tropical_forest");
  assert.equal(biomeForClass(10, 48), "temperate_forest");
  assert.equal(biomeForClass(10, 62), "boreal_forest");
  assert.equal(biomeForClass(10, -40), "temperate_forest");
  assert.equal(biomeForClass(20, 0), "grassland");
  assert.equal(biomeForClass(30, 0), "grassland");
  assert.equal(biomeForClass(40, 0), "cropland");
  assert.equal(biomeForClass(50, 0), "wetland");
  assert.equal(biomeForClass(60, 0), "mangrove");
  assert.equal(biomeForClass(90, 0), "urban");
  assert.equal(biomeForClass(100, 0), "lakes_rivers");
  for (const code of [70, 80, 110, 254]) assert.equal(biomeForClass(code, 0), null);
  assert.equal(LAND_COVER.classes[10], "Tree cover");

  const m = mixFromHistogram(new Map([...SFX_HIST, [254, 50]]), -6.65);
  assert.equal(m.pixels, 4096); // unclassifiable excluded
  const share = (id: string) => m.mix.find((x) => x.biome === id)?.share ?? 0;
  assert.ok(Math.abs(share("tropical_forest") - 1986 / 4096) < 1e-9);
  assert.ok(Math.abs(share("grassland") - (1867 + 23) / 4096) < 1e-9);
  assert.equal(m.classes[0]!.label, "Tree cover");
  // Bare pixels dilute the valued share instead of being renormalized away.
  const bare = mixFromHistogram(new Map([[10, 50], [80, 50]]), 0);
  assert.deepEqual(bare.mix, [{ biome: "tropical_forest", share: 0.5 }]);
  assert.throws(() => mixFromHistogram(new Map([[254, 9]]), 0), /no classified pixels/);

  const sq = statsSize([0, 0, 1, 1]);
  assert.equal(sq.height, 256);
  assert.ok(sq.width >= 250 && sq.width <= 256);
  const s = statsSize([0, 60, 4, 61]); // 4° lon × cos60.5° ≈ 1.97° wide vs 1° tall
  assert.equal(s.width, 256);
  assert.ok(Math.abs(s.height - 130) <= 1);
  assert.match(assumeBiome(-6.6).assumption, /ASSUMPTION/);
});

test("finding helper: 232 ha of tropical forest (São Félix)", () => {
  const lv = livingValueForFinding(232, "tropical_forest");
  const mid = BIOMES.tropical_forest.usdPerHaYr.mid;
  assert.equal(lv.annualUsd, Math.round(232 * mid));
  assert.equal(lv.horizonUsd, Math.round(232 * mid * 100));
  assert.equal(lv.npvUsd, Math.round(232 * mid * annuityFactor(100, 0.02)));
  assert.ok(lv.band.low <= lv.annualUsd && lv.annualUsd <= lv.band.high);
  assert.ok(lv.sources[0]!.includes("Costanza"));
  assert.ok(lv.note.length <= 500);
  assert.match(lv.note, /232 ha of tropical forest/);
  for (const v of [lv.annualUsd, lv.horizonUsd, lv.npvUsd]) assert.ok(Number.isFinite(v));
});

test("usd formatting", () => {
  assert.equal(usd(950), "$950");
  assert.equal(usd(1_560_000), "$1.6M");
  assert.equal(usd(215_000_000), "$215M");
  assert.equal(usd(1.25e14), "$125T");
});

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

test("tool: natural_value over a mocked land-cover histogram", async (t) => {
  process.env.CDSE_CLIENT_ID ??= "test-id";
  process.env.CDSE_CLIENT_SECRET ??= "test-secret";
  const fm = mockFetch((url, call) => {
    if (url.includes("/openid-connect/token")) return jsonResponse({ access_token: "tok", expires_in: 600 });
    if (url.endsWith("/statistics")) {
      const body = JSON.parse(call.body!);
      assert.equal(body.input.data[0].type, LAND_COVER.collection);
      assert.equal(body.calculations.default.histograms.default.binWidth, 1);
      assert.ok(body.aggregation.width <= 256 && body.aggregation.height <= 256);
      return jsonResponse(statsResponse(SFX_HIST));
    }
    return new Response("{}", { status: 200 }); // dashboard push
  });
  t.after(fm.restore);
  const { isError, body } = await callTool({ bbox: SFX });
  assert.equal(isError, false, JSON.stringify(body));
  assert.equal(body.landCover.pixels, 4096);
  const forest = body.byBiome.find((b: { biome: string }) => b.biome === "tropical_forest");
  assert.ok(Math.abs(forest.sharePct - 48.5) < 0.1);
  assert.ok(body.annualUsd.low <= body.annualUsd.mid && body.annualUsd.mid <= body.annualUsd.high);
  assert.equal(body.horizon.undiscountedUsd.mid, body.annualUsd.mid * 100);
  assert.ok(body.horizon.npvUsd.mid < body.horizon.undiscountedUsd.mid);
  assert.ok(body.method.blindSpots.length >= 5);
  assert.ok(body.services.length >= 3);
  assert.match(body.summary, /not a price for sale/);
});

test("tool: biome override and assume mode make no network call for land cover", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const a = await callTool({ bbox: SFX, biome: "mangrove" });
  assert.equal(a.body.byBiome[0].biome, "mangrove");
  const b = await callTool({ bbox: SFX, landCover: "assume", horizonYears: 50, discountRate: 0 });
  assert.match(b.body.method.assumptions[0], /ASSUMPTION/);
  assert.equal(b.body.horizon.npvUsd.mid, b.body.horizon.undiscountedUsd.mid);
  assert.ok(!fm.calls.some((c) => c.url.endsWith("/statistics")));
  const big = await callTool({ bbox: [-60, -10, -50, 0] });
  assert.equal(big.isError, true);
});
