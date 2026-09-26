// Methane wedge, offline: the S5P Statistics request/parse (recorded live over the Permian
// on 2026-09-26), the anomaly math, the EMIT plume parser (recorded live from the JPL feed),
// the methane_plumes tool end to end through the MCP server, and the methane_anomaly rule's
// detect/confirm + a kernel sweep with a scripted tool caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CopernicusClient } from "../src/clients/copernicus.js";
import {
  _resetEmitCache,
  ch4Anomaly,
  emitPlumes,
  parseEmitPlumes,
  plumesIn,
  S5P_CH4_SOURCE,
  s5pRasterSize,
  toCh4Buckets,
} from "../src/clients/methane.js";
import { S5P_CH4_EVALSCRIPT } from "../src/evalscripts.js";
import { buildServer } from "../src/index.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { loadWatchlists, parseWatchlist } from "../src/watch/watchlist.js";
import type { BBox } from "../src/types.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const PERMIAN: BBox = [-104.2, 31.4, -103.2, 32.4];
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const S5P_SERIES = fixture("s5p-ch4-permian-series.json");
const EMIT_FEED = fixture("emit-plumes-sample.json");
const isToken = (u: string) => u.includes("/openid-connect/token");

test("statisticsSeries: S5P request body and bucket parsing (recorded Permian response)", async (t) => {
  const fm = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "T", expires_in: 3600 }) : jsonResponse(S5P_SERIES)));
  t.after(fm.restore);
  const c = new CopernicusClient("id", "secret");
  const buckets = await c.statisticsSeries(PERMIAN, {
    dateFrom: "2026-06-21",
    dateTo: "2026-09-27",
    intervalDays: 14,
    evalscript: S5P_CH4_EVALSCRIPT,
    source: S5P_CH4_SOURCE,
    ...s5pRasterSize(PERMIAN),
  });
  const req = JSON.parse(fm.calls.find((x) => x.url.endsWith("/statistics"))!.body!);
  assert.equal(req.input.data[0].type, "sentinel-5p-l2");
  assert.equal(req.input.data[0].dataFilter.timeliness, "OFFL");
  assert.deepEqual(req.input.data[0].processing, { minQa: 50 });
  assert.deepEqual(req.input.data[0].dataFilter.timeRange, { from: "2026-06-21T00:00:00Z", to: "2026-09-27T00:00:00Z" });
  assert.equal(req.aggregation.aggregationInterval.of, "P14D");
  assert.match(req.aggregation.evalscript, /mosaicking:"ORBIT"/);
  assert.equal(buckets.length, 7);
  assert.equal(buckets[0]!.from, "2026-06-21T00:00:00Z");
  assert.ok(Math.abs(buckets[0]!.stats!.mean - 1917.44) < 0.01);
  assert.equal(buckets[6]!.stats!.validPct, 87);
});

test("statisticsSeries: an all-no-data bucket is null, not an error", async (t) => {
  const empty = { data: [{ interval: { from: "2026-09-13T00:00:00Z", to: "2026-09-27T00:00:00Z" }, outputs: { data: { bands: { B0: { stats: { min: "NaN", max: "NaN", mean: "NaN", stDev: "NaN", sampleCount: 340, noDataCount: 340 } } } } } }] };
  const fm = mockFetch((url) => (isToken(url) ? jsonResponse({ access_token: "T", expires_in: 3600 }) : jsonResponse(empty)));
  t.after(fm.restore);
  const b = await new CopernicusClient("id", "secret").statisticsSeries(PERMIAN, { dateFrom: "2026-09-13", dateTo: "2026-09-27", intervalDays: 14, evalscript: "x", source: S5P_CH4_SOURCE });
  assert.equal(b.length, 1);
  assert.equal(b[0]!.stats, null);
});

test("ch4Anomaly: recent vs baseline buckets from the recorded series", () => {
  const buckets = toCh4Buckets(
    (S5P_SERIES as { data: { interval: { from: string; to: string }; outputs: { data: { bands: { B0: { stats: { mean: number; sampleCount: number; noDataCount: number } } } } } }[] }).data.map((e) => {
      const st = e.outputs.data.bands.B0.stats;
      const validPct = Math.round((100 * (st.sampleCount - st.noDataCount)) / st.sampleCount);
      return { from: e.interval.from, to: e.interval.to, stats: { ...st, min: 0, max: 0, stDev: 0, validPct, p25: null, p50: null, p75: null, intervalFrom: e.interval.from, intervalTo: e.interval.to } };
    }),
  );
  assert.equal(buckets[0]!.from, "2026-06-21");
  const a = ch4Anomaly(buckets.at(-1)!, buckets.slice(0, -1))!;
  assert.equal(a.recentPpb, 1933.4);
  assert.equal(a.baselinePpb, 1927.2);
  assert.equal(a.deltaPpb, 6.2);
  assert.equal(a.bucketsUsed, 6);
  assert.equal(a.baselineSdPpb, 6.2);
  assert.equal(a.z, 0.99);
  assert.equal(a.validPct, 87);
});

test("ch4Anomaly: edge cases — empty recent, sparse baseline buckets, too few for z", () => {
  const b = (meanPpb: number | null, validPct: number) => ({ from: "x", to: "y", meanPpb, validPct });
  assert.equal(ch4Anomaly(b(null, 0), [b(1900, 100)]), null);
  assert.equal(ch4Anomaly(b(1950, 90), [b(1900, 10), b(null, 0)]), null, "all baseline buckets too sparse");
  const a = ch4Anomaly(b(1950, 90), [b(1900, 100), b(1910, 100), b(1000, 5)])!;
  assert.equal(a.baselinePpb, 1905, "sparse outlier bucket ignored");
  assert.equal(a.deltaPpb, 45);
  assert.equal(a.z, null, "< 3 buckets → no z");
  assert.equal(a.bucketsUsed, 2);
});

test("s5pRasterSize: ~5.5 km pixels, clamped", () => {
  assert.deepEqual(s5pRasterSize(PERMIAN), { width: 17, height: 20 });
  assert.deepEqual(s5pRasterSize([0, 0, 0.01, 0.01]), { width: 8, height: 8 });
  assert.deepEqual(s5pRasterSize([-20, -20, 20, 20]), { width: 128, height: 128 });
});

test("parseEmitPlumes + plumesIn: points only, NA → null, bbox/window filter, newest first", () => {
  const all = parseEmitPlumes(EMIT_FEED);
  assert.equal(all.length, 4, "polygon outlines skipped");
  const kz = all.find((p) => p.id === "CH4_PlumeComplex-495")!;
  assert.equal(kz.emissionRateKgHr, 3615.8424);
  assert.equal(kz.emissionRateUncertaintyKgHr, 194.9612);
  const na = all.find((p) => p.id === "CH4_PlumeComplex-3638")!;
  assert.equal(na.emissionRateKgHr, null);
  assert.equal(na.maxConcentrationPpmM, 2365);
  assert.match(na.licence, /Public domain/);
  const inPermian = plumesIn(all, PERMIAN, "2024-08-01", "2024-10-31");
  assert.deepEqual(inPermian.map((p) => p.id), ["CH4_PlumeComplex-3638", "CH4_PlumeComplex-3637", "CH4_PlumeComplex-3464"]);
  assert.equal(plumesIn(all, PERMIAN, "2024-09-01", "2024-10-03").length, 0);
  assert.throws(() => parseEmitPlumes({ nope: 1 }), /EMIT/);
});

test("emitPlumes: the ~7 MB feed is fetched once per process (cache)", async (t) => {
  _resetEmitCache();
  const fm = mockFetch(() => jsonResponse(EMIT_FEED));
  t.after(() => {
    fm.restore();
    _resetEmitCache();
  });
  await emitPlumes();
  await emitPlumes();
  assert.equal(fm.calls.length, 1);
});

test("methane_plumes tool: JSON result with anomaly, plumes, source status, provenance", async (t) => {
  process.env.CDSE_CLIENT_ID = "id";
  process.env.CDSE_CLIENT_SECRET = "secret";
  _resetEmitCache();
  const fm = mockFetch((url) => {
    if (isToken(url)) return jsonResponse({ access_token: "T", expires_in: 3600 });
    if (url.endsWith("/statistics")) return jsonResponse(S5P_SERIES);
    if (url.includes("emit-mmgis")) return jsonResponse(EMIT_FEED);
    return new Response("{}", { status: 200 }); // dashboard push
  });
  t.after(fm.restore);
  const server = buildServer();
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const res = await client.callTool({ name: "methane_plumes", arguments: { bbox: PERMIAN, date: "2026-09-26", plumeDays: 800 } });
  assert.ok(!res.isError);
  const out = JSON.parse((res.content as { text: string }[])[0]!.text);
  assert.deepEqual(out.ch4.window, { from: "2026-09-13", to: "2026-09-26" });
  assert.equal(out.ch4.anomaly.deltaPpb, 6.2);
  assert.equal(out.provenance.collection, "sentinel-5p-l2");
  assert.equal(out.provenance.cloudMask.validPct, 87);
  assert.equal(out.plumes.length, 3);
  assert.equal(out.plumeSources[0].feedLatest, "2024-10-04T16:52:27Z");
  assert.equal(out.plumeSources[1].status, "unavailable");
  assert.equal(out.plumeSources[2].status, "link-only");
  assert.ok(!fm.calls.some((c) => c.url.includes("carbonmapper")), "Carbon Mapper is never fetched");
  const req = JSON.parse(fm.calls.find((c) => c.url.endsWith("/statistics"))!.body!);
  assert.deepEqual(req.aggregation.timeRange, { from: "2026-06-21T00:00:00Z", to: "2026-09-27T00:00:00Z" });
});

// ---- methane_anomaly rule --------------------------------------------------------------

const NOW = "2026-09-26T12:00:00Z";
const aoi = parseWatchlist({
  version: 1,
  name: "t",
  aois: [{ id: "us-permian", name: "Permian", bbox: PERMIAN, rules: [{ name: "methane_anomaly", params: {} }] }],
}).aois[0]!;

const ch4 = (deltaPpb: number, validPct = 90) => ({
  ch4: {
    window: { from: "2026-09-13", to: "2026-09-26" },
    baselineWindow: { from: "2026-06-21", to: "2026-09-12" },
    anomaly: { recentPpb: 1920 + deltaPpb, baselinePpb: 1920, deltaPpb, baselineSdPpb: 6, z: Math.round((deltaPpb / 6) * 100) / 100, validPct, baselineValidPct: 95, bucketsUsed: 6 },
  },
});
const plume = (id: string, rate: number | null, datetime = "2026-09-20T17:00:00Z") => ({
  source: "EMIT", id, datetime, lat: 31.9, lon: -103.8, emissionRateKgHr: rate, emissionRateUncertaintyKgHr: rate ? 100 : null, maxConcentrationPpmM: 2000, href: "https://data.lpdaac.earthdatacloud.nasa.gov/x.tif", licence: "Public domain",
});

function fakeCall(fn: (tool: string, args: Record<string, unknown>) => unknown) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    return fn(tool, args);
  };
  return { call, calls };
}

test("methane_anomaly: detect opens above threshold with ring baseline; quiet/sparse AOIs stay quiet", async () => {
  const rule = RULES.get("methane_anomaly")!;
  assert.equal(rule.tier, 2);
  assert.ok(rule.blindSpots.length >= 4);
  const { call, calls } = fakeCall((_t, a) => ((a.bbox as number[])[0]! < -104.2 ? ch4(8) : ch4(31)));
  const c = (await rule.detect({ aoi, params: {}, now: NOW, since: null, call }))!;
  assert.ok(c);
  assert.equal(c.values.deltaPpb, 31);
  assert.equal(c.observedAt, "2026-09-26T00:00:00Z");
  assert.equal(c.evidence[0]!.source, "sentinel-5p-l2");
  assert.equal(c.evidence[0]!.kind, "raster");
  assert.deepEqual(c.baseline && { a: c.baseline.aoiValue, r: c.baseline.regionalValue, ratio: c.baseline.ratio }, { a: 31, r: 8, ratio: 3.88 });
  assert.match(c.summary, /no facility attribution/);
  assert.equal(calls[0]!.args.include, "ch4");
  assert.equal(calls[0]!.args.date, "2026-09-26");

  const quiet = fakeCall(() => ch4(12)).call;
  assert.equal(await rule.detect({ aoi, params: {}, now: NOW, since: null, call: quiet }), null);
  const sparse = fakeCall(() => ch4(50, 20)).call;
  assert.equal(await rule.detect({ aoi, params: {}, now: NOW, since: null, call: sparse }), null);
  const empty = fakeCall(() => ({ ch4: { window: { from: "a", to: "b" }, baselineWindow: { from: "a", to: "b" }, anomaly: null } })).call;
  assert.equal(await rule.detect({ aoi, params: {}, now: NOW, since: null, call: empty }), null);
  // Threshold is a watchlist param.
  const tuned = fakeCall(() => ch4(12)).call;
  assert.ok(await rule.detect({ aoi, params: { minAnomalyPpb: 10 }, now: NOW, since: null, call: tuned }));
});

test("methane_anomaly: confirm by an EMIT plume in the AOI (sensor independence); none → null", async () => {
  const rule = RULES.get("methane_anomaly")!;
  const cand = { observedAt: "2026-09-26T00:00:00Z", evidence: [], values: {}, geometry: undefined };
  const { call, calls } = fakeCall(() => ({ plumeWindow: { from: "2026-06-28", to: "2026-09-26" }, plumes: [plume("CH4_PlumeComplex-1", null, "2026-09-25T17:00:00Z"), plume("CH4_PlumeComplex-2", 1622.3)] }));
  const conf = (await rule.confirm({ aoi, params: {}, now: NOW, since: null, call }, cand))!;
  assert.equal(conf.independence, "sensor");
  assert.equal(conf.signal.source, "nasa-jpl-emit");
  assert.equal(conf.signal.id, "emit-CH4_PlumeComplex-2", "highest emission rate wins");
  assert.equal(conf.signal.values?.plumes, 2);
  assert.match(conf.signal.summary ?? "", /1622 ± 100 kg\/h/);
  assert.equal(calls[0]!.args.include, "plumes");
  const none = fakeCall(() => ({ plumeWindow: { from: "a", to: "b" }, plumes: [] })).call;
  assert.equal(await rule.confirm({ aoi, params: {}, now: NOW, since: null, call: none }, cand), null);
});

test("kernel: a methane anomaly opens a tier-2 candidate and confirms on a plume; watchlist seeds validate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-methane-"));
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const ledger = Ledger.open(dir);
  const journal = new Journal(join(dir, "watch"));
  const { call } = fakeCall((tool, a) => {
    if (tool === "methane_plumes") return a.include === "plumes" ? { plumeWindow: { from: "2026-06-28", to: "2026-09-26" }, plumes: [plume("CH4_PlumeComplex-9", 900)] } : ch4(27);
    if (tool === "enso") return { phase: "Neutral", latest: { oni: 0.1 } };
    if (tool === "events") return { events: [] };
    throw new ToolError(tool, "not scripted");
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [{ id: "us-permian", name: "Permian", bbox: PERMIAN, rules: [{ name: "methane_anomaly", params: {} }] }] });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger, journal, call, now: NOW, hasKey: () => true });
  assert.deepEqual(r.gaps, []);
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  const f = ledger.get(r.created[0]!)!;
  assert.equal(f.tier, 2);
  assert.equal(f.status, "confirmed");
  assert.equal(f.confirmed?.signal.source, "nasa-jpl-emit");
  assert.ok(f.blindSpots!.some((b) => /7×5\.5 km/.test(b)));
  assert.equal(ledger.verify().ok, true);

  const methane = loadWatchlists("watchlists/methane.json")[0]!;
  assert.equal(methane.aois.length, 3);
  assert.ok(methane.aois.every((x) => x.rules.every((rr) => rr.name === "methane_anomaly")));
});
