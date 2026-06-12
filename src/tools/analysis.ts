import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CopernicusClient,
  getCopernicus,
  S2_COLLECTION,
  type DataSourceSpec,
  type SceneInfo,
} from "../clients/copernicus.js";
import {
  INDEX_NAMES,
  medianRenderEvalscript,
  medianStatEvalscript,
  RENDER_EVALSCRIPTS,
  statEvalscript,
} from "../evalscripts.js";
import { pushCard } from "../dashboard/push.js";
import { s2Provenance, type CompositeMethod } from "../provenance.js";
import { imageResult, safe, safeResult } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, clampWidth, heightFor, isoDate, newId, nowIso } from "../util.js";

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box [west, south, east, north] in degrees (EPSG:4326)");

const RENDER_VIEWS = Object.keys(RENDER_EVALSCRIPTS) as [string, ...string[]];

const compositeSchema = z
  .enum(["leastCC", "median"])
  .optional()
  .describe(
    "leastCC (default): least-cloudy scene mosaic. median: per-pixel temporal median of all " +
      "clear observations in the window — kills residual cloud/haze, the robust choice for " +
      "change detection, but costs more processing units and wants a window of 30+ days.",
  );

/**
 * The Process/Statistics source for a composite method. Median uses ORBIT mosaicking inside
 * the evalscript, so no mosaickingOrder is sent (scene picking doesn't apply); leastCC
 * returns undefined → the client's default Sentinel-2 least-cloudy source.
 */
function s2SourceFor(composite: CompositeMethod, maxCloud?: number): DataSourceSpec | undefined {
  if (composite !== "median") return undefined;
  return { collection: S2_COLLECTION, ...(maxCloud != null ? { maxCloud } : {}) };
}

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
        "color ramp). composite leastCC (default) uses the least-cloudy scene in a lookback " +
        "window; composite median builds a cloud-free per-pixel temporal-median composite. " +
        "Requires CDSE creds. Returns the image and posts it to the dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        view: z.enum(RENDER_VIEWS).optional().describe("trueColor (default), falseColor, or ndvi."),
        composite: compositeSchema,
        windowDays: z.number().int().min(1).max(90).optional().describe("Lookback window (default 14; 45 for composite=median)."),
        maxCloud: z.number().min(0).max(100).optional().describe("Max scene cloud %% to consider."),
        width: z.number().int().min(64).max(2048).optional().describe("Image width px (default 1024)."),
      },
    },
    async ({ bbox, date, view, composite, windowDays, maxCloud, width }) =>
      safeResult(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const v = view ?? "trueColor";
        const comp = (composite ?? "leastCC") as CompositeMethod;
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? (comp === "median" ? 45 : 14)));
        const w = clampWidth(width ?? 1024);
        const h = heightFor(box, w);
        const [png, scenes] = await Promise.all([
          client.process(box, {
            dateFrom,
            dateTo,
            evalscript: comp === "median" ? medianRenderEvalscript(v) : RENDER_EVALSCRIPTS[v]!,
            width: w,
            height: h,
            maxCloud,
            source: s2SourceFor(comp, maxCloud),
          }),
          scenesFor(client, box, dateFrom, dateTo),
        ]);
        const dataBase64 = png.toString("base64");
        const provenance = s2Provenance({ bbox: box, from: dateFrom, to: dateTo, kind: "image", composite: comp, scenes });
        const meta = {
          source: "Copernicus Sentinel-2 L2A",
          view: v,
          composite: comp,
          window: { from: dateFrom, to: dateTo },
          bbox: box,
          dimensions: { width: w, height: h },
          provenance,
          dashboard: (await pushCard({
            id: newId(),
            type: "imagery",
            ts: nowIso(),
            title: `Sentinel-2 ${v}${comp === "median" ? " median" : ""} · ${dateFrom}…${dateTo}`,
            bbox: box,
            payload: { source: "Copernicus Sentinel-2 L2A", view: v, composite: comp, provenance },
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
        "Compute statistics for a spectral index over a Sentinel-2 composite: " +
        "NDVI (vegetation), NDWI (water), NBR (burn). composite leastCC (default) or median " +
        "(per-pixel temporal median of clear observations — robust to residual cloud). " +
        "Returns mean/min/max/stdev/percentiles the model can reason over. Requires CDSE " +
        "creds. Posts an index card to the dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        index: z.enum(INDEX_NAMES as [string, ...string[]]).optional().describe("NDVI (default), NDWI, or NBR."),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        composite: compositeSchema,
        windowDays: z.number().int().min(1).max(180).optional().describe("Composite window in days (default 30)."),
      },
    },
    async ({ bbox, index, date, composite, windowDays }) =>
      safe(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const idx = index ?? "NDVI";
        const comp = (composite ?? "leastCC") as CompositeMethod;
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? 30));
        const [stats, scenes] = await Promise.all([
          client.statistics(box, {
            dateFrom,
            dateTo,
            evalscript: comp === "median" ? medianStatEvalscript(idx) : statEvalscript(idx),
            source: s2SourceFor(comp),
          }),
          scenesFor(client, box, dateFrom, dateTo),
        ]);
        const provenance = s2Provenance({
          bbox: box,
          from: dateFrom,
          to: dateTo,
          kind: "stats",
          composite: comp,
          index: idx,
          validPct: stats.validPct,
          scenes,
        });
        const pushed = await pushCard({
          id: newId(),
          type: "index",
          ts: nowIso(),
          title: `${idx}${comp === "median" ? " median" : ""} · mean ${stats.mean.toFixed(3)} · ${dateFrom}…${dateTo}`,
          bbox: box,
          payload: { index: idx, composite: comp, stats, window: { from: dateFrom, to: dateTo }, provenance },
        });
        return {
          index: idx,
          composite: comp,
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
        "(e.g. mean-NDVI drop → deforestation, flood, or burn). composite median is the " +
        "robust choice here — per-pixel temporal medians suppress the residual-cloud noise " +
        "that fakes change. Returns both images and the change statistics, and posts a " +
        "before/after card to the dashboard. Requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        dateA: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Earlier (before) date YYYY-MM-DD."),
        dateB: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Later (after) date YYYY-MM-DD."),
        index: z.enum(INDEX_NAMES as [string, ...string[]]).optional().describe("Delta index: NDVI (default), NDWI, NBR."),
        view: z.enum(RENDER_VIEWS).optional().describe("Image view: trueColor (default), falseColor, ndvi."),
        composite: compositeSchema,
        windowDays: z.number().int().min(1).max(120).optional().describe("Composite window per date (default 25; 45 for composite=median)."),
        width: z.number().int().min(64).max(1536).optional().describe("Image width px (default 640)."),
      },
    },
    async ({ bbox, dateA, dateB, index, view, composite, windowDays, width }) =>
      safeResult(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const idx = index ?? "NDVI";
        const v = view ?? "trueColor";
        const comp = (composite ?? "leastCC") as CompositeMethod;
        const win = windowDays ?? (comp === "median" ? 45 : 25);
        const w = clampWidth(width ?? 640);
        const h = heightFor(box, w);
        const source = s2SourceFor(comp);

        const one = async (date: string) => {
          const from = addDays(date, -win);
          const [png, stats, scenes] = await Promise.all([
            client.process(box, {
              dateFrom: from,
              dateTo: date,
              evalscript: comp === "median" ? medianRenderEvalscript(v) : RENDER_EVALSCRIPTS[v]!,
              width: w,
              height: h,
              source,
            }),
            client.statistics(box, {
              dateFrom: from,
              dateTo: date,
              evalscript: comp === "median" ? medianStatEvalscript(idx) : statEvalscript(idx),
              source,
            }),
            scenesFor(client, box, from, date),
          ]);
          const provenance = s2Provenance({ bbox: box, from, to: date, kind: "stats", composite: comp, index: idx, validPct: stats.validPct, scenes });
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
          title: `${idx}${comp === "median" ? " median" : ""} ${dir} ${delta.meanChange.toFixed(3)} · ${dateA} → ${dateB}`,
          bbox: box,
          payload: {
            index: idx,
            view: v,
            composite: comp,
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
          composite: comp,
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
