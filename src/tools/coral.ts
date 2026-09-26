import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { baaLabel, crwArea, crwLatest, crwSeries, CRW_START, type CrwPoint } from "../clients/coralreefwatch.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, newId, nowIso } from "../util.js";

const CRW_SOURCE = "NOAA Coral Reef Watch CoralTemp v3.1 daily 5 km (NOAA_DHW via CoastWatch/PacIOOS ERDDAP) — free to use; credit NOAA CRW";

/** Pure: plain-language reading of DHW (NOAA thresholds: 4 °C-weeks significant, 8 severe). */
export function interpretDhw(dhw: number | null): string {
  if (dhw === null) return "no data";
  if (dhw >= 8) return "severe heat stress — widespread bleaching and significant mortality likely";
  if (dhw >= 4) return "significant heat stress — bleaching likely";
  if (dhw > 0) return "accumulating heat stress — bleaching possible";
  return "no accumulated heat stress";
}

/** Register coral_bleaching (NOAA Coral Reef Watch, no key). */
export function registerCoralTools(server: McpServer): void {
  server.registerTool(
    "coral_bleaching",
    {
      title: "Coral bleaching heat stress (NOAA Coral Reef Watch)",
      description:
        "Coral-reef heat stress at any ocean point from NOAA Coral Reef Watch's daily global 5 km " +
        "products (1985→~2 days ago), no key: current Degree Heating Weeks (DHW, °C-weeks; ≥4 " +
        "bleaching likely, ≥8 severe bleaching and mortality), SST and SST anomaly, the Bleaching " +
        "Alert Area level (No stress → Watch → Warning → Alert Level 1/2), plus a recent strided " +
        "series with the window's peak. Optional bbox adds the latest-day max/mean DHW and share " +
        "of cells at Alert Level ≥1 across the box. Pair with enso and ocean_temp. Posts a chart card.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("Latitude of the reef point (Great Barrier Reef ≈ -18.3)."),
        lon: z.number().min(-180).max(180).describe("Longitude of the reef point (Great Barrier Reef ≈ 147.5)."),
        days: z.number().int().min(30).max(3650).optional().describe("History window in days (default 365; sampled to ≤60 steps)."),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional()
          .describe("Optional reef-region box [west, south, east, north], ≤10° per side, for area stats on the latest day."),
      },
    },
    async ({ lat, lon, days, bbox }) =>
      safe(async () => {
        const latest = await crwLatest(lat, lon);
        const now = latest.points[0];
        if (!now || (now.dhw === null && now.sst === null)) {
          throw new OverviewError(`no Coral Reef Watch data at ${lat}, ${lon} — likely a land cell; try a point just offshore on the reef`);
        }
        const window = days ?? 365;
        const [series, area] = await Promise.all([
          crwSeries(lat, lon, addDays(now.t, -window), now.t),
          bbox ? crwArea(bbox as BBox) : Promise.resolve(null),
        ]);
        const pts: CrwPoint[] = series.points.some((p) => p.t === now.t) ? series.points : [...series.points, now];
        const peak = pts.reduce<CrwPoint | null>((a, p) => (p.dhw !== null && (a?.dhw ?? -1) < p.dhw ? p : a), null);
        const alert = baaLabel(now.baa);
        const summary =
          `Reef cell (${latest.gridLat}, ${latest.gridLon}) on ${now.t}: DHW ${now.dhw ?? "n/a"} °C-weeks (${interpretDhw(now.dhw)}), ` +
          `SST ${now.sst ?? "n/a"} °C (anomaly ${now.sstAnomaly !== null && now.sstAnomaly >= 0 ? "+" : ""}${now.sstAnomaly ?? "n/a"} °C), alert: ${alert ?? "n/a"}.` +
          (peak ? ` Peak in the last ${window} d: DHW ${peak.dhw} on ${peak.t} (${baaLabel(peak.baa) ?? "n/a"}).` : "") +
          (area ? ` Box max DHW ${area.maxDhw ?? "n/a"}, ${area.alertSharePct ?? "n/a"}% of cells at Alert Level ≥1.` : "");
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `Coral heat stress · DHW ${now.dhw ?? "n/a"} · ${alert ?? "n/a"}`,
          bbox: (bbox as BBox | undefined) ?? [latest.gridLon - 1, Math.max(-90, latest.gridLat - 1), latest.gridLon + 1, Math.min(90, latest.gridLat + 1)],
          payload: {
            series: [
              { label: "Degree Heating Weeks", unit: "°C-weeks", points: pts.map((p) => ({ t: p.t, v: p.dhw })) },
              { label: "SST anomaly", unit: "°C", points: pts.map((p) => ({ t: p.t, v: p.sstAnomaly })) },
            ],
            thresholds: [4, 8],
            summary,
            source: CRW_SOURCE,
          },
        });
        return {
          source: CRW_SOURCE,
          gridCell: { lat: latest.gridLat, lon: latest.gridLon },
          latest: { date: now.t, dhw: now.dhw, sst: now.sst, sstAnomaly: now.sstAnomaly, alertLevel: now.baa, alert, reading: interpretDhw(now.dhw) },
          window: { days: window, from: series.points[0]?.t ?? null, to: now.t, strideDays: series.strideDays, earliestAvailable: CRW_START },
          peak: peak ? { date: peak.t, dhw: peak.dhw, alert: baaLabel(peak.baa) } : null,
          area,
          thresholds: { dhwSignificant: 4, dhwSevere: 8, unit: "°C-weeks" },
          summary,
          series: pts,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
