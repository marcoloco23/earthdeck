import { test } from "node:test";
import assert from "node:assert/strict";
import { s2Provenance } from "../src/provenance.js";
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
  assert.equal(p.cloudMask.excludedClasses.length, 6);
  assert.match(p.cloudMask.method, /SCL/);
  assert.equal(p.composite.mosaicking, "leastCC");
  assert.equal(p.scenes?.length, 1);
  assert.match(p.disclaimer, /^Decision-support/);
  assert.equal(p.collection, "sentinel-2-l2a");
  assert.deepEqual(p.bbox, BBOX);
  assert.match(p.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("NDWI stats provenance excludes only 5 classes (keeps water)", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-01", to: "2025-05-31", kind: "stats", index: "NDWI", validPct: 80 });
  assert.equal(p.cloudMask.excludedClasses.length, 5);
});

test("image-kind provenance is an unmasked mosaic: no validPct, no excluded classes", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-17", to: "2025-05-31", kind: "image" });
  assert.equal(p.cloudMask.validPct, undefined);
  assert.equal(p.cloudMask.excludedClasses.length, 0);
  assert.match(p.cloudMask.method, /mosaic/);
  assert.match(p.disclaimer, /^Decision-support/);
});

test("provenance omits scenes when none were found", () => {
  const p = s2Provenance({ bbox: BBOX, from: "2025-05-01", to: "2025-05-31", kind: "stats", index: "NDVI", validPct: 70 });
  assert.equal(p.scenes, undefined);
  const empty = s2Provenance({ bbox: BBOX, from: "a", to: "b", kind: "stats", index: "NDVI", scenes: [] });
  assert.equal(empty.scenes, undefined, "empty scene list is omitted, not an empty array");
});
