import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assess, fetchIndicator, INDICATOR_GROUPS, INDICATORS, indicator, type Assessment, type Indicator, type IndicatorGroup } from "../clients/owid.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import { decimate } from "../series.js";
import { newId, nowIso } from "../util.js";

const SOURCE = "Our World in Data (CC BY 4.0; upstream licences per indicator)";

export interface PulseRow {
  slug: string;
  label: string;
  unit: string;
  group: IndicatorGroup;
  betterWhen: "up" | "down";
  upstream: string;
  licence: string;
  status: "ok" | "unavailable";
  error?: string;
  latest?: { t: string; v: number | null } | null;
  /** The valid point before `latest` (year-over-year comparisons), or null. */
  previous?: { t: string; v: number | null } | null;
  direction?: Assessment["direction"];
  pace?: Assessment["pace"];
  pctPerDecade?: number | null;
  perDecade?: number | null;
  sparkline?: { t: string; v: number | null }[];
}

/** Pure: build one row from a fetched series (exported for tests). */
export function pulseRow(ind: Indicator, points: { t: string; v: number | null }[]): PulseRow {
  const a = assess(points, ind.betterWhen, ind.flatPct);
  return {
    slug: ind.slug,
    label: ind.label,
    unit: ind.unit,
    group: ind.group,
    betterWhen: ind.betterWhen,
    upstream: ind.upstream,
    licence: ind.licence,
    status: "ok",
    latest: a.latest,
    previous: points.filter((p) => p.v !== null).at(-2) ?? null,
    direction: a.direction,
    pace: a.pace,
    pctPerDecade: a.pctPerDecade,
    perDecade: a.trend10y?.perDecade ?? null,
    sparkline: decimate(points, 60),
  };
}

/**
 * Pure: which indicators a call asks for — explicit slugs win, else the groups (default
 * all) — ordered by group so the card renders one section per group.
 */
export function selectIndicators(slugs?: string[], groups?: IndicatorGroup[]): Indicator[] {
  const picked = slugs?.length
    ? slugs.map((s) => indicator(s) ?? unknownIndicator(s))
    : INDICATORS.filter((i) => !groups?.length || groups.includes(i.group));
  const order = (i: Indicator) => INDICATOR_GROUPS.indexOf(i.group);
  return picked.map((ind, idx) => ({ ind, idx })).sort((a, b) => order(a.ind) - order(b.ind) || a.idx - b.idx).map((x) => x.ind);
}

export interface WorldPulse {
  source: string;
  generatedAt: string;
  rows: PulseRow[];
  counts: { improving: number; worsening: number; flat: number; unavailable: number };
  summary: string;
}

/** Fetch every selected indicator in parallel; a failing source becomes an "unavailable" row. */
export async function worldPulse(indicators?: string[], groups?: IndicatorGroup[]): Promise<WorldPulse> {
  const wanted = selectIndicators(indicators, groups);
  const settled = await Promise.allSettled(wanted.map((ind) => fetchIndicator(ind)));
  const rows: PulseRow[] = settled.map((r, i) => {
    const ind = wanted[i]!;
    if (r.status === "fulfilled") return pulseRow(ind, r.value);
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return { slug: ind.slug, label: ind.label, unit: ind.unit, group: ind.group, betterWhen: ind.betterWhen, upstream: ind.upstream, licence: ind.licence, status: "unavailable", error: msg };
  });
  const ok = rows.filter((r) => r.status === "ok");
  const counts = {
    improving: ok.filter((r) => r.direction === "improving").length,
    worsening: ok.filter((r) => r.direction === "worsening").length,
    flat: ok.filter((r) => r.direction === "flat").length,
    unavailable: rows.length - ok.length,
  };
  const summary =
    `${counts.improving} improving · ${counts.worsening} worsening · ${counts.flat} flat` +
    (counts.unavailable ? ` · ${counts.unavailable} unavailable` : "") +
    ". Improving: " + (ok.filter((r) => r.direction === "improving").map((r) => r.label).join(", ") || "—") +
    ". Worsening: " + (ok.filter((r) => r.direction === "worsening").map((r) => r.label).join(", ") || "—") + ".";
  return { source: SOURCE, generatedAt: nowIso(), rows, counts, summary };
}

/** Register world_pulse — civilization's and the planet's vital signs, each with an honest direction. */
export function registerWorldPulseTools(server: McpServer): void {
  server.registerTool(
    "world_pulse",
    {
      title: "World pulse — how are we and the living planet doing?",
      description:
        "Vital signs from Our World in Data (zero-key) in three groups — civilization (child " +
        "mortality, extreme poverty, life expectancy, literacy, renewable and coal electricity, " +
        "solar, disaster deaths), life (Living Planet Index, Red List Index, fish stocks, marine " +
        "and land protected areas, forest area, tree cover loss) and planet (CO₂ per person, " +
        "ocean pH, agricultural land, nitrogen, pesticides, freshwater withdrawals, plastic, " +
        "ozone-depleting substances). Each indicator " +
        "declares which direction is better, so the result says plainly what is improving, what " +
        "is worsening, and what is accelerating — good news and bad, not a news feed. Fetched in " +
        "parallel; any source that fails is reported as unavailable. Posts a pulse card to the dashboard.",
      inputSchema: {
        indicators: z
          .array(z.string())
          .optional()
          .describe(`Subset of indicator slugs (default: all). Known: ${INDICATORS.map((i) => i.slug).join(", ")}`),
        groups: z
          .array(z.enum(INDICATOR_GROUPS as [IndicatorGroup, ...IndicatorGroup[]]))
          .optional()
          .describe("Only these groups: civilization, life, planet (default: all). Ignored when `indicators` is given."),
      },
    },
    async ({ indicators, groups }) =>
      safe(async () => {
        const { rows, counts, summary } = await worldPulse(indicators, groups);
        const pushed = await pushCard({
          id: newId(),
          type: "worldpulse",
          ts: nowIso(),
          title: `World pulse · ${counts.improving}↑ ${counts.worsening}↓`,
          payload: { rows, counts, summary, source: SOURCE },
        });
        return { source: SOURCE, counts, summary, indicators: rows.map(({ sparkline, ...r }) => r), dashboard: pushed ? "card pushed" : "dashboard not running" };
      }),
  );
}

function unknownIndicator(slug: string): never {
  throw new OverviewError(`unknown indicator "${slug}". Known: ${INDICATORS.map((i) => i.slug).join(", ")}`);
}
