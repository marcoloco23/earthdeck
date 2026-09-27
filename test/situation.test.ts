// The daily Situation offline: the level rules (each criterion true and false), the dossier,
// the briefing's JSON parsing and faithfulness fallback, the one-a-day / unchanged-inputs
// skip, storage retention, and the export (api/situation*.json + the landing's strip).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonCallResult } from "../src/analyst/anthropic.js";
import { checkBriefing, parseBriefing, runSituation, type SituationCall } from "../src/analyst/situation.js";
import type { OniRow, SeaIceClimatologyRow } from "../src/clients/indicators.js";
import type { Finding, Status } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";
import { seedDemo } from "../src/ledger/cli.js";
import type { PulseRow } from "../src/tools/worldpulse.js";
import { exportSite } from "../src/watch/export.js";
import { buildDossier, computeLevel, fallbackBriefing, listSituations, pulseCrossing, readSituation, seaIceRecordFor, writeSituation, type IndicatorInputs, type SituationRecord } from "../src/watch/situation.js";

const NOW = new Date("2026-09-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let n = 0;

function mk(o: {
  rule?: string;
  status?: Status;
  indicator?: string;
  values?: Record<string, number>;
  observedAt?: string;
  createdAt?: string;
  confirmedAt?: string | null;
  publishedAt?: string | null;
  bbox?: [number, number, number, number];
  tags?: string[];
  name?: string;
}): Finding {
  n++;
  const id = `01994a2e-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const at = o.createdAt ?? hoursAgo(24 * 30);
  const history: Finding["history"] = [{ at, kind: "created", status: "candidate", actor: "system:x" }];
  if (o.confirmedAt) history.push({ at: o.confirmedAt, kind: "confirmed", status: "confirmed", actor: "system:x" });
  if (o.publishedAt) history.push({ at: o.publishedAt, kind: "status_changed", status: "published", actor: "model:x" });
  return {
    findingId: id,
    status: o.status ?? "confirmed",
    tier: 1,
    rule: { name: o.rule ?? "forest_loss", version: "1.0" },
    title: `Case ${n}`,
    summary: "s",
    geometry: { type: "Point", coordinates: [0, 0] },
    bbox: o.bbox ?? [-52.4, -6.9, -51.9, -6.4],
    aoi: { id: `aoi-${n}`, name: o.name ?? `Place ${n}`, tags: o.tags ?? [] },
    observedAt: o.observedAt ?? at,
    createdAt: at,
    updatedAt: o.publishedAt ?? o.confirmedAt ?? at,
    createdBy: "system:x",
    confirmed: o.confirmedAt ? { at: o.confirmedAt, independence: "sensor", signal: { id: "sig", kind: "series", source: "s", datetime: o.confirmedAt, method: { name: "m", version: "1" } } } : null,
    evidence: [{ id: "e1", kind: "series", source: "s", datetime: at, method: { name: o.rule ?? "m", version: "1", params: o.indicator ? { indicator: o.indicator } : {} }, values: o.values ?? {} }],
    attribution: null,
    narration: null,
    reviews: [],
    notifications: [],
    replies: [],
    retracted: null,
    history,
    eventCount: history.length,
    lastEventHash: "0".repeat(64),
  } as Finding;
}

const codes = (fs: Finding[], ind: IndicatorInputs = {}) => computeLevel(fs, ind, NOW).reasons.map((r) => r.code);
const oni = (anoms: number[]): OniRow[] => anoms.map((a, i) => ({ season: "JJA", year: 2025 + Math.floor(i / 12), total: 27 + a, anom: a }));

// ---- level rules, each criterion true and false --------------------------------------------

test("quiet when nothing fires", () => {
  const r = computeLevel([mk({ confirmedAt: hoursAgo(24 * 20) })], {}, NOW);
  assert.equal(r.level, "quiet");
  assert.deepEqual(r.reasons, []);
});

test("U1 ENSO: newly declared phase → urgent; unchanged phase → not", () => {
  // Fifth season ≥ +0.5 declares El Niño this release.
  assert.ok(codes([], { oni: oni([0.1, 0.6, 0.7, 0.8, 0.9, 1.0]) }).includes("enso_change"));
  assert.equal(computeLevel([], { oni: oni([0.1, 0.6, 0.7, 0.8, 0.9, 1.0]) }, NOW).level, "urgent");
  assert.ok(!codes([], { oni: oni([0.6, 0.7, 0.8, 0.9, 1.0, 1.1]) }).includes("enso_change"), "still El Niño: no change");
  assert.ok(!codes([], { oni: oni([0.1, 0.2, 0.1]) }).includes("enso_change"));
  // An ENSO case opened this month also counts; one from last month doesn't.
  assert.ok(codes([mk({ rule: "indicator_threshold", indicator: "enso", createdAt: "2026-09-03T00:00:00Z" })]).includes("enso_change"));
  assert.ok(!codes([mk({ rule: "indicator_threshold", indicator: "enso", createdAt: "2026-08-20T00:00:00Z" })]).includes("enso_change"));
});

test("U2 quake: M7+ in 48 h → urgent; M6.8 or older → not", () => {
  assert.ok(codes([mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 7.2 }, observedAt: hoursAgo(10), createdAt: hoursAgo(10) })]).includes("quake_m7"));
  assert.ok(!codes([mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 6.8 }, observedAt: hoursAgo(10), createdAt: hoursAgo(10) })]).includes("quake_m7"));
  assert.ok(!codes([mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 7.5 }, observedAt: hoursAgo(72), createdAt: hoursAgo(72) })]).includes("quake_m7"));
  assert.ok(!codes([mk({ rule: "indicator_threshold", indicator: "quake", status: "false_positive", values: { magnitude: 7.5 }, observedAt: hoursAgo(1), createdAt: hoursAgo(1) })]).includes("quake_m7"));
});

test("U3 weather: published heat/cyclone in 48 h → urgent; unpublished or rain → not", () => {
  const w = (o: Parameters<typeof mk>[0]) => mk({ rule: "weather_extreme", observedAt: hoursAgo(100), ...o });
  assert.ok(codes([w({ status: "published", values: { hazardCode: 2 }, publishedAt: hoursAgo(5) })]).includes("weather_published"));
  assert.ok(codes([w({ status: "published", values: { hazardCode: 1 }, publishedAt: hoursAgo(47) })]).includes("weather_published"));
  assert.ok(!codes([w({ status: "confirmed", values: { hazardCode: 2 }, observedAt: hoursAgo(5) })]).includes("weather_published"));
  assert.ok(!codes([w({ status: "published", values: { hazardCode: 3 }, publishedAt: hoursAgo(5) })]).includes("weather_published"));
  assert.ok(!codes([w({ status: "published", values: { hazardCode: 2 }, publishedAt: hoursAgo(60) })]).includes("weather_published"));
});

const clim: SeaIceClimatologyRow[] = [{ doy: 270, average: 5.5, p10: 4.6, p25: 5, p50: 5.5, p75: 6, p90: 6.4 }];
const daily = (today: number) => [
  { t: "2012-09-27", v: 3.5 },
  { t: "2020-09-27", v: 3.9 },
  { t: "2026-09-26", v: today + 0.01 },
  { t: "2026-09-27", v: today },
];

test("U4 sea ice below the record for the date → urgent; below p10 only → watch; normal → nothing", () => {
  assert.equal(seaIceRecordFor(daily(3.4), "2026-09-27"), 3.5);
  const r1 = computeLevel([], { seaIce: [{ pole: "north", daily: daily(3.4), clim }] }, NOW);
  assert.equal(r1.level, "urgent");
  assert.deepEqual(r1.reasons.map((r) => r.code), ["sea_ice_record"]);
  const r2 = computeLevel([], { seaIce: [{ pole: "north", daily: daily(4.2), clim }] }, NOW);
  assert.deepEqual([r2.level, r2.reasons.map((r) => r.code)], ["watch", ["sea_ice_p10"]]);
  assert.deepEqual(codes([], { seaIce: [{ pole: "north", daily: daily(5.2), clim }] }), []);
});

test("sea-ice reasons point only at their own pole's cases", () => {
  const arctic = mk({ rule: "indicator_threshold", indicator: "sea_ice" });
  arctic.evidence[0]!.method.params = { indicator: "sea_ice", hemisphere: "arctic" };
  const antarctic = mk({ rule: "indicator_threshold", indicator: "sea_ice" });
  antarctic.evidence[0]!.method.params = { indicator: "sea_ice", hemisphere: "antarctic" };
  const r = computeLevel([arctic, antarctic], { seaIce: [{ pole: "south", daily: daily(3.4), clim }] }, NOW);
  assert.deepEqual(r.reasons[0]!.caseIds, [antarctic.findingId]);
});

test("U5 acute cases at 3 distinct places in one 5° box within 24 h → urgent; flaring, same place, spread out or older → not", () => {
  const near = [0, 1, 2].map(() => mk({ confirmedAt: hoursAgo(3) }));
  assert.ok(codes(near).includes("regional_cluster"));
  assert.equal(computeLevel(near, {}, NOW).level, "urgent");
  const spread = [mk({ confirmedAt: hoursAgo(3) }), mk({ confirmedAt: hoursAgo(3) }), mk({ confirmedAt: hoursAgo(3), bbox: [-45.4, -6.9, -44.9, -6.4] })];
  assert.ok(!codes(spread).includes("regional_cluster"));
  for (const rule of ["flaring", "flaring_stopped", "improvement"]) {
    const fl = [0, 1, 2].map(() => mk({ rule, confirmedAt: hoursAgo(3) }));
    assert.ok(!codes(fl).includes("regional_cluster"), `${rule} never counts toward urgent`);
    assert.deepEqual(computeLevel(fl, {}, NOW).level, "watch", `${rule} can still make watch`);
  }
  assert.ok(!codes([0, 1, 2].map(() => mk({ tags: ["improvement"], confirmedAt: hoursAgo(3) }))).includes("regional_cluster"));
  const seaIce = [0, 1, 2].map(() => mk({ rule: "indicator_threshold", indicator: "sea_ice", confirmedAt: hoursAgo(3) }));
  assert.ok(!codes(seaIce).includes("regional_cluster"), "chronic indicators don't count");
  const quakes = [0, 1, 2].map(() => mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 6 }, confirmedAt: hoursAgo(3) }));
  assert.ok(codes(quakes).includes("regional_cluster"), "acute indicators do");
  const onePlace = [0, 1, 2].map(() => mk({ confirmedAt: hoursAgo(3) }));
  for (const f of onePlace) f.aoi = { id: "same-aoi", name: "Same" };
  assert.ok(!codes(onePlace).includes("regional_cluster"), "needs 3 distinct AOIs");
  const old = [0, 1, 2].map(() => mk({ confirmedAt: hoursAgo(30) }));
  assert.ok(!codes(old).includes("regional_cluster"));
  const many = [0, 1, 2, 3, 4].map(() => mk({ confirmedAt: hoursAgo(3) }));
  assert.match(computeLevel(many, {}, NOW).reasons[0]!.text, /and 2 more\.$/, "long lists are cut to three places");
});

test("W1 new confirmed case in 7 days → watch; 8 days ago or dropped → not", () => {
  const r = computeLevel([mk({ confirmedAt: hoursAgo(24 * 6) })], {}, NOW);
  assert.deepEqual([r.level, r.reasons.map((x) => x.code)], ["watch", ["new_confirmed"]]);
  assert.deepEqual(codes([mk({ confirmedAt: hoursAgo(24 * 8) })]), []);
  assert.deepEqual(codes([mk({ confirmedAt: hoursAgo(24), status: "false_positive" })]), []);
});

const row = (vals: number[], latest: number, prev?: number): PulseRow => ({
  slug: "forest_area",
  label: "Forest area",
  unit: "%",
  group: "planet" as PulseRow["group"],
  betterWhen: "up",
  upstream: "u",
  licence: "l",
  status: "ok",
  latest: { t: "2025", v: latest },
  previous: { t: "2024", v: prev ?? vals.at(-1)! },
  sparkline: [...vals, latest].map((v, i) => ({ t: String(2000 + i), v })),
});

test("W2 indicator crossing p90/p10 → watch; already outside or inside → not", () => {
  const base = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 5];
  assert.equal(pulseCrossing(row(base, 20)), "above_p90");
  assert.equal(pulseCrossing(row(base, 0)), "below_p10");
  assert.equal(pulseCrossing(row(base, 6)), null);
  assert.equal(pulseCrossing(row([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12)), null, "a steady climb was already above p90");
  assert.deepEqual(codes([], { pulse: [row(base, 20)] }), ["indicator_crossing"]);
  assert.equal(pulseCrossing(row([1, 2, 3], 20)), null, "too short a history");
});

test("reasons carry the case ids / indicator they point at; urgent outranks watch", () => {
  const q = mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 7.1 }, observedAt: hoursAgo(1), createdAt: hoursAgo(1), confirmedAt: hoursAgo(1) });
  const r = computeLevel([q], { pulse: [row([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 5], 20)] }, NOW);
  assert.equal(r.level, "urgent");
  assert.deepEqual(r.reasons.find((x) => x.code === "quake_m7")!.caseIds, [q.findingId]);
  assert.equal(r.reasons.find((x) => x.code === "indicator_crossing")!.indicator, "forest_area");
});

test("fallback briefing: plain sentences from the reasons; quiet says so", () => {
  const q = fallbackBriefing("quiet", []);
  assert.match(q.headline, /^Quiet/);
  const c = mk({ confirmedAt: hoursAgo(5) });
  const { level, reasons } = computeLevel([c], {}, NOW);
  const b = fallbackBriefing(level, reasons);
  assert.ok(b.headline.length <= 90);
  assert.equal(b.items[0]!.caseId, c.findingId);
});

// ---- the briefing: JSON parsing + faithfulness ----------------------------------------------

function dossierFixture() {
  const c = mk({ status: "published", confirmedAt: hoursAgo(20), publishedAt: hoursAgo(10), name: "São Félix do Xingu" });
  return { c, d: buildDossier([c], { oni: oni([0.1, 0.2, -0.3]) }, NOW) };
}

test("parseBriefing: schema errors and faithfulness violations are reported", () => {
  const { c, d } = dossierFixture();
  assert.ok(parseBriefing(d, { headline: "x".repeat(91), summary: "a", items: [] }).problems.some((p) => p.startsWith("headline")));
  assert.ok(parseBriefing(d, { headline: "h", summary: "s", items: [{ line: "no target" }] }).problems.length);
  const ok = { headline: "Watch: one newly published forest case", summary: "One case was published today. It is in São Félix do Xingu. The Pacific is neutral, with ONI at -0.3.", items: [{ caseId: c.findingId, line: "Forest case in São Félix do Xingu" }] };
  assert.deepEqual(parseBriefing(d, ok).problems, []);
  const bad = { ...ok, summary: "One case was published today. It covers 412 hectares. Dr Jane Doe owns the land." };
  const probs = checkBriefing(d, bad);
  assert.ok(probs.some((p) => p.includes("412")), probs.join(" | "));
  assert.ok(probs.some((p) => p.includes("personal name")), probs.join(" | "));
  assert.ok(checkBriefing(d, { ...ok, items: [{ caseId: "01994a2e-0000-7000-8000-999999999999", line: "x" }] }).some((p) => p.includes("not in the dossier")));
});

const res = (data: unknown, model: string, cost = 0.05): JsonCallResult => ({ data, text: JSON.stringify(data), model, usage: { input_tokens: 1000, output_tokens: 200 }, costUsd: cost, ms: 1, requestSha256: "a", responseSha256: "b" });

function scripted(brief: unknown, verdict: unknown): { call: SituationCall; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: async (purpose) => {
      calls.push(purpose);
      return purpose === "situation_brief" ? res(brief, "claude-opus-5") : res(verdict, "claude-sonnet-5", 0.02);
    },
  };
}

test("runSituation: accepted → model text stored; unchanged inputs → skipped; one briefing per day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-sit-"));
  const { c, d } = dossierFixture();
  const brief = { headline: "Watch: one newly published forest case", summary: "One case was published today. It is in São Félix do Xingu. The Pacific is neutral.", items: [{ caseId: c.findingId, line: "Forest case" }] };
  const s = scripted(brief, { accept: true, reason: "all supported" });
  const base = { findings: [c], indicators: { oni: oni([0.1, 0.2, -0.3]) }, ledgerDir: dir, narrator: "claude-opus-5", reviewer: "claude-sonnet-5", now: NOW };
  const r1 = await runSituation({ ...base, call: s.call });
  assert.equal(r1.record.source, "model");
  assert.equal(r1.record.level, d.level);
  assert.deepEqual(r1.record.models, { narrator: "claude-opus-5", reviewer: "claude-sonnet-5" });
  assert.ok(Math.abs(r1.record.costUsd - 0.07) < 1e-9);
  assert.equal(readSituation(dir, "2026-09-27")!.text.headline, brief.headline);
  const r2 = await runSituation({ ...base, call: s.call });
  assert.equal(r2.skipped, true);
  assert.deepEqual(s.calls, ["situation_brief", "situation_review"]);
  // Inputs change later the same day, same level → no new call, the day's text is kept.
  const more = mk({ confirmedAt: hoursAgo(2) });
  const r3 = await runSituation({ ...base, findings: [c, more], call: s.call });
  assert.equal(s.calls.length, 2);
  assert.equal(r3.record.source, "model");
  // …a different level → the rules-only text, still no call.
  const quake = mk({ rule: "indicator_threshold", indicator: "quake", values: { magnitude: 7.4 }, observedAt: hoursAgo(1), createdAt: hoursAgo(1) });
  const r4 = await runSituation({ ...base, findings: [c, more, quake], call: s.call });
  assert.equal(s.calls.length, 2);
  assert.deepEqual([r4.record.level, r4.record.source], ["urgent", "rules"]);
});

test("runSituation: faithfulness failure → rules-only fallback, reviewer never called", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-sit-"));
  const { c } = dossierFixture();
  const s = scripted({ headline: "Watch", summary: "It lost 999 hectares. That is a lot. More later.", items: [] }, { accept: true, reason: "x" });
  const r = await runSituation({ findings: [c], indicators: {}, ledgerDir: dir, narrator: "a", reviewer: "b", call: s.call, now: NOW });
  assert.equal(r.record.source, "rules");
  assert.ok(r.record.problems.some((p) => p.includes("999")));
  assert.deepEqual(s.calls, ["situation_brief"]);
  assert.equal(r.record.modelBriefings, 1);
});

test("runSituation: reviewer rejects → rules-only text with the verdict recorded; dry run writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-sit-"));
  const { c } = dossierFixture();
  const good = { headline: "Watch: one new case", summary: "One case was published. It is in São Félix do Xingu. Nothing else changed.", items: [] };
  const s = scripted(good, { accept: false, reason: "overstates" });
  const r = await runSituation({ findings: [c], indicators: {}, ledgerDir: dir, narrator: "a", reviewer: "b", call: s.call, now: NOW });
  assert.equal(r.record.source, "rules");
  assert.deepEqual(r.record.verdict, { accept: false, reason: "overstates" });
  const dry = mkdtempSync(join(tmpdir(), "earthdeck-sit-"));
  const r2 = await runSituation({ findings: [c], indicators: {}, ledgerDir: dry, narrator: "a", reviewer: "b", call: scripted(good, { accept: true, reason: "ok" }).call, now: NOW, dryRun: true });
  assert.equal(r2.written, false);
  assert.equal(existsSync(join(dry, "situation")), false);
});

test("storage keeps 30 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-sit-"));
  const rec = (date: string) => ({ ...fakeRecord(), date });
  writeSituation(dir, rec("2026-08-01"));
  writeSituation(dir, rec("2026-08-29"));
  writeSituation(dir, rec("2026-09-27"));
  assert.deepEqual(listSituations(dir).map((r) => r.date), ["2026-09-27", "2026-08-29"]);
});

function fakeRecord(): SituationRecord {
  const d = buildDossier([], {}, NOW);
  return { v: 1, date: d.date, generatedAt: NOW.toISOString(), level: "watch", reasons: [{ code: "new_confirmed", level: "watch", text: "1 case confirmed.", caseIds: [] }], dossierHash: "h", dossier: d, text: { headline: "Watch: <b>one</b> new case", summary: "S.", items: [{ indicator: "enso", line: "ENSO neutral" }] }, source: "rules", models: null, verdict: null, problems: [], modelBriefings: 0, costUsd: 0, note: "n" };
}

test("export writes api/situation.json + per-day files and the strip/briefing, escaped and anonymous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-sit-ledger-"));
  seedDemo(Ledger.open(dir));
  mkdirSync(join(dir, "watch"), { recursive: true });
  writeSituation(dir, { ...fakeRecord(), date: "2026-09-26" });
  writeSituation(dir, { ...fakeRecord(), draft: { headline: "REJECTED DRAFT", summary: "x", items: [] } });
  const out = mkdtempSync(join(tmpdir(), "earthdeck-sit-out-"));
  writeFileSync(join(dir, "..", "TRUST-none.md"), "");
  await exportSite({ out, ledgerDir: dir, baseUrl: "https://vital.example.org", siteDir: null, pulse: "off", trustFile: join(dir, "nope.md"), force: true, now: NOW });
  const latest = JSON.parse(readFileSync(join(out, "api/situation.json"), "utf8")) as SituationRecord;
  assert.equal(latest.date, "2026-09-27");
  assert.ok(existsSync(join(out, "api/situation/2026-09-26.json")));
  assert.ok(!readFileSync(join(out, "api/situation.json"), "utf8").includes("REJECTED DRAFT"), "a rejected draft never reaches the site");
  assert.ok(!readFileSync(join(out, "api/situation/2026-09-27.json"), "utf8").includes("REJECTED DRAFT"));
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.match(html, /class="sit-strip sit--watch"/);
  assert.match(html, /id="sit-brief"/);
  assert.match(html, /id="situation"/);
  assert.match(html, /href="#pulse-enso" data-indicator="enso"/);
  assert.ok(html.includes("Watch: &lt;b&gt;one&lt;/b&gt; new case"), "headline escaped");
  assert.ok(!/marc|sperzel|mailto:/i.test(readFileSync(join(out, "api/situation.json"), "utf8")));
  assert.ok(!readFileSync(join(out, "api/situation.json"), "utf8").includes("@"));
});
