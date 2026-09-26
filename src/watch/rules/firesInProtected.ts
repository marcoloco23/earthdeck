// fires_in_protected@1.0 — primary: a cluster of high-FRP VIIRS detections inside a
// watched protected / Indigenous boundary; confirmation: an open EONET wildfire event
// there (different provider) or re-detection on a later pass (revisit). Geometry is the
// cluster centroid, deliberately coarse — these are often Indigenous lands and the people
// nearest a fire must never be put at risk by a precise public pin.

import type { Evidence } from "../../ledger/schema.js";
import type { FireDetection } from "../../types.js";
import { bboxArea, dayStart, defineRule, num, ringBBox, type Candidate, type Confirmation, type RuleContext } from "./types.js";

interface FiresResult {
  count: number;
  source: string;
  fires: FireDetection[];
}
interface EventsResult {
  events: { id: string; title: string; category: string; lastDate: string | null; link: string }[];
}

export const firesInProtected = defineRule({
  name: "fires_in_protected",
  version: "1.0",
  tier: 1,
  description: "Cluster of high-FRP fire detections inside a protected or Indigenous boundary.",
  blindSpots: [
    "Cannot tell wildfire from managed burning, agricultural fire or a legal prescribed burn.",
    "VIIRS misses fires under cloud/smoke and small or short-lived fires between overpasses (~2/day).",
    "The watched boundary is the watchlist's bbox, not the legal polygon, until protected_areas (M3) lands.",
    "S-NPP products end 1 Nov 2026 — the default source is NOAA-20; a source outage looks like calm.",
    "Says nothing about cause or responsibility; attribution needs land-tenure and concession layers.",
  ],
  requires: ["FIRMS_MAP_KEY"],
  ringKm: 30,
  defaults: { dayRange: 2, minFrp: 20, minDetections: 5, source: "VIIRS_NOAA20_NRT", revisitHours: 18 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...firesInProtected.defaults, ...ctx.params };
    const args = { bbox: ctx.aoi.bbox, dayRange: num(p.dayRange, 2), source: String(p.source) };
    const r = (await ctx.call("fires_in", args)) as FiresResult;
    const hot = r.fires.filter((f) => (f.frp ?? 0) >= num(p.minFrp, 20));
    if (hot.length < num(p.minDetections, 5)) return null;

    const latest = hot.map((f) => f.acqDate).sort().pop()!;
    const observedAt = dayStart(latest);
    const cx = hot.reduce((a, f) => a + f.lon, 0) / hot.length;
    const cy = hot.reduce((a, f) => a + f.lat, 0) / hot.length;
    const maxFrp = Math.max(...hot.map((f) => f.frp ?? 0));

    let baseline: Candidate["baseline"];
    try {
      const ring = ringBBox(ctx.aoi.bbox, firesInProtected.ringKm);
      const rr = (await ctx.call("fires_in", { ...args, bbox: ring })) as FiresResult;
      const ringHot = rr.fires.filter((f) => (f.frp ?? 0) >= num(p.minFrp, 20)).length;
      const aoiValue = hot.length / bboxArea(ctx.aoi.bbox);
      const regionalValue = ringHot / bboxArea(ring);
      baseline = { metric: "hot detections per deg²", ringKm: firesInProtected.ringKm, aoiValue: round3(aoiValue), regionalValue: round3(regionalValue), ratio: regionalValue > 0 ? round3(aoiValue / regionalValue) : null };
    } catch {
      /* context only */
    }

    const evidence: Evidence[] = [
      {
        id: `firms-${String(p.source).toLowerCase()}-${ctx.aoi.id}-${latest}`,
        kind: "alert",
        source: `firms-${String(p.source).toLowerCase()}`,
        datetime: observedAt,
        href: "https://firms.modaps.eosdis.nasa.gov/",
        method: { name: "fires_in", version: "1.0", params: { ...args, minFrp: num(p.minFrp, 20) } },
        summary: `${hot.length} detections with FRP ≥ ${num(p.minFrp, 20)} MW in ${num(p.dayRange, 2)} d (max ${maxFrp.toFixed(1)} MW).`,
        values: { detections: hot.length, maxFrp: Math.round(maxFrp * 10) / 10 },
      },
    ];
    return {
      title: `Fire cluster${ctx.aoi.name ? ` inside ${ctx.aoi.name}` : ""}: ${hot.length} hot detections`,
      summary:
        `${hot.length} VIIRS detections with fire radiative power ≥ ${num(p.minFrp, 20)} MW within ${num(p.dayRange, 2)} days inside the watched boundary` +
        (baseline?.ratio != null ? `; density ${baseline.ratio}× the ${baseline.ringKm} km neighbourhood` : "") +
        ". Awaiting an independent signal (EONET event or a later pass).",
      observedAt,
      evidence,
      values: { detections: hot.length, maxFrp: Math.round(maxFrp * 10) / 10 },
      geometry: { type: "Point", coordinates: [Math.round(cx * 100) / 100, Math.round(cy * 100) / 100] },
      baseline,
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...firesInProtected.defaults, ...ctx.params };
    // 1. Different provider: an open EONET wildfire event in the AOI.
    const ev = (await ctx.call("events", { bbox: ctx.aoi.bbox, category: "wildfires", days: 14, limit: 20 })) as EventsResult;
    const hit = ev.events.find((e) => /wildfire/i.test(e.category));
    if (hit) {
      return {
        independence: "provider",
        signal: {
          id: `eonet-${hit.id}`,
          kind: "record",
          source: "nasa-eonet",
          datetime: hit.lastDate && /^\d{4}-\d{2}-\d{2}/.test(hit.lastDate) ? `${hit.lastDate.slice(0, 10)}T00:00:00Z` : ctx.now,
          href: hit.link,
          method: { name: "events", version: "1.0", params: { category: "wildfires", days: 14 } },
          summary: `EONET open wildfire event: ${hit.title}.`,
        },
      };
    }
    // 2. Revisit: re-detection on a later pass, once enough time has passed.
    const hours = (Date.parse(ctx.now) - Date.parse(candidate.observedAt)) / 3_600_000;
    if (hours < num(p.revisitHours, 18)) return null;
    const args = { bbox: ctx.aoi.bbox, dayRange: 1, source: String(p.source) };
    const r = (await ctx.call("fires_in", args)) as FiresResult;
    const hot = r.fires.filter((f) => (f.frp ?? 0) >= num(p.minFrp, 20) && dayStart(f.acqDate) > candidate.observedAt);
    if (hot.length < Math.max(2, Math.ceil(num(p.minDetections, 5) / 2))) return null;
    const latest = hot.map((f) => f.acqDate).sort().pop()!;
    return {
      independence: "revisit",
      signal: {
        id: `firms-${String(p.source).toLowerCase()}-${ctx.aoi.id}-${latest}-revisit`,
        kind: "alert",
        source: `firms-${String(p.source).toLowerCase()}`,
        datetime: dayStart(latest),
        method: { name: "fires_in", version: "1.0", params: { ...args, minFrp: num(p.minFrp, 20) } },
        summary: `${hot.length} hot detections again on a later pass (${latest}).`,
        values: { detections: hot.length },
      },
    };
  },
});

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
