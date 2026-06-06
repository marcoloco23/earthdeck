import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStacFeatures, stacSearch } from "../src/clients/stac.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

// A representative Earth Search sentinel-2-l2a ItemCollection with deliberate quirks.
function fixture() {
  return {
    type: "FeatureCollection",
    features: [
      {
        id: "S2A_30",
        collection: "sentinel-2-l2a",
        bbox: [10.0, 45.0, 100, 11.0, 46.0, 2000], // 6-element (3D) bbox
        properties: { datetime: "2024-07-10T10:20:00Z", "eo:cloud_cover": 30 },
        assets: {
          red: { href: "https://s3/red.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized", roles: ["data"] },
          nir: { href: "https://s3/nir.tif", roles: ["data"] },
          visual: { href: "https://s3/tci.tif", roles: ["data", "visual"], title: "True color" },
          thumbnail: { href: "https://s3/thumb.jpg", type: "image/jpeg", roles: ["thumbnail"] },
        },
      },
      {
        id: "S2B_05",
        collection: "sentinel-2-l2a",
        bbox: [10.0, 45.0, 11.0, 46.0],
        properties: { datetime: "2024-07-05T10:20:00Z", "eo:cloud_cover": 5 },
        assets: { scl: { href: "https://s3/scl.tif", roles: ["data"] } },
      },
      {
        id: "S2C_NA",
        collection: "sentinel-2-l2a",
        bbox: [10, 45, 11, 46],
        properties: { datetime: "2024-07-01T10:20:00Z" }, // no eo:cloud_cover
        assets: { b08: { href: "https://s3/b08.tif", type: "image/tiff; application=geotiff" } }, // typed COG, no roles
      },
      { properties: { datetime: "x" } }, // malformed: no id → skipped
    ],
  };
}

test("parseStacFeatures normalizes and sorts, skipping malformed features", () => {
  const scenes = parseStacFeatures(fixture());
  assert.equal(scenes.length, 3, "malformed feature dropped");
  assert.equal(scenes[0]!.id, "S2B_05", "least-cloudy first");
  assert.equal(scenes[2]!.id, "S2C_NA", "null cloud sorts last");
});

test("parseStacFeatures collapses a 6-element bbox to [w,s,e,n]", () => {
  const a = parseStacFeatures(fixture()).find((s) => s.id === "S2A_30")!;
  assert.deepEqual(a.bbox, [10, 45, 11, 46]);
  assert.equal(a.cloudCover, 30);
  assert.equal(a.datetime, "2024-07-10T10:20:00Z");
});

test("parseStacFeatures separates the thumbnail from data COG assets", () => {
  const a = parseStacFeatures(fixture()).find((s) => s.id === "S2A_30")!;
  assert.equal(a.thumbnail, "https://s3/thumb.jpg");
  assert.equal(a.assets.length, 3);
  assert.ok(!a.assets.some((x) => x.key === "thumbnail"));
  assert.equal(a.assets.find((x) => x.key === "red")!.href, "https://s3/red.tif");
  assert.equal(a.assets.find((x) => x.key === "visual")!.title, "True color");
});

test("parseStacFeatures keeps a typed COG asset that has no roles, and nulls absent cloud", () => {
  const c = parseStacFeatures(fixture()).find((s) => s.id === "S2C_NA")!;
  assert.equal(c.cloudCover, null);
  assert.equal(c.assets.length, 1);
  assert.equal(c.assets[0]!.key, "b08");
});

test("parseStacFeatures applies the maxCloud filter", () => {
  const scenes = parseStacFeatures(fixture(), 20);
  assert.deepEqual(scenes.map((s) => s.id).sort(), ["S2B_05", "S2C_NA"]);
});

test("parseStacFeatures returns [] for a missing/empty collection", () => {
  assert.deepEqual(parseStacFeatures({}), []);
  assert.deepEqual(parseStacFeatures({ features: [] }), []);
});

test("stacSearch POSTs to {endpoint}/search with bbox, datetime, and a cloud query", async (t) => {
  const fetchMock = mockFetch(() => jsonResponse(fixture()));
  t.after(() => fetchMock.restore());

  const res = await stacSearch({
    bbox: [10, 45, 11, 46],
    dateFrom: "2024-07-01",
    dateTo: "2024-07-31",
    maxCloud: 20,
    limit: 5,
  });

  assert.equal(fetchMock.calls.length, 1);
  const call = fetchMock.calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/search"));
  const body = JSON.parse(call.body!);
  assert.deepEqual(body.bbox, [10, 45, 11, 46]);
  assert.equal(body.datetime, "2024-07-01T00:00:00Z/2024-07-31T23:59:59Z");
  assert.equal(body.limit, 5);
  assert.deepEqual(body.query, { "eo:cloud_cover": { lt: 20 } });
  // maxCloud also re-filters client-side → the 30% scene is dropped.
  assert.deepEqual(res.scenes.map((s) => s.id).sort(), ["S2B_05", "S2C_NA"]);
  assert.equal(res.collection, "sentinel-2-l2a");
});

test("stacSearch omits the cloud query when maxCloud is unset", async (t) => {
  const fetchMock = mockFetch(() => jsonResponse({ features: [] }));
  t.after(() => fetchMock.restore());
  await stacSearch({ bbox: [10, 45, 11, 46], dateFrom: "2024-07-01", dateTo: "2024-07-31" });
  const body = JSON.parse(fetchMock.calls[0]!.body!);
  assert.equal(body.query, undefined);
});

test("stacSearch throws a clean error on an HTTP failure", async (t) => {
  const fetchMock = mockFetch(() => textResponse("Host not in allowlist", { status: 403 }));
  t.after(() => fetchMock.restore());
  await assert.rejects(
    () => stacSearch({ bbox: [10, 45, 11, 46], dateFrom: "2024-07-01", dateTo: "2024-07-31" }),
    /STAC search failed \(403\)/,
  );
});

test("stacSearch throws on a non-JSON body", async (t) => {
  const fetchMock = mockFetch(() => textResponse("<html>oops</html>"));
  t.after(() => fetchMock.restore());
  await assert.rejects(
    () => stacSearch({ bbox: [10, 45, 11, 46], dateFrom: "2024-07-01", dateTo: "2024-07-31" }),
    /non-JSON/,
  );
});
