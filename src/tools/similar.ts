import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AEF_ATTRIBUTION,
  pooled,
  AEF_BANDS,
  AEF_YEARS,
  aefEntriesFor,
  openAefCog,
  pickLevel,
  readEmbedWindow,
  type AefIndexEntry,
  type EmbedGrid,
} from "../clients/aef.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { lonLatToUtm, utmToLonLat, utmZoneLabel } from "../utm.js";
import { newId, nowIso } from "../util.js";

// AEF footprints are 81.92 km; a bbox near a file/zone corner can legitimately touch 8.
const MAX_FILES = 8;
const MAX_AREA_DEG2 = 2.5;
const CELL_CHOICES = [160, 320, 640] as const;

/** UTM coords of a lon/lat in a SPECIFIC zone+hemisphere convention (EPSG:326xx/327xx). */
function utmInConvention(lon: number, lat: number, zoneNum: number, south: boolean) {
  const u = lonLatToUtm(lon, lat, zoneNum);
  let northing = u.northing;
  if (south && !u.south) northing += 10_000_000; // point N of equator in a S-zone file
  if (!south && u.south) northing -= 10_000_000; // point S of equator in an N-zone file
  return { easting: u.easting, northing };
}

interface Match {
  lon: number;
  lat: number;
  similarity: number;
}

/** Greedy top-k with spatial thinning so one blob doesn't fill the whole list. */
export function topKThinned(cands: Match[], k: number, minSepDeg: number): Match[] {
  const sorted = [...cands].sort((a, b) => b.similarity - a.similarity);
  const out: Match[] = [];
  for (const c of sorted) {
    if (out.length >= k) break;
    const tooClose = out.some(
      (o) => Math.abs(o.lon - c.lon) < minSepDeg && Math.abs(o.lat - c.lat) < minSepDeg,
    );
    if (!tooClose) out.push(c);
  }
  return out;
}

/** Register AlphaEarth similarity tools: eo_similar (zero-key). */
export function registerSimilarTools(server: McpServer): void {
  server.registerTool(
    "eo_similar",
    {
      title: "Embedding similarity search (AlphaEarth)",
      description:
        "\"Find everywhere that looks like this\": takes the AlphaEarth Foundations 64-d " +
        "satellite embedding at a reference point and ranks every cell of a search bbox by " +
        "cosine similarity — land cover, structure and seasonal dynamics, not just color. " +
        "Zero keys (open Source Cooperative mirror, CC-BY). Years 2017–2025. The reference " +
        "cell itself should rank ~1.0 (sanity check). Posts a similarity-heatmap card to " +
        "the dashboard. Costs a few MB of range reads per file touched.",
      inputSchema: {
        refLon: z.number().min(-180).max(180).describe("Reference point longitude."),
        refLat: z.number().min(-84).max(84).describe("Reference point latitude."),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .describe("Search area [west, south, east, north] (≤ 2.5 deg², ≤ 8 AEF files)."),
        year: z
          .number()
          .int()
          .min(AEF_YEARS.min)
          .max(AEF_YEARS.max)
          .optional()
          .describe(`Embedding year ${AEF_YEARS.min}–${AEF_YEARS.max} (default 2024).`),
        cellM: z
          .union([z.literal(160), z.literal(320), z.literal(640)])
          .optional()
          .describe("Search cell size in meters: 160, 320 (default), or 640."),
        topK: z.number().int().min(1).max(50).optional().describe("Matches to return (default 12)."),
      },
    },
    async ({ refLon, refLat, bbox, year, cellM, topK }) =>
      safe(async () => {
        const box = bbox as BBox;
        const [w, s, e, n] = box;
        if (e <= w || n <= s) throw new OverviewError("bbox must be [west, south, east, north]");
        const area = (e - w) * (n - s);
        if (area > MAX_AREA_DEG2) {
          throw new OverviewError(
            `search bbox is ${area.toFixed(1)} deg² — cap is ${MAX_AREA_DEG2} deg². Tile the area and call eo_similar per tile.`,
          );
        }
        const yr = year ?? 2024;
        const cm = (cellM ?? 320) as (typeof CELL_CHOICES)[number];
        const k = topK ?? 12;

        // Candidate files: every index entry of the bbox's zones that intersects it.
        const zones = new Set<string>([
          utmZoneLabel(w, s),
          utmZoneLabel(w, n),
          utmZoneLabel(e, s),
          utmZoneLabel(e, n),
          utmZoneLabel((w + e) / 2, (s + n) / 2),
        ]);
        const entries: AefIndexEntry[] = [];
        for (const zone of zones) {
          for (const entry of await aefEntriesFor(yr, zone)) {
            if (entry.w84West < e && entry.w84East > w && entry.w84South < n && entry.w84North > s) {
              entries.push(entry);
            }
          }
        }
        if (entries.length === 0) {
          throw new OverviewError(
            `no AlphaEarth ${yr} coverage intersects this bbox (dataset covers global land, 2017–2025).`,
          );
        }
        if (entries.length > MAX_FILES) {
          throw new OverviewError(
            `search bbox spans ${entries.length} AEF files (cap ${MAX_FILES}). Shrink the bbox or use cellM=640.`,
          );
        }

        // The reference file: prefer one of the search files (its grid is read anyway).
        const refZone = utmZoneLabel(refLon, refLat);
        let refEntry = entries.find(
          (x) => x.w84West <= refLon && refLon < x.w84East && x.w84South <= refLat && refLat < x.w84North,
        );
        if (!refEntry) {
          const refEntries = await aefEntriesFor(yr, refZone);
          refEntry = refEntries.find(
            (x) => x.w84West <= refLon && refLon < x.w84East && x.w84South <= refLat && refLat < x.w84North,
          );
        }
        if (!refEntry) {
          throw new OverviewError(`no AlphaEarth ${yr} file covers the reference point — is it on land?`);
        }

        // Read the search grids (and the ref window if its file isn't among them).
        // Bounded concurrency: the mirror 5xx's under big parallel bursts.
        const grids = await pooled(entries, 3, async (entry) => {
            const info = await openAefCog(entry.url);
            const lvl = pickLevel(info, cm);
            const zoneNum = Number(entry.zone.slice(0, -1));
            const south = entry.zone.endsWith("S");
            const c1 = utmInConvention(w, s, zoneNum, south);
            const c2 = utmInConvention(e, n, zoneNum, south);
            const c3 = utmInConvention(w, n, zoneNum, south);
            const c4 = utmInConvention(e, s, zoneNum, south);
            const grid = await readEmbedWindow(info, entry, lvl, {
              west: Math.min(c1.easting, c2.easting, c3.easting, c4.easting),
              south: Math.min(c1.northing, c2.northing, c3.northing, c4.northing),
              east: Math.max(c1.easting, c2.easting, c3.easting, c4.easting),
              north: Math.max(c1.northing, c2.northing, c3.northing, c4.northing),
            });
            return { entry, grid, zoneNum, south };
        });

        // Reference vector: from a search grid when possible, else a dedicated tiny read.
        let refVec: Float32Array | null = null;
        const refHost = grids.find((g) => g.entry === refEntry);
        const takeCell = (grid: EmbedGrid, row: number, col: number): Float32Array | null => {
          if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return null;
          if (!grid.valid[row * grid.cols + col]) return null;
          return grid.data.slice((row * grid.cols + col) * AEF_BANDS, (row * grid.cols + col + 1) * AEF_BANDS);
        };
        if (refHost) {
          const u = utmInConvention(refLon, refLat, refHost.zoneNum, refHost.south);
          refVec = takeCell(
            refHost.grid,
            Math.floor((u.northing - refHost.grid.utmSouth) / refHost.grid.cellM),
            Math.floor((u.easting - refHost.grid.utmWest) / refHost.grid.cellM),
          );
        }
        if (!refVec) {
          const info = await openAefCog(refEntry.url);
          const lvl = pickLevel(info, cm);
          const zoneNum = Number(refEntry.zone.slice(0, -1));
          const south = refEntry.zone.endsWith("S");
          const u = utmInConvention(refLon, refLat, zoneNum, south);
          const grid = await readEmbedWindow(info, refEntry, lvl, {
            west: u.easting,
            south: u.northing,
            east: u.easting + 1,
            north: u.northing + 1,
          });
          refVec = takeCell(grid, 0, 0);
        }
        if (!refVec) {
          throw new OverviewError(
            "the reference cell has no valid embedding (masked/no data) — move the point or use a larger cellM.",
          );
        }

        // Similarity over every valid cell in the search window.
        const cands: Match[] = [];
        let validCells = 0;
        let simSum = 0;
        for (const { grid, zoneNum, south } of grids) {
          for (let r = 0; r < grid.rows; r++) {
            for (let c = 0; c < grid.cols; c++) {
              if (!grid.valid[r * grid.cols + c]) continue;
              let dot = 0;
              const base = (r * grid.cols + c) * AEF_BANDS;
              for (let b = 0; b < AEF_BANDS; b++) dot += grid.data[base + b]! * refVec[b]!;
              const center = utmToLonLat(
                grid.utmWest + (c + 0.5) * grid.cellM,
                grid.utmSouth + (r + 0.5) * grid.cellM,
                zoneNum,
                south,
              );
              // Clip cells outside the requested bbox (windows are rectangular in UTM).
              if (center.lon < w || center.lon > e || center.lat < s || center.lat > n) continue;
              validCells++;
              simSum += dot;
              cands.push({ lon: center.lon, lat: center.lat, similarity: dot });
            }
          }
        }
        if (validCells === 0) throw new OverviewError("no valid embedding cells in the search bbox.");

        const minSepDeg = (2 * cm) / 111_000; // ≥ 2 cells apart
        const matches = topKThinned(cands, k, minSepDeg).map((m) => ({
          lon: Number(m.lon.toFixed(5)),
          lat: Number(m.lat.toFixed(5)),
          similarity: Number(m.similarity.toFixed(4)),
        }));
        const sims = cands.map((x) => x.similarity).sort((a, b) => a - b);
        const stats = {
          cells: validCells,
          simMean: Number((simSum / validCells).toFixed(4)),
          simP95: Number(sims[Math.floor(0.95 * (sims.length - 1))]!.toFixed(4)),
          simMax: Number(sims[sims.length - 1]!.toFixed(4)),
        };

        // Heatmap card: a decimated sample of all cells + the top matches.
        const HEAT_CAP = 4000;
        const step = Math.max(1, Math.ceil(cands.length / HEAT_CAP));
        const heat = cands
          .filter((_, i) => i % step === 0)
          .map((x) => ({ lon: Number(x.lon.toFixed(5)), lat: Number(x.lat.toFixed(5)), sim: Number(x.similarity.toFixed(3)) }));
        const pushed = await pushCard({
          id: newId(),
          type: "similar",
          ts: nowIso(),
          title: `eo_similar · top ${matches.length} of ${validCells} cells · ${yr}`,
          bbox: box,
          payload: {
            ref: { lon: refLon, lat: refLat },
            year: yr,
            cellM: cm,
            matches,
            heat,
            stats,
            attribution: AEF_ATTRIBUTION,
          },
        });

        return {
          source: "AlphaEarth Foundations Satellite Embedding (Source Cooperative mirror)",
          attribution: AEF_ATTRIBUTION,
          ref: { lon: refLon, lat: refLat, zone: refZone },
          year: yr,
          cellM: cm,
          searchBbox: box,
          filesUsed: entries.map((x) => x.url.split("/annual/")[1]),
          stats,
          matches,
          interpretation:
            `Top similarity ${stats.simMax} (the reference cell itself should be ≈1.0); ` +
            `mean over the search area ${stats.simMean}. Values are cosine similarity of ` +
            `unit-norm 64-d embeddings — same land cover/structure tends to score ≥0.85.`,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
