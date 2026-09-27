// Marine layers for the public site, produced server-side at export time so no secret ever
// reaches a browser:
//   api/marine/fishing.json  Global Fishing Watch apparent fishing effort, last 30 days, 0.1°
//                            cells around every reserve in watchlists/marine.json (GeoJSON points)
//   api/marine/ships.json    aisstream.io ship density from one ≤ 20 s sample (GeoJSON points)
// Each is built only when its key is set (GFW_FISHING_TOKEN / AISSTREAM_KEY), cached next to
// the ledger dir, and refreshed at most every EARTHDECK_MARINE_FISHING_HOURS (24) /
// EARTHDECK_MARINE_SHIPS_HOURS (1) — so frequent exports don't spend the GFW token. Any
// failure falls back to the cache, else the file is simply omitted; the site works without.
// Neither file carries a vessel identity: fishing is hours per cell, ships are counts per cell.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sampleAis, type ShipDensity } from "../clients/ais.js";
import { effortGrid, FISHING_LICENCE, fishingAttribution, gfwFishingToken } from "../clients/gfwfishing.js";
import type { BBox } from "../types.js";
import { addDays } from "../util.js";
import { loadWatchlists } from "./watchlist.js";

export interface MarineOptions {
  mode: "auto" | "cache" | "off";
  cacheDir: string;
  watchlist: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  log?: (s: string) => void;
  /** Injection points for tests. */
  grid?: typeof effortGrid;
  sample?: typeof sampleAis;
}

export interface MarineFiles {
  fishing?: string;
  ships?: string;
}

interface Area {
  mpaId: string;
  name: string;
  bbox: BBox;
}

/** One query box per reserve (per side of the antimeridian): the union of its tiles. */
export function fishingAreas(watchlistPath: string): Area[] {
  const out = new Map<string, Area>();
  for (const wl of loadWatchlists(watchlistPath)) {
    for (const a of wl.aois) {
      const p = a.rules.find((r) => r.name === "mpa_fishing")?.params;
      if (!p || typeof p.mpaId !== "string") continue;
      const key = `${p.mpaId}|${a.bbox[0] < 0 ? "w" : "e"}`;
      const name = typeof p.mpaName === "string" ? p.mpaName : a.name;
      const b = a.bbox as BBox;
      const cur = out.get(key);
      out.set(key, cur ? { ...cur, bbox: [Math.min(cur.bbox[0], b[0]), Math.min(cur.bbox[1], b[1]), Math.max(cur.bbox[2], b[2]), Math.max(cur.bbox[3], b[3])] } : { mpaId: p.mpaId, name, bbox: b });
    }
  }
  return [...out.values()];
}

export async function buildFishingGeoJson(token: string, areas: Area[], now: Date, grid: typeof effortGrid = effortGrid, log: (s: string) => void = () => {}): Promise<string | null> {
  const to = now.toISOString().slice(0, 10);
  const from = addDays(to, -30);
  const features: unknown[] = [];
  const summary: { mpaId: string; name: string; hours: number }[] = [];
  let dataset = "";
  for (const a of areas) {
    try {
      const r = await grid(token, { bbox: a.bbox }, from, to, "LOW");
      dataset = r.dataset;
      let hours = 0;
      for (const c of r.cells) {
        hours += c.hours;
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { hours: c.hours } });
      }
      const prev = summary.find((s) => s.mpaId === a.mpaId);
      if (prev) prev.hours = Math.round((prev.hours + hours) * 10) / 10;
      else summary.push({ mpaId: a.mpaId, name: a.name, hours: Math.round(hours * 10) / 10 });
    } catch (e) {
      log(`  marine: fishing grid for ${a.name}: ${(e as Error).message}`);
    }
  }
  if (!summary.length) return null;
  return JSON.stringify({
    type: "FeatureCollection",
    features,
    meta: {
      kind: "fishing-effort",
      generatedAt: now.toISOString(),
      from,
      to,
      cellDeg: 0.1,
      unit: "hours of apparent fishing per 0.1° cell, whole window",
      dataset,
      areas: summary,
      attribution: fishingAttribution(now.getUTCFullYear()),
      licence: FISHING_LICENCE,
      note: "Boxes around watched marine reserves, not their legal boundaries. Apparent fishing is inferred from AIS; vessels without AIS are invisible. Aggregated — no vessel identities.",
    },
  });
}

export function shipsGeoJson(d: ShipDensity): string {
  const { cells, ...meta } = d;
  return JSON.stringify({
    type: "FeatureCollection",
    features: cells.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { count: c.count } })),
    meta: { kind: "ship-density", ...meta },
  });
}

function fresh(path: string, hours: number, now: Date): boolean {
  return existsSync(path) && now.getTime() - statSync(path).mtimeMs < hours * 3_600_000;
}

function readCache(path: string): string | undefined {
  try {
    const s = readFileSync(path, "utf8");
    const j = JSON.parse(s) as { type?: string };
    return j.type === "FeatureCollection" ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function marineSnapshots(o: MarineOptions): Promise<MarineFiles> {
  if (o.mode === "off") return {};
  const env = o.env ?? process.env;
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const hours = (name: string, d: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 0 && env[name]?.trim() ? v : d;
  };
  const fishingPath = join(o.cacheDir, "fishing.json");
  const shipsPath = join(o.cacheDir, "ships.json");
  const save = (path: string, body: string) => {
    try {
      mkdirSync(o.cacheDir, { recursive: true });
      writeFileSync(path, body);
    } catch {
      /* cache is best-effort */
    }
  };
  const out: MarineFiles = {};

  // Keys gate producing; "cache" mode (e.g. a re-export without keys) only reads what a keyed run left.
  const token = gfwFishingToken(env);
  if (token || o.mode === "cache") {
    if (token && o.mode === "auto" && !fresh(fishingPath, hours("EARTHDECK_MARINE_FISHING_HOURS", 24), now)) {
      try {
        const body = await buildFishingGeoJson(token, fishingAreas(o.watchlist), now, o.grid, log);
        if (body) save(fishingPath, body);
      } catch (e) {
        log(`  marine: fishing grid failed: ${(e as Error).message} — using the cache`);
      }
    }
    out.fishing = readCache(fishingPath);
  }

  const aisKey = env.AISSTREAM_KEY?.trim();
  if (aisKey || o.mode === "cache") {
    if (aisKey && o.mode === "auto" && !fresh(shipsPath, hours("EARTHDECK_MARINE_SHIPS_HOURS", 1), now)) {
      try {
        const d = await (o.sample ?? sampleAis)(aisKey, { seconds: 20 });
        save(shipsPath, shipsGeoJson(d));
      } catch (e) {
        log(`  marine: AIS sample failed: ${(e as Error).message} — using the cache`);
      }
    }
    out.ships = readCache(shipsPath);
  }
  return out;
}
