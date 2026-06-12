import { test } from "node:test";
import assert from "node:assert/strict";
import { s2Provenance, sarProvenance } from "../src/provenance.js";
import type { BBox } from "../src/types.js";

const BBOX: BBox = [-60.2, -3.3, -59.8, -2.9];

test("stats-kind provenance lists masked classes, validPct, and a decision-support note", () => {
  const p = s2Provenance({
    bbox: BBOX,
    from: "2025-05-01",
    to: "2025-05-31",
    kind: "stats",
    index: "NDVI",
    validPct: 91,
    scenes: [{ id: "S2_X", datetime: "2025-05-12T10:00:00Z", cloudCover: 4.2 }],
  });
  assert.equal(p.cloudMask.validPct, 91);
  assert.equal(p.cloudMask.excludedClasses.length, 7); // 6 SCL classes + the s2cloudless entry
  assert.match(p.cloudMask.method, /SCL/);
  assert.match(p.cloudMask.method, /s2cloudless/);
  assert.equal(p.composite.mosaicking, "leastCC");
  assert.equal(p.scenes?.length, 1);
  assert.match(p.disclaimer, /^Decision-support/);
  assert.equal(p.collection, "sentinel-2-l2a");
  assert.deepEqual(p.bbox, BBOX);
  assert.match(p.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("NDWI stats provenance keeps water: one fewer excluded class than NDVI", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-01", to: "2025-05-31", kind: "stats", index: "NDWI", validPct: 80 });
  assert.equal(p.cloudMask.excludedClasses.length, 6); // 5 SCL classes + s2cloudless, no water
  assert.ok(!p.cloudMask.excludedClasses.some((l) => l.includes("open water")));
});

test("image-kind provenance is an unmasked mosaic: no validPct, no excluded classes", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-17", to: "2025-05-31", kind: "image" });
  assert.equal(p.cloudMask.validPct, undefined);
  assert.equal(p.cloudMask.excludedClasses.length, 0);
  assert.match(p.cloudMask.method, /mosaic/);
  assert.match(p.disclaimer, /^Decision-support/);
});

test("median stats provenance records the ORBIT median composite and a median disclaimer", () => {
  const p = s2Provenance({
    bbox: BBOX,
    from: "2025-04-16",
    to: "2025-05-31",
    kind: "stats",
    composite: "median",
    index: "NDVI",
    validPct: 97,
  });
  assert.equal(p.composite.mosaicking, "ORBIT per-pixel median of clear observations");
  assert.match(p.disclaimer, /temporal-median composite/);
  assert.equal(p.cloudMask.excludedClasses.length, 7, "same mask classes as leastCC stats");
  assert.equal(p.cloudMask.validPct, 97);
});

test("median image provenance IS per-pixel masked (water kept) with a fallback note", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-04-16", to: "2025-05-31", kind: "image", composite: "median" });
  assert.equal(p.composite.mosaicking, "ORBIT per-pixel median of clear observations");
  assert.ok(p.cloudMask.excludedClasses.length > 0, "median renders list excluded classes");
  assert.ok(!p.cloudMask.excludedClasses.some((l) => l.includes("open water")), "imagery keeps water");
  assert.match(p.cloudMask.method, /unmasked median/);
  assert.match(p.disclaimer, /temporal median/);
});

test("omitting composite keeps the legacy leastCC provenance byte-for-byte semantics", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-17", to: "2025-05-31", kind: "image" });
  assert.equal(p.composite.mosaicking, "leastCC");
  assert.match(p.cloudMask.method, /no per-pixel cloud mask/);
});

test("sarProvenance describes an all-weather sensor with no cloud mask", () => {
  const p = sarProvenance({ bbox: BBOX, from: "2025-05-17", to: "2025-05-31", polarization: "DV", orbitDirection: "ASCENDING" });
  assert.equal(p.collection, "sentinel-1-grd");
  assert.match(p.sensor, /Sentinel-1/);
  assert.match(p.cloudMask.method, /all-weather/);
  assert.match(p.cloudMask.method, /ASCENDING orbit/);
  assert.equal(p.cloudMask.excludedClasses.length, 0);
  assert.equal(p.cloudMask.validPct, undefined);
  assert.equal(p.composite.mosaicking, "mostRecent");
  assert.match(p.disclaimer, /^Decision-support/);
});

test("provenance omits scenes when none were found", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-01", to: "2025-05-31", kind: "stats", index: "NDVI", validPct: 70 });
  assert.equal(p.scenes, undefined);
  const empty = s2Provenance({ bbox: BBOX, from: "a", to: "b", kind: "stats", index: "NDVI", scenes: [] });
  assert.equal(empty.scenes, undefined, "empty scene list is omitted, not an empty array");
});
