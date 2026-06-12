import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { registerImageryTools } from "./tools/imagery.js";
import { registerEventsTools } from "./tools/events.js";
import { registerFireTools } from "./tools/fires.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerSarTools } from "./tools/sar.js";
import { registerStacTools } from "./tools/stac.js";
import { registerGeoTools } from "./tools/geo.js";
import { registerOceanTools } from "./tools/ocean.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerClimateTools } from "./tools/climate.js";
import { registerQuakeTools } from "./tools/quakes.js";
import { registerEarthdataTools } from "./tools/earthdata.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "The data layer for the Earth system, over free open data. Two families: " +
        "(1) Earth observation — render satellite imagery for a bounding box, list live " +
        "natural-disaster events, search open archives (STAC, no key), and (with keys) compute " +
        "vegetation/water/burn indices, find active fires, render all-weather Sentinel-1 SAR, " +
        "and compare a place across two dates. (2) Planetary indicators (all no-key) — ENSO/" +
        "El Niño tracking (enso), ocean temperature history since 1981 (ocean_temp), CO₂ since " +
        "1958 (co2), the global temperature record since 1880 (global_temp), polar sea ice " +
        "(sea_ice), earthquakes (quakes), air quality (air_quality), per-place climate history " +
        "since 1940 (climate_history), river discharge (river_discharge), planet_pulse — " +
        "the planet's vital signs in one call — and earthdata_search to discover datasets " +
        "across NASA's full ~50k-collection archive. Historic series include trends; the Earth is one " +
        "interconnected system, so cross-reference (ENSO ↔ fires/floods/SST; discharge ↔ SAR " +
        "floods). Bounding boxes are [west, south, east, north] degrees. Results also stream to " +
        "a local dashboard if one is running (best-effort).",
    },
  );

  registerImageryTools(server);
  registerEventsTools(server);
  registerFireTools(server);
  registerAnalysisTools(server);
  registerSarTools(server);
  registerStacTools(server);
  registerGeoTools(server);
  registerOceanTools(server);
  registerIndicatorTools(server);
  registerClimateTools(server);
  registerQuakeTools(server);
  registerEarthdataTools(server);

  return server;
}

export async function runMcp(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => void server.close().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} running on stdio\n`);
}
