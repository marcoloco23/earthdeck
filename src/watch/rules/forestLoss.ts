// forest_loss@1.0 — primary: GFW integrated deforestation alerts (GLAD-L + GLAD-S2 + RADD)
// over the last N days; confirmation: an NDVI drop in a cloud-free Sentinel-2 median
// composite (different sensor physics from the radar-inclusive alert stack and a different
// provider). Baseline: alert density in a neighbourhood ring, so a quiet AOI next to a
// loud region — or the reverse — is visible in the finding itself.

import { livingValueForFinding } from "../../clients/naturalvalue.js";
import type { Evidence } from "../../ledger/schema.js";
import type { BBox } from "../../types.js";
import { addDays, isoDate } from "../../util.js";
import { bboxArea, bboxPolygon, dayStart, defineRule, num, ringBBox, type Candidate, type Confirmation, type RuleContext } from "./types.js";

const GFW_MAX_AREA_DEG2 = 4; // forest_alerts caps the AOI at 4 deg²

interface AlertsResult {
  window: { from: string; to: string };
  alertCount: number;
  areaHa: number;
  /** forest_alerts returns `{ high: { alertCount, areaHa }, highest: … }` (live-verified 2026-09-26). */
  byConfidence?: Record<string, { alertCount: number; areaHa: number | null } | number>;
  note?: string;
}

/** Evidence `values` must be flat numbers — `{ high: { alertCount, areaHa } }` → `{ high_alerts, high_ha }`. */
function flattenConfidence(bc: AlertsResult["byConfidence"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [conf, v] of Object.entries(bc ?? {})) {
    if (typeof v === "number") out[`${conf}_alerts`] = v;
    else {
      out[`${conf}_alerts`] = v.alertCount;
      if (typeof v.areaHa === "number") out[`${conf}_ha`] = v.areaHa;
    }
  }
  return out;
}

interface CompareResult {
  dateA: string;
  dateB: string;
  validPctA: number;
  validPctB: number;
  delta: { meanChange: number };
  provenanceA?: { scenes?: string[] };
  provenanceB?: { scenes?: string[] };
}

export const forestLoss = defineRule({
  name: "forest_loss",
  version: "1.0",
  tier: 1,
  description: "Deforestation alerts above a size threshold, confirmed by an NDVI drop in an optical composite.",
  blindSpots: [
    "Coverage is 30°N–30°S only — zero alerts outside the tropics means 'not monitored', not 'no loss'.",
    "Cannot distinguish legal clearing, fire, storm damage and selective logging from illegal clearing; attribution needs concession/protected-area layers (M3).",
    "Alerts lag reality by ~1–2 weeks; a burst just before the sweep is undercounted.",
    "Regrowth and plantation harvest cycles look like loss; the baseline ring only partly compensates.",
    "Persistent cloud can delay optical confirmation for months (SAR-only RADD alerts stay 'candidate').",
  ],
  requires: ["GFW_API_KEY", "CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
  ringKm: 25,
  defaults: { days: 90, minConfidence: "high", minAlerts: 50, minHa: 5, ndviDrop: 0.1, minValidPct: 60 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...forestLoss.defaults, ...ctx.params };
    const days = num(p.days, 90);
    const args = { bbox: ctx.aoi.bbox, days, minConfidence: String(p.minConfidence) };
    const r = (await ctx.call("forest_alerts", args)) as AlertsResult;
    if (r.alertCount < num(p.minAlerts, 50) || r.areaHa < num(p.minHa, 5)) return null;

    const observedAt = dayStart(r.window.to);
    // What the cleared area was doing alive (benefit transfer; GFW alerts are tropical-only).
    const living = livingValueForFinding(r.areaHa, "tropical_forest");
    const livingValues = { living_value_usd_yr: living.annualUsd, living_value_100y_usd: living.horizonUsd, living_value_100y_npv2_usd: living.npvUsd };
    const evidence: Evidence[] = [
      {
        id: `gfw-integrated-${ctx.aoi.id}-${r.window.from}..${r.window.to}`,
        kind: "alert",
        source: "gfw-integrated-alerts",
        datetime: observedAt,
        href: "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts",
        method: { name: "forest_alerts", version: "1.0", params: args },
        summary: `${r.alertCount} alerts (≥ ${String(p.minConfidence)} confidence), ${r.areaHa} ha, ${r.window.from}…${r.window.to}.${r.note ? ` ${r.note}` : ""}`,
        values: { alerts: r.alertCount, ha: r.areaHa, ...flattenConfidence(r.byConfidence), ...livingValues },
      },
    ];

    // Regional baseline: alert density (ha per deg²) in a ring around the AOI vs the AOI.
    let baseline: Candidate["baseline"];
    const ring = fitRing(ctx.aoi.bbox, forestLoss.ringKm);
    if (ring) {
      try {
        const rr = (await ctx.call("forest_alerts", { ...args, bbox: ring.bbox })) as AlertsResult;
        const aoiValue = r.areaHa / bboxArea(ctx.aoi.bbox);
        const regionalValue = rr.areaHa / bboxArea(ring.bbox);
        baseline = { metric: "alert ha per deg²", ringKm: ring.km, aoiValue: round3(aoiValue), regionalValue: round3(regionalValue), ratio: regionalValue > 0 ? round3(aoiValue / regionalValue) : null };
      } catch {
        /* baseline is context, never a blocker */
      }
    }

    return {
      title: `Forest loss${ctx.aoi.name ? `, ${ctx.aoi.name}` : ""}: ${r.areaHa} ha in ${days} d`,
      summary:
        `${r.alertCount} GFW integrated deforestation alerts (≥ ${String(p.minConfidence)} confidence) covering ${r.areaHa} ha ` +
        `between ${r.window.from} and ${r.window.to}` +
        (baseline?.ratio != null ? `; AOI alert density is ${baseline.ratio}× its ${baseline.ringKm} km neighbourhood` : "") +
        ". Awaiting optical confirmation.",
      observedAt,
      evidence,
      values: { alerts: r.alertCount, ha: r.areaHa, ...livingValues },
      geometry: bboxPolygon(ctx.aoi.bbox),
      baseline,
      notes: [living.note],
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...forestLoss.defaults, ...ctx.params };
    const dateB = candidate.observedAt.slice(0, 10);
    const dateA = addDays(dateB, -(num(p.days, 90) + 45));
    const args = { bbox: ctx.aoi.bbox, dateA, dateB, index: "NDVI", composite: "median", width: 256 };
    const c = (await ctx.call("eo_compare", args)) as CompareResult;
    const minValid = Math.min(c.validPctA, c.validPctB);
    if (minValid < num(p.minValidPct, 60)) return null; // clouds — try again next sweep
    if (c.delta.meanChange > -num(p.ndviDrop, 0.1)) return null;
    const scenes = [...(c.provenanceA?.scenes ?? []), ...(c.provenanceB?.scenes ?? [])];
    return {
      independence: "sensor",
      signal: {
        id: `s2-ndvi-median-${ctx.aoi.id}-${dateA}..${dateB}`,
        kind: "scene",
        source: "sentinel-2-l2a",
        datetime: dayStart(dateB),
        method: { name: "eo_compare", version: "1.0", params: args },
        summary: `Median-composite NDVI changed ${c.delta.meanChange.toFixed(3)} (${dateA} → ${dateB}); valid pixels ${c.validPctA}% / ${c.validPctB}%.${scenes.length ? ` Scenes: ${scenes.slice(0, 6).join(", ")}` : ""}`,
        values: { deltaNdvi: c.delta.meanChange, validPctA: c.validPctA, validPctB: c.validPctB },
      },
    };
  },
});

/** Largest ring ≤ ringKm whose bbox stays under the GFW area cap; null if the AOI itself is too big. */
function fitRing(bbox: BBox, km: number): { bbox: BBox; km: number } | null {
  for (let k = km; k >= 5; k = Math.floor(k / 2)) {
    const r = ringBBox(bbox, k);
    if (bboxArea(r) <= GFW_MAX_AREA_DEG2 * 0.98) return { bbox: r, km: k };
  }
  return null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// Exported for tests: the date arithmetic the rule relies on.
export const _dates = { isoDate, addDays };
