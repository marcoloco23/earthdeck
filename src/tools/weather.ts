import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { events as eonetEvents } from "../clients/nasa.js";
import { OPEN_METEO_ATTRIBUTION } from "../clients/openmeteo.js";
import { activeStorms, categoryLabel, matchEonet, stormTouchesBBox, type Storm } from "../clients/storms.js";
import { weatherReport, type WeatherReport } from "../clients/weather.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox, EonetEvent } from "../types.js";
import { assertBBox, isoDate, newId, nowIso } from "../util.js";

const latSchema = z.number().min(-90).max(90).describe("Latitude of the point.");
const lonSchema = z.number().min(-180).max(180).describe("Longitude of the point.");

/** One-line plain-language reading of a weather report (also the card summary). */
export function weatherSummary(r: WeatherReport, place?: string): string {
  const where = place ?? `(${r.lat}, ${r.lon})`;
  const today = r.days.find((d) => d.kind === "today");
  const hottest = r.days.filter((d) => d.kind === "forecast" && d.tmaxC != null).sort((a, b) => b.tmaxC! - a.tmaxC!)[0];
  const wettest = r.days.filter((d) => d.precipMm != null).sort((a, b) => b.precipMm! - a.precipMm!)[0];
  const anom = (a: number | null) => (a == null ? "" : `, ${a >= 0 ? "+" : ""}${a} °C vs ${r.normals.period} normal`);
  return (
    `${where}: now ${r.current.temperatureC ?? "?"} °C (feels ${r.current.apparentC ?? "?"} °C), wind ${r.current.windKmh ?? "?"} km/h. ` +
    (today ? `Today max ${today.tmaxC ?? "?"} °C${anom(today.tmaxAnomalyC)}, rain ${today.precipMm ?? "?"} mm. ` : "") +
    (hottest ? `Hottest forecast day ${hottest.date}: ${hottest.tmaxC} °C${anom(hottest.tmaxAnomalyC)}. ` : "") +
    (wettest && (wettest.precipMm ?? 0) >= 20 ? `Wettest day ${wettest.date}: ${wettest.precipMm} mm. ` : "")
  ).trim();
}

/** Storms as one GeoJSON FeatureCollection (cones, tracks, positions) for map layers. */
export function stormsGeoJson(storms: Storm[]): { type: "FeatureCollection"; features: unknown[] } {
  const features: unknown[] = [];
  for (const s of storms) {
    const props = { id: s.id, name: s.name, source: s.source, category: s.category, peakCategory: s.peakCategory, maxWindKt: s.maxWindKt, classification: s.classification };
    if (s.cone) features.push({ type: "Feature", geometry: s.cone, properties: { ...props, part: "cone" } });
    if (s.track.length >= 2) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: s.track.map((p) => [p.lon, p.lat]) }, properties: { ...props, part: "track" } });
    if (s.position) features.push({ type: "Feature", geometry: { type: "Point", coordinates: [s.position.lon, s.position.lat] }, properties: { ...props, part: "position" } });
  }
  return { type: "FeatureCollection", features };
}

/** Register weather tools: weather_now (Open-Meteo + ERA5 normals), storms (NHC/CPHC + GDACS + EONET). */
export function registerWeatherTools(server: McpServer): void {
  server.registerTool(
    "weather_now",
    {
      title: "Weather now + 7-day forecast vs normal (Open-Meteo, ERA5 1991–2020)",
      description:
        "Current weather and daily max/min temperature, feels-like (apparent) max, precipitation and wind for " +
        "the past days, today and the next 7 days at any point — from the Open-Meteo forecast API (keyless; " +
        "ECMWF/DWD/NOAA model blend) — each day's max compared with the ERA5 1991–2020 normal for that time of " +
        "year (anomaly in °C), plus ERA5's own independent reading of the elapsed days (~6-day latency). Use " +
        "geo_resolve first for place names. Posts a chart card.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        place: z.string().max(120).optional().describe("Label for the summary (e.g. 'Delhi')."),
        pastDays: z.number().int().min(0).max(14).optional().describe("Elapsed days to include (default 7)."),
        forecastDays: z.number().int().min(1).max(16).optional().describe("Days including today (default 7)."),
        normals: z.boolean().optional().describe("Compute ERA5 1991–2020 normals/anomalies (default true; ~30 small archive calls, memoized)."),
      },
    },
    async ({ lat, lon, place, pastDays, forecastDays, normals }) =>
      safe(async () => {
        const r = await weatherReport(lat, lon, { pastDays, forecastDays, normals });
        const summary = weatherSummary(r, place);
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `Weather${place ? ` · ${place}` : ""} · now ${r.current.temperatureC ?? "?"} °C`,
          bbox: [lon - 0.5, Math.max(-90, lat - 0.5), lon + 0.5, Math.min(90, lat + 0.5)],
          payload: {
            series: [
              { label: "Daily max", unit: "°C", points: r.days.map((d) => ({ t: d.date, v: d.tmaxC })) },
              { label: `Normal ${r.normals.period}`, unit: "°C", points: r.days.map((d) => ({ t: d.date, v: d.tmaxNormalC })) },
            ],
            summary,
            source: `Open-Meteo forecast + ERA5 via ${OPEN_METEO_ATTRIBUTION}`,
          },
        });
        return { ...r, place: place ?? null, summary, dashboard: pushed ? "pushed" : "dashboard offline" };
      }),
  );

  server.registerTool(
    "storms",
    {
      title: "Active tropical cyclones (NHC/CPHC + GDACS, EONET cross-check)",
      description:
        "Every active tropical cyclone, keyless: NOAA NHC/CPHC advisories for the Atlantic and eastern/central " +
        "Pacific (position, intensity, Saffir–Simpson category, 5-day forecast track points, forecast cone) and " +
        "GDACS for all other basins (Bay of Bengal, West Pacific, South Indian Ocean, Australia — cone + track). " +
        "Each storm is cross-checked against NASA EONET 'Severe Storms'. Optional bbox keeps storms whose cone " +
        "or track touches it; minCategory filters by current or forecast-peak category. Cone = uncertainty of " +
        "the centre track, not storm size and not a landfall forecast. Posts an events card with the cones.",
      inputSchema: {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("[west, south, east, north] — keep storms whose cone/track touches it."),
        minCategory: z.number().int().min(0).max(5).optional().describe("Minimum Saffir–Simpson category (current or forecast peak). 0 = include tropical storms/depressions (default)."),
        eonet: z.boolean().optional().describe("Cross-check against NASA EONET severe storms (default true)."),
      },
    },
    async ({ bbox, minCategory, eonet }) =>
      safe(async () => {
        const box = bbox as BBox | undefined;
        if (box) assertBBox(box);
        const { storms: all, sources } = await activeStorms(isoDate(0));
        const minCat = minCategory ?? 0;
        const storms = all.filter((s) => (box ? stormTouchesBBox(s, box) : true) && Math.max(s.category ?? 0, s.peakCategory ?? 0) >= minCat);
        let eonetList: EonetEvent[] = [];
        let eonetStatus = "skipped";
        if (eonet !== false) {
          try {
            eonetList = await eonetEvents({ status: "open", category: "severeStorms", days: 30, limit: 100 });
            eonetStatus = "ok";
          } catch (e) {
            eonetStatus = e instanceof Error ? e.message : String(e);
          }
        }
        const out = storms.map((s) => {
          const m = eonetStatus === "ok" ? matchEonet(s, eonetList) : null;
          return { ...s, eonet: m ? { id: m.id, title: m.title } : null };
        });
        const geojson = stormsGeoJson(storms);
        const label = (s: Storm) => `${s.name} (${categoryLabel(s.category, s.classification)}${s.maxWindKt != null ? `, ${s.maxWindKt} kt` : ""})`;
        const summary =
          out.length === 0
            ? `No active tropical cyclones${box ? " touching the bbox" : ""}${minCat ? ` at category ≥ ${minCat}` : ""}.`
            : `${out.length} active tropical cyclone(s): ${out.map(label).join("; ")}.`;
        const pushed = await pushCard({
          id: newId(),
          type: "events",
          ts: nowIso(),
          title: `${out.length} active tropical cyclone(s)`,
          bbox: box,
          payload: {
            events: out.map((s) => ({
              id: s.id,
              title: s.name,
              category: "Severe Storms",
              coordinates: s.position ? [s.position.lon, s.position.lat] : null,
              lastDate: s.advisory.issued,
              magnitude: `${categoryLabel(s.category, s.classification)}${s.maxWindKt != null ? ` · ${s.maxWindKt} kt` : ""}`,
              link: s.advisory.url ?? "",
            })),
            stormGeoJson: geojson,
          },
        });
        return {
          count: out.length,
          storms: out,
          geojson,
          summary,
          provenance: {
            dataSource: "NOAA/NWS NHC & CPHC (CurrentStorms.json + tropical weather summary MapServer); GDACS (UN OCHA / EC JRC) for other basins; NASA EONET cross-check",
            feeds: { ...sources, eonet: eonetStatus },
            retrievedAt: nowIso(),
            disclaimer:
              "Decision-support, not decision. Advisories are forecasts. The cone is the probable track of the " +
              "centre (≈2/3 of historical errors), not the storm's size or impact area; hazards (surge, rain, wind) " +
              "extend well outside it. GDACS categories come from wind speeds some agencies average over 10 min " +
              "(reads lower than 1-min). Official warnings come only from national met services.",
          },
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
