import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCmrCollections, searchCollections } from "../src/clients/cmr.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const CMR_JSON = {
  feed: {
    entry: [
      {
        id: "C2723754864-GES_DISC",
        short_name: "GPM_3IMERGDF",
        title: "GPM IMERG Final Precipitation L3 1 day",
        data_center: "GES_DISC",
        time_start: "2000-06-01T00:00:00.000Z",
        cloud_hosted: true,
        summary: "x".repeat(500),
        links: [{ rel: "http://esipfed.org/ns/fedsearch/1.1/documentation#", href: "https://example/landing" }],
      },
      { title: "no id — skipped" },
    ],
  },
};

test("parseCmrCollections normalizes entries, truncates summaries, skips malformed", () => {
  const rows = parseCmrCollections(CMR_JSON);
  assert.equal(rows.length, 1);
  const c = rows[0]!;
  assert.equal(c.conceptId, "C2723754864-GES_DISC");
  assert.equal(c.shortName, "GPM_3IMERGDF");
  assert.equal(c.timeEnd, null); // ongoing dataset
  assert.equal(c.cloudHosted, true);
  assert.equal(c.summary.length, 280);
  assert.equal(c.landingPage, "https://example/landing");
  assert.throws(() => parseCmrCollections({ nope: 1 }));
});

test("searchCollections builds keyword + bbox + temporal query, capped page size", async (t) => {
  const fm = mockFetch(() => jsonResponse(CMR_JSON));
  t.after(fm.restore);
  await searchCollections({
    keyword: "soil moisture",
    bbox: [-60.2, -3.3, -59.8, -2.9],
    dateFrom: "2020-01-01",
    dateTo: "2024-12-31",
    limit: 999,
  });
  const url = new URL(fm.calls[0]!.url);
  assert.equal(url.searchParams.get("keyword"), "soil moisture");
  assert.equal(url.searchParams.get("bounding_box"), "-60.2,-3.3,-59.8,-2.9");
  assert.equal(url.searchParams.get("temporal"), "2020-01-01T00:00:00Z,2024-12-31T23:59:59Z");
  assert.equal(url.searchParams.get("page_size"), "50"); // capped
  assert.equal(url.searchParams.get("sort_key"), "-usage_score");
});
