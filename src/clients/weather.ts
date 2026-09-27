// Weather for a point: Open-Meteo forecast API (current + past days + 7-day forecast, keyless,
// CC BY 4.0) and an ERA5 daily-max normal for 1991–2020 from the existing archive API, so a
// hot day is always reported next to what is normal for that place and time of year.
//
// Two ERA5 details that matter for honesty (both observed live 2026-09-27):
// - The archive API's default `best_match` fills the most recent days with forecast data, so
//   it is NOT independent of the forecast. We ask for `models=era5` explicitly, which leaves
//   the last ~6 days null (ERA5's real latency) — that null is the truth, not a bug.
// - Open-Meteo counts >2 weeks of data as several calls, so the 30-year normal is fetched as
//   30 short windows (one per year, ~2 weeks each) instead of one 30-year request.

import { OverviewError } from "../errors.js";
import { round } from "../series.js";
import { addDays } from "../util.js";
import { OPEN_METEO_ATTRIBUTION, omFetch, type OmDaily } from "./openmeteo.js";

const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";

export const NORMAL_PERIOD = { from: 1991, to: 2020 } as const;
/** ± days around each date pooled into its normal (7-day window × 30 years = 210 samples). */
export const NORMAL_HALF_WINDOW = 3;

const DAILY_VARS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "precipitation_sum",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
] as const;
const CURRENT_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "wind_speed_10m",
  "wind_direction_10m",
  "weather_code",
] as const;

export interface WeatherDay {
  date: string;
  /** "past" = model analysis of an elapsed day, "today", or "forecast". */
  kind: "past" | "today" | "forecast";
  tmaxC: number | null;
  tminC: number | null;
  /** Open-Meteo apparent temperature (Steadman "feels like"; our heat-index proxy). */
  apparentMaxC: number | null;
  precipMm: number | null;
  windMaxKmh: number | null;
  gustMaxKmh: number | null;
  /** ERA5 1991–2020 mean daily max for this calendar window (±3 d); null if unavailable. */
  tmaxNormalC: number | null;
  tmaxAnomalyC: number | null;
}

export interface WeatherCurrent {
  time: string;
  temperatureC: number | null;
  apparentC: number | null;
  humidityPct: number | null;
  precipMm: number | null;
  windKmh: number | null;
  windDirDeg: number | null;
  weatherCode: number | null;
}

export interface Era5Day {
  date: string;
  tmaxC: number | null;
  precipMm: number | null;
}

export interface WeatherReport {
  lat: number;
  lon: number;
  /** Grid cell Open-Meteo actually answered for. */
  gridLat: number;
  gridLon: number;
  elevationM: number | null;
  timezone: string;
  today: string;
  current: WeatherCurrent;
  days: WeatherDay[];
  /** ERA5 reanalysis for the past days (independent of the forecast; ~6-day latency → nulls). */
  era5: Era5Day[];
  normals: { period: string; halfWindowDays: number; available: boolean; error?: string };
  provenance: WeatherProvenance;
}

export interface WeatherProvenance {
  dataSource: string;
  forecastModel: string;
  reanalysis: string;
  retrievedAt: string;
  disclaimer: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function col(json: OmDaily, variable: string): (number | null)[] {
  const v = json.daily?.[variable];
  return Array.isArray(v) ? v.map(num) : [];
}

/** Forecast API call: current + `pastDays` elapsed days + today + forecast, in local time. */
export async function forecastPoint(lat: number, lon: number, pastDays = 7, forecastDays = 7) {
  const json = (await omFetch(FORECAST_BASE, {
    latitude: String(lat),
    longitude: String(lon),
    current: CURRENT_VARS.join(","),
    daily: DAILY_VARS.join(","),
    past_days: String(Math.max(0, Math.min(14, pastDays))),
    forecast_days: String(Math.max(1, Math.min(16, forecastDays))),
    timezone: "auto",
  })) as OmDaily & {
    latitude?: number;
    longitude?: number;
    elevation?: number;
    timezone?: string;
    current?: Record<string, unknown>;
  };
  const times = json.daily?.time;
  if (!Array.isArray(times) || times.length === 0) throw new OverviewError("Open-Meteo forecast response has no daily block");
  const c = json.current ?? {};
  const current: WeatherCurrent = {
    time: String(c.time ?? ""),
    temperatureC: num(c.temperature_2m),
    apparentC: num(c.apparent_temperature),
    humidityPct: num(c.relative_humidity_2m),
    precipMm: num(c.precipitation),
    windKmh: num(c.wind_speed_10m),
    windDirDeg: num(c.wind_direction_10m),
    weatherCode: num(c.weather_code),
  };
  // "today" in the place's own time zone: the current observation's local date.
  const today = current.time.slice(0, 10) || times[Math.min(times.length - 1, Math.max(0, pastDays))]!;
  const tmax = col(json, "temperature_2m_max");
  const tmin = col(json, "temperature_2m_min");
  const app = col(json, "apparent_temperature_max");
  const pr = col(json, "precipitation_sum");
  const wmax = col(json, "wind_speed_10m_max");
  const gmax = col(json, "wind_gusts_10m_max");
  const days: WeatherDay[] = times.map((t, i) => {
    const date = String(t);
    return {
      date,
      kind: date < today ? "past" : date === today ? "today" : "forecast",
      tmaxC: tmax[i] ?? null,
      tminC: tmin[i] ?? null,
      apparentMaxC: app[i] ?? null,
      precipMm: pr[i] ?? null,
      windMaxKmh: wmax[i] ?? null,
      gustMaxKmh: gmax[i] ?? null,
      tmaxNormalC: null,
      tmaxAnomalyC: null,
    };
  });
  return {
    gridLat: num(json.latitude) ?? lat,
    gridLon: num(json.longitude) ?? lon,
    elevationM: num(json.elevation),
    timezone: String(json.timezone ?? "UTC"),
    today,
    current,
    days,
  };
}

/** ERA5-only daily max temperature + precipitation (no forecast back-fill). */
export async function era5Daily(lat: number, lon: number, start: string, end: string): Promise<Era5Day[]> {
  const json = await omFetch(ARCHIVE_BASE, {
    latitude: String(lat),
    longitude: String(lon),
    start_date: start,
    end_date: end,
    daily: "temperature_2m_max,precipitation_sum",
    models: "era5",
    timezone: "auto",
  });
  const times = json.daily?.time ?? [];
  const tmax = col(json, "temperature_2m_max");
  const pr = col(json, "precipitation_sum");
  return times.map((t, i) => ({ date: String(t), tmaxC: tmax[i] ?? null, precipMm: pr[i] ?? null }));
}

/** Shift a YYYY-MM-DD date by whole years (Feb 29 → Mar 1 in non-leap years). */
export function shiftYears(date: string, years: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

const normalsCache = new Map<string, Map<string, number>>();

/**
 * ERA5 1991–2020 mean daily max for each date in [first, last], pooling ±NORMAL_HALF_WINDOW
 * days × 30 years. One small request per year (Open-Meteo weights long spans as many calls).
 * Memoized per process: a sweep's detect + confirm reuse it.
 */
export async function tmaxNormals(lat: number, lon: number, first: string, last: string): Promise<Map<string, number>> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${first},${last}`;
  const hit = normalsCache.get(key);
  if (hit) return hit;
  const h = NORMAL_HALF_WINDOW;
  const winStart = addDays(first, -h);
  const winEnd = addDays(last, h);
  const baseYear = Number(winStart.slice(0, 4));
  const years: number[] = [];
  for (let y = NORMAL_PERIOD.from; y <= NORMAL_PERIOD.to; y++) years.push(y);
  // Open-Meteo answers 429 "Too many concurrent requests" above ~2 in flight: pairs, one retry.
  const fetchYear = async (y: number): Promise<(number | null)[]> => {
    const delta = y - baseYear;
    const get = () => era5Daily(lat, lon, shiftYears(winStart, delta), shiftYears(winEnd, delta));
    const rows = await get().catch(async (e: unknown) => {
      if ((e as { status?: number }).status !== 429) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      return get();
    });
    return rows.map((r) => r.tmaxC);
  };
  const perYear: (number | null)[][] = [];
  for (let i = 0; i < years.length; i += 2) perYear.push(...(await Promise.all(years.slice(i, i + 2).map(fetchYear))));
  const out = new Map<string, number>();
  for (let d = first, i = 0; d <= last; d = addDays(d, 1), i++) {
    const pool: number[] = [];
    for (const series of perYear) for (let k = i; k <= i + 2 * h; k++) {
      const v = series[k];
      if (v != null) pool.push(v);
    }
    if (pool.length >= 30) out.set(d, round(pool.reduce((a, b) => a + b, 0) / pool.length, 1));
  }
  normalsCache.set(key, out);
  return out;
}

/** Test hook: drop memoized normals. */
export function clearNormalsCache(): void {
  normalsCache.clear();
}

/**
 * Everything `weather_now` returns: forecast days with ERA5 normals + anomalies, and ERA5's
 * own view of the elapsed days. Normals/ERA5 failures degrade (nulls + flag), never throw.
 */
export async function weatherReport(lat: number, lon: number, opts: { pastDays?: number; forecastDays?: number; normals?: boolean } = {}): Promise<WeatherReport> {
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new OverviewError(`lat/lon out of range: ${lat}, ${lon}`);
  const pastDays = opts.pastDays ?? 7;
  const f = await forecastPoint(lat, lon, pastDays, opts.forecastDays ?? 7);
  const first = f.days[0]!.date;
  const last = f.days[f.days.length - 1]!.date;
  let available = false;
  let normalsError: string | undefined;
  if (opts.normals !== false) {
    try {
      const normals = await tmaxNormals(lat, lon, first, last);
      for (const d of f.days) {
        const n = normals.get(d.date);
        if (n == null) continue;
        d.tmaxNormalC = n;
        d.tmaxAnomalyC = d.tmaxC != null ? round(d.tmaxC - n, 1) : null;
      }
      available = normals.size > 0;
    } catch (e) {
      normalsError = e instanceof Error ? e.message : String(e); // context, not a blocker
    }
  }
  let era5: Era5Day[] = [];
  const pastEnd = addDays(f.today, -1);
  if (pastDays > 0 && first <= pastEnd) {
    try {
      era5 = await era5Daily(lat, lon, first, pastEnd);
    } catch {
      era5 = [];
    }
  }
  return {
    lat,
    lon,
    ...f,
    era5,
    normals: { period: `${NORMAL_PERIOD.from}–${NORMAL_PERIOD.to}`, halfWindowDays: NORMAL_HALF_WINDOW, available, ...(normalsError ? { error: normalsError } : {}) },
    provenance: {
      dataSource: OPEN_METEO_ATTRIBUTION,
      forecastModel: "Open-Meteo forecast API, best_match (national/global NWP blend incl. ECMWF IFS, DWD ICON, NOAA GFS), local-time daily aggregates",
      reanalysis: "ECMWF ERA5 (models=era5, 0.25°, ~6-day latency) via the Open-Meteo archive API",
      retrievedAt: new Date().toISOString(),
      disclaimer:
        "Decision-support, not decision. 'past' and 'today' values are model analyses/short-range forecasts on a " +
        "~2–11 km grid, not station observations; ERA5 normals are on a coarser 0.25° grid, so anomalies carry " +
        "grid/elevation bias of ~1–2 °C, largest in mountains and on coasts.",
    },
  };
}
