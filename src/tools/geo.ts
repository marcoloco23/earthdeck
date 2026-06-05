import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { geocode } from "../clients/geo.js";
import { safe } from "../result.js";

/** Register the geocoding helper. geo_resolve (OSM Nominatim, no key). */
export function registerGeoTools(server: McpServer): void {
  server.registerTool(
    "geo_resolve",
    {
      title: "Resolve a place name to a bounding box",
      description:
        "Turn a place name (e.g. 'Manaus, Brazil' or 'Yosemite') into a bounding box and " +
        "center via OpenStreetMap, so you can pass it to the other tools instead of raw " +
        "coordinates. No API key.",
      inputSchema: {
        place: z.string().min(1).describe("A place name, address, or region."),
      },
    },
    async ({ place }) => safe(() => geocode(place)),
  );
}
