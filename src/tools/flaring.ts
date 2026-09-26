import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FLARING_DEFAULTS, FLARING_SOURCES, flaringReport, VNF_ANNUAL } from "../clients/vnf.js";
import { firmsMapKey } from "../config.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { newId, nowIso } from "../util.js";

const MAX_AREA_DEG2 = 25; // FIRMS transaction budget: keep the pull regional

/** Register `flaring`: persistent night-time VIIRS heat (FIRMS) + EOG VNF annual flare sites. */
export function registerFlaringTools(server: McpServer): void {
  server.registerTool(
    "flaring",
    {
      title: "Gas flaring (FIRMS night persistence + VIIRS Nightfire annual sites)",
      description:
        "Persistent night-time high-FRP heat sources in a bounding box — the satellite signature of " +
        "gas flares. Pulls NASA FIRMS VIIRS (NOAA-20 + NOAA-21 by default) for the last N days, keeps " +
        "night detections with FRP ≥ minFrp, clusters them to ~1 km and counts distinct nights per " +
        "cluster; clusters lit on ≥ minNights nights are reported (persistence separates a flare from " +
        "a wildfire). Each cluster is matched to the Earth Observation Group VIIRS Nightfire ANNUAL " +
        "flare summary (zero-key public aggregate: per-site flared volume in BCM + site type). " +
        "Requires FIRMS_MAP_KEY. Cannot tell a flare from a furnace, refinery or volcano on its own.",
      inputSchema: {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("Bounding box [west, south, east, north] in degrees"),
        days: z.number().int().min(1).max(60).optional().describe(`Look-back window in days, ending on endDate (default ${FLARING_DEFAULTS.days}).`),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Last day of the window, YYYY-MM-DD (default today UTC)."),
        minFrp: z.number().min(0).max(1000).optional().describe(`Minimum fire radiative power per detection, MW (default ${FLARING_DEFAULTS.minFrp}).`),
        minNights: z.number().int().min(1).max(60).optional().describe(`Nights a cluster must be lit to count as persistent (default ${FLARING_DEFAULTS.minNights}).`),
        clusterKm: z.number().min(0.3).max(5).optional().describe(`Cluster radius, km (default ${FLARING_DEFAULTS.clusterKm}).`),
        sources: z.array(z.enum(FLARING_SOURCES)).min(1).max(2).optional().describe("FIRMS VIIRS sources (default NOAA-20 + NOAA-21; S-NPP ends Nov 2026)."),
        vnf: z.boolean().optional().describe("Match against the EOG VNF annual flare summary (default true; ~12 MB download, cached)."),
        vnfYear: z
          .number()
          .int()
          .refine((y) => y in VNF_ANNUAL, "unsupported VNF year")
          .optional()
          .describe(`VNF annual summary year (${Object.keys(VNF_ANNUAL).join(", ")}; default ${FLARING_DEFAULTS.vnfYear}).`),
        limit: z.number().int().min(1).max(200).optional().describe(`Max persistent clusters returned (default ${FLARING_DEFAULTS.limit}).`),
      },
    },
    async ({ bbox, days, endDate, minFrp, minNights, clusterKm, sources, vnf, vnfYear, limit }) =>
      safe(async () => {
        const key = firmsMapKey();
        if (!key) {
          throw new OverviewError(
            "FIRMS_MAP_KEY is not set. Get a free key at https://firms.modaps.eosdis.nasa.gov/api/map_key/ and set FIRMS_MAP_KEY.",
          );
        }
        const box = bbox as BBox;
        const area = (box[2] - box[0]) * (box[3] - box[1]);
        if (area > MAX_AREA_DEG2) throw new OverviewError(`bbox too large for flaring (${area.toFixed(1)} deg² > ${MAX_AREA_DEG2}); narrow it to a basin or field.`);

        const r = await flaringReport(key, box, { days, end: endDate, minFrp, minNights, clusterKm, sources, vnf, vnfYear, limit });

        const pushed = await pushCard({
          id: newId(),
          type: "fires",
          ts: nowIso(),
          title: `${r.counts.persistentClusters} persistent flare cluster(s) · ${r.window.days} d · ${r.provenance.sensors.join("+")}`,
          bbox: box,
          payload: {
            source: r.provenance.sensors.join("+"),
            total: r.counts.persistentClusters,
            fires: r.clusters.map((c) => ({ lat: c.lat, lon: c.lon, confidence: `${c.nights} nights`, brightness: null, frp: c.maxFrp, acqDate: c.lastNight })),
          },
        });

        return { ...r, dashboard: pushed ? "pushed" : "dashboard offline" };
      }),
  );
}
