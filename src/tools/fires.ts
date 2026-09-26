import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fires, FIRMS_SOURCES } from "../clients/nasa.js";
import { firmsMapKey } from "../config.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { newId, nowIso } from "../util.js";

const MAX_CARD_FIRES = 1000; // cap markers shipped to the dashboard

/** Register fire tools. Phase 2: fires_in (NASA FIRMS, requires FIRMS_MAP_KEY). */
export function registerFireTools(server: McpServer): void {
  server.registerTool(
    "fires_in",
    {
      title: "Active fire detections (NASA FIRMS)",
      description:
        "Active fire / thermal-anomaly detections from NASA FIRMS within a bounding box, " +
        "near-real-time. Requires a free FIRMS_MAP_KEY. Returns detections with confidence, " +
        "brightness, and fire radiative power (FRP), and plots them on the dashboard.",
      inputSchema: {
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .describe("Bounding box [west, south, east, north] in degrees"),
        dayRange: z.number().int().min(1).max(5).optional().describe("Look back N days (default 1; FIRMS allows at most 5 — use `flaring` for longer windows)."),
        source: z
          .enum(FIRMS_SOURCES)
          .optional()
          .describe("Sensor source (default VIIRS_SNPP_NRT)."),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start date YYYY-MM-DD (default: most recent)."),
      },
    },
    async ({ bbox, dayRange, source, date }) =>
      safe(async () => {
        const key = firmsMapKey();
        if (!key) {
          throw new OverviewError(
            "FIRMS_MAP_KEY is not set. Get a free key at " +
              "https://firms.modaps.eosdis.nasa.gov/api/map_key/ and set FIRMS_MAP_KEY.",
          );
        }
        const box = bbox as BBox;
        const list = await fires(key, box, { dayRange, source, date });

        const pushed = await pushCard({
          id: newId(),
          type: "fires",
          ts: nowIso(),
          title: `${list.length} fire detection(s) · ${source ?? "VIIRS_SNPP_NRT"}`,
          bbox: box,
          payload: {
            source: source ?? "VIIRS_SNPP_NRT",
            total: list.length,
            fires: list.slice(0, MAX_CARD_FIRES).map((f) => ({
              lat: f.lat,
              lon: f.lon,
              confidence: f.confidence,
              brightness: f.brightness,
              frp: f.frp,
              acqDate: f.acqDate,
            })),
          },
        });

        return {
          count: list.length,
          dashboard: pushed ? "pushed" : "dashboard offline",
          source: source ?? "VIIRS_SNPP_NRT",
          fires: list,
        };
      }),
  );
}
