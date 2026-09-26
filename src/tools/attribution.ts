import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  adminsInBBox,
  CLIMATETRACE_LICENCE,
  CLIMATETRACE_SECTORS,
  sourcesForAdmin,
  splitSources,
  type ClimateTraceSector,
  type CtSource,
} from "../clients/climatetrace.js";
import { landmarkLands, overpassProtectedAreas, wdpaAreas, type ProtectedArea } from "../clients/protected.js";
import { gfwApiKey } from "../config.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { assertBBox, bboxCenter, newId, nowIso, pointRadiusToBBox } from "../util.js";

// Both tools fan out per AOI (Overpass is a shared, slot-limited service; Climate TRACE is
// two calls per admin area) — cap the AOI so a single call stays polite.
const MAX_AREA_DEG2 = 4;
const MAX_ADMINS = 12;

const aoiSchema = {
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional()
    .describe("Bounding box [west, south, east, north] in degrees (≤ 4 deg²). Or give point + radiusKm."),
  point: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe("Centre [lon, lat] — used with radiusKm when no bbox is given."),
  radiusKm: z.number().positive().max(100).optional().describe("Radius around `point` in km (default 10)."),
};

/** Resolve bbox | point+radius into a validated, size-capped bbox. */
export function resolveAoi(bbox?: number[], point?: number[], radiusKm?: number): BBox {
  let box: BBox;
  if (bbox) box = bbox as BBox;
  else if (point) box = pointRadiusToBBox(point[0]!, point[1]!, radiusKm ?? 10);
  else throw new OverviewError("Give either bbox [w,s,e,n] or point [lon,lat] (+ radiusKm).");
  assertBBox(box);
  const area = (box[2] - box[0]) * (box[3] - box[1]);
  if (area > MAX_AREA_DEG2) {
    throw new OverviewError(
      `AOI area ${area.toFixed(1)} deg² exceeds the ${MAX_AREA_DEG2} deg² cap — tile it into smaller boxes.`,
    );
  }
  return box.map((v) => Math.round(v * 1e5) / 1e5) as BBox;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerAttributionTools(server: McpServer): void {
  server.registerTool(
    "protected_areas",
    {
      title: "Protected areas & Indigenous lands in an AOI",
      description:
        "Protected areas and Indigenous/community lands intersecting a bbox (or point + radius). " +
        "Sources: OpenStreetMap via Overpass (boundary=protected_area/national_park/aboriginal_lands; " +
        "ODbL; no key), plus — when GFW_API_KEY is set, via the GFW Data API — LandMark " +
        "Indigenous & community lands (CC BY-SA 4.0) and WDPA/Protected Planet (IDs + stats only). Each row: name, designation, " +
        "category, source, licence, id, approximate area, a COARSE centroid (0.1° — never a " +
        "precise pin for Indigenous lands), and whether it contains the AOI centroid. No " +
        "geometry is returned. Use it to " +
        "attribute fires/forest loss to the land they fall on.",
      inputSchema: aoiSchema,
    },
    async ({ bbox, point, radiusKm }) =>
      safe(async () => {
        const box = resolveAoi(bbox, point, radiusKm);
        const key = gfwApiKey();
        const [osm, landmark, wdpa] = await Promise.allSettled([
          overpassProtectedAreas(box),
          key ? landmarkLands(key, box) : Promise.resolve(null),
          key ? wdpaAreas(key, box) : Promise.resolve(null),
        ]);
        const areas: ProtectedArea[] = [];
        const sources: Record<string, string> = {};
        const settled = { osm, landmark, wdpa } as const;
        for (const [name, r] of Object.entries(settled)) {
          if (r.status === "rejected") sources[name] = `unavailable: ${errMsg(r.reason)}`;
          else if (r.value === null) sources[name] = "skipped: GFW_API_KEY not set";
          else {
            areas.push(...r.value);
            sources[name] = `ok (${r.value.length})`;
          }
        }
        if (Object.values(settled).every((r) => r.status === "rejected" || r.value === null)) {
          throw new OverviewError(`No protected-area source answered — ${JSON.stringify(sources)}`);
        }
        // Containing areas first, then larger first.
        areas.sort(
          (a, b) =>
            Number(b.containsAoiCentroid === true) - Number(a.containsAoiCentroid === true) ||
            (b.approxAreaKm2 ?? 0) - (a.approxAreaKm2 ?? 0),
        );
        const containing = areas.filter((a) => a.containsAoiCentroid === true);

        const pushed = await pushCard({
          id: newId(),
          type: "events",
          ts: nowIso(),
          title: `${areas.length} protected/Indigenous area(s) · ${containing.length} contain the AOI centre`,
          bbox: box,
          payload: {
            events: areas
              .filter((a) => a.coarseCentroid)
              .map((a) => ({
                id: `${a.source}:${a.id}`,
                title: a.name ?? "(unnamed)",
                category: a.indigenous ? "indigenous-land" : "protected-area",
                coordinates: a.coarseCentroid,
                magnitude: [a.designation, a.approxAreaKm2 != null ? `~${a.approxAreaKm2} km²` : null, a.licence]
                  .filter(Boolean)
                  .join(" · "),
                lastDate: null,
                link: a.url,
              })),
          },
        });

        return {
          aoi: { bbox: box, centroid: bboxCenter(box) },
          count: areas.length,
          containingAoiCentroid: containing.map((a) => `${a.name ?? a.id} (${a.source})`),
          areas,
          sources,
          notes: [
            "Centroids are rounded to 0.1° (~11 km) on purpose; no geometry is returned.",
            "OSM approxAreaKm2 is the feature's bounding-box extent (upper bound), not its polygon area.",
            "Absence of a row is not absence of protection or of Indigenous/community tenure — coverage has gaps.",
            "WDPA rows are IDs + stats only (licence forbids redistributing its geometry); see protectedplanet.net for boundaries.",
          ],
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "emitters",
    {
      title: "Emitting assets in an AOI (Climate TRACE)",
      description:
        "Emitting assets inside a bbox (or point + radius) from Climate TRACE v7 (CC BY 4.0; no " +
        "key): name, sector/subsector, country, lat/lon, latest annual emissions in tonnes " +
        "CO2e (100-yr) and CH4 where reported, source id + licence. Also returns area-wide " +
        "aggregate sources (e.g. municipality forest fires, cattle on pasture) for the GADM " +
        "level-2 areas the AOI touches — those are context, not located assets. Optional " +
        "sector filter. Names assets, never people; ownership is not included.",
      inputSchema: {
        ...aoiSchema,
        sector: z.enum(CLIMATETRACE_SECTORS).optional().describe("Restrict to one Climate TRACE sector."),
        year: z.number().int().min(2021).max(2100).optional().describe("Emissions year (default: API's latest)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max assets / aggregates returned (default 25)."),
      },
    },
    async ({ bbox, point, radiusKm, sector, year, limit }) =>
      safe(async () => {
        const box = resolveAoi(bbox, point, radiusKm);
        const max = limit ?? 25;
        const admins = await adminsInBBox(box);
        if (admins.length > MAX_ADMINS) {
          throw new OverviewError(
            `AOI touches ${admins.length} admin areas (cap ${MAX_ADMINS}) — use a smaller bbox.`,
          );
        }
        const all: CtSource[] = [];
        const truncatedAdmins: string[] = [];
        // Sequential per admin (2 parallel calls each) — polite to a free API.
        for (const a of admins) {
          const r = await sourcesForAdmin(a.id, { sector: sector as ClimateTraceSector | undefined, year });
          all.push(...r.sources);
          if (r.truncated) truncatedAdmins.push(a.id);
        }
        const { assets, aggregates } = splitSources(all, box);
        const sum = (xs: CtSource[], f: (s: CtSource) => number | null) =>
          Math.round(xs.reduce((t, s) => t + (f(s) ?? 0), 0));
        const dataYear = all.find((s) => s.year != null)?.year ?? year ?? null;

        const pushed = await pushCard({
          id: newId(),
          type: "events",
          ts: nowIso(),
          title: `${assets.length} emitting asset(s) · ${sum(assets, (s) => s.co2e100yrT).toLocaleString("en")} t CO2e (${dataYear ?? "latest"})`,
          bbox: box,
          payload: {
            events: assets.slice(0, max).map((s) => ({
              id: `climatetrace:${s.sourceId}`,
              title: s.name,
              category: s.sector,
              coordinates: [s.lon, s.lat],
              magnitude: `${Math.round(s.co2e100yrT ?? 0).toLocaleString("en")} t CO2e · ${s.subsector}`,
              lastDate: s.year != null ? String(s.year) : null,
              link: "https://climatetrace.org/explore",
            })),
          },
        });

        return {
          aoi: { bbox: box, centroid: bboxCenter(box) },
          source: "Climate TRACE API v7",
          licence: CLIMATETRACE_LICENCE,
          year: dataYear,
          sector: sector ?? "all",
          admins: admins.map((a) => ({ gadmId: a.id, name: a.fullName })),
          assetCount: assets.length,
          assetTotals: { co2e100yrT: sum(assets, (s) => s.co2e100yrT), ch4T: sum(assets, (s) => s.ch4T) },
          assets: assets.slice(0, max),
          areaAggregates: aggregates.slice(0, max),
          ...(truncatedAdmins.length
            ? { truncated: `source lists hit the page cap for ${truncatedAdmins.join(", ")} — smaller assets may be missing` }
            : {}),
          notes: [
            "Emissions are modelled estimates in tonnes; negative CO2e = net sink.",
            "areaAggregates cover whole admin areas (which may extend beyond the AOI); their centroid is the area's, not an asset's.",
            "Point-source lat/lon is Climate TRACE's published location; ownership is deliberately not included.",
          ],
          citation: "Climate TRACE — Tracking Real-time Atmospheric Carbon Emissions (climatetrace.org), CC BY 4.0.",
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
