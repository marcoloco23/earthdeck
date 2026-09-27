// The landing's Metrics mode: api/metrics.json, computed at export time (src/watch/metrics.ts).
// Totals by status and topic, cases over time, top places, false-alarm rate per rule, and what's
// at stake — only from cases that passed an independent check, each with the ids behind it.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../src/ledger/schema.js";
import { bucketOf, computeMetrics, maxValue } from "../src/watch/metrics.js";

const ev = (values: Record<string, number>, params: Record<string, unknown> = {}, name = "m") => ({
  id: `e${Math.random().toString(16).slice(2, 8)}`,
  kind: "alert",
  source: "src",
  datetime: "2026-09-01T00:00:00Z",
  values,
  method: { name, version: "1.0", params },
});
const f = (id: string, rule: string, status: string, extra: Partial<Finding> = {}) =>
  ({
    findingId: id,
    rule: { name: rule, version: "1.0" },
    status,
    tier: 1,
    title: id,
    summary: "s",
    geometry: { type: "Point", coordinates: [10, 10] },
    bbox: [9, 9, 11, 11],
    aoi: { id: `aoi-${id}`, name: `Place ${id}` },
    observedAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-09-20T10:00:00Z",
    evidence: [],
    confirmed: null,
    ...extra,
  }) as unknown as Finding;

const STATS = {
  falsePositiveRate: {
    definition: "",
    overall: { falsePositives: 1, decided: 3, rate: 1 / 3 },
    byRule: { forest_loss: { falsePositives: 1, decided: 3, rate: 1 / 3 }, flaring: { falsePositives: 0, decided: 0, rate: null } },
  },
};

test("metrics: totals, timeline, places, rates", () => {
  const findings = [
    f("a", "forest_loss", "published", { aoi: { id: "x", name: "Xingu" }, evidence: [ev({ ha: 100, living_value_usd_yr: 5e5 })] as Finding["evidence"] }),
    f("b", "forest_loss", "confirmed", { aoi: { id: "x", name: "Xingu" }, createdAt: "2026-09-21T10:00:00Z", evidence: [ev({ ha: 50, living_value_usd_yr: 2e5 })] as Finding["evidence"] }),
    f("c", "forest_loss", "candidate", { evidence: [ev({ ha: 999, living_value_usd_yr: 9e9 })] as Finding["evidence"] }),
    f("d", "forest_loss", "false_positive"),
    f("e", "flaring", "published", { evidence: [ev({ bcm: 0.2, vnfTopBcm: 0.5 })] as Finding["evidence"] }),
    f("w", "indicator_trend", "candidate", { aoi: { id: "wp-lpi", name: "World: LPI" }, bbox: [-180, -90, 180, 90] }),
  ];
  const m = computeMetrics(findings, STATS, new Date("2026-09-27T00:00:00Z"));
  assert.equal(m.v, 1);
  assert.deepEqual(m.totals.byGroup, { published: 2, checking: 3, dropped: 1 });
  assert.deepEqual(m.totals.byTopic, { forest: 4, flaring: 1, trend: 1 });
  assert.equal(m.timeline.bucket, "day", "a young ledger is counted by day");
  assert.deepEqual(m.timeline.points, [
    { t: "2026-09-20", published: 2, checking: 2, dropped: 1 },
    { t: "2026-09-21", published: 0, checking: 1, dropped: 0 },
  ]);
  assert.deepEqual(m.places[0], { name: "Xingu", n: 2, caseIds: ["a", "b"] });
  assert.ok(!m.places.some((p) => p.name.startsWith("World")), "world trends are not places");
  assert.deepEqual(m.rules.map((r) => [r.rule, r.label, r.rate]), [
    ["forest_loss", "Forest loss", 1 / 3],
    ["flaring", "Gas flaring", null],
  ]);
  assert.equal(m.nature.lowUsd, 1.25e14);
});

test("metrics: stakes count only checked cases, carry their ids, and omit what no case carries", () => {
  const findings = [
    f("a", "forest_loss", "published", { evidence: [ev({ ha: 100, living_value_usd_yr: 5e5 })] as Finding["evidence"] }),
    f("b", "forest_loss", "confirmed", { evidence: [ev({ ha: 50, living_value_usd_yr: 2e5 })] as Finding["evidence"] }),
    f("c", "forest_loss", "candidate", { evidence: [ev({ ha: 999, living_value_usd_yr: 9e9 })] as Finding["evidence"] }),
    f("r", "forest_loss", "resolved", { evidence: [ev({ ha: 7 })] as Finding["evidence"] }),
    f("e", "flaring", "published", { evidence: [ev({ bcm: 0.2, vnfTopBcm: 0.5 })] as Finding["evidence"] }),
    f("s", "flaring_stopped", "notified", { evidence: [ev({ stopped_bcm: 0.03 })] as Finding["evidence"] }),
    f("q", "indicator_threshold", "confirmed", { evidence: [ev({ population: 2e7 }, { indicator: "air_quality" })] as Finding["evidence"] }),
  ];
  const m = computeMetrics(findings, STATS, new Date("2026-09-27T00:00:00Z"));
  const by = Object.fromEntries(m.stake.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by), ["living_value", "forest_ha", "flare_bcm", "flare_stopped_bcm", "people_bad_air"], "no methane or fishing numbers in these cases → no such metric");
  assert.equal(by.living_value!.value, 7e5, "the unconfirmed candidate's $9B is not counted");
  assert.deepEqual(by.living_value!.caseIds, ["a", "b"]);
  assert.equal(by.living_value!.display, "$700k a year");
  assert.equal(by.forest_ha!.value, 150, "resolved cases are no longer at stake");
  assert.equal(by.forest_ha!.display, "150 ha");
  assert.equal(by.flare_bcm!.value, 0.5, "per case the larger of its flare estimates");
  assert.deepEqual(by.flare_stopped_bcm!.caseIds, ["s"]);
  assert.equal(by.people_bad_air!.display, "20,000,000");
  for (const s of m.stake) assert.ok(s.explain.length > 20 && !s.explain.includes("undefined"), `${s.key} explains itself`);
});

test("metrics helpers: buckets and max values", () => {
  assert.equal(bucketOf("2026-09-27T23:00:00Z", "day"), "2026-09-27");
  assert.equal(bucketOf("2026-09-27T23:00:00Z", "week"), "2026-09-21", "weeks start on Monday");
  assert.equal(bucketOf("2026-09-27T23:00:00Z", "month"), "2026-09-01");
  assert.equal(bucketOf("nope", "day"), null);
  const x = f("x", "forest_loss", "published", { evidence: [ev({ a: 1, b: 3 }), ev({ a: 5, b: Number.NaN })] as Finding["evidence"] });
  assert.equal(maxValue(x, ["a", "b"]), 5);
  assert.equal(maxValue(x, ["zzz"]), null);
});
