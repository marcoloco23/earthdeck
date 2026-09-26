// flaring: FIRMS night persistence math, the EOG VNF annual-summary parser, the report the
// tool returns (fetch-mocked against fixtures recorded live on 2026-09-26), and the
// flaring@1.0 watch rule end to end through the kernel with a scripted tool caller.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearVnfCache, clusterFlares, flaringReport, nightKey, parseVnfKml, sitesIn, stoppedSites, windowChunks, type SourcedDetection } from "../src/clients/vnf.js";
import { parseFiresCsv } from "../src/clients/nasa.js";
import { Ledger } from "../src/ledger/store.js";
import { Journal } from "../src/watch/journal.js";
import { sweep } from "../src/watch/kernel.js";
import { RULES, ToolError, type ToolCall } from "../src/watch/rules/index.js";
import { parseWatchlist } from "../src/watch/watchlist.js";
import { addDays } from "../src/util.js";
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

/** Minimal EOG-style placemarks (what parseVnfKml reads) to append to the real sample. */
const kmlSites = (sites: { id: string; lat: number; lon: number; bcm: number }[]) =>
  sites
    .map((s) => `<Placemark><name>${s.id}</name><description><![CDATA[Country: <b>IRQ</b> Lat=${s.lat}, Lon=${s.lon} deg. BCM_total=${s.bcm}</td><td>Type: oil upstream</td>]]></description></Placemark>`)
    .join("\n");
const withSites = (kml: string, sites: Parameters<typeof kmlSites>[0]) => kml.replace("</Document>", `${kmlSites(sites)}\n</Document>`);

function mockUpstream(opts: { vnf?: "ok" | "404"; kml2024?: string; kml2023?: string } = {}) {
  clearVnfCache();
  return mockFetch((url) => {
    if (url.includes("eogdata.mines.edu")) {
      if (opts.vnf === "404") return textResponse("nope", { status: 404 });
      return textResponse((url.includes("/2023_") ? opts.kml2023 : opts.kml2024) ?? VNF_KML);
    }
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
  // 2023 registry also holds a site at the one Rumaila cluster the 2024 sample lacks → nothing is "new".
  const fm = mockUpstream({ kml2023: withSites(VNF_KML, [{ id: "IRQ_UPS_2023_47.3347E_30.4032N_v0.2", lat: 30.4035, lon: 47.335, bcm: 0.02 }]) });
  t.after(fm.restore);
  const report = await flaringReport("KEY", RUMAILA, { days: 10, end: "2026-09-24", minFrp: 5, minNights: 4 });
  assert.equal(report.vnf.newClusters, 0);
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

// ---- new vs stopped flares ----------------------------------------------------------------

test("flaringReport: a persistent cluster in neither VNF year is new; a registered site dark all window is stopped", async (t) => {
  const kml2024 = withSites(VNF_KML, [
    { id: "IRQ_UPS_2024_47.0500E_30.2500N_v0.2", lat: 30.25, lon: 47.05, bcm: 0.3 }, // no detection near it: stopped
    { id: "IRQ_UPS_2024_47.0600E_30.2600N_v0.2", lat: 30.26, lon: 47.06, bcm: 0.01 }, // dark too, but under 0.05 BCM
  ]);
  const fm = mockUpstream({ kml2024 });
  t.after(fm.restore);
  const r = await flaringReport("KEY", RUMAILA, { days: 10, end: "2026-09-24", minFrp: 5, minNights: 4 });
  const fresh = r.clusters.filter((c) => c.novel);
  assert.equal(fresh.length, 1, "one Rumaila cluster has no 2023/2024 site within 2 km");
  assert.deepEqual([fresh[0]!.lat, fresh[0]!.lon], [30.4032, 47.3347]);
  assert.equal(fresh[0]!.vnf, null);
  assert.equal(r.vnf.newClusters, 1);
  assert.equal((r.vnf.previous as { year: number }).year, 2023);
  const stopped = r.vnf.stopped as { count: number; bcm: number; sites: { id: string }[] };
  assert.equal(stopped.count, 1);
  assert.equal(stopped.bcm, 0.3);
  assert.equal(stopped.sites[0]!.id, "IRQ_UPS_2024_47.0500E_30.2500N_v0.2");
  assert.ok(fm.calls.some((c) => c.url.includes("/2023_flare_summary")), "previous year fetched for novelty");

  // A window with no night detection at all proves nothing: no stopped claim.
  const sites = parseVnfKml(kml2024);
  assert.equal(stoppedSites(sites, []), null);
  assert.equal(stoppedSites(sites, [{ lat: 0, lon: 0, daynight: "D" }]), null);
  assert.equal(stoppedSites(sites, [{ lat: 30.2501, lon: 47.0502, daynight: "N" }])!.some((s) => s.lat === 30.25), false, "one detection within 2 km keeps a site lit");
});

const IRN_AOI = {
  id: "flare-irn-32p4n-47p2e",
  name: "Flare field near Dehloran, Ilam (Iran) — 5 registered sites",
  bbox: [46.9, 32.2, 47.6, 32.8] as [number, number, number, number],
  rules: [
    { name: "flaring", params: {} },
    { name: "flaring_stopped", params: {} },
  ],
};
const SENSORS = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"];
const cluster = (lat: number, lon: number, extra: Record<string, unknown> = {}) => ({
  lat, lon, nights: 9, detections: 20, meanFrp: 12, maxFrp: 30, firstNight: "2026-08-30", lastNight: "2026-09-25", sources: SENSORS, vnf: null, ...extra,
});
const report = (o: { to?: string; clusters?: unknown[]; stopped?: { lat: number; lon: number; bcm: number }[]; matched?: number }) => {
  const to = o.to ?? "2026-09-26";
  const st = o.stopped ?? [];
  return {
    window: { from: addDays(to, -29), to, days: 30 },
    counts: { nightDetections: 40, hotNightDetections: 30, persistentClusters: (o.clusters ?? []).length },
    clusters: o.clusters ?? [],
    vnf: {
      available: true, year: 2024, previous: { available: true, year: 2023 }, matchedClusters: o.matched ?? 0,
      stopped: { count: st.length, bcm: Math.round(st.reduce((a, s) => a + s.bcm, 0) * 1000) / 1000, sites: st.map((s, i) => ({ id: `IRN_UPS_2024_S${i}`, type: "oil upstream", ...s })) },
    },
    provenance: { sensors: SENSORS },
  };
};
const ctxFor = (call: ToolCall) => ({ aoi: parseWatchlist({ version: 1, name: "t", aois: [IRN_AOI] }).aois[0]!, params: {}, now: NOW, since: null, call });

test("flaring@1.0: a cluster in neither VNF year → 'New flaring near <place>', new_flare = 1, not VNF-confirmed", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const r = report({ clusters: [cluster(32.5, 47.2, { vnf: { id: "IRN_UPS_2024_X", type: "oil upstream", bcm: 0.2, km: 0.3 }, novel: false }), cluster(32.61, 47.41, { nights: 6, novel: true })], matched: 1 });
  const direct = await RULES.get("flaring")!.detect(ctxFor(fakeCall({ flaring: () => r }).call));
  assert.equal(direct!.title, "New flaring near Dehloran, Ilam (Iran)");
  assert.deepEqual(direct!.tags, ["new-flare"]);
  assert.equal(direct!.values.new_flare, 1);
  assert.deepEqual(direct!.geometry, { type: "Point", coordinates: [47.41, 32.61] }, "the new cluster, not the brighter registered one");

  const s = setup();
  const { call } = fakeCall({ flaring: () => r, enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }), events: () => ({ events: [] }) });
  const wl = parseWatchlist({ version: 1, name: "t", aois: [{ ...IRN_AOI, rules: [{ name: "flaring", params: {} }] }] });
  const sw = await sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now: NOW, hasKey: () => true });
  assert.equal(sw.created.length, 1);
  assert.equal(sw.confirmed.length, 0, "a VNF match elsewhere in the box cannot confirm a flare the registry does not have");
  const f = s.ledger.get(sw.created[0]!)!;
  assert.equal(f.title, "New flaring near Dehloran, Ilam (Iran)");
  assert.equal(f.evidence[0]!.values?.new_flare, 1);
  assert.equal(f.status, "candidate");
});

test("flaring_stopped@1.0: dark registered sites → a separate good-news case, confirmed by the next dark window", async (t) => {
  const fm = mockFetch(() => new Response("{}", { status: 200 }));
  t.after(fm.restore);
  const both = [
    { lat: 32.45, lon: 47.1, bcm: 0.25 },
    { lat: 32.7, lon: 47.5, bcm: 0.1 },
  ];
  let next = [both[0]!]; // the second window: one site relit
  const s = setup();
  const { call, calls } = fakeCall({
    flaring: (a) => (a.endDate ? report({ to: String(a.endDate), stopped: next }) : report({ clusters: [cluster(32.5, 47.2, { novel: false })], stopped: both, matched: 1 })),
    enso: () => ({ phase: "Neutral", latest: { oni: 0.1 } }),
    events: () => ({ events: [] }),
  });
  const direct = await RULES.get("flaring_stopped")!.detect(ctxFor(fakeCall({ flaring: () => report({ stopped: both }) }).call));
  assert.deepEqual(direct!.tags, ["improvement"]);

  const wl = parseWatchlist({ version: 1, name: "t", aois: [IRN_AOI] });
  const run = (now: string) => sweep({ watchlists: [wl], rules: RULES, ledger: s.ledger, journal: s.journal, call, now, hasKey: () => true });
  const r1 = await run(NOW);
  assert.equal(r1.created.length, 2, "the flaring case and a separate stopped case for the same AOI");
  assert.equal(calls.filter((c) => c.tool === "flaring" && c.args.days === 30).length, 1, "both rules share one detect-time FIRMS pull per sweep");
  const stopped = r1.created.map((id) => s.ledger.get(id)!).find((f) => f.rule.name === "flaring_stopped")!;
  assert.equal(stopped.title, "Flaring stopped at 2 registered sites near Dehloran, Ilam (Iran)");
  assert.match(stopped.summary, /^Good news, if it holds: 2 gas-flare sites near Dehloran, Ilam \(Iran\) that burned 0\.35 billion m³/);
  assert.equal(stopped.evidence[0]!.values?.stopped_sites, 2);
  assert.equal(stopped.evidence[0]!.values?.stopped_bcm, 0.35);
  assert.deepEqual(stopped.geometry, { type: "Point", coordinates: [47.1, 32.45] });
  assert.ok(stopped.blindSpots!.some((b) => /cloud/i.test(b)) && stopped.blindSpots!.some((b) => /seasonal/i.test(b)) && stopped.blindSpots!.some((b) => /sensor/i.test(b)));
  assert.ok(stopped.context?.notes?.some((n) => /improvement/.test(n)));
  assert.equal(stopped.status, "candidate");

  // Mid-way through the next window: nothing to check yet, no extra pull for the stopped case.
  const r2 = await run("2026-10-10T12:00:00Z");
  assert.equal(r2.confirmed.length, 0);
  assert.ok(!calls.some((c) => c.args.endDate), "no confirmation pull before the next window has elapsed");

  // Next window over, but one of the two sites relit: not confirmed.
  const r3 = await run("2026-10-27T06:00:00Z");
  assert.ok(!r3.confirmed.includes(stopped.findingId));
  const pull = calls.find((c) => c.args.endDate)!;
  assert.deepEqual([pull.args.endDate, pull.args.days], ["2026-10-26", 30], "exactly the consecutive 30-night window");

  // Both still dark on the next sweep → confirmed by revisit.
  next = both;
  const r4 = await run("2026-10-28T06:00:00Z");
  assert.ok(r4.confirmed.includes(stopped.findingId));
  const f = s.ledger.get(stopped.findingId)!;
  assert.equal(f.status, "confirmed");
  assert.equal(f.confirmed?.independence, "revisit");
  assert.equal(f.confirmed?.signal.datetime, "2026-10-26T00:00:00Z");
  assert.equal(f.confirmed?.signal.values?.stopped_sites, 2);
  assert.equal(s.ledger.verify().ok, true);
});
