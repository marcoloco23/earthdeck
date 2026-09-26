import { randomFillSync, randomUUID } from "node:crypto";
import type { BBox } from "./types.js";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** YYYY-MM-DD for `daysAgo` days before now (UTC). 0 = today, 1 = yesterday. */
export function isoDate(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date by `delta` days (UTC), returning YYYY-MM-DD. */
export function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Validate that a bbox is well-formed: west<east, south<north, within world bounds. */
export function assertBBox(bbox: BBox): void {
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error(`bbox must be four finite numbers, got ${JSON.stringify(bbox)}`);
  }
  if (west >= east) throw new Error(`bbox west (${west}) must be < east (${east})`);
  if (south >= north) throw new Error(`bbox south (${south}) must be < north (${north})`);
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error(`bbox out of bounds: ${JSON.stringify(bbox)} (lon −180..180, lat −90..90)`);
  }
}

/**
 * Pick an integer image height from a width and a bbox, preserving aspect ratio so the
 * picture isn't stretched. Clamped to [64, maxDim].
 */
export function heightFor(bbox: BBox, width: number, maxDim = 2048): number {
  const [west, south, east, north] = bbox;
  const lonSpan = east - west;
  const latSpan = north - south;
  const ratio = lonSpan > 0 ? latSpan / lonSpan : 1;
  const h = Math.round(width * ratio);
  return Math.max(64, Math.min(maxDim, h));
}

/** Clamp a requested image width to a sane range. */
export function clampWidth(width: number, maxDim = 2048): number {
  if (!Number.isFinite(width)) return 1024;
  return Math.max(64, Math.min(maxDim, Math.round(width)));
}

/** Center [lon, lat] of a bbox. */
export function bboxCenter(bbox: BBox): [number, number] {
  const [west, south, east, north] = bbox;
  return [(west + east) / 2, (south + north) / 2];
}

/**
 * UUIDv7 (RFC 9562): 48-bit Unix-ms timestamp + version/variant bits + 74 random bits.
 * Time-ordered, so ledger ids sort chronologically as plain strings.
 */
export function uuidv7(now = Date.now()): string {
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  randomFillSync(b, 6, 10);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
