// discover: the pure pieces (tiling, clustering, thresholds, naming) and the whole
// `earthdeck discover` run replayed offline against responses recorded live on 2026-09-26
// (`--record`, trimmed): request count, validation, determinism, id stability, budget.
// Plus the committed watchlists/generated/*.json and the doctor line for them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchChecks } from "../src/doctor.js";
import { parseVnfKml } from "../src/clients/vnf.js";
import type { BBox } from "../src/types.js";
import { discover } from "../src/watch/discover.js";
import { buildControls, pickIfl } from "../src/watch/discover/controls.js";
import { fieldBoxes, flareFields, FLARING_MAX_DEG2, siteTag } from "../src/watch/discover/flaring.js";
import { hotspotThresholds } from "../src/watch/discover/forest.js";
import { aoiId, bboxArea, clusterSingleLinkage, coordToken, overlapOfSmaller, padKm, slug, snapOut, tileBBox } from "../src/watch/discover/geo.js";
import { basinName, basinBox, methaneBasins, parseCtRows, METHANE_MAX_SIDE } from "../src/watch/discover/methane.js";
import { protectedThresholds } from "../src/watch/discover/protected.js";
import { RULES } from "../src/watch/rules/index.js";
import { loadWatchlists } from "../src/watch/watchlist.js";
import { jsonResponse, mockFetch, textResponse } from "./helpers.js";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const FX = JSON.parse(fixture("discover-live-2026-09-26.json")) as Record<string, any>;
const VNF_KML = fixture("vnf-2024-flare-summary-sample.kml");
const tmp = () => mkdtempSync(join(tmpdir(), "earthdeck-discover-"));

// ---------------------------------------------------------------- geometry

test("tileBBox: São Félix do Xingu's district box → equal tiles ≤ 4 deg², ≤ 2° a side, covering it exactly", () => {
  const sfx: BBox = [-53.47, -9.78, -50.71, -5.14]; // GADM BRA.14.120_2, snapped
  const tiles = tileBBox(sfx, 4, 2);
  assert.equal(tiles.length, 6);
  assert.deepEqual(tiles.map((t) => t.index), [1, 2, 3, 4, 5, 6]);
  for (const t of tiles) {
    assert.ok(bboxArea(t.bbox) <= 4 + 1e-9);
    assert.ok(t.bbox[2] - t.bbox[0] <= 2 + 1e-9 && t.bbox[3] - t.bbox[1] <= 2 + 1e-9);
  }
  const total = tiles.reduce((s, t) => s + bboxArea(t.bbox), 0);
  assert.ok(Math.abs(total - bboxArea(sfx)) < 1e-6, "tiles partition the parent");
  assert.deepEqual(tiles[0]!.bbox.slice(0, 1), [-53.47]); // row-major from the north-west
  assert.equal(tiles[0]!.bbox[3], -5.14);
  assert.deepEqual(tileBBox(sfx, 4, 2), tiles, "deterministic");
  assert.equal(tileBBox([-52.4, -6.9, -51.9, -6.4], 4, 2).length, 1);
  // A long thin box splits along its long side only.
  assert.equal(tileBBox([0, 0, 10, 0.5], 4, 2).length, 5);
});

test("single-linkage clustering chains a field, keeps a distant site apart, and is order-stable", () => {
  const pts = [
    { lat: 30.0, lon: 47.0 },
    { lat: 30.09, lon: 47.0 }, // ~10 km north
    { lat: 30.18, lon: 47.0 }, // ~10 km further: chained, 20 km from the first
    { lat: 30.0, lon: 47.5 }, // ~48 km east
  ];
  assert.deepEqual(clusterSingleLinkage(pts, 15), [[0, 1, 2], [3]]);
  assert.deepEqual(clusterSingleLinkage(pts, 5), [[0], [1], [2], [3]]);
  // High latitude: lon degrees are short, the grid search must still reach neighbours.
  assert.deepEqual(clusterSingleLinkage([{ lat: 70, lon: 10 }, { lat: 70, lon: 10.35 }], 15), [[0, 1]]);
});

test("bbox helpers: pad, snap, overlap; slugs and ids", () => {
  const p = padKm([47, 30, 47, 30], 10);
  assert.ok(Math.abs(p[3] - p[1] - 20 / 110.57) < 1e-9);
  assert.ok(p[2] - p[0] > p[3] - p[1], "longitude padding widens with latitude");
  assert.deepEqual(snapOut([-53.4696963, -9.77286, -50.7196135, -5.1491748]), [-53.47, -9.78, -50.71, -5.14]);
  assert.equal(overlapOfSmaller([0, 0, 2, 2], [0.5, 0.5, 1, 1]), 1);
  assert.equal(overlapOfSmaller([0, 0, 1, 1], [2, 2, 3, 3]), 0);
  assert.equal(slug("São Félix do Xingu"), "sao-felix-do-xingu");
  assert.equal(slug("Kalimantan Barat"), "kalimantan-barat");
  assert.equal(coordToken(-47.13, "e", "w"), "47p1w");
  assert.equal(aoiId("BRA", 14, 8), "bra-14-8");
  assert.ok(aoiId("x".repeat(80)).length <= 64);
});

// ---------------------------------------------------------------- thresholds

test("hotspot thresholds: control noise floor scaled to area, never below 25 ha; loud fires, noise doesn't", () => {
  assert.deepEqual(hotspotThresholds(0.25), { days: 90, minConfidence: "high", minAlerts: 250, minHa: 25 });
  assert.equal(hotspotThresholds(0.05).minHa, 25);
  assert.equal(hotspotThresholds(2.13).minHa, 213);
  assert.equal(hotspotThresholds(4).minHa, 400);
  // Calibration: São Félix's 0.25 deg² box drew 232 ha / 90 d (loud) — clears the bar at any
  // tile size at that density; the control cores' 15–19 ha / 0.25 deg² noise does not.
  for (const deg2 of [0.25, 1, 2, 4]) {
    assert.ok((232 / 0.25) * deg2 >= hotspotThresholds(deg2).minHa, `loud @ ${deg2}`);
    assert.ok((19 / 0.25) * deg2 < hotspotThresholds(deg2).minHa, `noise @ ${deg2}`);
  }
});

test("protected thresholds: sensitive (Indigenous-land style) but scaled", () => {
  assert.deepEqual(protectedThresholds(0.1), { days: 60, minConfidence: "high", minAlerts: 50, minHa: 5 });
  assert.equal(protectedThresholds(0.25).minHa, 10);
  assert.equal(protectedThresholds(2.39).minHa, 96);
  assert.ok(protectedThresholds(1).minHa < hotspotThresholds(1).minHa);
});

// ---------------------------------------------------------------- flaring + methane builders

test("flare fields: Rumaila's VNF sites chain into one field; boxes padded and capped; tags drop the year", () => {
  const sites = parseVnfKml(VNF_KML);
  const fields = flareFields(sites);
  const top = fields[0]!;
  assert.equal(top.country, "IRQ");
  assert.ok(top.sites.length >= 20, `${top.sites.length} sites`);
  assert.ok(Math.abs(top.bcm - top.sites.reduce((s, x) => s + x.bcm, 0)) < 1e-9);
  const boxes = fieldBoxes(top);
  assert.equal(boxes.length, 1);
  assert.ok(bboxArea(boxes[0]!.bbox) <= FLARING_MAX_DEG2);
  for (const s of top.sites) assert.ok(s.lon > boxes[0]!.bbox[0] && s.lon < boxes[0]!.bbox[2] && s.lat > boxes[0]!.bbox[1] && s.lat < boxes[0]!.bbox[3]);
  assert.equal(siteTag("IRQ_UPS_2024_47.1036E_30.5649N_v0.2"), "irq_ups_47.1036e_30.5649n");
  // Order of input doesn't change the result.
  assert.deepEqual(flareFields([...sites].reverse()).map((f) => f.lead.id), fields.map((f) => f.lead.id));
  // A synthetic 7° × 7° diagonal chain (~10 km steps) is split into ≤ 25 deg² parts.
  const chain = Array.from({ length: 100 }, (_, i) => ({ ...sites[0]!, id: `S${String(i).padStart(3, "0")}`, lat: 20 + i * 0.07, lon: 40 + i * 0.07, bcm: 0.01 }));
  const long = flareFields(chain);
  assert.equal(long.length, 1);
  const parts = fieldBoxes(long[0]!);
  assert.ok(parts.length >= 2);
  for (const b of parts) assert.ok(bboxArea(b.bbox) <= FLARING_MAX_DEG2 && b.index >= 1);
});

test("methane basins: residuals and offshore dropped, basins clustered, names operator-free, boxes capped", () => {
  const { rows, dropped } = parseCtRows({ base: "x", bySubsector: FX.climatetrace });
  assert.ok(dropped.otherBasins > 0 && dropped.zero > 0);
  assert.ok(rows.every((r) => !/OtherBasins|deepwater|offshore/i.test(r.name)));
  const basins = methaneBasins(rows);
  assert.equal(basins[0]!.name, "Central Sub-basin - West Siberia");
  for (let i = 1; i < basins.length; i++) assert.ok(basins[i - 1]!.ch4T >= basins[i]!.ch4T);
  for (const b of basins) {
    const box = basinBox(b);
    assert.ok(box[2] - box[0] <= METHANE_MAX_SIDE + 0.02 && box[3] - box[1] <= METHANE_MAX_SIDE + 0.02, JSON.stringify(box));
    assert.ok(!/refinery|exxon|marathon|chevron|shell/i.test(b.name), b.name);
  }
  assert.equal(basinName("Iraq_Widyan - North Arabian Gulf_Conventional onshore"), "Widyan - North Arabian Gulf");
  assert.equal(basinName("Permian Spraberry Lower Lower Spraberry Lower Light Oil TX"), "Permian Spraberry Lower (TX)");
  assert.equal(basinName("Haynesville-Bossier-Bossier Haynesville-Bossier Wet Gas TX"), "Haynesville-Bossier (TX)");
  assert.equal(basinName("Anadarko - Hugoton Wet Gas OK"), "Anadarko - Hugoton (OK)");
  assert.equal(basinName("Appalachian Other Dry Gas NY"), "Appalachian (NY)");
});

test("controls: IFL picks interleave continents; narrow interiors and hotspot overlaps are skipped", () => {
  const picks = pickIfl(FX.ifl, 6);
  assert.deepEqual(picks.map((p) => p.region), ["SAM", "AFR", "SEA", "SAM", "AFR", "SEA"]);
  const raw = { list: FX.ifl, cores: FX.iflCores, picks };
  const free = buildControls(raw, 20, "2026-09-26");
  assert.equal(free.watchlist.aois.length, 20);
  const first = free.watchlist.aois[0]!;
  const blocked = buildControls(raw, 20, "2026-09-26", [first.bbox as BBox]);
  assert.ok(!blocked.watchlist.aois.some((a) => a.id === first.id));
  assert.ok(blocked.skipped.some((s) => /overlaps a forest-hotspot tile/.test(s)));
  for (const a of free.watchlist.aois) {
    assert.equal(a.control, true);
    assert.ok(a.bbox[2] - a.bbox[0] <= 0.5 + 1e-9 && a.bbox[2] - a.bbox[0] >= 0.2 - 1e-9);
    assert.deepEqual(a.rules[0], { name: "forest_loss", params: { days: 90, minConfidence: "high", minAlerts: 300, minHa: 25 } });
  }
});

// ---------------------------------------------------------------- the whole run, offline

/** Replay the recorded responses by URL + SQL shape (GADM/IFL rows filtered by the ids asked for). */
function replay() {
  return mockFetch((url) => {
    const u = new URL(url);
    if (u.hostname === "eogdata.mines.edu") return textResponse(VNF_KML);
    if (u.hostname === "api.climatetrace.org") return jsonResponse(FX.climatetrace[u.searchParams.get("subsectors")!] ?? []);
    const m = /^\/dataset\/([^/]+)(?:\/([^/]+)\/query\/json)?$/.exec(u.pathname);
    if (!m) return textResponse("unexpected", { status: 404 });
    const [, ds, version] = m;
    if (!version) return jsonResponse(FX.versions[ds!] ?? { data: { versions: ["v2021"] } });
    const sql = u.searchParams.get("sql") ?? "";
    const data = (rows: unknown[]) => jsonResponse({ data: rows, status: "success" });
    if (ds === "gadm__integrated_alerts__adm2_daily_alerts") {
      if (sql.includes("MAX(")) return jsonResponse(FX.forestMaxDate);
      if (sql.includes("ORDER BY")) return data(FX.forestTop.slice(0, Number(/LIMIT (\d+)/.exec(sql)![1])));
      return data(FX.forestProtected);
    }
    if (ds === "gadm_administrative_boundaries") return data(FX.gadm.filter((r: { gid_2: string }) => sql.includes(`'${r.gid_2}'`)));
    if (ds === "wdpa_protected_areas") return data(FX.wdpa);
    if (ds === "wdpa_protected_areas__integrated_alerts__daily_alerts") return data(FX.wdpaForest);
    if (ds === "ifl_intact_forest_landscapes") {
      return sql.includes("MaximumInscribedCircle") ? data(FX.iflCores.filter((r: { ifl_id: string }) => sql.includes(`'${r.ifl_id}'`))) : data(FX.ifl);
    }
    return textResponse("unexpected dataset", { status: 404 });
  });
}

const readLists = (dir: string) =>
  Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));

test("discover end to end (replayed): 19 requests, every list valid, deterministic, ids stable under --max-per-list, no CDSE", async (t) => {
  const fm = replay();
  t.after(fm.restore);
  const a = tmp();
  const s = await discover({ out: a, today: "2026-09-26", gfwKey: "KEY" });
  assert.equal(s.requests.total, 19, JSON.stringify(s.requests));
  assert.deepEqual(s.requests.bySource, { gfw: 15, "eog-vnf": 1, climatetrace: 3 });
  assert.equal(fm.calls.length, 19);
  assert.ok(fm.calls.every((c) => !/copernicus|dataspace/.test(c.url)), "never calls CDSE");
  assert.ok(fm.calls.filter((c) => c.url.includes("globalforestwatch")).every((c) => c.headers["x-api-key"] === "KEY" && c.headers.origin === "localhost"));
  for (const l of Object.values(s.lists)) assert.equal(l.error, undefined, l.error);
  assert.equal(s.lists["forest-hotspots"]!.entities, 150);
  assert.equal(s.lists["forest-hotspots"]!.versions.window, "2026-08-26..2026-09-24");
  assert.equal(s.lists["controls-generated"]!.aois, 20);

  // The same parser `earthdeck watch` uses; `_summary.json` is skipped as metadata.
  const lists = loadWatchlists(a);
  assert.equal(lists.length, 5);
  const aois = lists.flatMap((l) => l.aois);
  assert.equal(new Set(aois.map((x) => x.id)).size, aois.length, "ids unique across lists");
  assert.equal(aois.length, s.totals.aois);
  for (const x of aois) for (const r of x.rules) assert.ok(RULES.has(r.name));
  const summary = JSON.parse(readFileSync(join(a, "_summary.json"), "utf8"));
  assert.equal(summary.requests.total, 19);

  // Determinism: a second run over the same data writes byte-identical lists.
  const b = tmp();
  await discover({ out: b, today: "2026-09-26", gfwKey: "KEY" });
  assert.deepEqual(readLists(b), readLists(a));

  // Stability: a smaller run keeps the same ids for what it keeps (ids come from dataset ids, not positions).
  const c = tmp();
  const sc = await discover({ out: c, today: "2026-09-26", gfwKey: "KEY", maxPerList: 5 });
  assert.equal(sc.lists["forest-hotspots"]!.entities, 5);
  assert.equal(sc.lists["controls-generated"]!.aois, 5);
  const full = new Set(aois.map((x) => x.id));
  for (const x of loadWatchlists(c).flatMap((l) => l.aois)) {
    if (x.control) continue; // controls avoid the hotspot tiles of *their own* run
    assert.ok(full.has(x.id), `${x.id} not in the full run`);
  }
});

test("discover: the request budget is enforced; a failing list is reported, the others still written", async (t) => {
  const fm = replay();
  t.after(fm.restore);
  const dir = tmp();
  const s = await discover({ out: dir, today: "2026-09-26", gfwKey: "KEY", budget: 13 });
  assert.equal(s.requests.total, 13);
  assert.ok(s.lists["forest-hotspots"]!.error === undefined);
  assert.match(s.lists["protected-fires"]!.error ?? "", /budget of 13 exhausted/);
  assert.equal(loadWatchlists(dir).length, 3); // forest, flaring, methane
  const noKey = await discover({ out: tmp(), today: "2026-09-26", gfwKey: null, only: ["forest-hotspots"] });
  assert.match(noKey.lists["forest-hotspots"]!.error ?? "", /GFW_API_KEY/);
});

// ---------------------------------------------------------------- committed output + doctor

test("committed watchlists/generated: valid, unique ids across all lists, per-rule caps respected", () => {
  const gen = loadWatchlists("watchlists/generated");
  assert.equal(gen.length, 5);
  const all = [...loadWatchlists("watchlists"), ...gen].flatMap((l) => l.aois);
  assert.equal(new Set(all.map((a) => a.id)).size, all.length, "no id collides with the hand-written lists");
  for (const a of gen.flatMap((l) => l.aois)) {
    for (const r of a.rules) {
      assert.ok(RULES.has(r.name), `${a.id}: ${r.name}`);
      if (r.name === "forest_loss") assert.ok(bboxArea(a.bbox as BBox) <= 4 + 1e-6, `${a.id} too big for forest_alerts`);
      if (r.name === "flaring") assert.ok(bboxArea(a.bbox as BBox) <= 25, `${a.id} too big for flaring`);
    }
    assert.ok(a.tags.includes("discovered") || a.tags.includes("control"));
  }
  const summary = JSON.parse(readFileSync("watchlists/generated/_summary.json", "utf8"));
  assert.ok(summary.requests.total < 200);
  assert.equal(summary.totals.aois, gen.flatMap((l) => l.aois).length);
});

test("doctor: a line for the generated watchlists — fresh, stale, or invalid", () => {
  const root = tmp();
  const gen = join(root, "wl", "generated");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "a.json"), JSON.stringify({ version: 1, name: "g", aois: [{ id: "g-1", name: "G", bbox: [0, 0, 1, 1], rules: [{ name: "flaring" }] }] }));
  writeFileSync(join(gen, "_summary.json"), JSON.stringify({ generatedAt: "2026-09-26T10:00:00.000Z" }));
  const at = (iso: string) => watchChecks({ ledgerDir: join(root, "ledger"), watchlistsPath: join(root, "wl"), env: {}, now: Date.parse(iso) });
  const fresh = at("2026-09-27T10:00:00Z");
  assert.ok(fresh.lines.some((l) => /^    ✓ Generated watchlists\s+1 list\(s\), 1 AOIs \(0 control\) in .*generated 2026-09-26 \(24\.0 h ago\)$/.test(l)), fresh.lines.join("\n"));
  assert.ok(at("2026-10-26T10:00:00Z").lines.some((l) => /^    · Generated watchlists\s+.* — stale, re-run `earthdeck discover`$/.test(l)));
  writeFileSync(join(gen, "bad.json"), JSON.stringify({ version: 1, name: "x", aois: [] }));
  const bad = at("2026-09-27T10:00:00Z");
  assert.equal(bad.failed, true);
  assert.ok(bad.lines.some((l) => /^    ✗ Generated watchlists\s+invalid: /.test(l)));
  assert.ok(watchChecks({ ledgerDir: join(root, "ledger"), watchlistsPath: join(root, "none"), env: {} }).lines.some((l) => /^    · Generated watchlists\s+none at/.test(l)));
});
