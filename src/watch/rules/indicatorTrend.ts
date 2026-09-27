// indicator_trend@1.0 — the annual world-pulse indicators (Living Planet Index, Red List
// Index, fish stocks, ocean pH, tree cover loss, marine protected areas, …): when a NEW
// year's value appears and the 10-year direction is worsening (or improving → tag
// `improvement`), open one case for that indicator-year. Confirmation: the value reads the
// same on a later sweep (data stability — the source did not revise or retract it); same
// provider, so `independence: "method"`.
//
// Stable case scheme (the kernel keys cases by rule + AOI):
//   • one AOI per indicator, id `wp-<short>`, params.indicator = the OWID slug, cooldownDays 1
//     — so each new year's value opens a fresh case instead of piling onto last year's;
//   • detect reads this rule's earlier cases for the AOI from the ledger (`ledger_list`) and
//     stays quiet when one already has observedAt in the latest year — an indicator-year is
//     never re-opened, even after the cooldown or after the case is closed;
//   • evidence id `owid-<slug>-<year>`, observedAt `<year>-01-01T00:00:00Z`.
// If the ledger read fails the pair is a gap (fail closed), never a duplicate case.

import type { Evidence } from "../../ledger/schema.js";
import { round } from "../../series.js";
import { defineRule, type Candidate, type Confirmation, type RuleContext } from "./types.js";

interface PulseRow {
  slug: string;
  label: string;
  unit: string;
  betterWhen: "up" | "down";
  upstream: string;
  status: "ok" | "unavailable";
  error?: string;
  latest?: { t: string; v: number | null } | null;
  previous?: { t: string; v: number | null } | null;
  direction?: "improving" | "worsening" | "flat";
  pctPerDecade?: number | null;
}
interface WorldPulseResult {
  indicators: PulseRow[];
}
interface LedgerListResult {
  findings: { observedAt: string; rule: string; aoi?: { id: string } }[];
}

/** Plain-language tails for the tracked indicators: [worsening, improving]. */
const PLAIN: Record<string, [string, string]> = {
  "global-living-planet-index": ["wildlife populations keep shrinking", "wildlife populations are recovering"],
  "red-list-index": ["more species are sliding towards extinction", "fewer species are heading for extinction"],
  "fish-stocks-within-sustainable-levels": ["more of the ocean's fish stocks are overfished", "more fish stocks are fished sustainably"],
  "seawater-ph": ["the ocean keeps acidifying as it absorbs CO₂", "ocean acidification is easing"],
  "tree-cover-loss": ["the world keeps losing tree cover faster", "tree cover loss is slowing"],
  "marine-protected-areas": ["less of the ocean is protected", "more of the ocean is protected"],
};

/** Readable number: 29.6 million, 64.5, 0.74, 8.042. */
export function fmtValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${round(v / 1e6, 1)} million`;
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (a >= 10) return String(round(v, 1));
  return String(Number(v.toPrecision(4)));
}

const obsOf = (year: string) => `${year}-01-01T00:00:00Z`;

async function row(ctx: RuleContext): Promise<PulseRow> {
  const slug = ctx.params.indicator;
  if (typeof slug !== "string" || !slug) throw new Error("indicator_trend: params.indicator (an OWID slug) is required");
  const r = (await ctx.call("world_pulse", { indicators: [slug] })) as WorldPulseResult;
  const x = r.indicators.find((i) => i.slug === slug);
  if (!x) throw new Error(`world_pulse: no row for ${slug}`);
  if (x.status !== "ok") throw new Error(`world_pulse: ${slug} unavailable (${x.error ?? "no reason"})`);
  return x;
}

export const indicatorTrend = defineRule({
  name: "indicator_trend",
  version: "1.0",
  tier: 1,
  description: "A new annual value of a world indicator (wildlife, species, fish, ocean pH, forests, protected ocean) continues a worsening — or improving — 10-year trend.",
  blindSpots: [
    "Annual global indicators lag reality by 1–5 years: a 'new' value can describe a year long past.",
    "The direction is the 10-year trend, not the single year: one year can move against the trend, and the title then says so.",
    "Global aggregates hide where it happens — a stable global number can mask collapse in one region and recovery in another.",
    "Confirmation only proves the source did not revise the number on a later read — same provider, not an independent measurement.",
    "Some series are single sites (ocean pH is Station ALOHA, Hawaii) or modelled composites (Living Planet Index) with wide uncertainty bands we do not show.",
    "Upstream methods change between releases; a revised back-series can make a year look new or change the trend.",
  ],
  requires: [],
  ringKm: 0,
  defaults: {},

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const x = await row(ctx);
    const v = x.latest?.v;
    const year = x.latest?.t?.slice(0, 4);
    if (v == null || !year || !x.direction || x.direction === "flat") return null;

    // Never re-open an indicator-year: this rule's earlier cases on this AOI carry their year in observedAt.
    const seen = (await ctx.call("ledger_list", { rule: "indicator_trend", aoi: ctx.aoi.id, limit: 500 })) as LedgerListResult;
    const years = seen.findings.filter((f) => f.rule.startsWith("indicator_trend") && (!f.aoi || f.aoi.id === ctx.aoi.id)).map((f) => f.observedAt.slice(0, 4));
    if (years.includes(year)) return null;
    const lastSeen = years.sort().pop();

    const prev = x.previous?.v ?? null;
    const prevYear = x.previous?.t?.slice(0, 4) ?? null;
    const changePct = prev !== null && prev !== 0 ? round(((v - prev) / Math.abs(prev)) * 100, 2) : null;
    const verb = prev === null || v === prev ? "stood at" : v > prev ? "rose to" : "fell to";
    const improving = x.direction === "improving";
    // Did this year move with the trend or against it? (For "down is better" series, a rise is bad.)
    const yearGood = prev === null || v === prev ? null : (v > prev) === (x.betterWhen === "up");
    const plain = PLAIN[x.slug]?.[improving ? 1 : 0] ?? `the 10-year trend is ${x.direction}`;
    const against = yearGood !== null && yearGood !== improving;
    const tail = against ? `a ${yearGood ? "better" : "worse"} year, but over ten years ${plain}` : plain;

    const values: Record<string, number> = { value: v, year: Number(year) };
    if (prev !== null) values.previous = prev;
    if (changePct !== null) values.changePct = changePct;
    if (typeof x.pctPerDecade === "number") values.pctPerDecade = x.pctPerDecade;
    const observedAt = obsOf(year);
    const evidence: Evidence[] = [
      {
        id: `owid-${x.slug}-${year}`,
        kind: "series",
        source: "owid-grapher",
        collection: x.slug,
        datetime: observedAt,
        href: `https://ourworldindata.org/grapher/${x.slug}`,
        // retrievedAt: when this sweep read the value — confirmation needs a strictly later read.
        method: { name: "indicator_trend", version: "1.0", params: { indicator: x.slug, retrievedAt: ctx.now } },
        summary: `${x.label}: ${year} = ${v}${prev !== null ? ` (${prevYear} = ${prev})` : ""} ${x.unit}; 10-year trend ${x.pctPerDecade ?? "?"}% per decade (${x.direction}). Upstream: ${x.upstream}.`.slice(0, 2000),
        values,
      },
    ];
    return {
      title: `${x.label} ${verb} ${fmtValue(v)} (${x.unit}) in ${year} — ${tail}`.slice(0, 200),
      summary:
        `${x.label} ${verb} ${fmtValue(v)} (${x.unit}) in ${year}` +
        (prev !== null && changePct !== null ? `, from ${fmtValue(prev)} in ${prevYear} (${changePct >= 0 ? "+" : ""}${changePct}%)` : "") +
        `. Over the last ten years of data it is ${x.direction}` +
        (typeof x.pctPerDecade === "number" ? ` (${x.pctPerDecade >= 0 ? "+" : ""}${x.pctPerDecade}% per decade)` : "") +
        (against ? ` — this year moved the other way, which one year can do without changing the trend` : "") +
        `. Source: ${x.upstream}, via Our World in Data. A later read showing the same value confirms the source has not revised it.`,
      observedAt,
      evidence,
      values,
      notes: [`Dataset: ${x.upstream} via Our World in Data (grapher ${x.slug}); annual series, direction = 10-year linear trend.${lastSeen ? ` Last year this watch reported: ${lastSeen}.` : ""}`],
      tags: [improving ? "improvement" : "worsening"],
    };
  },

  async confirm(ctx: RuleContext, c): Promise<Confirmation | null> {
    const year = String(c.values.year ?? "");
    const first = c.evidence.find((e) => e.id.endsWith(`-${year}`) && typeof e.method.params?.retrievedAt === "string");
    const readAt = first?.method.params?.retrievedAt as string | undefined;
    if (!readAt || Date.parse(ctx.now) <= Date.parse(readAt)) return null; // same sweep: not a second read
    const x = await row(ctx);
    if (x.latest?.t?.slice(0, 4) !== year || x.latest.v == null) return null;
    if (Math.abs(x.latest.v - Number(c.values.value)) > 1e-9 * Math.max(1, Math.abs(x.latest.v))) return null; // revised: not stable (yet)
    return {
      independence: "method",
      signal: {
        id: `owid-${x.slug}-${year}-reread-${ctx.now.slice(0, 10)}`,
        kind: "series",
        source: "owid-grapher",
        collection: x.slug,
        datetime: obsOf(year),
        href: `https://ourworldindata.org/grapher/${x.slug}`,
        method: { name: "indicator_trend", version: "1.0", params: { indicator: x.slug, retrievedAt: ctx.now } },
        summary: `Re-read on ${ctx.now.slice(0, 10)}: ${year} value unchanged at ${x.latest.v} — the source has not revised it. Same provider (data stability, not an independent measurement).`,
        values: { value: x.latest.v, year: Number(year) },
      },
    };
  },
});
