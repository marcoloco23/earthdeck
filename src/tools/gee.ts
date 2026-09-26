import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { biomass, landCoverMix, population, type LandCoverDataset } from "../clients/gee.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { newId, nowIso } from "../util.js";

/** Register gee_query (Google Earth Engine REST, service-account key). */
export function registerGeeTools(server: McpServer): void {
  server.registerTool(
    "gee_query",
    {
      title: "Google Earth Engine query (land cover, biomass, population)",
      description:
        "Zonal statistics over a bounding box computed server-side in Google Earth Engine " +
        "(needs GEE_SERVICE_ACCOUNT_JSON + GEE_PROJECT). query='land_cover' → class shares from " +
        "dataset 'dynamic-world' (10 m, near-real-time, per-pixel mode over dateFrom..dateTo, default " +
        "last 90 d), 'mapbiomas' (Brazil 30 m annual 1985–2024 — separates PASTURE from natural " +
        "grassland, returns naturalSharePct) or 'worldcover' (ESA 10 m, 2021). query='biomass' → GEDI " +
        "L4B mean aboveground biomass density (t/ha, 1 km, 2019–2021, ±51.6° lat). query='population' → " +
        "WorldPop 100 m people count (bbox ≤2° per side). Large boxes are computed at a coarser scale " +
        "(scaleM is reported). Posts a card.",
      inputSchema: {
        query: z.enum(["land_cover", "biomass", "population"]),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[west, south, east, north] degrees"),
        dataset: z.enum(["dynamic-world", "mapbiomas", "worldcover"]).optional().describe("land_cover only (default dynamic-world)"),
        year: z.number().int().min(1985).max(2030).optional().describe("mapbiomas year (default 2024) or population year (default 2020)"),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("dynamic-world window start"),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("dynamic-world window end"),
      },
    },
    async ({ query, bbox, dataset, year, dateFrom, dateTo }) =>
      safe(async () => {
        const box = bbox as BBox;
        let out: Record<string, unknown>;
        let title: string;
        let metrics: { label: string; value: string; sub?: string }[];
        if (query === "land_cover") {
          const ds: LandCoverDataset = dataset ?? "dynamic-world";
          const mix = await landCoverMix(box, ds, { year, dateFrom, dateTo });
          out = { query, bbox: box, ...mix };
          title = `Land cover · ${ds}${mix.naturalSharePct !== null ? ` · ${mix.naturalSharePct}% natural` : ""}`;
          metrics = mix.classes.slice(0, 8).map((c) => ({ label: c.name, value: `${c.sharePct}%` }));
        } else if (query === "biomass") {
          const r = await biomass(box);
          out = { query, bbox: box, ...r };
          title = `Biomass · ${r.meanAgbTHa ?? "n/a"} t/ha`;
          metrics = [{ label: "Mean AGB", value: `${r.meanAgbTHa ?? "n/a"} t/ha`, sub: "GEDI L4B, 1 km" }];
        } else {
          const r = await population(box, year);
          out = { query, bbox: box, ...r };
          title = `Population · ${r.people?.toLocaleString("en-US") ?? "n/a"} (${r.year})`;
          metrics = [{ label: "People", value: r.people?.toLocaleString("en-US") ?? "n/a", sub: `WorldPop ${r.year}` }];
        }
        const pushed = await pushCard({
          id: newId(),
          type: "pulse",
          ts: nowIso(),
          title,
          bbox: box,
          payload: { metrics, summary: title, source: out.source },
        });
        return { ...out, dashboard: pushed ? "pushed" : "dashboard offline" };
      }),
  );
}
