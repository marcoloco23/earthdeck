import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCopernicus } from "../clients/copernicus.js";
import {
  CARBON_MAPPER_URL,
  ch4Anomaly,
  EMIT_LICENCE,
  EMIT_PLUMES_URL,
  emitPlumes,
  plumesIn,
  S5P_CH4_SOURCE,
  S5P_MIN_QA,
  s5pRasterSize,
  toCh4Buckets,
  type Ch4Anomaly,
  type Ch4Bucket,
  type Plume,
} from "../clients/methane.js";
import { pushCard } from "../dashboard/push.js";
import { S5P_CH4_EVALSCRIPT } from "../evalscripts.js";
import { s5pProvenance, type Provenance } from "../provenance.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const MARS_STATUS = {
  source: "UNEP IMEO MARS (Eye on Methane)",
  status: "unavailable",
  url: "https://methanedata.unep.org/",
  reason:
    "No unattended public endpoint: the API requires authorization (unep-methanedata@un.org) and the " +
    "CSV/GeoJSON download page is behind a Cloudflare challenge. Plumes are published 30 days after detection.",
} as const;

const CARBON_MAPPER_STATUS = {
  source: "Carbon Mapper",
  status: "link-only",
  url: CARBON_MAPPER_URL,
  reason: "Non-commercial + revocable licence — linked for manual review, never fetched or republished.",
} as const;

export interface Ch4Result {
  window: { from: string; to: string };
  baselineWindow: { from: string; to: string };
  bucketDays: number;
  anomaly: Ch4Anomaly | null;
  buckets: Ch4Bucket[];
  provenance: Provenance;
}

/** S5P CH₄: one Statistics request → baseline buckets + the recent bucket → anomaly. */
async function ch4For(box: BBox, date: string, windowDays: number, baselineDays: number): Promise<Ch4Result> {
  const end = addDays(date, 1); // exclusive; the recent window includes `date`
  const recentFrom = addDays(end, -windowDays);
  const nBase = Math.max(2, Math.round(baselineDays / windowDays));
  const baseFrom = addDays(recentFrom, -nBase * windowDays);
  const series = await getCopernicus().statisticsSeries(box, {
    dateFrom: baseFrom,
    dateTo: end,
    intervalDays: windowDays,
    evalscript: S5P_CH4_EVALSCRIPT,
    source: S5P_CH4_SOURCE,
    ...s5pRasterSize(box),
  });
  const buckets = toCh4Buckets(series);
  const recent = buckets.find((b) => b.from === recentFrom) ?? { from: recentFrom, to: end, meanPpb: null, validPct: 0 };
  const baseline = buckets.filter((b) => b.from < recentFrom);
  const anomaly = ch4Anomaly(recent, baseline);
  return {
    window: { from: recentFrom, to: date },
    baselineWindow: { from: baseFrom, to: addDays(recentFrom, -1) },
    bucketDays: windowDays,
    anomaly,
    buckets,
    provenance: s5pProvenance({ bbox: box, from: baseFrom, to: date, minQa: S5P_MIN_QA, validPct: recent.validPct }),
  };
}

function interpret(c: Ch4Result): string {
  const a = c.anomaly;
  if (!a) return `No usable S5P CH₄ retrievals in ${c.window.from}…${c.window.to} or its baseline (cloud / QA gaps / product latency).`;
  const sign = a.deltaPpb >= 0 ? "+" : "";
  return (
    `Mean XCH₄ ${a.recentPpb} ppb in ${c.window.from}…${c.window.to} vs ${a.baselinePpb} ppb over the prior ` +
    `${a.bucketsUsed}×${c.bucketDays}-day baseline (${sign}${a.deltaPpb} ppb` +
    (a.z != null ? `, z ≈ ${a.z} vs baseline variability ±${a.baselineSdPpb} ppb` : "") +
    `; ${a.validPct}% of pixels had a retrieval).` +
    (a.validPct < 40 ? " ⚠️ Sparse recent coverage — treat with caution." : "")
  );
}

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box [west, south, east, north] in degrees (EPSG:4326)");

/** Register methane_plumes: S5P CH₄ anomaly + EMIT plume points (+ MARS / Carbon Mapper status). */
export function registerMethaneTools(server: McpServer): void {
  server.registerTool(
    "methane_plumes",
    {
      title: "Methane: S5P CH₄ anomaly + EMIT plumes",
      description:
        "Methane over a bbox from two independent sensors. (1) Sentinel-5P TROPOMI CH₄ column (ppb, ~7 km " +
        "pixels) via Copernicus: mean over a recent window vs a ~90-day baseline of equal-length buckets → " +
        "anomaly (Δ ppb, z-ish score vs baseline variability) and % valid. (2) NASA JPL EMIT plume complexes " +
        "(public domain) inside the bbox: datetime, emission rate (kg/h) when estimated, location, link. UNEP " +
        "MARS has no unattended public endpoint (reported, skipped); Carbon Mapper is link-only. A regional CH₄ " +
        "anomaly is NOT facility attribution. include: all (default) | ch4 | plumes. S5P part requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        windowDays: z.number().int().min(7).max(31).optional().describe("Recent window + baseline bucket length, days (default 14)."),
        baselineDays: z.number().int().min(28).max(180).optional().describe("Baseline length before the recent window, days (default 90)."),
        plumeDays: z.number().int().min(1).max(1095).optional().describe("Plume lookback from date, days (default 90)."),
        include: z.enum(["all", "ch4", "plumes"]).optional().describe("Which parts to fetch (default all)."),
      },
    },
    async ({ bbox, date, windowDays, baselineDays, plumeDays, include }) =>
      safe(async () => {
        const box = bbox as BBox;
        const day = date ?? isoDate(0);
        const inc = include ?? "all";

        const ch4 = inc === "plumes" ? null : await ch4For(box, day, windowDays ?? 14, baselineDays ?? 90);

        let plumes: Plume[] | null = null;
        let plumeWindow: { from: string; to: string } | null = null;
        const sources: Record<string, unknown>[] = [];
        if (inc !== "ch4") {
          plumeWindow = { from: addDays(day, -(plumeDays ?? 90)), to: day };
          try {
            const all = await emitPlumes();
            plumes = plumesIn(all, box, plumeWindow.from, plumeWindow.to);
            const feedLatest = all.reduce((m, p) => (p.datetime > m ? p.datetime : m), "");
            sources.push({ source: "EMIT (NASA JPL)", status: "ok", count: plumes.length, feedLatest, url: EMIT_PLUMES_URL, licence: EMIT_LICENCE });
          } catch (err) {
            plumes = [];
            sources.push({ source: "EMIT (NASA JPL)", status: "error", error: err instanceof Error ? err.message : String(err), url: EMIT_PLUMES_URL });
          }
          sources.push(MARS_STATUS, CARBON_MAPPER_STATUS);
        }

        let dashboard = "not pushed";
        if (ch4) {
          const pts = ch4.buckets.filter((b) => b.meanPpb != null).map((b) => ({ t: b.from, v: b.meanPpb! }));
          const a = ch4.anomaly;
          const pushed = await pushCard({
            id: newId(),
            type: "series",
            ts: nowIso(),
            title: a
              ? `S5P CH₄ ${a.deltaPpb >= 0 ? "+" : ""}${a.deltaPpb} ppb vs baseline · ${ch4.window.from}…${ch4.window.to}`
              : `S5P CH₄ · no usable retrievals · ${ch4.window.from}…${ch4.window.to}`,
            bbox: box,
            payload: {
              series: [{ label: `XCH₄ (${ch4.bucketDays}-day means)`, unit: "ppb", points: pts }],
              thresholds: a ? [a.baselinePpb] : [],
              summary: interpret(ch4) + (plumes ? ` EMIT plumes in bbox (${plumeWindow!.from}…${plumeWindow!.to}): ${plumes.length}.` : ""),
              source: "Copernicus Sentinel-5P TROPOMI CH₄ (+ NASA JPL EMIT plumes)",
              provenance: ch4.provenance,
            },
          });
          dashboard = pushed ? "pushed" : "dashboard offline";
        }

        return {
          bbox: box,
          ...(ch4
            ? {
                ch4: {
                  window: ch4.window,
                  baselineWindow: ch4.baselineWindow,
                  bucketDays: ch4.bucketDays,
                  anomaly: ch4.anomaly,
                  buckets: ch4.buckets,
                  interpretation: interpret(ch4),
                },
                provenance: ch4.provenance,
              }
            : {}),
          ...(plumeWindow ? { plumeWindow, plumes, plumeSources: sources } : {}),
          dashboard,
        };
      }),
  );
}
