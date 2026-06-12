import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchCollections } from "../clients/cmr.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { newId, nowIso } from "../util.js";

const CMR_SOURCE = "NASA Common Metadata Repository (CMR / Earthdata)";

/** Register the NASA Earthdata catalog tool: earthdata_search (CMR, no key). */
export function registerEarthdataTools(server: McpServer): void {
  server.registerTool(
    "earthdata_search",
    {
      title: "NASA Earthdata catalog search (CMR, no key)",
      description:
        "Discover datasets across NASA's entire Earth-science archive (~50,000 collections, " +
        "all DAACs) via the Common Metadata Repository — no key. Search by topic keyword " +
        "(e.g. 'soil moisture', 'GRACE groundwater', 'aerosol optical depth', 'ICESat-2 " +
        "elevation'), optionally constrained to a bbox and date range; most-used datasets " +
        "first. Returns collection ids, providers, temporal coverage, and landing pages — " +
        "use it to find WHAT data exists beyond earthdeck's built-in sources, then fetch via " +
        "the dataset's own access route (or NASA's hosted Earthdata MCP for granule-level " +
        "search). Posts a card to the dashboard.",
      inputSchema: {
        keyword: z.string().min(2).describe("Topic to search for, e.g. 'snow water equivalent'."),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe("Optional bounding box [west, south, east, north] the data must cover."),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Data must cover dates from here."),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Data must cover dates up to here."),
        limit: z.number().int().min(1).max(50).optional().describe("Max collections (default 10)."),
      },
    },
    async ({ keyword, bbox, dateFrom, dateTo, limit }) =>
      safe(async () => {
        const collections = await searchCollections({
          keyword,
          bbox: bbox as BBox | undefined,
          dateFrom,
          dateTo,
          limit,
        });
        const pushed = await pushCard({
          id: newId(),
          type: "search",
          ts: nowIso(),
          title: `${collections.length} NASA dataset(s) · "${keyword}"`,
          ...(bbox ? { bbox: bbox as BBox } : {}),
          payload: {
            collections: collections.map((c) => ({
              shortName: c.shortName,
              title: c.title,
              dataCenter: c.dataCenter,
              timeStart: c.timeStart,
              timeEnd: c.timeEnd,
            })),
            keyword,
            source: CMR_SOURCE,
          },
        });
        return {
          source: CMR_SOURCE,
          keyword,
          count: collections.length,
          collections,
          note:
            "These are dataset catalog entries, not pixels. For granule-level file search " +
            "use NASA's hosted Earthdata MCP (https://cmr.earthdata.nasa.gov/mcp/v1) or the " +
            "collection's landing page.",
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
