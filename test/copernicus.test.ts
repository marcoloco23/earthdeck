import { test } from "node:test";
import assert from "node:assert/strict";
import { CopernicusClient } from "../src/clients/copernicus.js";
import type { BBox } from "../src/types.js";
import { binaryResponse, jsonResponse, mockFetch, textResponse } from "./helpers.js";

const BBOX: BBox = [-60.2, -3.3, -59.8, -2.9];
const isToken = (u: string) => u.includes("openid-connect/token");

function statsBody(over: Record<string, number> = {}) {
  return {
    data: [
      {
        interval: { from: "2025-05-01T00:00:00Z", to: "2025-05-31T23:59:59Z" },
        outputs: {
          data: {
            bands: {
              B0: {
                stats: {
                  mean: 0.31,
                  min: -0.1,
                  max: 0.82,
                  stDev: 0.12,
                  sampleCount: 100,
                  noDataCount: 10,
                  percentiles: { "25.0": 0.2, "50.0": 0.3, "75.0": 0.6 },
                  ...over,
                },
              },
            },
          },
        },
      },
    ],
  };
}

test("statistics parses stats and computes validPct (= survived / total)", async (t) => {
  const fetchMock = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "TKN", expires_in: 3600 }) : jsonResponse(statsBody())));
  t.after(() => fetchMock.restore());

  const client = new CopernicusClient("id", "secret");
  const stats = await client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" });
  assert.equal(stats.mean, 0.31);
  assert.equal(stats.validPct, 90); // (100 - 10) / 100
  assert.equal(stats.p50, 0.3);
  assert.equal(stats.sampleCount, 100);
});

test("statistics throws when every pixel was masked (no valid data)", async (t) => {
  const fetchMock = mockFetch((url) =>
    isToken(url) ? jsonResponse({ access_token: "TKN", expires_in: 3600 }) : jsonResponse(statsBody({ sampleCount: 50, noDataCount: 50 })),
  );
  t.after(() => fetchMock.restore());
  const client = new CopernicusClient("id", "secret");
  await assert.rejects(
    () => client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" }),
    /No valid Sentinel-2 data/,
  );
});

test("token is cached across calls (only one token POST for two requests)", async (t) => {
  const fetchMock = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "TKN", expires_in: 3600 }) : jsonResponse(statsBody())));
  t.after(() => fetchMock.restore());

  const client = new CopernicusClient("id", "secret");
  await client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" });
  await client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" });
  assert.equal(fetchMock.calls.filter((c) => isToken(c.url)).length, 1, "token fetched once, then reused");
});

test("a 401 triggers exactly one forced token refresh and a retry", async (t) => {
  let statsHits = 0;
  let tokenHits = 0;
  const fetchMock = mockFetch((url) => {
    if (isToken(url)) {
      tokenHits++;
      return jsonResponse({ access_token: `TKN${tokenHits}`, expires_in: 3600 });
    }
    statsHits++;
    return statsHits === 1 ? textResponse("expired", { status: 401 }) : jsonResponse(statsBody());
  });
  t.after(() => fetchMock.restore());

  const client = new CopernicusClient("id", "secret");
  const stats = await client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" });
  assert.equal(stats.validPct, 90);
  assert.equal(tokenHits, 2, "initial token + one forced refresh");
  assert.equal(statsHits, 2, "first 401, then a successful retry");
});

test("process returns the image bytes and sends a bearer token", async (t) => {
  const png = Buffer.from([137, 80, 78, 71]);
  const fetchMock = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "TKN", expires_in: 3600 }) : binaryResponse(png, "image/png")));
  t.after(() => fetchMock.restore());

  const client = new CopernicusClient("id", "secret");
  const buf = await client.process(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x", width: 256, height: 256 });
  assert.deepEqual([...buf], [...png]);
  const shCall = fetchMock.calls.find((c) => c.url.includes("/process"))!;
  assert.equal(shCall.headers["authorization"], "Bearer TKN");
});

test("search parses scenes, filters by maxCloud, and uses Accept: */*", async (t) => {
  const features = {
    features: [
      { id: "S2_A", properties: { datetime: "2025-05-12T10:00:00Z", "eo:cloud_cover": 4 } },
      { id: "S2_B", properties: { datetime: "2025-05-15T10:00:00Z", "eo:cloud_cover": 60 } },
      { id: "S2_C", properties: { datetime: "2025-05-18T10:00:00Z" } }, // unknown cloud → kept
    ],
  };
  const fetchMock = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "TKN", expires_in: 3600 }) : jsonResponse(features)));
  t.after(() => fetchMock.restore());

  const client = new CopernicusClient("id", "secret");
  const scenes = await client.search(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", maxCloud: 20 });
  assert.deepEqual(scenes.map((s) => s.id), ["S2_A", "S2_C"]); // 60% dropped, null kept
  assert.equal(scenes[0]!.cloudCover, 4);

  const catalogCall = fetchMock.calls.find((c) => c.url.includes("/catalog"))!;
  assert.equal(catalogCall.headers["accept"], "*/*"); // 406 otherwise
});

test("auth failure surfaces a clean OverviewError", async (t) => {
  const fetchMock = mockFetch(() => textResponse("bad client", { status: 401 }));
  t.after(() => fetchMock.restore());
  const client = new CopernicusClient("id", "bad");
  await assert.rejects(
    () => client.statistics(BBOX, { dateFrom: "2025-05-01", dateTo: "2025-05-31", evalscript: "x" }),
    /Copernicus auth failed \(401\)/,
  );
});
