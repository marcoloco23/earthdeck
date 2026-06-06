import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, assertBBox, bboxCenter, clampWidth, heightFor, isoDate, newId } from "../src/util.js";
import type { BBox } from "../src/types.js";

test("addDays shifts a date in UTC, both directions, across month/year", () => {
  assert.equal(addDays("2024-01-01", 1), "2024-01-02");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29"); // leap year
  assert.equal(addDays("2024-12-31", 1), "2025-01-01");
  assert.equal(addDays("2024-01-15", -30), "2023-12-16");
});

test("isoDate returns YYYY-MM-DD and counts back N days", () => {
  assert.match(isoDate(0), /^\d{4}-\d{2}-\d{2}$/);
  const today = new Date(isoDate(0) + "T00:00:00Z").getTime();
  const sevenAgo = new Date(isoDate(7) + "T00:00:00Z").getTime();
  assert.equal((today - sevenAgo) / 86_400_000, 7);
});

test("assertBBox accepts a valid box and rejects malformed ones", () => {
  assert.doesNotThrow(() => assertBBox([-60.2, -3.3, -59.8, -2.9]));
  assert.throws(() => assertBBox([1, 2, 3] as unknown as BBox), /four finite numbers/);
  assert.throws(() => assertBBox([NaN, 0, 1, 1]), /four finite numbers/);
  assert.throws(() => assertBBox([10, 0, 5, 1]), /west .* must be < east/);
  assert.throws(() => assertBBox([0, 10, 1, 5]), /south .* must be < north/);
  assert.throws(() => assertBBox([-181, 0, 1, 1]), /out of bounds/);
  assert.throws(() => assertBBox([0, -91, 1, 1]), /out of bounds/);
});

test("heightFor preserves aspect ratio and clamps", () => {
  assert.equal(heightFor([0, 0, 10, 10], 1000), 1000); // square
  assert.equal(heightFor([0, 0, 20, 10], 1000), 500); // 2:1 wide
  assert.equal(heightFor([0, 0, 10, 20], 1000), 2000); // ratio 2 → 2000 (under the 2048 cap)
  assert.ok(heightFor([0, 0, 1000, 1], 1000) >= 64); // tiny ratio clamped up to 64
  assert.ok(heightFor([0, 0, 1, 1000], 1000, 512) <= 512); // clamped to maxDim
});

test("clampWidth bounds the width and defaults non-finite to 1024", () => {
  assert.equal(clampWidth(800), 800);
  assert.equal(clampWidth(10), 64); // below min
  assert.equal(clampWidth(99999), 2048); // above max
  assert.equal(clampWidth(NaN), 1024);
  assert.equal(clampWidth(700.6), 701); // rounded
});

test("bboxCenter returns the [lon, lat] midpoint", () => {
  assert.deepEqual(bboxCenter([-10, -20, 10, 20]), [0, 0]);
  assert.deepEqual(bboxCenter([0, 0, 10, 10]), [5, 5]);
});

test("newId returns distinct UUID-shaped strings", () => {
  const a = newId();
  const b = newId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});
