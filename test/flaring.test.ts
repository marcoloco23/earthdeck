// flaring: FIRMS night persistence math, the EOG VNF annual-summary parser, the report the
// tool returns (fetch-mocked against fixtures recorded live on 2026-09-26), and the
// flaring@1.0 watch rule end to end through the kernel with a scripted tool caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterFlares, flaringReport, nightKey, parseVnfKml, sitesIn, windowChunks, type SourcedDetection } from "../src/clients/vnf.js";
import { parseFiresCsv } from "../src/clients/nasa.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { parseWatchlist } from "../src/watch/watchlist.js";
import type { BBox } from "../src/types.js";
import { mockFetch, textResponse } from "./helpers.js";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
// Real FIRMS VIIRS_NOAA20_NRT, Rumaila [47.0,30.2,47.6,30.8], 2026-09-20 + 5 days (455 rows).
const RUMAILA_CSV = fixture("firms-rumaila-noaa20-2026-09-20.csv");
// Real EOG 2024 flare summary (NOAA-20): the 25 sites inside the Rumaila bbox + 2 others.
const VNF_KML = fixture("vnf-2024-flare-summary-sample.kml");
const RUMAILA: BBox = [47.0, 30.2, 47.6, 30.8];
const HEADER = RUMAILA_CSV.split("\n")[0]!;

const det = (lat: number, lon: number, frp: number, acqDate: string, acqTime = "2230", daynight = "N"): SourcedDetection => ({
  lat, lon, frp, acqDate, acqTime, daynight, brightness: 340, confidence: "nominal", satellite: "N20", source: "VIIRS_NOAA20_NRT",
});

test("windowChunks splits a window into FIRMS-sized (≤5 day) requests ending on the end date", () => {
  const c = windowChunks("2026-09-26", 30);
  assert.equal(c.length, 6);
  assert.deepEqual(c[0], { date: "2026-08-28", dayRange: 5 });
  assert.deepEqual(c[5], { date: "2026-09-22", dayRange: 5 });
  assert.deepEqual(windowChunks("2026-09-26", 7), [{ date: "2026-09-20", dayRange: 5 }, { date: "2026-09-25", dayRange: 2 }]);
});

test("nightKey: one local night counts once, even across UTC midnight and time zones", () => {
  // Rumaila, two passes on the same night (seen live: 2150 and 2329 UTC on 2026-09-24).
  assert.equal(nightKey({ acqDate: "2026-09-24", acqTime: "2150", lon: 47.3 }), "2026-09-24");
  assert.equal(nightKey({ acqDate: "2026-09-24", acqTime: "2329", lon: 47.3 }), "2026-09-24");
  // Niger Delta: passes straddling UTC midnight → same night.
  assert.equal(nightKey({ acqDate: "2026-09-24", acqTime: "2350", lon: 6.5 }), nightKey({ acqDate: "2026-09-25", acqTime: "40", lon: 6.5 }));
  // Bakken: 08:00 UTC is ~01:00 local — the night that began on the previous evening.
  assert.equal(nightKey({ acqDate: "2026-09-25", acqTime: "800", lon: -103.1 }), "2026-09-24");
  assert.equal(nightKey({ acqDate: "", acqTime: "800", lon: 0 }), null);
});

test("clusterFlares: persistence separates a flare from a (brighter) one-night fire", () => {
  const flare = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-08"].map((d, i) =>
    det(30.5 + (i % 2) * 0.003, 47.3 + (i % 3) * 0.003, 8 + i, d), // ≤ ~0.5 km jitter
  );
  const fire = Array.from({ length: 12 }, (_, i) => det(30.7 + i * 0.0005, 47.1, 60, "2026-09-04"));
  const noise = [
    det(30.5, 47.3, 90, "2026-09-07", "1030", "D"), // day pass: ignored
    det(30.5, 47.3, 1.2, "2026-09-09"), // below minFrp: ignored
    det(30.5, 47.34, 7, "2026-09-09"), // ~3.8 km east: its own cluster
  ];
  const r = clusterFlares([...flare, ...fire, ...noise], { minFrp: 3, clusterKm: 1 });
  assert.equal(r.nightDetections, 20);
  assert.equal(r.hotNightDetections, 19);
  assert.equal(r.clusters.length, 3);
  const [top, wild] = r.clusters;
  assert.equal(top!.nights, 6); // sorted by nights first
  assert.equal(top!.detections, 6);
  assert.equal(top!.maxFrp, 13);
  assert.equal(top!.meanFrp, 10.5);
  assert.equal(top!.firstNight, "2026-09-01");
  assert.equal(top!.lastNight, "2026-09-08");
  assert.equal(wild!.nights, 1); // 12 detections, 60 MW, but one night
  assert.equal(wild!.detections, 12);
  assert.equal(r.clusters.filter((c) => c.nights >= 5).length, 1);
});

test("clusterFlares on the real Rumaila pull: bookkeeping holds and the field is persistent", () => {
  const dets = parseFiresCsv(RUMAILA_CSV).map((f) => ({ ...f, source: "VIIRS_NOAA20_NRT" }));
  assert.equal(dets.length, 455);
  assert.equal(dets.filter((d) => d.daynight === "N").length, 326);
  const r = clusterFlares(dets, { minFrp: 3, clusterKm: 1 });
  assert.equal(r.nightDetections, 326);
  assert.equal(r.clusters.reduce((a, c) => a + c.detections, 0), r.hotNightDetections);
  assert.ok(r.clusters.every((c) => c.nights >= 1 && c.nights <= 5), "a 5-day pull has at most 5 nights");
  assert.ok(r.clusters.filter((c) => c.nights >= 4).length >= 5, "Rumaila has several near-nightly flares");
  // Clusters are ≤ ~1 km: every member within clusterKm of the seed ⇒ centroid within the bbox.
  for (const c of r.clusters) assert.ok(c.lat >= 30.2 && c.lat <= 30.8 && c.lon >= 47 && c.lon <= 47.6);
});

test("parseVnfKml reads the EOG annual flare summary; non-KML (login wall) throws", () => {
  const sites = parseVnfKml(VNF_KML);
  assert.equal(sites.length, 27);
  assert.deepEqual(sites[0], {
    id: "USA_UPS_2024_150.9261W_70.3428N_v0.2", country: "USA", type: "oil upstream", lat: 70.34276, lon: -150.926137, bcm: 0.005, clearObs: 56, clearPct: 44.643, tAvgK: 2004.83,
  });
  assert.equal(sites[1]!.type, "unknown"); // Hawaii: EOG leaves volcano/other heat as "unknown"
  const local = sitesIn(RUMAILA, sites);
  assert.equal(local.length, 25);
  assert.equal(Math.round(local.reduce((a, s) => a + s.bcm, 0) * 1000) / 1000, 3.201);
  assert.throws(() => parseVnfKml("<!DOCTYPE html><title>Sign in to eog</title>"), /not KML/);
});

function mockUpstream(opts: { vnf?: "ok" | "404" } = {}) {
  return mockFetch((url) => {
    if (url.includes("eogdata.mines.edu")) return opts.vnf === "404" ? textResponse("nope", { status: 404 }) : textResponse(VNF_KML);
    if (url.includes("/VIIRS_NOAA20_NRT/") && url.endsWith("/5/2026-09-20")) return textResponse(RUMAILA_CSV);
    return textResponse(`${HEADER}\n`);
  });
}

test("flaringReport: NOAA-20/21 in ≤5-day chunks, persistent clusters matched to VNF sites", async (t) => {
  const fm = mockUpstream();
  t.after(fm.restore);
  const r = await flaringReport("KEY", RUMAILA, { days: 10, end: "2026-09-24", minFrp: 3, minNights: 4 });
  const firms = fm.calls.filter((c) => c.url.includes("firms.modaps"));
  assert.equal(firms.length, 4); // 2 sources × 2 chunks
  assert.ok(firms.every((c) => !c.url.includes("SNPP")), "S-NPP is not a default");
  assert.ok(firms.some((c) => c.url.includes("/VIIRS_NOAA21_NRT/47,30.2,47.6,30.8/5/2026-09-15")));
  assert.equal(r.provenance.firmsRequests, 4);
  assert.deepEqual(r.window, { from: "2026-09-15", to: "2026-09-24", days: 10 });
  assert.equal(r.counts.detections, 455);
  assert.ok(r.counts.persistentClusters >= 5);
  assert.ok(r.clusters.every((c) => c.nights >= 4));
  assert.equal(r.vnf.available, true);
  assert.equal(r.vnf.sitesInBbox, 25);
  assert.ok((r.vnf.matchedClusters as number) >= 1, "Rumaila's persistent clusters sit on known VNF sites");
  assert.ok(r.clusters.some((c) => c.vnf && c.vnf.km <= 2));
});

test("flaringReport: a VNF failure degrades to FIRMS-only with an EOG link, never an error", async (t) => {
  const fm = mockUpstream({ vnf: "404" });
  t.after(fm.restore);
  const r = await flaringReport("KEY", RUMAILA, { days: 5, end: "2026-09-24", vnfYear: 2023 });
  assert.equal(r.vnf.available, false);
  assert.match(String(r.vnf.reason), /404/);
  assert.match(String(r.vnf.href), /eogdata\.mines\.edu/);
  assert.ok(r.counts.persistentClusters >= 1);
});

// ---- flaring@1.0 through the kernel -------------------------------------------------------

const NOW = "2026-09-26T12:00:00Z";
const aoi = { id: "iq-rumaila", name: "Rumaila", bbox: RUMAILA as [number, number, number, number], rules: [{ name: "flaring", params: {} }] };

function fakeCall(script: Record<string, (args: Record<string, unknown>) => unknown>): { call: ToolCall; calls: { tool: string; args: Record<string, unknown> }[] } {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const call: ToolCall = async (tool, args) => {
    calls.push({ tool, args });
    const fn = script[tool];
    if (!fn) throw new ToolError(tool, "not scripted");
    return JSON.parse(JSON.stringify(await fn(args))); // what run.ts's `call` sees: parsed JSON text
  };
  return { call, calls };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-flaring-"));
  return { ledger: Ledger.open(dir), journal: new Journal(join(dir, "watch")) };
}

test("flaring@1.0: real report → candidate confirmed by the VNF annual summary (provider)", async (t) => {
  const fm = mockUpstream();
  t.after(fm.restore);
  const report = await flaringReport("KEY", RUMAILA, { days: 10, end: "2026-09-24", minFrp: 5, minNights: 4 });
  const s = setup();
  const { call, calls } = fakeCall({ flaring: () => report, enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }), events: () => ({ events: [] }) });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [aoi] });
  const r = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r.created.length, 1);
  assert.equal(r.confirmed.length, 1);
  const f = s.ledger.get(r.created[0]!)!;
  assert.equal(f.tier, 2);
  assert.equal(f.status, "confirmed");
  assert.equal(f.confirmed?.independence, "provider");
  assert.equal(f.confirmed?.signal.source, "eog-vnf-annual");
  assert.equal(f.confirmed?.signal.datetime, "2024-12-31T00:00:00Z");
  assert.equal(f.evidence[0]!.source, "firms-viirs_noaa20_nrt+viirs_noaa21_nrt");
  assert.equal(f.evidence[0]!.values?.persistentClusters, report.counts.persistentClusters);
  assert.equal(f.geometry.type, "Point");
  assert.ok(f.blindSpots!.some((b) => /furnace|volcano/.test(b)));
  assert.equal(calls.filter((c) => c.tool === "flaring").length, 1, "VNF confirmation costs no extra FIRMS pull");
  assert.equal(s.ledger.verify().ok, true);
});

const synthetic = (clusters: { nights: number; lastNight: string; lat?: number; lon?: number }[]) => ({
  window: { from: "2026-08-28", to: "2026-09-26", days: 30 },
  counts: { hotNightDetections: clusters.length * 10, persistentClusters: clusters.filter((c) => c.nights >= 5).length },
  clusters: clusters.map((c) => ({ lat: c.lat ?? 30.5, lon: c.lon ?? 47.3, nights: c.nights, detections: 10, meanFrp: 9, maxFrp: 20, firstNight: "2026-08-29", lastNight: c.lastNight, sources: ["VIIRS_NOAA20_NRT"], vnf: null })),
  vnf: { available: false },
  provenance: { sensors: ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"] },
});

test("flaring@1.0: quiet when nothing persists; no VNF → candidate, then confirmed on a later pass (revisit)", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 })); // dashboard push → swallowed
  t.after(fm.restore);
  const rule = RULES.get("flaring")!;
  const ctxAoi = parseWatchlist({ version: 1, name: "t", aois: [aoi] }).aois[0]!;
  const quiet = fakeCall({ flaring: () => ({ ...synthetic([{ nights: 2, lastNight: "2026-09-25" }]), clusters: [] }) });
  assert.equal(await rule.detect({ aoi: ctxAoi, params: {}, now: NOW, since: null, call: quiet.call }), null);

  const s = setup();
  let later = false;
  const { call, calls } = fakeCall({
    flaring: (a) =>
      a.days === 2
        ? synthetic(later ? [{ nights: 1, lastNight: "2026-09-26", lat: 30.503 }, { nights: 1, lastNight: "2026-09-26", lat: 30.7, lon: 47.55 }] : [])
        : synthetic([{ nights: 12, lastNight: "2026-09-25" }]),
    enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }),
    events: () => ({ events: [] }),
  });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [aoi] });
  const r1 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(r1.created.length, 1);
  assert.equal(r1.confirmed.length, 0);
  assert.equal(s.ledger.get(r1.created[0]!)!.status, "candidate");
  assert.ok(calls.some((c) => c.tool === "flaring" && c.args.days === 2 && c.args.vnf === false), "revisit asks for a short, FIRMS-only pull");

  const r2 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: "2026-09-27T12:00:00Z", hasKey: () => true });
  assert.equal(r2.confirmed.length, 0, "the later pass saw nothing at the flagged cluster");

  later = true;
  const r3 = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: "2026-09-28T12:00:00Z", hasKey: () => true });
  assert.equal(r3.confirmed.length, 1);
  const f = s.ledger.get(r1.created[0]!)!;
  assert.equal(f.confirmed?.independence, "revisit");
  assert.equal(f.confirmed?.signal.values?.clusters, 1, "only the cluster near the flagged point counts");
  assert.equal(s.ledger.verify().ok, true);
});
