// Global Forest Watch Data API client (data-api.globalforestwatch.org) — integrated
// deforestation alerts (GLAD-L + GLAD-S2 + RADD fused by UMD/WUR; daily, 10 m, 30°N–30°S).
// Auth is a free API key in the `x-api-key` header; data queries are SQL over the
// pseudo-table `results`, POSTed with a GeoJSON geometry. `latest` 307-redirects to the
// concrete daily version — fetch follows it, preserving method+body (307/308 semantics).

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

const GFW_API = "https://data-api.globalforestwatch.org";
export const GFW_ALERTS_DATASET = "gfw_integrated_alerts";
const DATE_FIELD = "gfw_integrated_alerts__date";
const CONF_FIELD = "gfw_integrated_alerts__confidence";

export const GFW_CONFIDENCES = ["nominal", "high", "highest"] as const;
export type GfwConfidence = (typeof GFW_CONFIDENCES)[number];

export interface GfwAlertsSummary {
  alertCount: number;
  areaHa: number | null;
  byConfidence: Partial<Record<GfwConfidence, { alertCount: number; areaHa: number | null }>>;
}

export interface GfwDailyCount {
  date: string; // YYYY-MM-DD
  count: number;
}

/** bbox → GeoJSON Polygon for the query body. */
export function bboxToPolygon(bbox: BBox): { type: "Polygon"; coordinates: number[][][] } {
  const [w, s, e, n] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/**
 * The WHERE clause for a window + minimum confidence (nominal < high < highest). The GFW
 * SQL dialect rejects `IN` ("Unsupported filter operator") and numeric comparison against
 * encoded fields — string equality OR-chained is the form it accepts (verified live).
 */
export function alertsWhere(dateFrom: string, minConfidence: GfwConfidence): string {
  let where = `${DATE_FIELD} >= '${dateFrom}'`;
  if (minConfidence !== "nominal") {
    const allowed = GFW_CONFIDENCES.slice(GFW_CONFIDENCES.indexOf(minConfidence));
    where += ` AND (${allowed.map((c) => `${CONF_FIELD} = '${c}'`).join(" OR ")})`;
  }
  return where;
}

// NOTE: the GFW SQL engine ignores `AS` aliases — COUNT(*) comes back as `count` and
// SUM(area__ha) as `area__ha` (verified live), so the SQL stays alias-free.

/** Totals + area grouped by confidence level. */
export function alertsSummarySql(dateFrom: string, minConfidence: GfwConfidence): string {
  return (
    `SELECT ${CONF_FIELD}, COUNT(*), SUM(area__ha) FROM results ` +
    `WHERE ${alertsWhere(dateFrom, minConfidence)} GROUP BY ${CONF_FIELD}`
  );
}

/** Daily alert counts (drives the dashboard series chart). */
export function alertsDailySql(dateFrom: string, minConfidence: GfwConfidence): string {
  return (
    `SELECT ${DATE_FIELD}, COUNT(*) FROM results ` +
    `WHERE ${alertsWhere(dateFrom, minConfidence)} GROUP BY ${DATE_FIELD} ORDER BY ${DATE_FIELD}`
  );
}

/** Fold the GROUP BY confidence rows into a summary (rows may be empty → zero alerts). */
export function parseSummaryRows(rows: Array<Record<string, unknown>>): GfwAlertsSummary {
  const byConfidence: GfwAlertsSummary["byConfidence"] = {};
  let alertCount = 0;
  let areaHa = 0;
  let sawArea = false;
  for (const row of rows) {
    const conf = String(row[CONF_FIELD] ?? "");
    const count = Number(row.count ?? 0);
    const area = row.area__ha == null ? null : Number(row.area__ha);
    if (!Number.isFinite(count)) continue;
    alertCount += count;
    if (area != null && Number.isFinite(area)) {
      areaHa += area;
      sawArea = true;
    }
    if ((GFW_CONFIDENCES as readonly string[]).includes(conf)) {
      byConfidence[conf as GfwConfidence] = {
        alertCount: count,
        areaHa: area != null && Number.isFinite(area) ? Math.round(area * 100) / 100 : null,
      };
    }
  }
  return {
    alertCount,
    areaHa: sawArea ? Math.round(areaHa * 100) / 100 : null,
    byConfidence,
  };
}

/** Parse GROUP BY date rows into a daily series (dates normalized to YYYY-MM-DD). */
export function parseDailyRows(rows: Array<Record<string, unknown>>): GfwDailyCount[] {
  const out: GfwDailyCount[] = [];
  for (const row of rows) {
    const raw = String(row[DATE_FIELD] ?? "");
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    const count = Number(row.count ?? NaN);
    if (!m || !Number.isFinite(count)) continue;
    out.push({ date: m[1]!, count });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * POST a SQL query against a GFW dataset with a GeoJSON geometry. Returns the data rows.
 *
 * Two live-verified gateway quirks: requests need an `origin` header to pass key checks
 * (even for keys minted with no domain restriction — `localhost` is the documented value
 * for non-browser use), and a valid key occasionally still draws a transient 403, so one
 * 403/401 gets retried before we conclude the key is bad.
 */
export async function gfwQuery(
  apiKey: string,
  dataset: string,
  sql: string,
  geometry: unknown,
): Promise<Array<Record<string, unknown>>> {
  const send = () =>
    fetch(`${GFW_API}/dataset/${dataset}/latest/query/json`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        origin: "localhost",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ sql, geometry }),
    });
  let res = await send();
  if (res.status === 401 || res.status === 403) res = await send();
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new OverviewError(
      "GFW API key was rejected. Check GFW_API_KEY, or mint a new key: " +
        "https://www.globalforestwatch.org/help/developers/guides/create-and-use-an-api-key/",
      res.status,
      text.slice(0, 300),
    );
  }
  if (!res.ok) {
    throw new OverviewError(`GFW query failed (${res.status})`, res.status, text.slice(0, 300));
  }
  const j = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return j.data ?? [];
}

/** Integrated alerts for a bbox: summary + daily counts (two queries, in parallel). */
export async function integratedAlerts(
  apiKey: string,
  bbox: BBox,
  dateFrom: string,
  minConfidence: GfwConfidence,
): Promise<{ summary: GfwAlertsSummary; daily: GfwDailyCount[] }> {
  assertBBox(bbox);
  const geometry = bboxToPolygon(bbox);
  const [summaryRows, dailyRows] = await Promise.all([
    gfwQuery(apiKey, GFW_ALERTS_DATASET, alertsSummarySql(dateFrom, minConfidence), geometry),
    gfwQuery(apiKey, GFW_ALERTS_DATASET, alertsDailySql(dateFrom, minConfidence), geometry),
  ]);
  return { summary: parseSummaryRows(summaryRows), daily: parseDailyRows(dailyRows) };
}
