// world_pulse: OWID CSV parsing, the improving/worsening/pace logic, and the tool's
// partial-failure behaviour — all against fixtures, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assess, INDICATORS, owidUrl, OwidEntityMissing, parseOwidCsv, indicator } from "../src/clients/owid.js";
import { pulseRow, selectIndicators } from "../src/tools/worldpulse.js";
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
  const quoted = parseOwidCsv('Entity,Code,Year,x\n"Korea, Rep.",KOR,2000,\n"Korea, Rep.",KOR,2001,3.5\n', { entity: "KOR" });
  assert.deepEqual(quoted, [
    { t: "2000", v: null },
    { t: "2001", v: 3.5 },
  ]);
  assert.throws(() => parseOwidCsv("nope"), /no data rows/);
});

// Live-verified shapes (2026-09-26): some charts ignore `country=` and return every
// entity; the disaster-deaths chart puts per-type columns before the total.
test("owid: rows are filtered to the entity; column override; entity-missing is a typed error", () => {
  const multi = "entity,code,year,v\nZambia,ZMB,2025,71.6\nWorld,OWID_WRL,2024,9.1\nWorld,OWID_WRL,2025,8.9\nZimbabwe,ZWE,2025,50\n";
  assert.deepEqual(parseOwidCsv(multi), [
    { t: "2024", v: 9.1 },
    { t: "2025", v: 8.9 },
  ]);
  assert.throws(() => parseOwidCsv("entity,code,year,v\nZambia,ZMB,2025,71.6\n"), OwidEntityMissing);
  const deaths = "entity,code,year,total_dead_drought_yearly,total_dead_all_disasters_yearly\nWorld,OWID_WRL,2025,89,16373\n";
  assert.deepEqual(parseOwidCsv(deaths, { column: "total_dead_all_disasters_yearly" }), [{ t: "2025", v: 16373 }]);
  assert.throws(() => parseOwidCsv(deaths, { column: "nope" }), /column nope not found/);
  assert.equal(indicator("number-of-deaths-from-natural-disasters")!.column, "total_dead_all_disasters_yearly");
  assert.equal(owidUrl(indicator("forest-area-km")!, "full"), "https://ourworldindata.org/grapher/forest-area-km.csv?v=1&csvType=full&useColumnShortNames=true");
});

test("owid: fetchIndicator falls back to the full CSV when the filtered one lacks the entity", async (t) => {
  const filtered = "entity,code,year,v\nZambia,ZMB,2025,71.6\n";
  const full = "entity,code,year,v\nZambia,ZMB,2025,71.6\nWorld,OWID_WRL,2025,8.9\n";
  const fm = mockFetch((url) => textResponse(url.includes("csvType=full") ? full : filtered));
  t.after(fm.restore);
  const { fetchIndicator } = await import("../src/clients/owid.js");
  assert.deepEqual(await fetchIndicator(indicator("forest-area-km")!), [{ t: "2025", v: 8.9 }]);
  assert.equal(fm.calls.length, 2);
  assert.ok(fm.calls[0]!.url.includes("csvType=filtered"));
  assert.ok(fm.calls[1]!.url.includes("csvType=full"));
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

// Live shapes (2026-09-26): seawater-ph has no `code` column and daily `day` rows at
// Station ALOHA; the Living Planet Index puts the headline before its CI columns.
test("owid: daily charts without codes collapse to the year's last value, matched by entity name", () => {
  const ph = [
    "entity,day,ocean_ph_yearly_average,ocean_ph",
    "Hawaii,1988-10-31,,8.1097",
    "Hawaii,2014-01-16,8.067312,8.0817",
    "Hawaii,2014-12-17,8.068949,8.0744",
    "Hawaii,2024-09-08,8.04167,8.0338",
    "Hawaii,2024-12-20,8.042414,8.055",
    "Hawaii,2024-12-31,,8.05",
  ].join("\n");
  const ind = indicator("seawater-ph")!;
  assert.deepEqual(parseOwidCsv(ph, { entity: ind.entity, column: ind.column }), [
    { t: "1988", v: null },
    { t: "2014", v: 8.068949 },
    { t: "2024", v: 8.042414 }, // trailing blank doesn't erase the year's value
  ]);
  assert.throws(() => parseOwidCsv(ph, { entity: "Bermuda", column: ind.column }), OwidEntityMissing);
  const lpi = "entity,code,year,lpi_final,ci_high,ci_low\nWorld,OWID_WRL,2019,27.327448,33.41134,22.170989\nWorld,OWID_WRL,2020,27.134067,33.27644,21.972492\n";
  assert.deepEqual(parseOwidCsv(lpi, { column: indicator("global-living-planet-index")!.column }).at(-1), { t: "2020", v: 27.134067 });
});

test("owid: flatPct — a log-scale pH decline is not 'flat'", () => {
  // Station ALOHA: ~ -0.017 pH per decade ≈ -0.2 %/decade of the mean.
  const pts = Array.from({ length: 11 }, (_, i) => ({ t: String(2014 + i), v: 8.07 - 0.0017 * i }));
  assert.equal(assess(pts, "up").direction, "flat");
  assert.equal(assess(pts, "up", indicator("seawater-ph")!.flatPct).direction, "worsening");
});

test("world_pulse: groups select and order indicators; life group carries LPI and Red List Index", () => {
  const life = selectIndicators(undefined, ["life"]);
  assert.ok(life.every((i) => i.group === "life"));
  assert.ok(life.some((i) => i.slug === "global-living-planet-index"));
  assert.ok(life.some((i) => i.slug === "red-list-index"));
  const all = selectIndicators();
  assert.equal(all.length, INDICATORS.length);
  const order = all.map((i) => i.group);
  assert.deepEqual(order, [...order].sort((a, b) => ["civilization", "life", "planet"].indexOf(a) - ["civilization", "life", "planet"].indexOf(b)));
  assert.deepEqual(selectIndicators(["seawater-ph", "child-mortality"], ["life"]).map((i) => i.slug), ["child-mortality", "seawater-ph"]);
  assert.throws(() => selectIndicators(["nope"]), /unknown indicator/);
});
