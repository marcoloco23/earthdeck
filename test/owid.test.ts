// world_pulse: OWID CSV parsing, the improving/worsening/pace logic, and the tool's
// partial-failure behaviour — all against fixtures, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, INDICATORS, owidUrl, parseOwidCsv, indicator } from "../src/clients/owid.js";
import { pulseRow } from "../src/tools/worldpulse.js";
import { mockFetch, textResponse } from "./helpers.js";

const CSV = [
  "Entity,Code,Year,child_mortality_igme",
  ...Array.from({ length: 30 }, (_, i) => {
    const year = 1996 + i;
    // Falls 8 %/yr, then the decline slows in the last 5 years.
    const v = year <= 2020 ? 9.0 * Math.pow(0.95, i) : 9.0 * Math.pow(0.95, 24) * Math.pow(0.985, year - 2020);
    return `World,OWID_WRL,${year},${v.toFixed(3)}`;
  }),
].join("\n");

test("owid: url shape and CSV parsing", () => {
  const ind = indicator("child-mortality")!;
  assert.equal(owidUrl(ind), "https://ourworldindata.org/grapher/child-mortality.csv?v=1&csvType=filtered&useColumnShortNames=true&country=OWID_WRL");
  const pts = parseOwidCsv(CSV);
  assert.equal(pts.length, 30);
  assert.equal(pts[0]!.t, "1996");
  assert.equal(pts[29]!.t, "2025");
  // Quoted entity names and blank values are handled.
  const quoted = parseOwidCsv('Entity,Code,Year,x\n"Korea, Rep.",KOR,2000,\n"Korea, Rep.",KOR,2001,3.5\n');
  assert.deepEqual(quoted, [
    { t: "2000", v: null },
    { t: "2001", v: 3.5 },
  ]);
  assert.throws(() => parseOwidCsv("nope"), /no data rows/);
});

test("owid: direction honours betterWhen; pace detects a slowing decline", () => {
  const pts = parseOwidCsv(CSV);
  const down = assess(pts, "down");
  assert.equal(down.direction, "improving");
  assert.equal(down.pace, "slowing");
  assert.ok(down.pctPerDecade! < 0);
  const up = assess(pts, "up");
  assert.equal(up.direction, "worsening");

  const flat = assess(
    Array.from({ length: 15 }, (_, i) => ({ t: String(2010 + i), v: 50 + (i % 2) * 0.01 })),
    "up",
  );
  assert.equal(flat.direction, "flat");
  assert.deepEqual(assess([], "up").latest, null);
});

test("owid: registry is well-formed and every indicator records its upstream licence", () => {
  const slugs = new Set(INDICATORS.map((i) => i.slug));
  assert.equal(slugs.size, INDICATORS.length);
  for (const i of INDICATORS) {
    assert.ok(i.licence.length > 0 && i.upstream.length > 0, i.slug);
    assert.ok(["up", "down"].includes(i.betterWhen));
  }
});

test("world_pulse row: latest, sparkline and trend fields from a fetched series", async (t) => {
  const fm = mockFetch((url) => (url.includes("child-mortality") ? textResponse(CSV) : new Response("nope", { status: 500 })));
  t.after(fm.restore);
  const { fetchIndicator } = await import("../src/clients/owid.js");
  const row = pulseRow(indicator("child-mortality")!, await fetchIndicator(indicator("child-mortality")!));
  assert.equal(row.status, "ok");
  assert.equal(row.latest?.t, "2025");
  assert.equal(row.direction, "improving");
  assert.ok(row.sparkline!.length <= 60);
  await assert.rejects(fetchIndicator(indicator("forest-area-km")!), /request failed \(500\)/);
  assert.ok(fm.calls.every((c) => c.headers["user-agent"]?.startsWith("earthdeck/")));
});
