import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { registerImageryTools } from "./tools/imagery.js";
import { registerEventsTools } from "./tools/events.js";
import { registerFireTools } from "./tools/fires.js";
import { registerFlaringTools } from "./tools/flaring.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerSarTools } from "./tools/sar.js";
import { registerStacTools } from "./tools/stac.js";
import { registerGeoTools } from "./tools/geo.js";
import { registerOceanTools } from "./tools/ocean.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerClimateTools } from "./tools/climate.js";
import { registerQuakeTools } from "./tools/quakes.js";
import { registerEarthdataTools } from "./tools/earthdata.js";
import { registerForestTools } from "./tools/forest.js";
import { registerNarrateTools } from "./tools/narrate.js";
import { registerSimilarTools } from "./tools/similar.js";
import { registerWorldPulseTools } from "./tools/worldpulse.js";
import { registerLedgerTools } from "./tools/ledger.js";
import { registerMethaneTools } from "./tools/methane.js";
import { registerAttributionTools } from "./tools/attribution.js";
import { registerBiodiversityTools } from "./tools/biodiversity.js";
import { registerCoralTools } from "./tools/coral.js";
import { registerNaturalValueTools } from "./tools/naturalvalue.js";
import { registerGeeTools } from "./tools/gee.js";
import { registerWeatherTools } from "./tools/weather.js";
import { registerMarineTools } from "./tools/marine.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "The data layer for the Earth system, over free open data. Three families: " +
        "(1) Earth observation — render satellite imagery for a bounding box, list live " +
        "natural-disaster events, search open archives (STAC, no key), and (with keys) compute " +
        "vegetation/water/burn indices, find active fires and persistent gas flares (flaring), surface deforestation alerts " +
        "(forest_alerts), attribute them — protected_areas (OSM/LandMark/WDPA lands in an AOI) and " +
        "emitters (Climate TRACE assets in an AOI) — render all-weather Sentinel-1 SAR, " +
        "compare a place across two dates, and search by similarity — eo_similar finds everywhere " +
        "that 'looks like' a reference point via AlphaEarth embeddings (no key). (2) Planetary indicators (all no-key) — ENSO/" +
        "El Niño tracking (enso), ocean temperature history since 1981 (ocean_temp), CO₂ since " +
        "1958 (co2), the global temperature record since 1880 (global_temp), polar sea ice " +
        "(sea_ice), earthquakes (quakes), air quality (air_quality), per-place climate history " +
        "since 1940 (climate_history), river discharge (river_discharge), weather now + 7-day forecast vs the 1991–2020 normal (weather_now), active tropical cyclones with forecast cones (storms), planet_pulse — " +
        "the planet's vital signs in one call — world_pulse — civilization's vital signs (child " +
        "mortality, poverty, renewables…), the living world (Living Planet Index, Red List Index, " +
        "fish stocks…) and the planet (ocean pH, nitrogen, plastic…), each with an honest " +
        "improving/worsening direction — and earthdata_search to discover datasets " +
        "across NASA's full ~50k-collection archive. (3) Life (all no-key) — biodiversity (GBIF: " +
        "what lives in a place, by kingdom incl. Fungi, threatened species, an effort-dependent " +
        "score), species (taxonomy breadcrumb, IUCN status, OpenTree id for any animal, plant or " +
        "fungus), coral_bleaching (NOAA Coral Reef Watch heat stress). With a Google Earth Engine service " +
        "account, gee_query adds land-cover mix (Dynamic World / MapBiomas incl. pasture / WorldCover), " +
        "GEDI biomass and WorldPop population for a bbox. Historic series include trends; the Earth is one " +
        "interconnected system, so cross-reference (ENSO ↔ fires/floods/SST; discharge ↔ SAR " +
        "floods). Bounding boxes are [west, south, east, north] degrees. Results also stream to " +
        "a local dashboard if one is running (best-effort) — and `narrate` lets you stream YOUR " +
        "interpretation there too: post a note alongside data calls explaining what the results " +
        "mean, and update it (same noteId, full text) as the picture develops. The Earth Watch ledger " +
        "is reachable via ledger_list/ledger_get/ledger_verify (read) and ledger_advance/" +
        "ledger_narrate/ledger_review/ledger_propose_attribution (append) — these never publish; " +
        "publication is a human act.",
    },
  );

  registerImageryTools(server);
  registerEventsTools(server);
  registerFireTools(server);
  registerFlaringTools(server);
  registerAnalysisTools(server);
  registerSarTools(server);
  registerStacTools(server);
  registerGeoTools(server);
  registerOceanTools(server);
  registerIndicatorTools(server);
  registerClimateTools(server);
  registerQuakeTools(server);
  registerEarthdataTools(server);
  registerForestTools(server);
  registerNarrateTools(server);
  registerSimilarTools(server);
  registerWorldPulseTools(server);
  registerLedgerTools(server);
  registerMethaneTools(server);
  registerAttributionTools(server);
  registerBiodiversityTools(server);
  registerCoralTools(server);
  registerNaturalValueTools(server);
  registerGeeTools(server);
  registerWeatherTools(server);
  registerMarineTools(server);

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
