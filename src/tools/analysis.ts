import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CopernicusClient, getCopernicus, type SceneInfo } from "../clients/copernicus.js";
import { INDEX_NAMES, RENDER_EVALSCRIPTS, statEvalscript } from "../evalscripts.js";
import { pushCard } from "../dashboard/push.js";
import { s2Provenance } from "../provenance.js";
import { imageResult, safe, safeResult } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, clampWidth, heightFor, isoDate, newId, nowIso } from "../util.js";

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box [west, south, east, north] in degrees (EPSG:4326)");

const RENDER_VIEWS = Object.keys(RENDER_EVALSCRIPTS) as [string, ...string[]];

/**
 * Best-effort: list the scenes that fed a composite, for the provenance block. The catalog
 * search is free metadata (no processing units), runs in parallel with the main call, and is
 * capped + swallowed so a slow/failed lookup never blocks or breaks the tool.
 */
async function scenesFor(
  client: CopernicusClient,
  box: BBox,
  from: string,
  to: string,
): Promise<SceneInfo[] | undefined> {
  try {
    return await Promise.race([
      client.search(box, { dateFrom: from, dateTo: to, limit: 8 }),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("scene lookup timeout")), 4000);
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
  } catch {
    return undefined;
  }
}

/** Register Copernicus Sentinel-2 tools: eo_render, eo_index, eo_search. Need CDSE creds. */
export function registerAnalysisTools(server: McpServer): void {
  // ---- eo_render: high-res Sentinel-2 imagery -----------------------------------------
  server.registerTool(
    "eo_render",
    {
      title: "Sentinel-2 imagery (Copernicus)",
      description:
        "Render a high-resolution (10 m) Sentinel-2 image for a bbox via Copernicus. " +
        "view: trueColor, falseColor (color-infrared, vegetation red), or ndvi (vegetation " +
        "color ramp). Uses the least-cloudy scene in a lookback window. Requires CDSE creds. " +
        "Returns the image and posts it to the dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        view: z.enum(RENDER_VIEWS).optional().describe("trueColor (default), falseColor, or ndvi."),
        windowDays: z.number().int().min(1).max(90).optional().describe("Lookback window for least-cloudy scene (default 14)."),
        maxCloud: z.number().min(0).max(100).optional().describe("Max scene cloud %% to consider."),
        width: z.number().int().min(64).max(2048).optional().describe("Image width px (default 1024)."),
      },
    },
    async ({ bbox, date, view, windowDays, maxCloud, width }) =>
      safeResult(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const v = view ?? "trueColor";
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? 14));
        const w = clampWidth(width ?? 1024);
        const h = heightFor(box, w);
        const [png, scenes] = await Promise.all([
          client.process(box, {
            dateFrom,
            dateTo,
            evalscript: RENDER_EVALSCRIPTS[v]!,
            width: w,
            height: h,
            maxCloud,
          }),
          scenesFor(client, box, dateFrom, dateTo),
        ]);
        const dataBase64 = png.toString("base64");
        const provenance = s2Provenance({ bbox: box, from: dateFrom, to: dateTo, kind: "image", scenes });
        const meta = {
          source: "Copernicus Sentinel-2 L2A",
          view: v,
          window: { from: dateFrom, to: dateTo },
          bbox: box,
          dimensions: { width: w, height: h },
          provenance,
          dashboard: (await pushCard({
            id: newId(),
            type: "imagery",
            ts: nowIso(),
            title: `Sentinel-2 ${v} · ${dateFrom}…${dateTo}`,
            bbox: box,
            payload: { source: "Copernicus Sentinel-2 L2A", view: v, provenance },
            image: { mimeType: "image/png", dataBase64 },
          }))
            ? "pushed"
            : "dashboard offline",
        };
        return imageResult(dataBase64, "image/png", meta);
      }),
  );

  // ---- eo_index: vegetation/water/burn statistics -------------------------------------
  server.registerTool(
    "eo_index",
    {
      title: "Sentinel-2 index statistics (NDVI/NDWI/NBR)",
      description:
        "Compute statistics for a spectral index over a least-cloudy Sentinel-2 composite: " +
        "NDVI (vegetation), NDWI (water), NBR (burn). Returns mean/min/max/stdev/percentiles " +
        "the model can reason over. Requires CDSE creds. Posts an index card to the dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        index: z.enum(INDEX_NAMES as [string, ...string[]]).optional().describe("NDVI (default), NDWI, or NBR."),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        windowDays: z.number().int().min(1).max(180).optional().describe("Composite window in days (default 30)."),
      },
    },
    async ({ bbox, index, date, windowDays }) =>
      safe(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const idx = index ?? "NDVI";
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? 30));
        const [stats, scenes] = await Promise.all([
          client.statistics(box, { dateFrom, dateTo, evalscript: statEvalscript(idx) }),
          scenesFor(client, box, dateFrom, dateTo),
        ]);
        const provenance = s2Provenance({
          bbox: box,
          from: dateFrom,
          to: dateTo,
          kind: "stats",
          index: idx,
          validPct: stats.validPct,
          scenes,
        });
        const pushed = await pushCard({
          id: newId(),
          type: "index",
          ts: nowIso(),
          title: `${idx} · mean ${stats.mean.toFixed(3)} · ${dateFrom}…${dateTo}`,
          bbox: box,
          payload: { index: idx, stats, window: { from: dateFrom, to: dateTo }, provenance },
        });
        return {
          index: idx,
          window: { from: dateFrom, to: dateTo },
          stats,
          provenance,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  // ---- eo_compare: change detection between two dates ---------------------------------
  server.registerTool(
    "eo_compare",
    {
      title: "Change detection (Sentinel-2, two dates)",
      description:
        "Compare the same place at two dates: renders both and computes the index delta " +
        "(e.g. mean-NDVI drop → deforestation, flood, or burn). Returns both images and the " +
        "change statistics, and posts a before/after card to the dashboard. Requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        dateA: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Earlier (before) date YYYY-MM-DD."),
        dateB: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Later (after) date YYYY-MM-DD."),
        index: z.enum(INDEX_NAMES as [string, ...string[]]).optional().describe("Delta index: NDVI (default), NDWI, NBR."),
        view: z.enum(RENDER_VIEWS).optional().describe("Image view: trueColor (default), falseColor, ndvi."),
        windowDays: z.number().int().min(1).max(120).optional().describe("Composite window per date (default 25)."),
        width: z.number().int().min(64).max(1536).optional().describe("Image width px (default 640)."),
      },
    },
    async ({ bbox, dateA, dateB, index, view, windowDays, width }) =>
      safeResult(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const idx = index ?? "NDVI";
        const v = view ?? "trueColor";
        const win = windowDays ?? 25;
        const w = clampWidth(width ?? 640);
        const h = heightFor(box, w);

        const one = async (date: string) => {
          const from = addDays(date, -win);
          const [png, stats, scenes] = await Promise.all([
            client.process(box, { dateFrom: from, dateTo: date, evalscript: RENDER_EVALSCRIPTS[v]!, width: w, height: h }),
            client.statistics(box, { dateFrom: from, dateTo: date, evalscript: statEvalscript(idx) }),
            scenesFor(client, box, from, date),
          ]);
          const provenance = s2Provenance({ bbox: box, from, to: date, kind: "stats", index: idx, validPct: stats.validPct, scenes });
          return { date, from, b64: png.toString("base64"), stats, provenance };
        };
        const [a, b] = await Promise.all([one(dateA), one(dateB)]);

        const delta = {
          meanChange: b.stats.mean - a.stats.mean,
          medianChange: (b.stats.p50 ?? b.stats.mean) - (a.stats.p50 ?? a.stats.mean),
        };
        const dir = delta.meanChange < 0 ? "decrease" : "increase";

        await pushCard({
          id: newId(),
          type: "compare",
          ts: nowIso(),
          title: `${idx} ${dir} ${delta.meanChange.toFixed(3)} · ${dateA} → ${dateB}`,
          bbox: box,
          payload: {
            index: idx,
            view: v,
            dateA,
            dateB,
            statsA: a.stats,
            statsB: b.stats,
            delta,
            provenanceA: a.provenance,
            provenanceB: b.provenance,
          },
          images: [
            { mimeType: "image/png", dataBase64: a.b64 },
            { mimeType: "image/png", dataBase64: b.b64 },
          ],
        });

        const minValid = Math.min(a.stats.validPct, b.stats.validPct);
        const lowQuality = minValid < 60;
        const meta = {
          index: idx,
          view: v,
          dateA,
          dateB,
          windowDays: win,
          [`${idx}_mean_A`]: a.stats.mean,
          [`${idx}_mean_B`]: b.stats.mean,
          validPctA: a.stats.validPct,
          validPctB: b.stats.validPct,
          delta,
          provenanceA: a.provenance,
          provenanceB: b.provenance,
          interpretation:
            `${idx} mean ${dir}d by ${Math.abs(delta.meanChange).toFixed(3)} from ${dateA} to ${dateB}` +
            ` (clear pixels: ${a.stats.validPct}% / ${b.stats.validPct}% after cloud+water masking).` +
            (lowQuality
              ? ` ⚠️ Low valid coverage (${minValid}%) on at least one date — the delta may be driven by data quality, not real change. Treat with caution.`
              : ``),
        };
        return {
          content: [
            { type: "image", data: a.b64, mimeType: "image/png" },
            { type: "image", data: b.b64, mimeType: "image/png" },
            { type: "text", text: JSON.stringify(meta, null, 2) },
          ],
        };
      }),
  );

  // ---- eo_search: Sentinel-2 scene archive search -------------------------------------
  server.registerTool(
    "eo_search",
    {
      title: "Sentinel-2 scene search (STAC)",
      description:
        "Search the Sentinel-2 archive for scenes intersecting a bbox in a date range, with " +
        "cloud cover. Useful to find a clear date before rendering. Requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (default 30 days ago)."),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (default today)."),
        maxCloud: z.number().min(0).max(100).optional().describe("Drop scenes cloudier than this %%."),
        limit: z.number().int().min(1).max(50).optional().describe("Max scenes (default 10)."),
      },
    },
    async ({ bbox, dateFrom, dateTo, maxCloud, limit }) =>
      safe(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const to = dateTo ?? isoDate(0);
        const from = dateFrom ?? addDays(to, -30);
        const scenes = await client.search(box, { dateFrom: from, dateTo: to, maxCloud, limit });
        const pushed = await pushCard({
          id: newId(),
          type: "search",
          ts: nowIso(),
          title: `${scenes.length} Sentinel-2 scene(s) · ${from}…${to}`,
          bbox: box,
          payload: { scenes, window: { from, to } },
        });
        return {
          count: scenes.length,
          window: { from, to },
          scenes,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
