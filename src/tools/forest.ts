import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GFW_CONFIDENCES, integratedAlerts, type GfwConfidence } from "../clients/gfw.js";
import { gfwApiKey } from "../config.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

// Integrated alerts are an on-the-fly 10 m raster query — cap the AOI so requests stay
// fast and within GFW's good graces. 4 deg² ≈ 49,000 km² at the equator.
const MAX_AREA_DEG2 = 4;

const GFW_SOURCE =
  "Integrated Deforestation Alerts (GLAD-L + GLAD-S2 + RADD), UMD/GLAD and WUR, via Global Forest Watch";

/** Register forest tools. Horizon 1 #5: forest_alerts (GFW integrated deforestation alerts). */
export function registerForestTools(server: McpServer): void {
  server.registerTool(
    "forest_alerts",
    {
      title: "Deforestation alerts (Global Forest Watch)",
      description:
        "Integrated deforestation alerts for a bbox from Global Forest Watch — GLAD-L, " +
        "GLAD-S2 and RADD fused into one daily 10 m layer (tropics, 30°N–30°S). Returns the " +
        "alert count, affected area (ha), confidence breakdown, and daily counts, and posts " +
        "a chart card to the dashboard. Requires a free GFW_API_KEY. Cross-reference with " +
        "eo_compare (NDVI drop) or fires_in to attribute the loss.",
      inputSchema: {
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .describe("Bounding box [west, south, east, north] in degrees (≤ 4 deg² area)"),
        days: z.number().int().min(1).max(365).optional().describe("Look back N days (default 90)."),
        minConfidence: z
          .enum(GFW_CONFIDENCES)
          .optional()
          .describe("Minimum alert confidence: nominal (default, all), high, or highest."),
      },
    },
    async ({ bbox, days, minConfidence }) =>
      safe(async () => {
        const key = gfwApiKey();
        if (!key) {
          throw new OverviewError(
            "GFW_API_KEY is not set. Create a free Global Forest Watch account and API key " +
              "(https://www.globalforestwatch.org/help/developers/guides/create-and-use-an-api-key/) " +
              "and set GFW_API_KEY.",
          );
        }
        const box = bbox as BBox;
        const [w, s, e, n] = box;
        const area = (e - w) * (n - s);
        if (area > MAX_AREA_DEG2) {
          throw new OverviewError(
            `bbox area ${area.toFixed(1)} deg² exceeds the ${MAX_AREA_DEG2} deg² cap for ` +
              "alert queries. Tile the AOI into smaller boxes and call forest_alerts per tile.",
          );
        }
        const conf = (minConfidence ?? "nominal") as GfwConfidence;
        const lookback = days ?? 90;
        const dateTo = isoDate(0);
        const dateFrom = addDays(dateTo, -lookback);
        const { summary, daily } = await integratedAlerts(key, box, dateFrom, conf);

        // The layer only covers the tropics — flag AOIs that poke outside it.
        const coverageNote =
          s > 30 || n < -30
            ? "⚠️ AOI is entirely outside the alert coverage (30°N–30°S) — zero alerts here means 'not monitored', not 'no loss'."
            : n > 30 || s < -30
              ? "⚠️ AOI extends beyond the alert coverage (30°N–30°S); counts only reflect the covered part."
              : undefined;

        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `${summary.alertCount} deforestation alert(s) · ${dateFrom}…${dateTo}`,
          bbox: box,
          payload: {
            series: [
              {
                label: `Daily alerts (≥ ${conf})`,
                unit: "alerts",
                points: daily.map((d) => ({ t: d.date, v: d.count })),
              },
            ],
            summary: {
              alertCount: summary.alertCount,
              areaHa: summary.areaHa,
              byConfidence: summary.byConfidence,
            },
            source: GFW_SOURCE,
          },
        });

        return {
          source: GFW_SOURCE,
          window: { from: dateFrom, to: dateTo },
          minConfidence: conf,
          alertCount: summary.alertCount,
          areaHa: summary.areaHa,
          byConfidence: summary.byConfidence,
          dailyCounts: daily,
          ...(coverageNote ? { note: coverageNote } : {}),
          citation:
            'Hansen et al. 2016 (GLAD-L); Pickens et al. 2020 (GLAD-S2); Reiche et al. 2021 (RADD). "Integrated Deforestation Alerts", UMD/GLAD and WUR, accessed through Global Forest Watch.',
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
