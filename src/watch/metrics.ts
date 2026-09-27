// `api/metrics.json` — every report on one screen (the landing's Metrics mode). Computed at export
// time so the page stays static: totals by status and topic, cases over time, the places with the
// most cases, the published false-alarm rate per rule, and what's at stake — each stake metric
// carries the ids of the cases behind it, so a click can filter the map to exactly those.
//
// Stakes count only cases that passed a second, independent check (confirmed or public, not
// resolved or retracted) — the same set as the living-value tile. A metric with no case behind it
// is left out rather than shown as 0: "no data" is not "nothing at stake".

import type { Finding, Status } from "../ledger/schema.js";
import { livingValueOf, type SiteStats } from "./export.js";
import { groupOf, indicatorOf, isGlobalCase, topicOf, type MapGroup, type MapTopic } from "./map-data.js";
import { areaHaOf, fmtUsd, GLOBAL_NATURE_VALUE } from "./site-render.js";

export interface StakeMetric {
  key: string;
  label: string;
  value: number;
  /** The number as a person reads it ("$3.4M a year", "1,240 ha"). */
  display: string;
  /** One plain line: what the number is, and what it is not. */
  explain: string;
  caseIds: string[];
}

export interface Metrics {
  v: 1;
  generatedAt: string;
  totals: { all: number; byGroup: Record<MapGroup, number>; byTopic: Partial<Record<MapTopic, number>> };
  timeline: { bucket: "day" | "week" | "month"; points: { t: string; published: number; checking: number; dropped: number }[] };
  places: { name: string; n: number; caseIds: string[] }[];
  rules: { rule: string; label: string; falsePositives: number; decided: number; rate: number | null }[];
  stake: StakeMetric[];
  nature: { lowUsd: number; highUsd: number; source: string };
}

/** Confirmed or public, and not closed — the cases whose stakes we stand behind. */
const AT_STAKE: readonly Status[] = ["confirmed", "published", "notified", "replied", "no_response", "ignored"];

export const RULE_LABEL: Record<string, string> = {
  forest_loss: "Forest loss",
  fires_in_protected: "Fires in protected land",
  flaring: "Gas flaring",
  flaring_stopped: "Flaring stopped",
  methane_anomaly: "Methane",
  indicator_threshold: "Planet indicators",
  indicator_trend: "World trends",
  weather_extreme: "Extreme weather",
};

/** Largest numeric value under any of `keys` across a finding's evidence (incl. the confirming signal). */
export function maxValue(f: Finding, keys: readonly string[]): number | null {
  let best: number | null = null;
  for (const e of [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])]) {
    for (const k of keys) {
      const v = e.values?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && (best === null || v > best)) best = v;
    }
  }
  return best;
}

const DAY_MS = 86_400_000;
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const sig = (v: number) => (v >= 100 ? int(v) : String(Number(v.toPrecision(2))));

/** Start of the bucket holding `iso`, as YYYY-MM-DD (weeks start on Monday, UTC). */
export function bucketOf(iso: string, bucket: "day" | "week" | "month"): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (bucket === "month") return `${d.toISOString().slice(0, 7)}-01`;
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === "day") return new Date(day).toISOString().slice(0, 10);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day - dow * DAY_MS).toISOString().slice(0, 10);
}

/** Pure: the Metrics screen's numbers from the ledger's findings (and the export's stats for the rates). */
export function computeMetrics(findings: readonly Finding[], stats: Pick<SiteStats, "falsePositiveRate">, now = new Date()): Metrics {
  const byGroup: Record<MapGroup, number> = { published: 0, checking: 0, dropped: 0 };
  const byTopic: Partial<Record<MapTopic, number>> = {};
  const places = new Map<string, { name: string; ids: string[] }>();
  for (const f of findings) {
    byGroup[groupOf(f.status)] += 1;
    const indicator = indicatorOf(f);
    const topic = topicOf(f.rule.name, indicator);
    byTopic[topic] = (byTopic[topic] ?? 0) + 1;
    if (f.aoi?.name && !isGlobalCase({ bbox: f.bbox, aoiId: f.aoi.id, indicator })) {
      const p = places.get(f.aoi.id) ?? { name: f.aoi.name, ids: [] };
      p.ids.push(f.findingId);
      places.set(f.aoi.id, p);
    }
  }

  // Cases over time, by when the watch opened them: days for a young ledger, then weeks, then months.
  const times = findings.map((f) => Date.parse(f.createdAt)).filter((t) => !Number.isNaN(t));
  const span = times.length ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
  const bucket = span <= 45 ? "day" : span <= 400 ? "week" : "month";
  const series = new Map<string, { published: number; checking: number; dropped: number }>();
  for (const f of findings) {
    const b = bucketOf(f.createdAt, bucket);
    if (!b) continue;
    const row = series.get(b) ?? { published: 0, checking: 0, dropped: 0 };
    row[groupOf(f.status)] += 1;
    series.set(b, row);
  }
  const points = [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, r]) => ({ t, ...r }));

  const rules = Object.entries(stats.falsePositiveRate.byRule)
    .map(([rule, c]) => ({ rule, label: RULE_LABEL[rule] ?? rule.replace(/_/g, " "), falsePositives: c.falsePositives, decided: c.decided, rate: c.rate }))
    .sort((a, b) => b.decided - a.decided || a.label.localeCompare(b.label));

  // What's at stake — only where a case carries the number, only cases we stand behind.
  const open = findings.filter((f) => AT_STAKE.includes(f.status));
  const stake: StakeMetric[] = [];
  const sum = (key: string, label: string, pick: (f: Finding) => number | null, display: (v: number) => string, explain: (n: number) => string) => {
    let total = 0;
    const ids: string[] = [];
    for (const f of open) {
      const v = pick(f);
      if (v !== null && v > 0) {
        total += v;
        ids.push(f.findingId);
      }
    }
    if (ids.length) stake.push({ key, label, value: total, display: display(total), explain: explain(ids.length), caseIds: ids });
  };
  const nCases = (n: number) => `${n} checked case${n === 1 ? "" : "s"}`;
  sum("living_value", "Nature’s work at stake", livingValueOf, (v) => `${fmtUsd(v)} a year`, (n) => `A rough estimate of what the land in ${nCases(n)} does for people each year — clean water, carbon, food. Order of magnitude only.`);
  sum("forest_ha", "Forest lost", (f) => (topicOf(f.rule.name, null) === "forest" ? areaHaOf(f) : null), (v) => `${int(v)} ha`, (n) => `Hectares of forest cleared in ${nCases(n)} (one football pitch ≈ 0.7 ha).`);
  sum("flare_bcm", "Gas flared", (f) => (f.rule.name === "flaring" ? maxValue(f, ["bcm", "vnfTopBcm"]) : null), (v) => `${sig(v)} bn m³ a year`, (n) => `Gas burned off at the sites in ${nCases(n)}, from yearly satellite flare estimates — wasted energy and CO₂.`);
  sum("flare_stopped_bcm", "Flaring stopped", (f) => (f.rule.name === "flaring_stopped" ? maxValue(f, ["stopped_bcm"]) : null), (v) => `${sig(v)} bn m³ a year`, (n) => `Good news: yearly flaring at sites that went dark, across ${nCases(n)}.`);
  sum("methane_t", "Methane released", (f) => maxValue(f, ["ch4_t", "methane_t", "ch4_tonnes"]), (v) => `${int(v)} t`, (n) => `Tonnes of methane estimated in ${nCases(n)} — a gas about 80× stronger than CO₂ over 20 years.`);
  sum("fishing_hours", "Fishing in protected water", (f) => maxValue(f, ["fishing_hours", "apparent_fishing_hours"]), (v) => `${int(v)} h`, (n) => `Hours of apparent fishing counted in ${nCases(n)}.`);
  sum("people_bad_air", "People breathing bad air", (f) => (topicOf(f.rule.name, indicatorOf(f)) === "air" ? maxValue(f, ["population", "people", "pop"]) : null), (v) => int(v), (n) => `People living in the cities of ${nCases(n)} while fine-particle pollution ran above the WHO limit.`);

  return {
    v: 1,
    generatedAt: now.toISOString(),
    totals: { all: findings.length, byGroup, byTopic },
    timeline: { bucket, points },
    places: [...places.values()]
      .map((p) => ({ name: p.name, n: p.ids.length, caseIds: p.ids }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, 8),
    rules,
    stake,
    nature: { lowUsd: GLOBAL_NATURE_VALUE.usdPerYear.low, highUsd: GLOBAL_NATURE_VALUE.usdPerYear.high, source: GLOBAL_NATURE_VALUE.source },
  };
}
