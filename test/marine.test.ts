// marine: Global Fishing Watch 4Wings client + fishing_activity (fetch-mocked against reports
// recorded live over the Galápagos on 2026-09-27), mpa_fishing@1.0 detect/confirm through the
// kernel, the aisstream sampler/aggregator (one live 20 s Gibraltar sample, identities
// pseudonymised), the marine export files, the quota provider, and the privacy guarantee that
// no vessel identity survives into any tool or export output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AisAggregator, AIS_REGIONS, sampleAis, shipClass, subscription } from "../src/clients/ais.js";
import { effortGrid, parseReport, reportBody, reportUrl, summarize } from "../src/clients/gfwfishing.js";
import { Ledger } from "../src/ledger/store.js";
import { fishingActivity } from "../src/tools/marine.js";
import { exportSite } from "../src/watch/export.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { buildFishingGeoJson, fishingAreas, marineSnapshots, shipsGeoJson } from "../src/watch/marine-export.js";
import { capsFromEnv, costOf, providersForRequires } from "../src/watch/quota.js";
import { insetBBox } from "../src/watch/rules/mpaFishing.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { loadWatchlists, parseWatchlist } from "../src/watch/watchlist.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as Record<string, unknown>;
const BOX = fixture("gfw-fishing-galapagos-bbox-2026-09-27.json");
const GEAR = fixture("gfw-fishing-galapagos-gear-2026-09-27.json");
const MPA = fixture("gfw-fishing-galapagos-mpa-2026-09-27.json");
const AIS = fixture("aisstream-gibraltar-2026-09-27.json") as { messages: unknown[] };
const GALAPAGOS: BBox = [-92.68, -2.09, -88.57, 2.36];
const ENV = { GFW_FISHING_TOKEN: "test-token" } as NodeJS.ProcessEnv;

/** Anything that could identify a vessel, in any casing. */
const IDENTITY = /mmsi|shipname|ship_name|callsign|call_sign|imo|vesselid|vessel_id|TEST VESSEL|99000\d{4}/i;

// ---- client -------------------------------------------------------------------------------

test("reportUrl/reportBody: v3 4Wings shape; group-by is mandatory (ungrouped = per-vessel rows)", () => {
  const u = reportUrl({ from: "2026-08-28", to: "2026-09-27", spatial: "HIGH", temporal: "DAILY", groupBy: "FLAG" });
  assert.equal(
    u,
    "https://gateway.api.globalfishingwatch.org/v3/4wings/report?spatial-resolution=HIGH&temporal-resolution=DAILY&group-by=FLAG&datasets[0]=public-global-fishing-effort:latest&date-range=2026-08-28,2026-09-27&format=JSON",
  );
  assert.throws(() => reportUrl({ from: "a", to: "b", spatial: "LOW", temporal: "ENTIRE", groupBy: undefined as never }), /group-by/);
  assert.deepEqual(JSON.parse(reportBody({ mpaId: "11753" })), { region: { dataset: "public-mpa-all", id: "11753" } });
  assert.deepEqual(JSON.parse(reportBody({ bbox: [1, 2, 3, 4] })).geojson.coordinates[0][2], [3, 4]);
});

test("parseReport + summarize: live Galápagos box — totals, flags, zero-filled daily series, clip", () => {
  const { dataset, rows } = parseReport(BOX);
  assert.equal(dataset, "public-global-fishing-effort:v4.0");
  assert.equal(rows.length, 333);
  const s = summarize({ area: { bbox: GALAPAGOS }, from: "2026-08-28", to: "2026-09-27", resolution: "HIGH", clip: insetBBox(GALAPAGOS, 0.15), maxCells: 3 }, dataset, rows, null);
  assert.equal(s.totalHours, 519.7);
  assert.deepEqual(s.byFlag, [{ flag: "ECU", hours: 513.4 }, { flag: "USA", hours: 6.3 }]);
  assert.equal(s.lastDataDate, "2026-09-23", "~4-day lag");
  assert.equal(s.daily.length, 27);
  assert.equal(s.daily[0]!.date, "2026-08-28");
  assert.equal(s.cellDeg, 0.01);
  assert.equal(s.grid.length, 3);
  assert.ok(s.clip && s.clip.hours > 0 && s.clip.hours < s.totalHours);
  assert.equal(s.byGear, null);
});

test("fishing_activity: two sequential reports (flag+daily HIGH, gear LOW), bearer auth, attribution in provenance", async (t) => {
  const fm = mockFetch((url) => jsonResponse(url.includes("group-by=GEARTYPE") ? GEAR : BOX));
  t.after(fm.restore);
  const r = await fishingActivity({ bbox: GALAPAGOS, from: "2026-08-28", to: "2026-09-27", resolution: "HIGH" }, ENV);
  assert.equal(fm.calls.length, 2);
  assert.ok(fm.calls.every((c) => c.method === "POST" && c.headers.authorization === "Bearer test-token"));
  assert.match(fm.calls[0]!.url, /spatial-resolution=HIGH&temporal-resolution=DAILY&group-by=FLAG/);
  assert.match(fm.calls[1]!.url, /spatial-resolution=LOW&temporal-resolution=ENTIRE&group-by=GEARTYPE/);
  assert.equal(r.totalHours, 519.7);
  assert.deepEqual(r.byGear!.slice(0, 2), [{ gear: "fishing", hours: 359 }, { gear: "drifting_longlines", hours: 122.5 }]);
  assert.equal(r.provenance.attribution, "Global Fishing Watch, 2026. www.globalfishingwatch.org");
  assert.match(r.summary, /519\.7 hours of apparent fishing/);

  await assert.rejects(fishingActivity({ bbox: GALAPAGOS }, {} as NodeJS.ProcessEnv), /GFW_FISHING_TOKEN/);
  await assert.rejects(fishingActivity({ bbox: GALAPAGOS, mpaId: "11753" }, ENV), /exactly one/);
});

test("fishing_activity by MPA: region body, clip to the AOI box, 422 surfaces GFW's message", async (t) => {
  let status = 200;
  const fm = mockFetch(() => (status === 200 ? jsonResponse(MPA) : jsonResponse({ statusCode: 422, messages: [{ title: "region", detail: "Region not found" }] }, { status })));
  t.after(fm.restore);
  const r = await fishingActivity({ mpaId: "11753", from: "2026-08-28", to: "2026-09-27", resolution: "HIGH", byGear: false, clipBBox: GALAPAGOS }, ENV);
  assert.equal(fm.calls.length, 1);
  assert.deepEqual(JSON.parse(fm.calls[0]!.body!), { region: { dataset: "public-mpa-all", id: "11753" } });
  assert.equal(r.totalHours, 186.8);
  assert.equal(r.clip!.hours, 186.8);
  assert.deepEqual(r.area, { kind: "mpa", regionDataset: "public-mpa-all", id: "11753" });
  status = 422;
  await assert.rejects(fishingActivity({ mpaId: "999", byGear: false }, ENV), /Region not found/);
});

// ---- privacy ------------------------------------------------------------------------------

test("privacy: vessel identities never survive — GFW rows, tool output, AIS aggregates, export files", async (t) => {
  // A report reply with per-vessel columns (what GFW returns when group-by is omitted).
  const leaky = {
    entries: [{ "public-global-fishing-effort:v4.0": [{ date: "2026-09-01", flag: "XXX", hours: 3, lat: 1, lon: 2, vesselIDs: 1, callsign: "HC0000", shipName: "TEST VESSEL 9", mmsi: "990009999", vesselId: "abc", imo: "1" }] }],
  };
  const parsed = parseReport(leaky);
  assert.doesNotMatch(JSON.stringify(parsed), IDENTITY);
  assert.deepEqual(Object.keys(parsed.rows[0]!).sort(), ["date", "flag", "hours", "lat", "lon"]);

  const fm = mockFetch(() => jsonResponse(leaky));
  t.after(fm.restore);
  const tool = await fishingActivity({ bbox: GALAPAGOS, maxCells: 50 }, ENV);
  assert.doesNotMatch(JSON.stringify({ ...tool, provenance: { ...tool.provenance, privacy: "" } }), IDENTITY);
  const grid = await effortGrid("t", { bbox: GALAPAGOS }, "2026-09-01", "2026-09-27");
  assert.doesNotMatch(JSON.stringify(grid), IDENTITY);

  // The AIS fixture carries (pseudonymised) MMSI + names; the aggregate must not.
  const agg = new AisAggregator();
  for (const m of AIS.messages) agg.add(m);
  const density = agg.result({ regions: AIS_REGIONS, sampleSeconds: 20 });
  assert.match(JSON.stringify(AIS), /TEST VESSEL/, "fixture really has names to drop");
  assert.doesNotMatch(JSON.stringify({ ...density, privacy: "" }), IDENTITY);
  assert.doesNotMatch(shipsGeoJson({ ...density, privacy: "" }), IDENTITY);
  assert.doesNotMatch((await buildFishingGeoJson("t", [{ mpaId: "11753", name: "Galápagos", bbox: GALAPAGOS }], new Date("2026-09-27T12:00:00Z"))) ?? "", IDENTITY);
});

// ---- AIS ----------------------------------------------------------------------------------

test("AIS: live Gibraltar sample → density grid + counts by type; subscription uses [lat, lon] corners", () => {
  const agg = new AisAggregator();
  for (const m of AIS.messages) agg.add(m);
  const d = agg.result({ regions: AIS_REGIONS, sampleSeconds: 20, now: new Date("2026-09-27T08:43:00Z") });
  assert.equal(d.messages, 18, "confirmation frame not counted");
  assert.equal(d.vessels, 18);
  assert.equal(d.byType.tanker, 1);
  assert.equal(d.byType.cargo, 1);
  assert.equal(d.byType.unknown, 16, "static data is rare in a 20 s sample");
  assert.equal(d.regions.find((r) => r.id === "gibraltar")!.vessels, 18);
  assert.equal(d.cells.reduce((a, c) => a + c.count, 0), 18);
  assert.ok(d.cells.every((c) => Math.abs(((c.lon - 0.05) / 0.1) - Math.round((c.lon - 0.05) / 0.1)) < 1e-6), "cell centres on the 0.1° grid");
  const sub = JSON.parse(subscription("k", [{ id: "g", name: "G", bbox: [-6.6, 35.6, -4.8, 36.4] }]));
  assert.deepEqual(sub.BoundingBoxes, [[[35.6, -6.6], [36.4, -4.8]]]);
  assert.equal(shipClass(30), "fishing");
  assert.equal(shipClass(84), "tanker");
  assert.equal(shipClass(undefined), "unknown");
});

test("sampleAis: replays frames through a fake socket, closes on time, reports a bad key", async () => {
  const frames = AIS.messages.map((m) => new TextEncoder().encode(JSON.stringify(m)));
  let sent = "";
  class FakeWs {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      setTimeout(() => {
        this.onopen?.();
        for (const f of frames) this.onmessage?.({ data: f });
      }, 5);
    }
    send(d: string) {
      sent = d;
    }
    close() {
      this.onclose?.();
    }
  }
  const d = await sampleAis("secret", { seconds: 1, WebSocketImpl: FakeWs });
  assert.equal(d.vessels, 18);
  assert.equal(JSON.parse(sent).APIKey, "secret");
  assert.doesNotMatch(JSON.stringify(d), /secret/);

  class BadKey extends FakeWs {
    constructor(url: string) {
      super(url);
      frames.length = 0;
      setTimeout(() => this.onmessage?.({ data: '{"error":"Api Key Is Not Valid"}' }), 10);
    }
  }
  await assert.rejects(sampleAis("bad", { seconds: 1, WebSocketImpl: BadKey }), /Api Key Is Not Valid/);
});

// ---- rule ---------------------------------------------------------------------------------

function fakeCall(script: Record<string, (args: Record<string, unknown>) => unknown>): { call: ToolCall; calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const fn = script[tool];
    if (!fn) throw new ToolError(tool, "not scripted");
    return JSON.parse(JSON.stringify(await fn(args)));
  };
  return { call, calls };
}

function fishing(total: number, opts: { clip?: number; last?: string; flags?: [string, number][] } = {}) {
  return {
    dataset: "public-global-fishing-effort:v4.0",
    totalHours: total,
    activeDays: total > 0 ? 20 : 0,
    lastDataDate: opts.last ?? "2026-09-23",
    byFlag: (opts.flags ?? [["ECU", total]]).map(([flag, hours]) => ({ flag, hours })),
    clip: opts.clip === undefined ? null : { hours: opts.clip, share: null },
    provenance: { attribution: "Global Fishing Watch, 2026. www.globalfishingwatch.org" },
  };
}

const NOW = "2026-09-27T06:00:00Z";
const galAoi = { id: "mpa-galapagos", name: "Galápagos Marine Reserve", bbox: GALAPAGOS, tags: [], control: false, cooldownDays: 30, rules: [{ name: "mpa_fishing", params: { mpaId: "11753", mpaName: "Galápagos Marine Reserve" } }] };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-marine-"));
  return { ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")) };
}

test("mpa_fishing detect: counts only effort inside the WDPA polygon ∩ tile; plain title; quiet below minHours", async () => {
  const rule = RULES.get("mpa_fishing")!;
  assert.equal(rule.tier, 2);
  assert.ok(rule.blindSpots.some((b) => /dark/i.test(b)) && rule.blindSpots.some((b) => /transit/i.test(b)));
  // 519.7 h in the reserve, but only 49.9 h inside this tile → quiet.
  const quiet = fakeCall({ fishing_activity: () => fishing(519.7, { clip: 49.9 }) });
  assert.equal(await rule.detect({ aoi: galAoi, params: galAoi.rules[0]!.params, now: NOW, since: null, call: quiet.call }), null);

  const { call, calls } = fakeCall({ fishing_activity: () => fishing(186.8, { clip: 186.8, flags: [["ECU", 180.4], ["USA", 6.4]] }) });
  const c = (await rule.detect({ aoi: galAoi, params: galAoi.rules[0]!.params, now: NOW, since: null, call }))!;
  assert.equal(c.title, "Fishing activity inside Galápagos Marine Reserve: 187 hours in 30 days");
  assert.equal(c.observedAt, "2026-09-23T00:00:00Z");
  assert.deepEqual(calls[0]!.args, { mpaId: "11753", from: "2026-08-28", to: "2026-09-27", resolution: "HIGH", byGear: false, clipBBox: GALAPAGOS });
  assert.equal(c.values.hours, 186.8);
  assert.equal(c.values.flagStates, 2);
  assert.equal(c.geometry!.type, "Polygon");
  assert.match(c.evidence[0]!.summary!, /inside the legal boundary of MPA 11753.*ECU 180 h, USA 6 h.*Global Fishing Watch, 2026/);
  assert.doesNotMatch(JSON.stringify(c), IDENTITY);

  // No WDPA id → the box total is the measure.
  const noId = { ...galAoi, rules: [{ name: "mpa_fishing", params: {} }] };
  const box = fakeCall({ fishing_activity: () => fishing(519.7) });
  const c2 = (await rule.detect({ aoi: noId, params: {}, now: NOW, since: null, call: box.call }))!;
  assert.equal(c2.values.hours, 519.7);
  assert.deepEqual(box.calls[0]!.args, { bbox: GALAPAGOS, from: "2026-08-28", to: "2026-09-27", resolution: "HIGH", byGear: false });
});

test("mpa_fishing through the kernel: confirmed when the effort lies well inside, not on the edge (method)", async () => {
  const s = setup();
  const inset = insetBBox(GALAPAGOS, 0.15);
  const { call, calls } = fakeCall({ fishing_activity: (a) => fishing(186.8, { clip: JSON.stringify(a.clipBBox) === JSON.stringify(inset) ? 150.2 : 186.8 }) });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [galAoi] });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  const f = s.ledger.list()[0]!;
  assert.equal(f.status, "confirmed");
  assert.deepEqual(calls.filter((c) => c.tool === "fishing_activity")[1]!.args, { mpaId: "11753", from: "2026-08-28", to: "2026-09-27", resolution: "HIGH", byGear: false, clipBBox: inset });
  assert.match(JSON.stringify(f), /150\.2 h \(80% of the 186\.8 h\) lie in 0\.01° cells well inside the area/);
});

test("mpa_fishing confirm: edge-only effort stays a candidate; persistence a week later confirms (revisit)", async () => {
  const rule = RULES.get("mpa_fishing")!;
  const params = galAoi.rules[0]!.params;
  const det = fakeCall({ fishing_activity: () => fishing(120, { clip: 120 }) });
  const cand = (await rule.detect({ aoi: galAoi, params, now: NOW, since: null, call: det.call }))!;

  const edge = fakeCall({ fishing_activity: () => fishing(120, { clip: 24.9 }) });
  assert.equal(await rule.confirm({ aoi: galAoi, params, now: NOW, since: null, call: edge.call }, cand), null, "below half the bar in the inset box");
  assert.equal(edge.calls.length, 1, "too soon for a revisit");

  const later = "2026-10-04T06:00:00Z";
  const cont = fakeCall({ fishing_activity: (a) => (a.from === "2026-08-28" ? fishing(120, { clip: 10 }) : fishing(30, { clip: 25, last: "2026-09-30" })) });
  const conf = (await rule.confirm({ aoi: galAoi, params, now: later, since: null, call: cont.call }, cand))!;
  assert.equal(conf.independence, "revisit");
  assert.deepEqual(cont.calls[1]!.args, { mpaId: "11753", from: "2026-09-24", to: "2026-10-04", resolution: "HIGH", byGear: false, clipBBox: GALAPAGOS });
  assert.equal(conf.signal.values!.hours, 25, "polygon ∩ tile hours in the new window");

  const stopped = fakeCall({ fishing_activity: (a) => (a.from === "2026-08-28" ? fishing(120, { clip: 10 }) : fishing(3, { clip: 3, last: "2026-09-30" })) });
  assert.equal(await rule.confirm({ aoi: galAoi, params, now: later, since: null, call: stopped.call }, cand), null, "3 h < pro-rated bar");
});

// ---- quota --------------------------------------------------------------------------------

test("quota: gfw_fishing provider — cost, requires mapping, env caps incl. per-rule", () => {
  assert.deepEqual(costOf("fishing_activity", {}), { provider: "gfw_fishing", units: 2 });
  assert.deepEqual(costOf("fishing_activity", { byGear: false }), { provider: "gfw_fishing", units: 1 });
  assert.deepEqual(providersForRequires(RULES.get("mpa_fishing")!.requires), ["gfw_fishing"]);
  assert.equal(capsFromEnv({}).gfw_fishing, 200);
  const caps = capsFromEnv({ EARTHDECK_MAX_GFW_FISHING_CALLS: "5", EARTHDECK_MAX_GFW_FISHING_CALLS_MPA_FISHING: "3", EARTHDECK_MAX_GFW_CALLS: "7" });
  assert.equal(caps.gfw_fishing, 5);
  assert.equal(caps.gfw, 7);
  assert.deepEqual(caps.perRule!.MPA_FISHING, { gfw_fishing: 3 });
});

// ---- watchlist ----------------------------------------------------------------------------

test("watchlists/marine.json: 12–20 strict MPAs, tiles ≤ 25 deg², every AOI on mpa_fishing with a WDPA id", () => {
  const [wl] = loadWatchlists(new URL("../watchlists/marine.json", import.meta.url).pathname);
  const ids = new Set<string>();
  for (const a of wl!.aois) {
    assert.equal(a.rules.length, 1);
    assert.equal(a.rules[0]!.name, "mpa_fishing");
    assert.ok(RULES.has(a.rules[0]!.name));
    const p = a.rules[0]!.params as { mpaId: string; mpaName: string };
    assert.match(p.mpaId, /^\d+(_\d+)?$/);
    assert.ok(p.mpaName);
    ids.add(p.mpaId);
    assert.ok((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) <= 25.0001, `${a.id} tile too big`);
  }
  assert.ok(ids.size >= 12 && ids.size <= 20, `${ids.size} MPAs`);
  for (const id of ["220201", "309888", "11753", "555629385", "555624172", "555651558", "303552", "313615"]) assert.ok(ids.has(id), id);
  // One export query per reserve and side of the antimeridian (Papahānaumokuākea straddles it).
  const areas = fishingAreas(new URL("../watchlists/marine.json", import.meta.url).pathname);
  assert.equal(areas.filter((a) => a.mpaId === "220201").length, 2);
  assert.equal(areas.length, ids.size + 1);
});

// ---- export -------------------------------------------------------------------------------

test("marine export: built only with keys, cached, copied into api/marine/ by exportSite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-marine-export-"));
  const wlPath = new URL("../watchlists/marine.json", import.meta.url).pathname;
  let gridCalls = 0;
  const grid = (async () => {
    gridCalls++;
    return { dataset: "public-global-fishing-effort:v4.0", cells: [{ lon: -90.35, lat: -0.35, hours: 12.5 }] };
  }) as unknown as typeof effortGrid;
  const agg = new AisAggregator();
  for (const m of AIS.messages) agg.add(m);
  const sample = (async () => agg.result({ regions: AIS_REGIONS, sampleSeconds: 20 })) as unknown as typeof sampleAis;
  const now = new Date("2026-09-27T12:00:00Z");

  assert.deepEqual(await marineSnapshots({ mode: "auto", cacheDir: join(dir, "c0"), watchlist: wlPath, env: {}, now, grid, sample }), {});
  assert.equal(gridCalls, 0, "no keys → nothing produced");

  const cacheDir = join(dir, "cache");
  const env = { GFW_FISHING_TOKEN: "t", AISSTREAM_KEY: "k" } as NodeJS.ProcessEnv;
  const m = await marineSnapshots({ mode: "auto", cacheDir, watchlist: wlPath, env, now, grid, sample });
  const fish = JSON.parse(m.fishing!);
  assert.equal(fish.type, "FeatureCollection");
  assert.equal(fish.meta.attribution, "Global Fishing Watch, 2026. www.globalfishingwatch.org");
  assert.equal(fish.meta.areas.length, 16);
  const ships = JSON.parse(m.ships!);
  assert.equal(ships.meta.vessels, 18);
  assert.equal(ships.features.reduce((a: number, f: { properties: { count: number } }) => a + f.properties.count, 0), 18);
  const calls = gridCalls;
  await marineSnapshots({ mode: "auto", cacheDir, watchlist: wlPath, env, now, grid, sample });
  assert.equal(gridCalls, calls, "fresh cache → no new GFW calls");

  // exportSite: default off → no marine files; "cache" → copied from the cache dir.
  const ledgerDir = join(dir, "ledger");
  mkdirSync(ledgerDir, { recursive: true });
  const out1 = join(dir, "site1");
  const r1 = await exportSite({ out: out1, ledgerDir, siteDir: null, pulse: "off" });
  assert.deepEqual(r1.marine, { fishing: false, ships: false });
  assert.equal(existsSync(join(out1, "api", "marine")), false);
  const out2 = join(dir, "site2");
  const r2 = await exportSite({ out: out2, ledgerDir, siteDir: null, pulse: "off", marine: "cache", marineCacheDir: cacheDir });
  assert.deepEqual(r2.marine, { fishing: true, ships: true });
  assert.doesNotMatch(readFileSync(join(out2, "api/marine/ships.json"), "utf8").replace(/"privacy":"[^"]*"/, ""), IDENTITY);
  writeFileSync(join(cacheDir, "ships.json"), "not json");
  const r3 = await exportSite({ out: join(dir, "site3"), ledgerDir, siteDir: null, pulse: "off", marine: "cache", marineCacheDir: cacheDir });
  assert.deepEqual(r3.marine, { fishing: true, ships: false }, "a broken cache is omitted, not published");
});
