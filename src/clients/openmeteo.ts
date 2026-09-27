// Open-Meteo clients: ERA5 climate archive (1940→now), air quality, and GloFAS river
// discharge (1984→now). Free for non-commercial use, no key, CC-BY 4.0 data.
// https://open-meteo.com/

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { SeriesPoint } from "../series.js";

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const AIR_BASE = "https://air-quality-api.open-meteo.com/v1/air-quality";
const FLOOD_BASE = "https://flood-api.open-meteo.com/v1/flood";

export const OPEN_METEO_ATTRIBUTION = "Open-Meteo.com (CC-BY 4.0)";

export interface OmDaily {
  daily?: { time?: string[] } & Record<string, unknown>;
  hourly?: { time?: string[] } & Record<string, unknown>;
  daily_units?: Record<string, string>;
  hourly_units?: Record<string, string>;
  error?: boolean;
  reason?: string;
}

export async function omFetch(base: string, params: Record<string, string>): Promise<OmDaily> {
  const url = `${base}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  const json = (await res.json().catch(() => null)) as OmDaily | null;
  if (!res.ok || !json || json.error) {
    throw new OverviewError(
      `Open-Meteo request failed (${res.status})${json?.reason ? `: ${json.reason}` : ""}`,
      res.status,
    );
  }
  return json;
}

/** Extract one variable block (daily or hourly) as series points, nulls preserved. */
export function omSeries(json: OmDaily, block: "daily" | "hourly", variable: string): SeriesPoint[] {
  const b = json[block];
  const times = b?.time;
  const values = b?.[variable];
  if (!Array.isArray(times) || !Array.isArray(values)) {
    throw new OverviewError(`Open-Meteo response missing ${block}.${variable}`);
  }
  return times.map((t, i) => {
    const v = (values as Array<number | null>)[i];
    return { t: String(t), v: typeof v === "number" && Number.isFinite(v) ? v : null };
  });
}

export function omUnit(json: OmDaily, block: "daily" | "hourly", variable: string): string {
  return (block === "daily" ? json.daily_units : json.hourly_units)?.[variable] ?? "";
}

function assertLatLon(lat: number, lon: number): void {
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new OverviewError(`lat/lon out of range: ${lat}, ${lon}`);
  }
}

/** ERA5 daily variables we expose via climate_history. */
export const ARCHIVE_VARS = [
  "temperature_2m_mean",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "wind_speed_10m_max",
  "snowfall_sum",
] as const;
export type ArchiveVar = (typeof ARCHIVE_VARS)[number];

export interface ArchiveResult {
  series: Record<string, SeriesPoint[]>;
  units: Record<string, string>;
}

/** Daily ERA5 reanalysis history for a point (1940-01-01 → ~5 days ago). */
export async function archiveDaily(
  lat: number,
  lon: number,
  vars: ArchiveVar[],
  start: string,
  end: string,
): Promise<ArchiveResult> {
  assertLatLon(lat, lon);
  const json = await omFetch(ARCHIVE_BASE, {
    latitude: String(lat),
    longitude: String(lon),
    start_date: start,
    end_date: end,
    daily: vars.join(","),
    timezone: "UTC",
  });
  const series: Record<string, SeriesPoint[]> = {};
  const units: Record<string, string> = {};
  for (const v of vars) {
    series[v] = omSeries(json, "daily", v);
    units[v] = omUnit(json, "daily", v);
  }
  return { series, units };
}

export const AIR_VARS = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "us_aqi"] as const;
export type AirVar = (typeof AIR_VARS)[number];

/** Hourly air quality (CAMS) for a point: past `pastDays` days + today. */
export async function airQuality(
  lat: number,
  lon: number,
  pastDays = 2,
): Promise<ArchiveResult> {
  assertLatLon(lat, lon);
  const json = await omFetch(AIR_BASE, {
    latitude: String(lat),
    longitude: String(lon),
    hourly: AIR_VARS.join(","),
    past_days: String(Math.max(1, Math.min(16, pastDays))),
    forecast_days: "1",
    timezone: "UTC",
  });
  const series: Record<string, SeriesPoint[]> = {};
  const units: Record<string, string> = {};
  for (const v of AIR_VARS) {
    series[v] = omSeries(json, "hourly", v);
    units[v] = omUnit(json, "hourly", v);
  }
  return { series, units };
}

/** Daily GloFAS river discharge (m³/s) at the nearest river cell (1984 → +7d forecast). */
export async function riverDischarge(
  lat: number,
  lon: number,
  start: string,
  end: string,
): Promise<{ points: SeriesPoint[]; unit: string }> {
  assertLatLon(lat, lon);
  const json = await omFetch(FLOOD_BASE, {
    latitude: String(lat),
    longitude: String(lon),
    daily: "river_discharge",
    start_date: start,
    end_date: end,
  });
  return {
    points: omSeries(json, "daily", "river_discharge"),
    unit: omUnit(json, "daily", "river_discharge") || "m³/s",
  };
}
