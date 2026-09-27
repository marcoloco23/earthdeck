import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  archiveDaily,
  airQuality,
  riverDischarge,
  ARCHIVE_VARS,
  OPEN_METEO_ATTRIBUTION,
  type ArchiveVar,
} from "../clients/openmeteo.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import { annualMean, decimate, linearTrend, monthlyMean, round, summarize } from "../series.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const latSchema = z.number().min(-90).max(90).describe("Latitude of the point.");
const lonSchema = z.number().min(-180).max(180).describe("Longitude of the point.");
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

/** Register climate tools: climate_history, air_quality, river_discharge (Open-Meteo). */
export function registerClimateTools(server: McpServer): void {
  server.registerTool(
    "climate_history",
    {
      title: "Climate history & trends (ERA5, 1940→now)",
      description:
        "Historic weather/climate for any point on Earth from the ERA5 reanalysis via " +
        "Open-Meteo (1940 to ~5 days ago), no key. Pick a daily variable (temperature mean/" +
        "max/min, precipitation, wind, snowfall); the tool aggregates to monthly + annual " +
        "series and computes the long-term trend per decade — how has this place's climate " +
        "actually changed? Use geo_resolve first to turn a place name into coordinates. " +
        "Posts a chart card to the dashboard.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        variable: z.enum(ARCHIVE_VARS as unknown as [string, ...string[]]).optional()
          .describe("Daily variable (default temperature_2m_mean)."),
        startYear: z.number().int().min(1940).max(2100).optional()
          .describe("First year of the window (default 30 years ago)."),
        endYear: z.number().int().min(1940).max(2100).optional()
          .describe("Last year of the window (default this year)."),
      },
    },
    async ({ lat, lon, variable, startYear, endYear }) =>
      safe(async () => {
        const v = (variable ?? "temperature_2m_mean") as ArchiveVar;
        const thisYear = Number(isoDate(0).slice(0, 4));
        const y1 = startYear ?? thisYear - 30;
        const y2 = Math.min(endYear ?? thisYear, thisYear);
        if (y1 > y2) throw new Error(`startYear ${y1} is after endYear ${y2}`);
        const end = y2 === thisYear ? addDays(isoDate(0), -6) : `${y2}-12-31`;
        const r = await archiveDaily(lat, lon, [v], `${y1}-01-01`, end);
        const daily = r.series[v]!;
        const unit = r.units[v] ?? "";
        const isSum = v.endsWith("_sum"); // precipitation/snowfall: annual totals, not means
        const monthly = monthlyMean(daily);
        const annual = isSum
          ? annualSum(daily)
          : annualMean(daily);
        const trend = linearTrend(annual);
        const s = summarize(annual);
        const summary =
          `${v} at (${lat}, ${lon}), ${y1}–${y2}: annual ${isSum ? "total" : "mean"} ` +
          `${s.mean}${unit ? ` ${unit}` : ""}${isSum ? "/yr" : ""}, ` +
          `latest year ${s.latest?.t} = ${s.latest?.v}${unit ? ` ${unit}` : ""}, trend ` +
          `${trend ? `${trend.perDecade >= 0 ? "+" : ""}${round(trend.perDecade, 3)} ${unit}/decade` : "n/a"}.`;
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `${v} · (${lat}, ${lon}) · ${y1}–${y2}`,
          bbox: [lon - 1, Math.max(-90, lat - 1), lon + 1, Math.min(90, lat + 1)],
          payload: {
            series: [{ label: `${v} (annual)`, unit, points: decimate(annual) }],
            summary,
            source: `ERA5 reanalysis via ${OPEN_METEO_ATTRIBUTION}`,
          },
        });
        return {
          source: `ERA5 reanalysis via ${OPEN_METEO_ATTRIBUTION}`,
          variable: v,
          unit,
          window: { from: `${y1}-01-01`, to: end },
          annualSeries: decimate(annual),
          monthlySeriesRecent: monthly.slice(-24),
          trendPerDecade: trend ? round(trend.perDecade, 4) : null,
          stats: { min: s.min, max: s.max, mean: s.mean, latest: s.latest },
          summary,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "air_quality",
    {
      title: "Air quality (CAMS: PM2.5, PM10, O₃, NO₂, US AQI)",
      description:
        "Current + recent air quality for any point, from the Copernicus CAMS model via " +
        "Open-Meteo, no key: PM2.5, PM10, ozone, NO₂ (µg/m³) and the US AQI, hourly for the " +
        "last 2 days. Returns the latest values and a 48-hour series; flags unhealthy levels " +
        "(WHO 24h PM2.5 guideline: 15 µg/m³). `pastDays` (1–7) widens the window; the " +
        "result then carries PM2.5 daily means (UTC days, hours up to now only). " +
        "Posts a chart card to the dashboard.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        pastDays: z.number().int().min(1).max(7).optional().describe("Days of history (default 2, max 7)."),
      },
    },
    async ({ lat, lon, pastDays }) =>
      safe(async () => {
        const r = await airQuality(lat, lon, pastDays ?? 2);
        const latestOf = (k: string) => summarize(r.series[k] ?? []).latest;
        const pm25 = latestOf("pm2_5");
        const aqi = latestOf("us_aqi");
        const latest = {
          pm2_5: pm25,
          pm10: latestOf("pm10"),
          ozone: latestOf("ozone"),
          nitrogen_dioxide: latestOf("nitrogen_dioxide"),
          us_aqi: aqi,
        };
        const flag =
          pm25?.v != null && pm25.v > 15
            ? ` ⚠️ PM2.5 ${pm25.v} µg/m³ exceeds the WHO 24h guideline (15).`
            : "";
        const summary =
          `Air quality at (${lat}, ${lon}): US AQI ${aqi?.v ?? "n/a"}, PM2.5 ${pm25?.v ?? "n/a"} µg/m³ (${pm25?.t ?? ""}).${flag}`;
        const pm25Series = decimate(r.series.pm2_5 ?? [], 96);
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `Air quality · AQI ${aqi?.v ?? "?"} · PM2.5 ${pm25?.v ?? "?"}`,
          bbox: [lon - 0.5, Math.max(-90, lat - 0.5), lon + 0.5, Math.min(90, lat + 0.5)],
          payload: {
            series: [{ label: "PM2.5", unit: "µg/m³", points: pm25Series }],
            thresholds: [15],
            summary,
            source: `CAMS via ${OPEN_METEO_ATTRIBUTION}`,
          },
        });
        return {
          source: `CAMS via ${OPEN_METEO_ATTRIBUTION}`,
          latest,
          units: r.units,
          summary,
          pm25Last48h: pm25Series,
          pm25Daily: dailyMeans(r.series.pm2_5 ?? [], nowIso()),
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "river_discharge",
    {
      title: "River discharge (GloFAS, 1984→now)",
      description:
        "Daily river discharge (m³/s) at the nearest river cell for any point, from the " +
        "GloFAS hydrological model via Open-Meteo, 1984 to now, no key. Returns the series, " +
        "latest flow vs the period mean (flood/drought signal), and min/max. Combine with " +
        "sar_flood to confirm flooding from radar. Posts a chart card to the dashboard.",
      inputSchema: {
        lat: latSchema,
        lon: lonSchema,
        start: z.string().regex(dateRe).optional().describe("Start date (default 2 years ago; earliest 1984-01-01)."),
        end: z.string().regex(dateRe).optional().describe("End date (default today)."),
      },
    },
    async ({ lat, lon, start, end }) =>
      safe(async () => {
        const endDate = end ?? isoDate(0);
        const startDate = start ?? addDays(endDate, -730);
        const r = await riverDischarge(lat, lon, startDate, endDate);
        const s = summarize(r.points);
        if (s.n === 0) throw new Error(`no discharge data at (${lat}, ${lon}) — no river cell nearby?`);
        const ratio = s.latest?.v != null && s.mean ? round(s.latest.v / s.mean, 2) : null;
        const summary =
          `River discharge at (${lat}, ${lon}): latest ${s.latest?.v} ${r.unit} (${s.latest?.t}), ` +
          `period mean ${s.mean}, range ${s.min}–${s.max}.` +
          (ratio != null ? ` Latest is ${ratio}× the period mean${ratio >= 2 ? " — elevated (possible flood)" : ratio <= 0.3 ? " — low (possible drought)" : ""}.` : "");
        const series = decimate(r.points);
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `River discharge ${s.latest?.v} ${r.unit} · (${lat}, ${lon})`,
          bbox: [lon - 1, Math.max(-90, lat - 1), lon + 1, Math.min(90, lat + 1)],
          payload: {
            series: [{ label: "River discharge", unit: r.unit, points: series }],
            summary,
            source: `GloFAS via ${OPEN_METEO_ATTRIBUTION}`,
          },
        });
        return {
          source: `GloFAS via ${OPEN_METEO_ATTRIBUTION}`,
          unit: r.unit,
          window: { from: startDate, to: endDate },
          latest: s.latest,
          stats: { min: s.min, max: s.max, mean: s.mean },
          latestVsMean: ratio,
          series,
          summary,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}

/**
 * UTC-day means of an hourly series, using only hours at or before `now` (the CAMS feed
 * appends forecast hours). `hours` is how many valid hours each mean rests on.
 */
export function dailyMeans(points: { t: string; v: number | null }[], now: string): { t: string; v: number; hours: number }[] {
  const nowKey = now.slice(0, 16);
  const acc = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    if (p.v === null || p.t.slice(0, 16) > nowKey) continue;
    const d = p.t.slice(0, 10);
    const a = acc.get(d) ?? { sum: 0, n: 0 };
    a.sum += p.v;
    a.n += 1;
    acc.set(d, a);
  }
  return [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, a]) => ({ t, v: round(a.sum / a.n, 1), hours: a.n }));
}

/** Calendar-year sums for accumulation variables (precipitation, snowfall). */
function annualSum(points: { t: string; v: number | null }[]): { t: string; v: number }[] {
  const sums = new Map<string, number>();
  for (const p of points) {
    if (p.v === null) continue;
    const y = p.t.slice(0, 4);
    sums.set(y, (sums.get(y) ?? 0) + p.v);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([t, v]) => ({ t, v: round(v, 1) }));
}
