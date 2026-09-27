import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FISHING_LICENCE, FISHING_SOURCE, fishingAttribution, fishingEffort, gfwFishingToken, type FishingArea, type FishingSummary, type SpatialRes } from "../clients/gfwfishing.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, assertBBox, newId, nowIso } from "../util.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export interface FishingActivityArgs {
  bbox?: BBox;
  mpaId?: string;
  days?: number;
  from?: string;
  to?: string;
  resolution?: SpatialRes;
  byGear?: boolean;
  clipBBox?: BBox;
  maxCells?: number;
}

/** The `fishing_activity` body, separate from MCP registration so tests call it directly. */
export async function fishingActivity(a: FishingActivityArgs, env: NodeJS.ProcessEnv = process.env): Promise<FishingSummary & { summary: string; provenance: Record<string, unknown> }> {
  const token = gfwFishingToken(env);
  if (!token) throw new OverviewError("fishing_activity needs GFW_FISHING_TOKEN (free Global Fishing Watch API token, non-commercial terms)");
  if ((a.bbox ? 1 : 0) + (a.mpaId ? 1 : 0) !== 1) throw new OverviewError("give exactly one of bbox or mpaId");
  if (a.bbox) {
    assertBBox(a.bbox);
    if ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) > 2500) throw new OverviewError("bbox too large (> 2500 deg²) — split it, or query an MPA by mpaId");
  }
  if (a.clipBBox) assertBBox(a.clipBBox);
  const to = a.to ?? new Date().toISOString().slice(0, 10);
  const from = a.from ?? addDays(to, -(a.days ?? 30));
  if (!DATE.test(from) || !DATE.test(to) || from >= to) throw new OverviewError(`bad date range ${from}..${to}`);
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw new OverviewError("date range longer than 366 days");
  const area: FishingArea = a.bbox ? { bbox: a.bbox } : { mpaId: a.mpaId! };
  const r = await fishingEffort(token, { area, from, to, resolution: a.resolution ?? "LOW", byGear: a.byGear, clip: a.clipBBox, maxCells: a.maxCells ?? 0 });
  const where = a.mpaId ? `WDPA MPA ${a.mpaId}` : `bbox ${JSON.stringify(a.bbox)}`;
  const top = r.byFlag.slice(0, 3).map((f) => `${f.flag} ${f.hours} h`).join(", ");
  const summary =
    `${r.totalHours} hours of apparent fishing in ${where}, ${from}..${r.lastDataDate ?? to} (${r.activeDays} active days, ${r.cells} cells at ${r.cellDeg}°)` +
    (top ? `; by flag: ${top}` : "") +
    (r.byGear?.length ? `; top gear: ${r.byGear[0]!.gear} ${r.byGear[0]!.hours} h` : "") +
    (r.clip ? `; ${r.clip.hours} h in the clip box` : "") +
    ".";
  return {
    ...r,
    summary,
    provenance: {
      dataSource: FISHING_SOURCE,
      dataset: r.dataset,
      attribution: fishingAttribution(Number(to.slice(0, 4))),
      licence: FISHING_LICENCE,
      request: { endpoint: "POST /v3/4wings/report", area: r.area, dateRange: [from, to], spatial: r.resolution, groupBy: ["FLAG", ...(r.byGear ? ["GEARTYPE"] : [])] },
      retrievedAt: nowIso(),
      privacy: "Aggregated effort only (hours per cell/day/flag/gear). No vessel names, IDs, MMSI or call signs are requested or returned.",
      disclaimer:
        "Apparent fishing effort is inferred by a model from AIS tracks: vessels without AIS (or with it switched off / spoofed) are invisible, " +
        "transiting can be misread as fishing, and data lag ~4 days. Fishing inside an MPA may be legal in some zones. Decision-support, not a finding of wrongdoing.",
    },
  };
}

/** Register marine tools: fishing_activity (Global Fishing Watch apparent fishing effort). */
export function registerMarineTools(server: McpServer): void {
  server.registerTool(
    "fishing_activity",
    {
      title: "Apparent fishing effort (Global Fishing Watch)",
      description:
        "Hours of apparent fishing (AIS-based, model-inferred) in a bbox or inside a WDPA marine protected area " +
        "(mpaId = WDPA site_pid, e.g. '11753' Galápagos Marine Reserve) over a date range — total hours, by flag state, " +
        "by gear type, a daily series, and optionally the top grid cells and the hours inside a clip box. Aggregated only: " +
        "never names or identifies vessels. Needs GFW_FISHING_TOKEN (non-commercial terms). Data lag ~4 days.",
      inputSchema: {
        bbox: bboxSchema.optional().describe("[west, south, east, north]; must not cross the antimeridian (split it)."),
        mpaId: z.string().regex(/^[0-9]+(_[0-9]+)?$/).optional().describe("WDPA site_pid of a marine protected area (GFW region dataset public-mpa-all)."),
        days: z.number().int().min(1).max(366).optional().describe("Window ending `to` (default 30)."),
        from: z.string().regex(DATE).optional(),
        to: z.string().regex(DATE).optional().describe("Default today (UTC)."),
        resolution: z.enum(["LOW", "HIGH"]).optional().describe("LOW = 0.1° cells (default), HIGH = 0.01°."),
        byGear: z.boolean().optional().describe("Also break down by gear type (one extra request; default true)."),
        clipBBox: bboxSchema.optional().describe("Also sum hours in cells whose centre lies in this box."),
        maxCells: z.number().int().min(0).max(2000).optional().describe("Top cells by hours to return (default 0)."),
      },
    },
    async (args) =>
      safe(async () => {
        const r = await fishingActivity(args as FishingActivityArgs);
        await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `Fishing effort · ${r.totalHours} h`,
          ...(args.bbox ? { bbox: args.bbox as BBox } : {}),
          payload: { series: [{ label: "Apparent fishing", unit: "h", points: r.daily.map((d) => ({ t: d.date, v: d.hours })) }], summary: r.summary, source: String(r.provenance.attribution) },
        });
        return r;
      }),
  );
}
