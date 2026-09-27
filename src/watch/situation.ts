// The daily Situation: one level for the whole watch — quiet, watch or urgent — decided by
// explicit rules over the ledger (last 7 days) and the planet indicators, never by a model.
// A model may write the briefing around it (src/analyst/situation.ts); if it can't, the
// rules-only text below is what goes out. Criteria in plain words: TRUST.md "Situation".
//
// Stored as <ledger dir>/situation/<YYYY-MM-DD>.json (last 30 days). The Merkle ledger only
// holds per-finding events (every event needs a findingId), so a situation is kept beside it,
// not in it: its inputs are ledger facts, but the briefing itself is not signed.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensoPhase, type OniRow, type SeaIceClimatologyRow } from "../clients/indicators.js";
import { PUBLIC_STATUSES, type Finding, type Status } from "../ledger/schema.js";
import type { SeriesPoint } from "../series.js";
import type { PulseRow } from "../tools/worldpulse.js";
import { canonicalize } from "../ledger/jcs.js";
import { indicatorOf, topicOf } from "./map-data.js";

export type Level = "quiet" | "watch" | "urgent";
export const LEVELS: readonly Level[] = ["quiet", "watch", "urgent"];

export interface Reason {
  /** Which criterion fired (stable, testable). */
  code: "enso_change" | "quake_m7" | "weather_published" | "sea_ice_record" | "regional_cluster" | "new_confirmed" | "indicator_crossing" | "sea_ice_p10";
  level: Exclude<Level, "quiet">;
  /** One plain sentence a general reader can follow. */
  text: string;
  caseIds: string[];
  indicator?: string;
}

export interface SeaIceInput {
  pole: "north" | "south";
  daily: SeriesPoint[];
  clim: SeaIceClimatologyRow[];
}

/** Indicator data the rules read. Anything missing just can't trigger its criterion. */
export interface IndicatorInputs {
  oni?: OniRow[] | null;
  seaIce?: SeaIceInput[];
  pulse?: PulseRow[] | null;
}

const H = 3_600_000;
/** Statuses that take a case out of the picture: ruled out, lapsed or withdrawn. */
const DROPPED: readonly Status[] = ["false_positive", "expired", "retracted"];
const live = (f: Finding) => !DROPPED.includes(f.status);
const within = (iso: string | null | undefined, now: Date, hours: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && t <= now.getTime() + H && now.getTime() - t <= hours * H;
};
const values = (f: Finding) => [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])].map((e) => e.values ?? {});
const valueOf = (f: Finding, key: string): number | null => {
  for (const v of values(f)) if (typeof v[key] === "number" && Number.isFinite(v[key])) return v[key]!;
  return null;
};
/** Rules about something happening now (not chronic sources like flaring, not good news). */
const ACUTE_RULES = new Set(["forest_loss", "fires_in_protected", "weather_extreme", "methane_anomaly", "mpa_fishing"]);
const ACUTE_INDICATORS = new Set(["quake", "marine_heatwave", "river_discharge", "air_quality"]);
/** Pure: may this case count toward the regional-cluster criterion? */
export function isAcute(f: Finding): boolean {
  if (f.aoi?.tags?.includes("improvement")) return false;
  if (f.rule.name === "indicator_threshold") return ACUTE_INDICATORS.has(indicatorOf(f) ?? "");
  return ACUTE_RULES.has(f.rule.name);
}

/** When a case went public (first move into a public status), or null. */
export function publishedAt(f: Finding): string | null {
  return f.history.find((h) => PUBLIC_STATUSES.includes(h.status) && h.status !== "retracted")?.at ?? null;
}
/** A 5° × 5° box around a case's centre — "one region" for the cluster criterion. */
export function regionOf(f: Pick<Finding, "bbox">): string {
  const [w, s, e, n] = f.bbox;
  const lon = (w + e) / 2;
  const lat = (s + n) / 2;
  const cell = (v: number) => Math.floor(v / 5) * 5;
  return `${cell(lat)},${cell(lon)}`;
}
const place = (f: Finding) => f.aoi?.name ?? f.title;
/** "A; B; C and 7 more" — reasons stay one readable line however many cases are behind them. */
const places = (fs: readonly Finding[], max = 3) => {
  const names = [...new Set(fs.map(place))];
  return names.length > max ? `${names.slice(0, max).join("; ")} and ${names.length - max} more` : names.join("; ");
};
const hemisphereOf = (f: Finding) => f.evidence.map((e) => e.method.params?.hemisphere).find((h) => typeof h === "string");

/** ENSO phase by NOAA's event definition (≥ 5 seasons), else Neutral. */
const declared = (rows: OniRow[]) => {
  if (!rows.length) return "Neutral";
  const p = ensoPhase(rows);
  return p.meetsEventDefinition ? p.phase : "Neutral";
};

/** Lowest extent on the same month-day in earlier years of the series (the record for the date), or null. */
export function seaIceRecordFor(daily: SeriesPoint[], date: string): number | null {
  const md = date.slice(5, 10);
  const year = date.slice(0, 4);
  let min: number | null = null;
  for (const p of daily) if (p.v !== null && p.t.slice(5, 10) === md && p.t.slice(0, 4) < year && (min === null || p.v < min)) min = p.v;
  return min;
}

const pct = (sorted: number[], q: number) => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};
/** A world-pulse row whose latest value just left its own p10–p90 band (the previous value was inside). */
export function pulseCrossing(r: PulseRow): "above_p90" | "below_p10" | null {
  if (r.status !== "ok" || !r.latest || r.latest.v === null) return null;
  const hist = (r.sparkline ?? []).map((p) => p.v).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (hist.at(-1) === r.latest.v) hist.pop();
  if (hist.length < 10) return null;
  const prev = r.previous?.v ?? hist.at(-1)!;
  const s = [...hist].sort((a, b) => a - b);
  const p10 = pct(s, 0.1);
  const p90 = pct(s, 0.9);
  if (prev === null || prev < p10 || prev > p90) return null;
  if (r.latest.v > p90) return "above_p90";
  if (r.latest.v < p10) return "below_p10";
  return null;
}

/** Pure: the level and every criterion that fired. The highest level among the reasons wins. */
export function computeLevel(findings: readonly Finding[], ind: IndicatorInputs, now = new Date()): { level: Level; reasons: Reason[] } {
  const reasons: Reason[] = [];
  const month = now.toISOString().slice(0, 7);

  // U1 — ENSO phase newly declared or changed this month.
  const ensoCases = findings.filter((f) => live(f) && indicatorOf(f) === "enso" && f.createdAt.slice(0, 7) === month);
  const oni = ind.oni ?? [];
  const nowPhase = oni.length ? declared(oni) : null;
  const wasPhase = oni.length > 1 ? declared(oni.slice(0, -1)) : null;
  if ((nowPhase && wasPhase && nowPhase !== wasPhase) || ensoCases.length) {
    const phase = nowPhase ?? "an ENSO phase";
    const text = nowPhase && wasPhase && nowPhase !== wasPhase ? `ENSO changed this month: ${wasPhase} → ${nowPhase} by NOAA's definition.` : `A new ${phase === "Neutral" ? "ENSO" : phase} case was opened this month.`;
    reasons.push({ code: "enso_change", level: "urgent", text, caseIds: ensoCases.map((f) => f.findingId), indicator: "enso" });
  }

  // U2 — an M7+ earthquake case in the last 48 h.
  const quakes = findings.filter((f) => live(f) && indicatorOf(f) === "quake" && (valueOf(f, "magnitude") ?? 0) >= 7 && (within(f.observedAt, now, 48) || within(f.createdAt, now, 48)));
  if (quakes.length) reasons.push({ code: "quake_m7", level: "urgent", text: `Magnitude 7 or stronger earthquake: ${places(quakes)}.`, caseIds: quakes.map((f) => f.findingId), indicator: "quake" });

  // U3 — a published tropical-cyclone or extreme-heat case in the last 48 h.
  const weather = findings.filter((f) => {
    if (f.rule.name !== "weather_extreme" || !PUBLIC_STATUSES.includes(f.status) || f.status === "retracted") return false;
    const code = valueOf(f, "hazardCode");
    return (code === 1 || code === 2) && (within(publishedAt(f), now, 48) || within(f.observedAt, now, 48));
  });
  if (weather.length) reasons.push({ code: "weather_published", level: "urgent", text: `Published extreme heat or tropical cyclone: ${places(weather)}.`, caseIds: weather.map((f) => f.findingId) });

  // U4 / W3 — sea ice below the record for the date (urgent) or below the 1981–2010 p10 (watch).
  for (const s of ind.seaIce ?? []) {
    const latest = [...s.daily].reverse().find((p) => p.v !== null);
    if (!latest || latest.v === null) continue;
    const label = s.pole === "north" ? "Arctic" : "Antarctic";
    const hemi = s.pole === "north" ? "arctic" : "antarctic";
    const cases = findings.filter((f) => live(f) && indicatorOf(f) === "sea_ice" && (hemisphereOf(f) ?? "arctic") === hemi).map((f) => f.findingId);
    const record = seaIceRecordFor(s.daily, latest.t);
    if (record !== null && latest.v < record) {
      reasons.push({ code: "sea_ice_record", level: "urgent", text: `${label} sea ice is at a record low for ${latest.t.slice(5)}: ${latest.v} million km², below the previous lowest of ${record}.`, caseIds: cases, indicator: `sea_ice_${s.pole}` });
      continue;
    }
    const doy = dayOfYearUtc(latest.t);
    const c = s.clim.find((r) => r.doy === doy);
    if (c && latest.v < c.p10) reasons.push({ code: "sea_ice_p10", level: "watch", text: `${label} sea ice is in the lowest tenth for the date: ${latest.v} million km² (1981–2010 p10 ${c.p10}).`, caseIds: cases, indicator: `sea_ice_${s.pole}` });
  }

  // U5 — acute cases newly confirmed in the last 24 h at ≥ 3 distinct places (AOI ids) in one 5° box.
  const fresh = findings.filter((f) => live(f) && isAcute(f) && f.confirmed && within(f.confirmed.at, now, 24));
  const byRegion = new Map<string, Finding[]>();
  for (const f of fresh) byRegion.set(regionOf(f), [...(byRegion.get(regionOf(f)) ?? []), f]);
  for (const [, fs] of byRegion) {
    if (new Set(fs.map((f) => f.aoi?.id ?? f.findingId)).size >= 3) reasons.push({ code: "regional_cluster", level: "urgent", text: `${fs.length} urgent cases confirmed in one region within a day: ${places(fs)}.`, caseIds: fs.map((f) => f.findingId) });
  }

  // W1 — any newly confirmed case in the last 7 days.
  const week = findings.filter((f) => live(f) && f.confirmed && within(f.confirmed.at, now, 7 * 24));
  if (week.length) reasons.push({ code: "new_confirmed", level: "watch", text: `${week.length} case${week.length === 1 ? "" : "s"} confirmed by a second, independent signal in the last 7 days.`, caseIds: week.map((f) => f.findingId) });

  // W2 — a world-pulse indicator leaving its own p10–p90 band.
  for (const r of ind.pulse ?? []) {
    const x = pulseCrossing(r);
    if (x) reasons.push({ code: "indicator_crossing", level: "watch", text: `${r.label} moved ${x === "above_p90" ? "above its usual range (p90)" : "below its usual range (p10)"}: ${r.latest!.v} ${r.unit}.`, caseIds: [], indicator: r.slug });
  }

  const level: Level = reasons.some((r) => r.level === "urgent") ? "urgent" : reasons.length ? "watch" : "quiet";
  return { level, reasons };
}

function dayOfYearUtc(date: string): number {
  const d = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Math.round((d - Date.UTC(Number(date.slice(0, 4)), 0, 0)) / 86_400_000);
}

// ---- Dossier: everything the briefing model may know ----------------------------------------

export interface DossierCase {
  caseId: string;
  headline: string;
  topic: string;
  place: string | null;
  status: Status;
}
export interface DossierIndicator {
  indicator: string;
  label: string;
  unit: string;
  latest: number;
  latestDate: string;
  normal: number | null;
  normalMeans: string;
}
export interface Dossier {
  date: string;
  level: Level;
  reasons: Reason[];
  sinceYesterday: { byStatus: Partial<Record<Status, number>>; byTopic: Record<string, number> };
  newPublished: DossierCase[];
  goodNews: DossierCase[];
  indicators: DossierIndicator[];
  falseAlarmsCaught: { last7Days: number; caseIds: string[] };
}

const headlineOf = (f: Finding) => (f.narration?.text.split("\n")[0]?.trim() || f.title).slice(0, 200);
const dcase = (f: Finding): DossierCase => ({ caseId: f.findingId, headline: headlineOf(f), topic: topicOf(f.rule.name, indicatorOf(f), f.aoi?.tags ?? []), place: f.aoi?.name ?? null, status: f.status });
const r3 = (v: number) => Number(v.toPrecision(3));

/** Pure: the facts behind one day's briefing. */
export function buildDossier(findings: readonly Finding[], ind: IndicatorInputs, now = new Date()): Dossier {
  const { level, reasons } = computeLevel(findings, ind, now);
  const byStatus: Partial<Record<Status, number>> = {};
  const byTopic: Record<string, number> = {};
  for (const f of findings) {
    if (!within(f.updatedAt, now, 24)) continue;
    byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    const t = topicOf(f.rule.name, indicatorOf(f), f.aoi?.tags ?? []);
    byTopic[t] = (byTopic[t] ?? 0) + 1;
  }
  const pub = findings.filter((f) => PUBLIC_STATUSES.includes(f.status) && f.status !== "retracted");
  const newPublished = pub.filter((f) => within(publishedAt(f), now, 24)).map(dcase);
  const goodNews = pub.filter((f) => f.aoi?.tags?.includes("improvement") || f.rule.name === "flaring_stopped").filter((f) => within(publishedAt(f), now, 7 * 24)).map(dcase);
  const fps = findings.filter((f) => f.status === "false_positive" && within(f.updatedAt, now, 7 * 24));

  const indicators: DossierIndicator[] = [];
  const oni = ind.oni ?? [];
  if (oni.length) {
    const p = ensoPhase(oni);
    indicators.push({ indicator: "enso", label: `ENSO (ONI), current phase ${declared(oni)}`, unit: "°C", latest: p.latest.anom, latestDate: `${p.latest.season} ${p.latest.year}`, normal: 0, normalMeans: "ONI 0 = neutral; El Niño at +0.5 or above for 5 seasons, La Niña at −0.5 or below" });
  }
  for (const s of ind.seaIce ?? []) {
    const latest = [...s.daily].reverse().find((p) => p.v !== null);
    if (!latest || latest.v === null) continue;
    const c = s.clim.find((r) => r.doy === dayOfYearUtc(latest.t));
    indicators.push({ indicator: `sea_ice_${s.pole}`, label: `${s.pole === "north" ? "Arctic" : "Antarctic"} sea-ice extent`, unit: "million km²", latest: latest.v, latestDate: latest.t, normal: c ? c.average : null, normalMeans: "1981–2010 average for this day of the year" });
  }
  for (const r of ind.pulse ?? []) {
    if (r.status !== "ok" || !r.latest || r.latest.v === null) continue;
    indicators.push({ indicator: r.slug, label: r.label, unit: r.unit, latest: r3(r.latest.v), latestDate: r.latest.t, normal: r.previous?.v != null ? r3(r.previous.v) : null, normalMeans: `previous reading (${r.previous?.t ?? "n/a"}); trend ${r.direction ?? "flat"}` });
  }
  return {
    date: now.toISOString().slice(0, 10),
    level,
    reasons,
    sinceYesterday: { byStatus, byTopic },
    newPublished,
    goodNews,
    indicators,
    falseAlarmsCaught: { last7Days: fps.length, caseIds: fps.map((f) => f.findingId) },
  };
}

export const dossierHash = (d: Dossier) => createHash("sha256").update(canonicalize(d)).digest("hex");

// ---- The briefing text and its record ------------------------------------------------------

export interface BriefingItem {
  caseId?: string;
  indicator?: string;
  line: string;
}
export interface Briefing {
  headline: string;
  summary: string;
  items: BriefingItem[];
}

export interface SituationRecord {
  v: 1;
  date: string;
  generatedAt: string;
  level: Level;
  reasons: Reason[];
  dossierHash: string;
  dossier: Dossier;
  text: Briefing;
  /** "model": written by the narrator and accepted by the reviewer; "rules": the plain fallback. */
  source: "model" | "rules";
  models: null | { narrator: string; reviewer: string };
  verdict: null | { accept: boolean; reason: string };
  /** The model's draft when it was not used (failed the checks or the reviewer) — kept for the record, never shown. */
  draft?: Briefing | null;
  /** Deterministic check failures (faithfulness, no persons, JSON), when the model text was dropped. */
  problems: string[];
  /** Model calls spent on today's briefing so far (cap: one briefing a day). */
  modelBriefings: number;
  costUsd: number;
  note: string;
}

export const LEVEL_LABEL: Record<Level, string> = { quiet: "Quiet", watch: "Watch", urgent: "Urgent" };
export const SITUATION_NOTE = "Level decided by fixed rules, not by AI. Kept beside the signed ledger, not in it: the ledger records only per-case events.";

/** Pure: the rules-only briefing — level and reasons as plain sentences, no model text. */
export function fallbackBriefing(level: Level, reasons: readonly Reason[]): Briefing {
  if (!reasons.length) return { headline: "Quiet: nothing urgent in the watch today", summary: "No rule for urgent or watch fired today. No newly confirmed cases in the last 7 days and no watched indicator left its usual range.", items: [] };
  const top = reasons.find((r) => r.level === level) ?? reasons[0]!;
  const headline = `${LEVEL_LABEL[level]}: ${top.text.replace(/\.$/, "")}`;
  return {
    headline: headline.length > 90 ? `${headline.slice(0, 89).trimEnd()}…` : headline,
    summary: reasons.map((r) => r.text).join(" "),
    items: reasons.slice(0, 6).map((r) => ({ ...(r.caseIds[0] ? { caseId: r.caseIds[0] } : r.indicator ? { indicator: r.indicator } : {}), line: r.text })),
  };
}

export const situationDir = (ledgerDir: string) => join(ledgerDir, "situation");
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

export function readSituation(ledgerDir: string, date: string): SituationRecord | null {
  const p = join(situationDir(ledgerDir), `${date}.json`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as SituationRecord;
    return r && r.v === 1 && LEVELS.includes(r.level) ? r : null;
  } catch {
    return null;
  }
}

/** Every stored day, newest first. */
export function listSituations(ledgerDir: string): SituationRecord[] {
  const dir = situationDir(ledgerDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => DATE_FILE.test(f))
    .sort()
    .reverse()
    .map((f) => readSituation(ledgerDir, f.slice(0, 10)))
    .filter((r): r is SituationRecord => r !== null);
}

/** Write today's record and drop days older than `keepDays`. */
export function writeSituation(ledgerDir: string, rec: SituationRecord, keepDays = 30): void {
  const dir = situationDir(ledgerDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.date}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  const cutoff = new Date(Date.parse(`${rec.date}T00:00:00Z`) - keepDays * 86_400_000).toISOString().slice(0, 10);
  for (const f of readdirSync(dir)) if (DATE_FILE.test(f) && f.slice(0, 10) <= cutoff) rmSync(join(dir, f), { force: true });
}
