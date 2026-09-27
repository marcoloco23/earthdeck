// mpa_fishing@1.0 — primary: Global Fishing Watch apparent fishing hours inside a no-take /
// strict marine protected area over the last `days` ≥ `minHours`. With a WDPA `mpaId` (the
// marine watchlist always has one) GFW clips the effort to the reserve's legal polygon
// server-side (region `public-mpa-all/<mpaId>`) and we count the 0.01° cells that also fall
// in this AOI's box — so a tiled reserve is judged per tile, and nothing outside the polygon
// counts. Without an id, the AOI box itself is the (approximate) boundary.
// Confirmation (whichever comes first):
//   1. method — the effort is not a boundary artefact: at least `insetShare` of the bar is
//      met in cells well inside the box (box inset by `insetFrac` on every side).
//   2. revisit — ≥ `revisitDays` later, fishing is still there in the new days alone
//      (pro-rated bar): persistence across two different temporal windows.
// Aggregated effort only; the title and summary never name a vessel or company.

import type { Evidence } from "../../ledger/schema.js";
import type { BBox } from "../../types.js";
import { addDays } from "../../util.js";
import { bboxPolygon, dayStart, defineRule, num, type Candidate, type Confirmation, type RuleContext } from "./types.js";

interface FishingResult {
  dataset: string;
  from: string;
  to: string;
  totalHours: number;
  activeDays: number;
  lastDataDate: string | null;
  byFlag: { flag: string; hours: number }[];
  clip: { hours: number; share: number | null } | null;
  provenance?: { attribution?: string };
}

const GFW_HREF = "https://globalfishingwatch.org/map";
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The box shrunk by `frac` of its width/height on every side. */
export function insetBBox(b: BBox, frac: number): BBox {
  const dx = (b[2] - b[0]) * frac;
  const dy = (b[3] - b[1]) * frac;
  return [b[0] + dx, b[1] + dy, b[2] - dx, b[3] - dy];
}

function mpaIdOf(p: Record<string, unknown>): string | null {
  return typeof p.mpaId === "string" && p.mpaId ? p.mpaId : null;
}

function mpaName(ctx: RuleContext): string {
  const p = ctx.params.mpaName;
  if (typeof p === "string" && p.trim()) return p.trim();
  return (ctx.aoi.name ?? ctx.aoi.id).replace(/\s+—\s+tile.*$/, "");
}

export const mpaFishing = defineRule({
  name: "mpa_fishing",
  version: "1.0",
  tier: 2,
  description: "Apparent fishing hours (Global Fishing Watch) inside a no-take / strict marine protected area.",
  blindSpots: [
    "Only vessels broadcasting AIS are seen: 'dark' vessels (AIS off, absent or spoofed) are invisible, and most small-scale boats carry no AIS at all.",
    "Apparent fishing is inferred by a GFW model from vessel movement, not observed catch — it can be wrong for a given track.",
    "Transiting, drifting or waiting vessels can be misread as fishing (and slow fishing as transit).",
    "The legal boundary is GFW's copy of the WDPA polygon (0.01° cells, centre-in rule); without a WDPA id the watch box stands in for the boundary. Zoning inside a reserve is not modelled.",
    "Some MPAs allow fishing legally in zones or for local/artisanal fleets (e.g. Galápagos, Phoenix Islands since 2021) — effort there may be lawful.",
    "Data lag ~4 days, and GFW's effort model is revised between dataset versions.",
    "Says nothing about who is responsible; flag state is where a vessel is registered, not who owns or controls it.",
  ],
  requires: ["GFW_FISHING_TOKEN"],
  ringKm: 0,
  defaults: { days: 30, minHours: 50, resolution: "HIGH", insetFrac: 0.15, insetShare: 0.5, revisitDays: 7 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...mpaFishing.defaults, ...ctx.params };
    const days = num(p.days, 30);
    const minHours = num(p.minHours, 50);
    const to = ctx.now.slice(0, 10);
    const from = addDays(to, -days);
    const mpaId = mpaIdOf(p);
    const args = mpaId
      ? { mpaId, from, to, resolution: String(p.resolution), byGear: false, clipBBox: ctx.aoi.bbox }
      : { bbox: ctx.aoi.bbox, from, to, resolution: String(p.resolution), byGear: false };
    const r = (await ctx.call("fishing_activity", args)) as FishingResult;
    const inside = mpaId ? (r.clip?.hours ?? 0) : r.totalHours;
    if (!(inside >= minHours)) return null;

    const name = mpaName(ctx);
    const hours = Math.round(inside);
    const last = r.lastDataDate ?? to;
    const flags = r.byFlag.filter((f) => f.hours > 0);
    const topFlags = flags.slice(0, 3).map((f) => `${f.flag} ${Math.round(f.hours)} h`).join(", ");
    const values = { hours: r1(inside), reserveHours: r1(r.totalHours), activeDays: r.activeDays, flagStates: flags.length, days };
    const where = mpaId ? `inside the legal boundary of MPA ${mpaId} (GFW polygon clip) within this watch box` : "in the watch box (approximate boundary)";
    const evidence: Evidence[] = [
      {
        id: `gfw-fishing-${ctx.aoi.id}-${from}-${to}`,
        kind: "record",
        source: "globalfishingwatch-fishing-effort",
        collection: r.dataset,
        datetime: dayStart(last),
        href: GFW_HREF,
        method: { name: "fishing_activity", version: "1.0", params: args },
        summary:
          `${r1(inside)} h of apparent fishing ${where}, ${from}..${last}` +
          (topFlags ? `; ${mpaId ? "whole reserve " : ""}by flag state: ${topFlags}` : "") +
          `. ${r.provenance?.attribution ?? "Global Fishing Watch"}.`,
        values,
      },
    ];
    return {
      title: `Fishing activity inside ${name}: ${hours} hours in ${days} days`,
      summary:
        `Global Fishing Watch shows ${hours} hours of apparent fishing inside ${name} over the last ${days} days` +
        (flags.length ? ` (vessels of ${flags.length} flag state${flags.length === 1 ? "" : "s"})` : "") +
        ". The area is a no-take or strictly protected marine reserve. Awaiting an independent check: the effort lying well inside the area rather than along its edge, or still there a week later.",
      observedAt: dayStart(last),
      evidence,
      values,
      geometry: bboxPolygon(ctx.aoi.bbox),
      notes: ["Apparent fishing is model-inferred from AIS; vessels without AIS are not counted. Flag state ≠ owner.", ...(typeof p.legalNote === "string" ? [p.legalNote] : [])],
      tags: ["fishing", "marine-protected-area"],
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...mpaFishing.defaults, ...ctx.params };
    const days = num(p.days, 30);
    const minHours = num(p.minHours, 50);
    const params = candidate.evidence[0]?.method.params as { from?: string; to?: string } | undefined;
    const to = params?.to ?? ctx.now.slice(0, 10);
    const from = params?.from ?? addDays(to, -days);
    const detected = num(candidate.values.hours, 0);
    const mpaId = mpaIdOf(p);

    // 1. method: the effort sits well inside the box, not along its edge.
    const frac = num(p.insetFrac, 0.15);
    const inset = insetBBox(ctx.aoi.bbox, frac);
    const args = mpaId ? { mpaId, from, to, resolution: "HIGH", byGear: false, clipBBox: inset } : { bbox: ctx.aoi.bbox, from, to, resolution: "HIGH", byGear: false, clipBBox: inset };
    const r = (await ctx.call("fishing_activity", args)) as FishingResult;
    const deep = r.clip?.hours ?? 0;
    const bar = minHours * num(p.insetShare, 0.5);
    if (deep >= bar) {
      const share = detected > 0 ? Math.round((deep / detected) * 100) : null;
      return {
        independence: "method",
        signal: {
          id: `gfw-fishing-inset-${ctx.aoi.id}-${from}-${to}`,
          kind: "record",
          source: "globalfishingwatch-fishing-effort",
          collection: r.dataset,
          datetime: candidate.observedAt,
          href: GFW_HREF,
          method: { name: "fishing_activity", version: "1.0", params: args },
          summary:
            `${r1(deep)} h${share != null ? ` (${share}% of the ${r1(detected)} h)` : ""} lie in 0.01° cells well inside the area (box inset ${Math.round(frac * 100)}% per side)` +
            `${mpaId ? " and inside the legal polygon" : ""} — not a boundary artefact (bar ${r1(bar)} h).`,
          values: { insetHours: r1(deep), ...(share != null ? { insetSharePct: share } : {}) },
        },
      };
    }

    // 2. revisit: still there in the days after the first window.
    const age = (Date.parse(ctx.now) - Date.parse(candidate.observedAt)) / 86_400_000;
    if (age < num(p.revisitDays, 7)) return null;
    const from2 = addDays(candidate.observedAt.slice(0, 10), 1);
    const to2 = ctx.now.slice(0, 10);
    if (from2 >= to2) return null;
    const args2 = mpaId ? { mpaId, from: from2, to: to2, resolution: "HIGH", byGear: false, clipBBox: ctx.aoi.bbox } : { bbox: ctx.aoi.bbox, from: from2, to: to2, resolution: "HIGH", byGear: false };
    const r2 = (await ctx.call("fishing_activity", args2)) as FishingResult;
    const h2 = mpaId ? (r2.clip?.hours ?? 0) : r2.totalHours;
    const newDays = Math.max(1, Math.round((Date.parse(to2) - Date.parse(from2)) / 86_400_000));
    const bar2 = Math.max(5, (minHours * newDays) / days);
    if (!(h2 >= bar2) || !r2.lastDataDate) return null;
    return {
      independence: "revisit",
      signal: {
        id: `gfw-fishing-${ctx.aoi.id}-${from2}-${to2}-revisit`,
        kind: "record",
        source: "globalfishingwatch-fishing-effort",
        collection: r2.dataset,
        datetime: dayStart(r2.lastDataDate),
        href: GFW_HREF,
        method: { name: "fishing_activity", version: "1.0", params: args2 },
        summary: `Fishing continued: ${r1(h2)} h in the ${newDays} days after the first window (bar ${r1(bar2)} h, pro-rated).`,
        values: { hours: r1(h2), days: newDays },
      },
    };
  },
});
