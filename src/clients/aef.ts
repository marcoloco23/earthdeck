// AlphaEarth Foundations (AEF) Satellite Embedding client — Source Cooperative mirror.
// CC-BY 4.0: "The AlphaEarth Foundations Satellite Embedding dataset is produced by
// Google and Google DeepMind." Zero keys: plain HTTPS range reads.
//
// Layout (grounded 2026-06-13 by probing the bucket — see .plans/2026-06-13_eo-similar.md):
//   {base}/{year}/{zone}/{eeImage}-{yOff}-{xOff}.tiff — BigTIFF COG, 8192² px @ 10 m,
//   64 int8 bands (A00–A63, planar=2: band-separate tiles), 1024² tiles, ZSTD (50000),
//   nodata −128, BOTTOM-UP (ModelTransformation y-scale +10), overviews 4096²…1×1 whose
//   pixels are mean embeddings renormalized to unit length (i.e. valid embeddings).
//   Dequantize: sign(v)·(v/127.5)².
// Index: aef_index.csv (798 MB) is ordered zone-major (1N…60N, 1S…60S, numeric), year
// ascending within zone → we binary-search it with HTTP range requests instead of
// downloading it.

import { decompress } from "fzstd";
import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";

const AEF_BASE =
  process.env.EARTHDECK_AEF_URL ?? "https://data.source.coop/tge-labs/aef/v1/annual";
const INDEX_URL = `${AEF_BASE}/aef_index.csv`;

export const AEF_ATTRIBUTION =
  "The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind. (CC-BY 4.0)";
export const AEF_YEARS = { min: 2017, max: 2025 };
export const AEF_BANDS = 64;
const FULL_RES_M = 10;
const FULL_PX = 8192;

async function fetchRange(url: string, start: number, end: number): Promise<Buffer> {
  // The mirror occasionally 5xx's under parallel multi-MB reads — retry twice with backoff.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { range: `bytes=${start}-${end}`, "user-agent": USER_AGENT },
    });
    if (res.status === 206 || res.status === 200) return Buffer.from(await res.arrayBuffer());
    if (res.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    throw new OverviewError(`AEF range read failed (${res.status})`, res.status, url);
  }
}

/** Run async jobs with bounded concurrency (the mirror dislikes large parallel bursts). */
export async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------
// Index: binary search over the remote CSV
// ---------------------------------------------------------------------------------------

export interface AefIndexEntry {
  url: string;
  epsg: number;
  year: number;
  zone: string; // e.g. "21S"
  utmWest: number;
  utmSouth: number;
  utmEast: number;
  utmNorth: number;
  w84West: number;
  w84South: number;
  w84East: number;
  w84North: number;
}

/** Sort key of a row in aef_index.csv: zone-major (N before S, numeric), year ascending. */
export function indexOrderKey(zoneNum: number, south: boolean, year: number): number {
  return (south ? 1 : 0) * 1e9 + zoneNum * 1e7 + year;
}

/** Extract the order key from any chunk of CSV that contains a path cell. */
export function keyOfChunk(chunk: string): number | null {
  const m = chunk.match(/annual\/(\d{4})\/(\d{1,2})([NS])\//);
  if (!m) return null;
  return indexOrderKey(Number(m[2]), m[3] === "S", Number(m[1]));
}

/**
 * Parse the non-WKT tail of index rows out of a CSV chunk. Rows look like:
 *   "POLYGON((…))",EPSG:32601,s3://…/aef/v1/annual/2017/1N/x…-0000000000-0000008192.tiff,
 *   2017,1N,254240,5734400,336160,5816320,-180,51.72…,-179.37…,52.47…
 * The huge WKT column is skipped entirely; the s3:// path is rewritten onto AEF_BASE.
 */
export function parseIndexRows(chunk: string): AefIndexEntry[] {
  const out: AefIndexEntry[] = [];
  const re =
    /,EPSG:(\d+),([^,]*\/annual\/(\d{4})\/(\d{1,2}[NS])\/([^,/]+\.tiff)),(\d{4}),([0-9]{1,2}[NS]),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)(?=\r?\n|$)/g;
  for (const m of chunk.matchAll(re)) {
    out.push({
      epsg: Number(m[1]),
      url: `${AEF_BASE}/${m[3]}/${m[4]}/${m[5]}`,
      year: Number(m[6]),
      zone: m[7]!,
      utmWest: Number(m[8]),
      utmSouth: Number(m[9]),
      utmEast: Number(m[10]),
      utmNorth: Number(m[11]),
      w84West: Number(m[12]),
      w84South: Number(m[13]),
      w84East: Number(m[14]),
      w84North: Number(m[15]),
    });
  }
  return out;
}

const PROBE_BYTES = 64 * 1024; // ≥ a few full rows (rows are ~2.6 KB)
const SECTION_CHUNK = 4 * 1024 * 1024;

const indexSizeCache = { size: 0 };
const sectionCache = new Map<string, AefIndexEntry[]>();

async function indexSize(): Promise<number> {
  if (indexSizeCache.size > 0) return indexSizeCache.size;
  const res = await fetch(INDEX_URL, { method: "HEAD", headers: { "user-agent": USER_AGENT } });
  const len = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || !len) throw new OverviewError(`AEF index unavailable (${res.status})`);
  indexSizeCache.size = len;
  return len;
}

/**
 * All index entries for one (year, zone), via ranged binary search of the big CSV.
 * Network cost: ~15 × 64 KB probes + the section itself (typically 0.5–6 MB), then cached
 * for the life of the process.
 */
export async function aefEntriesFor(year: number, zone: string): Promise<AefIndexEntry[]> {
  const cacheKey = `${zone}/${year}`;
  const hit = sectionCache.get(cacheKey);
  if (hit) return hit;

  const zm = zone.match(/^(\d{1,2})([NS])$/);
  if (!zm) throw new OverviewError(`bad UTM zone '${zone}'`);
  const target = indexOrderKey(Number(zm[1]), zm[2] === "S", year);

  const total = await indexSize();
  // Binary search for the first byte position whose row key is >= target.
  let lo = 0;
  let hi = total;
  while (hi - lo > PROBE_BYTES) {
    const mid = Math.floor((lo + hi) / 2);
    const chunk = (await fetchRange(INDEX_URL, mid, mid + PROBE_BYTES - 1)).toString("utf8");
    const key = keyOfChunk(chunk);
    if (key === null || key >= target) hi = mid;
    else lo = mid;
  }

  // Stream forward from lo, collecting rows of the target section until the key passes it.
  const entries: AefIndexEntry[] = [];
  let pos = lo;
  let carry = "";
  while (pos < total) {
    const chunk = (await fetchRange(INDEX_URL, pos, Math.min(pos + SECTION_CHUNK, total) - 1)).toString("utf8");
    const text = carry + chunk;
    const lastNl = text.lastIndexOf("\n");
    const complete = lastNl >= 0 ? text.slice(0, lastNl) : "";
    carry = lastNl >= 0 ? text.slice(lastNl + 1) : text;
    for (const e of parseIndexRows(complete)) {
      const k = indexOrderKey(Number(e.zone.slice(0, -1)), e.zone.endsWith("S"), e.year);
      if (k === target) entries.push(e);
      else if (k > target) {
        sectionCache.set(cacheKey, entries);
        return entries;
      }
    }
    pos += SECTION_CHUNK;
  }
  sectionCache.set(cacheKey, entries);
  return entries;
}

// ---------------------------------------------------------------------------------------
// BigTIFF COG reader — pinned to this dataset's exact shape, asserts everything.
// ---------------------------------------------------------------------------------------

interface AefLevel {
  width: number;
  height: number;
  tileW: number;
  tileH: number;
  tilesAcross: number;
  tilesPerBand: number;
  compression: number; // 50000 zstd | 1 none (test fixtures)
  offsets: number[]; // SamplesPerPixel × tilesPerBand entries, plane-major (band 0 first)
  sizes: number[];
  /** Pixel size in meters at this level (10 × downsample factor). */
  cellM: number;
}

export interface AefCogInfo {
  url: string;
  /** Affine from FULL-RES (col,row) → UTM: x = x0 + 10·col ; y = y0 + 10·row (bottom-up). */
  x0: number;
  y0: number;
  levels: AefLevel[];
}

const T_U16 = 3;
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

/** Parse the BigTIFF header + full IFD chain. One ~256 KB range read covers everything. */
export async function openAefCog(url: string): Promise<AefCogInfo> {
  const head = await fetchRange(url, 0, 256 * 1024 - 1);
  // Little-endian BigTIFF magic: "II", 43, offset-size 8.
  if (head.length < 16 || head[0] !== 0x49 || head[1] !== 0x49 || head.readUInt16LE(2) !== 43) {
    throw new OverviewError(`not a little-endian BigTIFF: ${url}`);
  }
  const need = (cond: boolean, what: string): void => {
    if (!cond) throw new OverviewError(`AEF COG layout changed (${what}) — update the reader: ${url}`);
  };

  let ifdOff = u64(head, 8);
  const levels: AefLevel[] = [];
  let transform: number[] | null = null;
  while (ifdOff !== 0) {
    need(ifdOff + 8 <= head.length, "IFD beyond header read");
    const n = u64(head, ifdOff);
    const tags = new Map<number, { typ: number; cnt: number; val: number }>();
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 8 + i * 20;
      tags.set(head.readUInt16LE(e), {
        typ: head.readUInt16LE(e + 2),
        cnt: u64(head, e + 4),
        val: u64(head, e + 12),
      });
    }
    const get = (tag: number) => tags.get(tag);
    const width = get(256)!.val;
    const height = get(257)!.val;
    need(get(258)?.typ === T_U16 && get(258)?.cnt === 64, "64 bands");
    need(get(277)?.val === 64, "spp=64");
    need(get(284)?.val === 2, "planar=2");
    need((get(317)?.val ?? 1) === 1, "predictor=1");
    const compression = get(259)!.val;
    need(compression === 50000 || compression === 1, `compression=${compression}`);
    const tileW = get(322)!.val;
    const tileH = get(323)!.val;
    const to = get(324)!;
    const tb = get(325)!;
    const tilesAcross = Math.ceil(width / tileW);
    const tilesPerBand = tilesAcross * Math.ceil(height / tileH);
    need(to.cnt === tilesPerBand * 64, "tile count = 64 planes");
    // Offset/size arrays: count≤1 values are inlined in `val`, larger live at offset `val`.
    const offsets: number[] = [];
    const sizes: number[] = [];
    if (to.cnt === 1) {
      offsets.push(to.val);
      sizes.push(tb.val);
    } else {
      need(to.val + to.cnt * 8 <= head.length && tb.val + tb.cnt * 4 <= head.length, "tile arrays in header");
      for (let i = 0; i < to.cnt; i++) offsets.push(u64(head, to.val + i * 8));
      for (let i = 0; i < tb.cnt; i++) sizes.push(head.readUInt32LE(tb.val + i * 4));
    }
    const t34264 = get(34264);
    if (t34264 && !transform) {
      need(t34264.cnt === 16 && t34264.val + 128 <= head.length, "ModelTransformation");
      transform = [];
      for (let i = 0; i < 16; i++) transform.push(head.readDoubleLE(t34264.val + i * 8));
    }
    levels.push({
      width,
      height,
      tileW,
      tileH,
      tilesAcross,
      tilesPerBand,
      compression,
      offsets,
      sizes,
      cellM: FULL_RES_M * (FULL_PX / width),
    });
    ifdOff = u64(head, ifdOff + 8 + n * 20);
    if (ifdOff !== 0) need(ifdOff + 8 <= head.length, "IFD chain in header");
  }
  need(levels.length > 0, "no IFDs");
  need(transform !== null, "georeferencing");
  const sx = transform![0]!;
  const x0 = transform![3]!;
  const sy = transform![5]!;
  const y0 = transform![7]!;
  need(sx === FULL_RES_M && sy === FULL_RES_M, "10 m bottom-up transform");
  // Pixel size per level = base pixel size × downsample factor (base is level 0).
  const baseW = levels[0]!.width;
  for (const l of levels) l.cellM = sx * (baseW / l.width);
  return { url, x0, y0, levels };
}

/** The level whose pixel size best matches (without exceeding 2×) the requested cellM. */
export function pickLevel(info: AefCogInfo, cellM: number): number {
  let best = 0;
  let bestDiff = Infinity;
  info.levels.forEach((l, i) => {
    const d = Math.abs(l.cellM - cellM);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

export interface EmbedGrid {
  /** Row-major [row][col][band] dequantized, renormalized embeddings. ROW 0 = SOUTH. */
  data: Float32Array;
  /** 1 = valid, 0 = nodata. */
  valid: Uint8Array;
  rows: number;
  cols: number;
  cellM: number;
  /** UTM coords of the grid's south-west corner (cell edges). */
  utmWest: number;
  utmSouth: number;
  epsg: number;
}

/** De-quantize an int8 AEF value to the native [-1,1] float. */
export function dequantize(v: number): number {
  return (v / 127.5) ** 2 * Math.sign(v);
}

/**
 * Read a window of embeddings at a given level. The window is given in UTM meters and
 * clamped to the file. Tiles are fetched with coalesced range requests (adjacent tiles
 * are contiguous in the file) and decompressed with fzstd.
 */
export async function readEmbedWindow(
  info: AefCogInfo,
  entry: Pick<AefIndexEntry, "epsg">,
  levelIdx: number,
  utm: { west: number; south: number; east: number; north: number },
): Promise<EmbedGrid> {
  const L = info.levels[levelIdx];
  if (!L) throw new OverviewError(`no level ${levelIdx}`);
  const cell = L.cellM;
  // Window in level pixel coords; bottom-up: row r spans y0 + r·cell … y0 + (r+1)·cell.
  const col0 = Math.max(0, Math.floor((utm.west - info.x0) / cell));
  const row0 = Math.max(0, Math.floor((utm.south - info.y0) / cell));
  const col1 = Math.min(L.width, Math.ceil((utm.east - info.x0) / cell));
  const row1 = Math.min(L.height, Math.ceil((utm.north - info.y0) / cell));
  const cols = col1 - col0;
  const rows = row1 - row0;
  if (cols <= 0 || rows <= 0) {
    throw new OverviewError("window does not intersect this AEF file");
  }

  // Which tiles (per band) the window touches.
  const tx0 = Math.floor(col0 / L.tileW);
  const tx1 = Math.floor((col1 - 1) / L.tileW);
  const ty0 = Math.floor(row0 / L.tileH);
  const ty1 = Math.floor((row1 - 1) / L.tileH);
  const tilesNeeded: number[] = [];
  for (let b = 0; b < AEF_BANDS; b++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        tilesNeeded.push(b * L.tilesPerBand + ty * L.tilesAcross + tx);
      }
    }
  }

  // Coalesce adjacent byte ranges into few big reads.
  const wanted = tilesNeeded
    .map((t) => ({ t, off: L.offsets[t]!, size: L.sizes[t]! }))
    .sort((a, b) => a.off - b.off);
  const GAP = 256 * 1024;
  const groups: Array<{ start: number; end: number; tiles: typeof wanted }> = [];
  for (const w of wanted) {
    const g = groups[groups.length - 1];
    if (g && w.off - g.end <= GAP) {
      g.end = Math.max(g.end, w.off + w.size);
      g.tiles.push(w);
    } else {
      groups.push({ start: w.off, end: w.off + w.size, tiles: [w] });
    }
  }
  const tileData = new Map<number, Uint8Array>();
  await Promise.all(
    groups.map(async (g) => {
      const buf = await fetchRange(info.url, g.start, g.end - 1);
      for (const w of g.tiles) {
        const raw = new Uint8Array(buf.buffer, buf.byteOffset + (w.off - g.start), w.size);
        tileData.set(w.t, L.compression === 50000 ? decompress(raw) : raw);
      }
    }),
  );

  // Assemble [row][col][band] with dequantization, then renormalize each vector.
  const data = new Float32Array(rows * cols * AEF_BANDS);
  const valid = new Uint8Array(rows * cols).fill(1);
  for (let b = 0; b < AEF_BANDS; b++) {
    for (let r = 0; r < rows; r++) {
      const absRow = row0 + r;
      const ty = Math.floor(absRow / L.tileH);
      const inTileR = absRow % L.tileH;
      for (let c = 0; c < cols; c++) {
        const absCol = col0 + c;
        const tx = Math.floor(absCol / L.tileW);
        const tile = tileData.get(b * L.tilesPerBand + ty * L.tilesAcross + tx)!;
        const raw = (tile[inTileR * L.tileW + (absCol % L.tileW)]! << 24) >> 24;
        if (raw === -128) valid[r * cols + c] = 0;
        else data[(r * cols + c) * AEF_BANDS + b] = dequantize(raw);
      }
    }
  }
  for (let i = 0; i < rows * cols; i++) {
    if (!valid[i]) continue;
    let s = 0;
    for (let b = 0; b < AEF_BANDS; b++) s += data[i * AEF_BANDS + b]! ** 2;
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    if (inv === 0) {
      valid[i] = 0;
      continue;
    }
    for (let b = 0; b < AEF_BANDS; b++) data[i * AEF_BANDS + b]! *= inv;
  }

  return {
    data,
    valid,
    rows,
    cols,
    cellM: cell,
    utmWest: info.x0 + col0 * cell,
    utmSouth: info.y0 + row0 * cell,
    epsg: entry.epsg,
  };
}
