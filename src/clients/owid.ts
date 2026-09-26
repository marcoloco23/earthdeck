// Our World in Data — civilization's vital signs, zero-key, CC BY 4.0 (upstream licences
// vary per indicator and are recorded in the registry). The grapher CSV endpoint is
// documented at https://docs.owid.io/projects/etl/api/ ; ⚠️ VERIFY LIVE: URL shape and
// column names were taken from docs, not a live call (sandbox had no egress).
//
// Every indicator declares `betterWhen`, so the pulse can say "improving" / "worsening"
// honestly instead of leaving the reader to guess which direction is good.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import { linearTrend, round, summarize, type SeriesPoint, type Trend } from "../series.js";

export const OWID_BASE = "https://ourworldindata.org/grapher";

export interface Indicator {
  slug: string; // grapher chart slug
  label: string;
  unit: string;
  betterWhen: "up" | "down";
  /** Upstream producer — the licence that actually applies to the numbers. */
  upstream: string;
  licence: string;
  /** Entity to fetch (World aggregate by default). */
  entity?: string;
}

/** The registry. Adding an indicator is one line — but check its upstream licence first. */
export const INDICATORS: readonly Indicator[] = [
  { slug: "child-mortality", label: "Child mortality (under-5)", unit: "% of live births", betterWhen: "down", upstream: "UN IGME", licence: "CC BY 4.0" },
  { slug: "share-of-population-in-extreme-poverty", label: "Extreme poverty", unit: "% of population", betterWhen: "down", upstream: "World Bank PIP", licence: "CC BY 4.0" },
  { slug: "life-expectancy", label: "Life expectancy at birth", unit: "years", betterWhen: "up", upstream: "UN WPP / HMD", licence: "CC BY 3.0 IGO" },
  { slug: "cross-country-literacy-rates", label: "Adult literacy", unit: "%", betterWhen: "up", upstream: "UNESCO UIS / World Bank", licence: "CC BY 4.0" },
  { slug: "share-electricity-renewables", label: "Renewable share of electricity", unit: "%", betterWhen: "up", upstream: "Ember / Energy Institute", licence: "CC BY 4.0" },
  { slug: "share-electricity-coal", label: "Coal share of electricity", unit: "%", betterWhen: "down", upstream: "Ember / Energy Institute", licence: "CC BY 4.0" },
  { slug: "installed-solar-pv-capacity", label: "Installed solar capacity", unit: "GW", betterWhen: "up", upstream: "IRENA", licence: "CC BY 4.0" },
  { slug: "co-emissions-per-capita", label: "CO₂ emissions per person", unit: "t/yr", betterWhen: "down", upstream: "Global Carbon Budget", licence: "CC BY 4.0" },
  { slug: "forest-area-km", label: "Forest area", unit: "km²", betterWhen: "up", upstream: "FAO FRA", licence: "CC BY 4.0" },
  { slug: "terrestrial-protected-areas", label: "Protected land", unit: "% of land area", betterWhen: "up", upstream: "UNEP-WCMC via World Bank", licence: "CC BY 4.0" },
  { slug: "number-of-deaths-from-natural-disasters", label: "Deaths from natural disasters", unit: "people/yr", betterWhen: "down", upstream: "EM-DAT (CRED)", licence: "EM-DAT terms — non-commercial; attribute" },
];

export function indicator(slug: string): Indicator | undefined {
  return INDICATORS.find((i) => i.slug === slug);
}

/** OWID grapher CSV URL for one chart, filtered to one entity. */
export function owidUrl(ind: Indicator): string {
  const entity = ind.entity ?? "OWID_WRL";
  return `${OWID_BASE}/${ind.slug}.csv?v=1&csvType=filtered&useColumnShortNames=true&country=${encodeURIComponent(entity)}`;
}

/**
 * Parse a grapher CSV (`Entity,Code,Year,<value>[,…]`) into annual points. Takes the first
 * numeric column after Year — grapher charts with several columns put the headline first.
 */
export function parseOwidCsv(text: string): SeriesPoint[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new OverviewError("OWID CSV: no data rows");
  const header = splitCsv(lines[0]!);
  const yearIdx = header.findIndex((h) => h.toLowerCase() === "year");
  if (yearIdx < 0 || header.length <= yearIdx + 1) throw new OverviewError("OWID CSV: unexpected header — format changed?");
  const valIdx = yearIdx + 1;
  const out: SeriesPoint[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    const y = cols[yearIdx];
    const v = cols[valIdx];
    if (!y || !/^-?\d{1,4}$/.test(y)) continue;
    const num = v === undefined || v === "" ? null : Number(v);
    out.push({ t: y.padStart(4, "0"), v: num !== null && Number.isFinite(num) ? num : null });
  }
  if (out.length === 0) throw new OverviewError("OWID CSV: no year rows parsed");
  return out.sort((a, b) => (a.t < b.t ? -1 : 1));
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export type Direction = "improving" | "worsening" | "flat";
export type Pace = "accelerating" | "steady" | "slowing" | "reversed";

export interface Assessment {
  latest: SeriesPoint | null;
  trend10y: Trend | null;
  direction: Direction;
  pace: Pace | null;
  /** Relative change per decade vs the period mean, in % — comparable across units. */
  pctPerDecade: number | null;
}

/**
 * Direction of the last ~10 years vs `betterWhen`; pace compares the last 5 years'
 * slope against the prior 10. "flat" = under ±1 % of the mean per decade.
 */
export function assess(points: SeriesPoint[], betterWhen: "up" | "down"): Assessment {
  const valid = points.filter((p) => p.v !== null);
  const latest = valid[valid.length - 1] ?? null;
  if (!latest) return { latest: null, trend10y: null, direction: "flat", pace: null, pctPerDecade: null };
  const lastYear = Number(latest.t);
  const window = (from: number, to: number) => valid.filter((p) => Number(p.t) > lastYear - from && Number(p.t) <= lastYear - to);
  const recent10 = window(10, 0);
  const trend10y = linearTrend(recent10);
  const mean = summarize(recent10).mean;
  const pctPerDecade = trend10y && mean ? round((trend10y.perDecade / Math.abs(mean)) * 100, 1) : null;
  let direction: Direction = "flat";
  if (pctPerDecade !== null && Math.abs(pctPerDecade) >= 1) {
    const good = betterWhen === "up" ? pctPerDecade > 0 : pctPerDecade < 0;
    direction = good ? "improving" : "worsening";
  }
  const t5 = linearTrend(window(5, 0));
  const tPrior = linearTrend(window(15, 5));
  let pace: Pace | null = null;
  if (t5 && tPrior && tPrior.perYear !== 0) {
    const ratio = t5.perYear / tPrior.perYear;
    pace = ratio < 0 ? "reversed" : ratio > 1.25 ? "accelerating" : ratio < 0.75 ? "slowing" : "steady";
  }
  return { latest, trend10y, direction, pace, pctPerDecade };
}

export async function fetchIndicator(ind: Indicator): Promise<SeriesPoint[]> {
  const res = await fetch(owidUrl(ind), { headers: { "user-agent": USER_AGENT, accept: "text/csv" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`OWID ${ind.slug} request failed (${res.status})`, res.status, body.slice(0, 300));
  }
  return parseOwidCsv(await res.text());
}
