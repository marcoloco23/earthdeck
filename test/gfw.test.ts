import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertsDailySql,
  alertsSummarySql,
  alertsWhere,
  bboxToPolygon,
  GFW_ALERTS_DATASET,
  gfwQuery,
  integratedAlerts,
  parseDailyRows,
  parseSummaryRows,
} from "../src/clients/gfw.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

const BBOX: BBox = [-52.2, -6.75, -51.8, -6.45];

test("bboxToPolygon builds a closed GeoJSON ring in lon/lat order", () => {
  const p = bboxToPolygon(BBOX);
  assert.equal(p.type, "Polygon");
  const ring = p.coordinates[0]!;
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], [-52.2, -6.75], "starts at [west, south]");
  assert.deepEqual(ring[0], ring[4], "ring is closed");
  assert.deepEqual(ring[2], [-51.8, -6.45], "[east, north] corner present");
});

test("alertsWhere: nominal means no confidence filter; high/highest OR-chain upward", () => {
  assert.equal(alertsWhere("2026-03-14", "nominal"), "gfw_integrated_alerts__date >= '2026-03-14'");
  // GFW's SQL dialect rejects IN — string-equality OR chains are the accepted form.
  assert.ok(
    alertsWhere("2026-03-14", "high").includes(
      "(gfw_integrated_alerts__confidence = 'high' OR gfw_integrated_alerts__confidence = 'highest')",
    ),
  );
  assert.ok(alertsWhere("2026-03-14", "highest").includes("(gfw_integrated_alerts__confidence = 'highest')"));
  assert.ok(!alertsWhere("2026-03-14", "high").includes("'nominal'"));
  assert.ok(!alertsWhere("2026-03-14", "high").includes(" IN "));
});

test("summary/daily SQL group by confidence and date, alias-free (GFW ignores AS)", () => {
  const summary = alertsSummarySql("2026-03-14", "nominal");
  assert.ok(summary.includes("FROM results"));
  assert.ok(summary.includes("SUM(area__ha)"));
  assert.ok(summary.includes("GROUP BY gfw_integrated_alerts__confidence"));
  const daily = alertsDailySql("2026-03-14", "high");
  assert.ok(daily.includes("GROUP BY gfw_integrated_alerts__date"));
  assert.ok(daily.includes("ORDER BY gfw_integrated_alerts__date"));
  assert.ok(!summary.includes(" AS ") && !daily.includes(" AS "), "aliases are ignored upstream — don't use them");
});

test("parseSummaryRows folds confidence rows into totals (live response column names)", () => {
  const s = parseSummaryRows([
    { gfw_integrated_alerts__confidence: "high", count: 120, area__ha: 10.567 },
    { gfw_integrated_alerts__confidence: "highest", count: 30, area__ha: 2.5 },
  ]);
  assert.equal(s.alertCount, 150);
  assert.equal(s.areaHa, 13.07);
  assert.equal(s.byConfidence.high?.alertCount, 120);
  assert.equal(s.byConfidence.highest?.areaHa, 2.5);
  assert.equal(s.byConfidence.nominal, undefined);
});

test("parseSummaryRows: empty rows → zero alerts, null area", () => {
  const s = parseSummaryRows([]);
  assert.equal(s.alertCount, 0);
  assert.equal(s.areaHa, null);
  assert.deepEqual(s.byConfidence, {});
});

test("parseDailyRows normalizes timestamps to dates, drops malformed rows, sorts", () => {
  const d = parseDailyRows([
    { gfw_integrated_alerts__date: "2026-05-02T00:00:00", count: 4 },
    { gfw_integrated_alerts__date: "2026-05-01", count: 7 },
    { gfw_integrated_alerts__date: "garbage", count: 1 },
    { gfw_integrated_alerts__date: "2026-05-03", count: "nope" },
  ]);
  assert.deepEqual(d, [
    { date: "2026-05-01", count: 7 },
    { date: "2026-05-02", count: 4 },
  ]);
});

test("gfwQuery POSTs {sql, geometry} with x-api-key + origin headers to the latest version", async (t) => {
  const mock = mockFetch(() => jsonResponse({ data: [{ count: 1 }] }));
  t.after(mock.restore);
  const rows = await gfwQuery("KEY123", GFW_ALERTS_DATASET, "SELECT 1", bboxToPolygon(BBOX));
  assert.deepEqual(rows, [{ count: 1 }]);
  const call = mock.calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith(`/dataset/${GFW_ALERTS_DATASET}/latest/query/json`));
  assert.equal(call.headers["x-api-key"], "KEY123");
  assert.equal(call.headers["origin"], "localhost", "origin header is required by the GFW gateway");
  const body = JSON.parse(call.body!);
  assert.equal(body.sql, "SELECT 1");
  assert.equal(body.geometry.type, "Polygon");
});

test("gfwQuery retries one transient 403, then succeeds", async (t) => {
  let n = 0;
  const mock = mockFetch(() => (++n === 1 ? textResponse("denied", { status: 403 }) : jsonResponse({ data: [{ count: 5 }] })));
  t.after(mock.restore);
  const rows = await gfwQuery("K", GFW_ALERTS_DATASET, "SELECT 1", null);
  assert.deepEqual(rows, [{ count: 5 }]);
  assert.equal(mock.calls.length, 2, "exactly one retry");
});

test("gfwQuery surfaces a persistently rejected key (403×2) with the key guide, other errors plainly", async (t) => {
  const mock = mockFetch((url, call) =>
    JSON.parse(call.body!).sql.includes("teapot")
      ? textResponse("boom", { status: 500 })
      : textResponse("denied", { status: 403 }),
  );
  t.after(mock.restore);
  await assert.rejects(
    () => gfwQuery("BAD", GFW_ALERTS_DATASET, "SELECT 1", null),
    /GFW API key was rejected.*create-and-use-an-api-key/s,
  );
  await assert.rejects(() => gfwQuery("K", GFW_ALERTS_DATASET, "SELECT teapot", null), /GFW query failed \(500\)/);
});

test("integratedAlerts runs summary + daily queries and returns both parsed", async (t) => {
  const mock = mockFetch((url, call) => {
    const sql = JSON.parse(call.body!).sql as string;
    return sql.includes("GROUP BY gfw_integrated_alerts__confidence")
      ? jsonResponse({
          data: [{ gfw_integrated_alerts__confidence: "high", count: 9, area__ha: 0.8 }],
        })
      : jsonResponse({ data: [{ gfw_integrated_alerts__date: "2026-06-01", count: 9 }] });
  });
  t.after(mock.restore);
  const { summary, daily } = await integratedAlerts("K", BBOX, "2026-03-14", "high");
  assert.equal(mock.calls.length, 2);
  assert.equal(summary.alertCount, 9);
  assert.deepEqual(daily, [{ date: "2026-06-01", count: 9 }]);
  for (const call of mock.calls) {
    assert.ok(
      JSON.parse(call.body!).sql.includes("= 'high' OR gfw_integrated_alerts__confidence = 'highest'"),
      "confidence filter applied",
    );
  }
});
