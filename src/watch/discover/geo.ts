// Pure geometry + naming helpers for `earthdeck discover` (no I/O, fully unit-tested).

import type { BBox } from "../../types.js";
import { bboxArea } from "../rules/types.js";

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;

/** Round to `dp` decimals (avoids 0.30000000000000004 in committed JSON). */
export function round(v: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Snap a bbox outward to a `step`-degree grid and clamp to the globe — tidy, stable numbers. */
export function snapOut(bbox: BBox, step = 0.01): BBox {
  const [w, s, e, n] = bbox;
  const down = (v: number) => round(Math.floor(v / step + 1e-9) * step, 4);
  const up = (v: number) => round(Math.ceil(v / step - 1e-9) * step, 4);
  return [Math.max(-180, down(w)), Math.max(-90, down(s)), Math.min(180, up(e)), Math.min(90, up(n))];
}

/** Pad a bbox by `km` on every side (longitude padding widened by 1/cos(lat)). */
export function padKm(bbox: BBox, km: number): BBox {
  const [w, s, e, n] = bbox;
  const dLat = km / KM_PER_DEG_LAT;
  const midLat = (s + n) / 2;
  const dLon = km / (KM_PER_DEG_LON_EQ * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return [Math.max(-180, w - dLon), Math.max(-90, s - dLat), Math.min(180, e + dLon), Math.min(90, n + dLat)];
}

/** A `side`-degree square centred on a point. */
export function boxAround(lon: number, lat: number, side: number): BBox {
  const h = side / 2;
  return [lon - h, lat - h, lon + h, lat + h];
}

/** Equirectangular distance in km (plenty for 15–50 km clustering). */
export function kmBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * KM_PER_DEG_LAT;
  const dx = (lon2 - lon1) * KM_PER_DEG_LON_EQ * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export interface Tile {
  /** 1-based, row-major from the north-west corner — stable for a given parent bbox + cap. */
  index: number;
  count: number;
  bbox: BBox;
}

/**
 * Split a bbox into an equal nx × ny grid whose cells are each ≤ `maxDeg2` in area and
 * ≤ `maxSide` degrees on a side. A bbox already under both caps comes back as one tile.
 * Deterministic: the same parent always yields the same tiles in the same order.
 */
export function tileBBox(bbox: BBox, maxDeg2: number, maxSide = Math.sqrt(maxDeg2)): Tile[] {
  const [w, s, e, n] = bbox;
  const W = e - w;
  const H = n - s;
  let nx = Math.max(1, Math.ceil(W / maxSide - 1e-9));
  let ny = Math.max(1, Math.ceil(H / maxSide - 1e-9));
  // Equal cells of (W/nx)×(H/ny); grow the longer-cell axis until the area fits.
  while ((W / nx) * (H / ny) > maxDeg2 + 1e-9) {
    if (W / nx >= H / ny) nx++;
    else ny++;
  }
  const tiles: Tile[] = [];
  const count = nx * ny;
  for (let j = 0; j < ny; j++) {
    const top = n - (H * j) / ny;
    const bottom = j === ny - 1 ? s : n - (H * (j + 1)) / ny;
    for (let i = 0; i < nx; i++) {
      const left = w + (W * i) / nx;
      const right = i === nx - 1 ? e : w + (W * (i + 1)) / nx;
      tiles.push({ index: j * nx + i + 1, count, bbox: [round(left), round(bottom), round(right), round(top)] });
    }
  }
  return tiles;
}

export interface Point {
  lat: number;
  lon: number;
}

/**
 * Single-linkage clustering: two points closer than `km` share a cluster (chains allowed —
 * an oil field is a chain of flares). Grid-bucketed union-find, O(n) neighbours per point.
 * Returns clusters as index lists, each sorted, clusters ordered by their smallest index —
 * deterministic for a deterministic input order.
 */
export function clusterSingleLinkage<T extends Point>(points: readonly T[], km: number): number[][] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const cellDeg = km / KM_PER_DEG_LAT; // lon cells are this many degrees too; we widen the search by latitude
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${x}:${y}`;
  points.forEach((p, i) => {
    const k = key(Math.floor(p.lon / cellDeg), Math.floor(p.lat / cellDeg));
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  });
  points.forEach((p, i) => {
    const cx = Math.floor(p.lon / cellDeg);
    const cy = Math.floor(p.lat / cellDeg);
    const reachX = Math.ceil(1 / Math.max(0.05, Math.cos((p.lat * Math.PI) / 180)));
    for (let dx = -reachX; dx <= reachX; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (j > i && kmBetween(p.lat, p.lon, points[j]!.lat, points[j]!.lon) <= km) union(i, j);
        }
      }
    }
  });
  const groups = new Map<number, number[]>();
  points.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  return [...groups.values()].sort((a, b) => a[0]! - b[0]!);
}

/** Tight bbox of points (degenerate for a single point — pad before use). */
export function pointsBBox(points: readonly Point[]): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  return [w, s, e, n];
}

/** Intersection area / area of the smaller box (1 = one contains the other). */
export function overlapOfSmaller(a: BBox, b: BBox): number {
  const w = Math.max(a[0], b[0]);
  const s = Math.max(a[1], b[1]);
  const e = Math.min(a[2], b[2]);
  const n = Math.min(a[3], b[3]);
  if (e <= w || n <= s) return 0;
  return ((e - w) * (n - s)) / Math.min(bboxArea(a), bboxArea(b));
}

/** Lowercase ASCII slug: diacritics stripped, anything else → dashes, trimmed to `max`. */
export function slug(s: string, max = 40): string {
  const out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, max).replace(/-+$/g, "");
}

/** "30.56N" style coordinate token for ids: 30.56 → "30p6n", -47.1 → "47p1w". */
export function coordToken(v: number, pos: string, neg: string, dp = 1): string {
  const r = round(Math.abs(v), dp).toFixed(dp).replace(".", "p");
  return `${r}${v >= 0 ? pos : neg}`;
}

/** Keep an AOI id within the watchlist regex (≤ 64 chars, lowercase, digits, dashes). */
export function aoiId(...parts: (string | number)[]): string {
  const id = parts
    .map((p) => slug(String(p), 64))
    .filter(Boolean)
    .join("-");
  return id.slice(0, 64).replace(/-+$/g, "");
}

export { bboxArea };
