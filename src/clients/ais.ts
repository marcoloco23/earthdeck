// Ship density from a short aisstream.io sample — runner-side only (the key is a secret, so
// it never reaches a browser). Opens the websocket for ≤ `seconds` (default 20) over a few
// bounding boxes, keeps each vessel's latest position *in memory only*, and returns a
// density grid + counts by ship type. The output carries no MMSI, name, call sign, IMO,
// destination or track — only per-cell vessel counts, per-region totals and per-type totals.
//
// Protocol (verified live 2026-09-27): connect wss://stream.aisstream.io/v0/stream, then within
// 3 s send {APIKey, BoundingBoxes: [[[lat, lon], [lat, lon]], …], FilterMessageTypes}. Frames
// arrive as binary JSON: {MessageType, MetaData: {MMSI, ShipName, latitude, longitude,
// time_utc}, Message: {<MessageType>: {...}}}; the first is a SubscriptionConfirmation.
// Ship type (AIS code) only comes in ShipStaticData (every ~6 min) / StaticDataReport, so a
// 20 s sample leaves most vessels "unknown". Coverage is terrestrial (volunteer receivers):
// busy straits fill up, open-ocean reserves stay nearly empty — absence is not evidence.

import type { BBox } from "../types.js";

export const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";
export const AIS_ATTRIBUTION = "AIS: aisstream.io (terrestrial receivers, short sample)";

export interface AisRegion {
  id: string;
  name: string;
  bbox: BBox;
}

/** Busy straits (good terrestrial coverage) + a few reserves near coasts. */
export const AIS_REGIONS: AisRegion[] = [
  { id: "gibraltar", name: "Strait of Gibraltar", bbox: [-6.6, 35.6, -4.8, 36.4] },
  { id: "dover", name: "Strait of Dover", bbox: [0.8, 50.6, 2.2, 51.3] },
  { id: "singapore", name: "Singapore Strait", bbox: [103.5, 1.0, 104.5, 1.5] },
  { id: "hormuz", name: "Strait of Hormuz", bbox: [55.8, 25.8, 57.2, 27.0] },
  { id: "bosphorus", name: "Bosphorus", bbox: [28.9, 40.95, 29.2, 41.25] },
  { id: "panama", name: "Panama Canal approaches", bbox: [-80.0, 8.7, -79.4, 9.5] },
  { id: "galapagos", name: "Galápagos Marine Reserve", bbox: [-92.68, -2.09, -88.57, 2.36] },
  { id: "revillagigedo", name: "Revillagigedo", bbox: [-115.48, 17.65, -110.07, 20.01] },
];

export type ShipClass = "cargo" | "tanker" | "passenger" | "fishing" | "tug_service" | "pleasure_sailing" | "high_speed" | "other" | "unknown";
const CLASSES: ShipClass[] = ["cargo", "tanker", "passenger", "fishing", "tug_service", "pleasure_sailing", "high_speed", "other", "unknown"];

/** AIS ship-type code (ITU-R M.1371) → coarse class. */
export function shipClass(code: number | undefined): ShipClass {
  if (code === undefined || !Number.isFinite(code) || code <= 0) return "unknown";
  if (code === 30) return "fishing";
  if (code === 31 || code === 32 || code === 33 || code === 34 || code === 35 || (code >= 50 && code <= 59)) return "tug_service";
  if (code === 36 || code === 37) return "pleasure_sailing";
  if (code >= 40 && code <= 49) return "high_speed";
  if (code >= 60 && code <= 69) return "passenger";
  if (code >= 70 && code <= 79) return "cargo";
  if (code >= 80 && code <= 89) return "tanker";
  return "other";
}

export interface ShipDensity {
  generatedAt: string;
  sampleSeconds: number;
  cellDeg: number;
  messages: number;
  vessels: number;
  byType: Record<ShipClass, number>;
  regions: { id: string; name: string; bbox: BBox; vessels: number }[];
  cells: { lon: number; lat: number; count: number }[];
  attribution: string;
  privacy: string;
}

const inBox = (b: BBox, lon: number, lat: number) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

/** Folds aisstream frames into per-vessel latest state; `result()` emits only aggregates. */
export class AisAggregator {
  private readonly vessels = new Map<string, { lon: number; lat: number; type?: number }>();
  private messages = 0;

  add(frame: unknown): void {
    const f = frame as { MessageType?: string; MetaData?: { MMSI?: unknown; latitude?: unknown; longitude?: unknown }; Message?: Record<string, Record<string, unknown>> };
    if (!f || typeof f !== "object" || !f.MessageType || f.MessageType === "SubscriptionConfirmation") return;
    const id = f.MetaData?.MMSI;
    if (id === undefined || id === null) return;
    this.messages++;
    const key = String(id);
    const v = this.vessels.get(key) ?? { lon: NaN, lat: NaN };
    const body = f.Message?.[f.MessageType] ?? {};
    if (f.MessageType === "ShipStaticData" && typeof body.Type === "number") v.type = body.Type;
    if (f.MessageType === "StaticDataReport") {
      const t = (body.ReportB as { ShipType?: unknown } | undefined)?.ShipType;
      if (typeof t === "number") v.type = t;
    }
    const lat = Number(f.MetaData?.latitude);
    const lon = Number(f.MetaData?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
      v.lat = lat;
      v.lon = lon;
    }
    this.vessels.set(key, v);
  }

  result(o: { regions: AisRegion[]; sampleSeconds: number; cellDeg?: number; now?: Date }): ShipDensity {
    const cellDeg = o.cellDeg ?? 0.1;
    const placed = [...this.vessels.values()].filter((v) => Number.isFinite(v.lat));
    const byType = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ShipClass, number>;
    for (const v of placed) byType[shipClass(v.type)]++;
    const cells = new Map<string, { lon: number; lat: number; count: number }>();
    const snap = (x: number) => Math.round((Math.floor(x / cellDeg) * cellDeg + cellDeg / 2) * 1e4) / 1e4;
    for (const v of placed) {
      const lon = snap(v.lon);
      const lat = snap(v.lat);
      const k = `${lon},${lat}`;
      const c = cells.get(k) ?? { lon, lat, count: 0 };
      c.count++;
      cells.set(k, c);
    }
    return {
      generatedAt: (o.now ?? new Date()).toISOString(),
      sampleSeconds: o.sampleSeconds,
      cellDeg,
      messages: this.messages,
      vessels: placed.length,
      byType,
      regions: o.regions.map((r) => ({ ...r, vessels: placed.filter((v) => inBox(r.bbox, v.lon, v.lat)).length })),
      cells: [...cells.values()].sort((a, b) => b.count - a.count || a.lon - b.lon || a.lat - b.lat),
      attribution: AIS_ATTRIBUTION,
      privacy: `Aggregated: vessel counts per ${cellDeg}° cell, per region and per ship type from one short sample. No MMSI, names, call signs, IMO numbers, destinations or tracks are stored or published.`,
    };
  }
}

/** The subscription message (bbox → aisstream's [[lat, lon], [lat, lon]] corners). */
export function subscription(key: string, regions: AisRegion[]): string {
  return JSON.stringify({
    APIKey: key,
    BoundingBoxes: regions.map((r) => [[r.bbox[1], r.bbox[0]], [r.bbox[3], r.bbox[2]]]),
    FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
  });
}

type WsLike = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

/** Sample aisstream for `seconds` (capped at 20) and return aggregates only. Never throws on a quiet stream. */
export async function sampleAis(
  key: string,
  o: { regions?: AisRegion[]; seconds?: number; cellDeg?: number; WebSocketImpl?: new (url: string) => WsLike } = {},
): Promise<ShipDensity> {
  const regions = o.regions ?? AIS_REGIONS;
  const seconds = Math.min(20, Math.max(1, o.seconds ?? 20));
  const Impl = o.WebSocketImpl ?? (globalThis as unknown as { WebSocket?: new (url: string) => WsLike }).WebSocket;
  if (!Impl) throw new Error("no WebSocket implementation (Node ≥ 22 has one built in)");
  const agg = new AisAggregator();
  const pending: Promise<void>[] = [];
  let error: string | null = null;
  await new Promise<void>((resolve) => {
    const ws = new Impl(AISSTREAM_URL);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve();
    }, seconds * 1000);
    ws.onopen = () => ws.send(subscription(key, regions));
    ws.onmessage = (e) => {
      pending.push(
        decode(e.data).then((text) => {
          try {
            const j = JSON.parse(text) as { error?: string };
            if (j && typeof j.error === "string") error = j.error;
            else agg.add(j);
          } catch {
            /* skip malformed frame */
          }
        }),
      );
    };
    ws.onerror = () => {
      error ??= "websocket error";
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await Promise.all(pending);
  const r = agg.result({ regions, sampleSeconds: seconds, cellDeg: o.cellDeg });
  // aisstream reports a bad key as {"error": "..."} then closes: surface that (the message
  // never contains the key itself), but a merely quiet sample is a valid, empty result.
  if (error && r.messages === 0) throw new Error(`aisstream: ${error}`);
  return r;
}

async function decode(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof (data as Blob).arrayBuffer === "function") return Buffer.from(await (data as Blob).arrayBuffer()).toString("utf8");
  return String(data);
}
