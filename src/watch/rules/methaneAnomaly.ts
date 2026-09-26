// methane_anomaly@1.0 — primary: Sentinel-5P TROPOMI CH₄ column over the AOI in the recent
// window vs its own ~90-day baseline (CDSE Statistics, via methane_plumes include=ch4);
// confirmation: a NASA JPL EMIT plume inside the AOI in the plume window (a different sensor
// — imaging spectrometer on the ISS, ~60 m — and a different provider). Baseline: the same
// anomaly over a wide neighbourhood ring, so a basin-wide or seasonal rise is visible in the
// finding instead of being read as a local source. Tier 2: a regional column anomaly is
// never facility attribution.

import type { Evidence } from "../../ledger/schema.js";
import { bboxPolygon, dayStart, defineRule, num, ringBBox, type Candidate, type Confirmation, type RuleContext } from "./types.js";

interface Anomaly {
  recentPpb: number;
  baselinePpb: number;
  deltaPpb: number;
  baselineSdPpb: number | null;
  z: number | null;
  validPct: number;
  baselineValidPct: number;
  bucketsUsed: number;
}

interface MethaneResult {
  ch4?: { window: { from: string; to: string }; baselineWindow: { from: string; to: string }; anomaly: Anomaly | null };
  plumeWindow?: { from: string; to: string };
  plumes?: Array<{
    source: string;
    id: string;
    datetime: string;
    lat: number;
    lon: number;
    emissionRateKgHr: number | null;
    emissionRateUncertaintyKgHr: number | null;
    href: string | null;
  }>;
}

export const methaneAnomaly = defineRule({
  name: "methane_anomaly",
  version: "1.0",
  tier: 2,
  description: "Sentinel-5P CH₄ column anomaly vs the AOI's 90-day baseline, confirmed by an EMIT plume inside the AOI.",
  blindSpots: [
    "Sentinel-5P pixels are ~7×5.5 km column averages: small or intermittent point sources are diluted below detection, and an anomaly is never attribution to a facility.",
    "Cloud, snow, water, dark/bright surfaces and QA filtering leave gaps; a sparse recent window can swing tens of ppb on a handful of pixels.",
    "Wetland, rice and livestock CH₄ are seasonal and the global background rises ~10 ppb/yr; the 90-day baseline and the neighbourhood ring only partly separate this from new emissions.",
    "Wind carries enhancements across AOI edges; a plume upwind can raise the column here, a local source can be blown out.",
    "EMIT only sees what the ISS overpasses in daylight, and its public plume feed has lagged (latest plume 2025-09-22 as of 2026-09-26) — no plume means 'not observed', not 'no plume'. UNEP MARS is not machine-readable without an API grant.",
  ],
  requires: ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
  ringKm: 100,
  defaults: { windowDays: 14, baselineDays: 90, minAnomalyPpb: 20, minValidPct: 40, plumeDays: 90 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...methaneAnomaly.defaults, ...ctx.params };
    const args = {
      bbox: ctx.aoi.bbox,
      date: ctx.now.slice(0, 10),
      windowDays: num(p.windowDays, 14),
      baselineDays: num(p.baselineDays, 90),
      include: "ch4",
    };
    const r = (await ctx.call("methane_plumes", args)) as MethaneResult;
    const a = r.ch4?.anomaly;
    if (!r.ch4 || !a) return null; // no usable retrievals — nothing to say
    if (a.validPct < num(p.minValidPct, 40)) return null;
    if (a.deltaPpb < num(p.minAnomalyPpb, 20)) return null;

    const { window } = r.ch4;
    const observedAt = dayStart(window.to);
    const evidence: Evidence[] = [
      {
        id: `s5p-ch4-${ctx.aoi.id}-${window.from}..${window.to}`,
        kind: "raster",
        source: "sentinel-5p-l2",
        collection: "sentinel-5p-l2",
        datetime: observedAt,
        href: "https://dataspace.copernicus.eu/",
        method: { name: "methane_plumes", version: "1.0", params: args },
        summary:
          `Mean XCH₄ ${a.recentPpb} ppb in ${window.from}…${window.to} vs ${a.baselinePpb} ppb baseline ` +
          `(${r.ch4.baselineWindow.from}…${r.ch4.baselineWindow.to}): +${a.deltaPpb} ppb` +
          (a.z != null ? `, z ≈ ${a.z}` : "") +
          `; ${a.validPct}% of pixels valid.`,
        values: {
          recentPpb: a.recentPpb,
          baselinePpb: a.baselinePpb,
          deltaPpb: a.deltaPpb,
          validPct: a.validPct,
          ...(a.z != null ? { z: a.z } : {}),
        },
      },
    ];

    // Regional baseline: the same anomaly over a wide ring. A ring that rose as much as the
    // AOI means seasonal/transport, not a local source.
    let baseline: Candidate["baseline"];
    try {
      const ring = ringBBox(ctx.aoi.bbox, methaneAnomaly.ringKm);
      const rr = (await ctx.call("methane_plumes", { ...args, bbox: ring })) as MethaneResult;
      const ra = rr.ch4?.anomaly;
      if (ra) {
        baseline = {
          metric: "CH₄ anomaly, ppb (recent − 90 d baseline)",
          ringKm: methaneAnomaly.ringKm,
          aoiValue: a.deltaPpb,
          regionalValue: ra.deltaPpb,
          ratio: ra.deltaPpb > 0 ? Math.round((a.deltaPpb / ra.deltaPpb) * 100) / 100 : null,
        };
      }
    } catch {
      /* baseline is context, never a blocker */
    }

    return {
      title: `Methane anomaly${ctx.aoi.name ? `, ${ctx.aoi.name}` : ""}: +${a.deltaPpb} ppb vs baseline`,
      summary:
        `Sentinel-5P CH₄ column ${a.recentPpb} ppb in ${window.from}…${window.to}, +${a.deltaPpb} ppb over the AOI's ` +
        `own baseline (${a.validPct}% valid)` +
        (baseline ? `; the ${baseline.ringKm} km neighbourhood moved ${baseline.regionalValue >= 0 ? "+" : ""}${baseline.regionalValue} ppb` : "") +
        ". Regional column signal only — no facility attribution. Awaiting a plume-level confirmation.",
      observedAt,
      evidence,
      values: { deltaPpb: a.deltaPpb, recentPpb: a.recentPpb, validPct: a.validPct },
      geometry: bboxPolygon(ctx.aoi.bbox),
      baseline,
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...methaneAnomaly.defaults, ...ctx.params };
    const args = { bbox: ctx.aoi.bbox, date: candidate.observedAt.slice(0, 10), plumeDays: num(p.plumeDays, 90), include: "plumes" };
    const r = (await ctx.call("methane_plumes", args)) as MethaneResult;
    const plumes = r.plumes ?? [];
    // TODO(emitters): when the `emitters` tool (Climate TRACE v7 / GEM assets) lands, try an
    // asset-at-the-point match here as a second confirmation path (independence: "provider").
    if (plumes.length === 0) return null;
    const best = [...plumes].sort((x, y) => (y.emissionRateKgHr ?? -1) - (x.emissionRateKgHr ?? -1) || (x.datetime < y.datetime ? 1 : -1))[0]!;
    const rate =
      best.emissionRateKgHr != null
        ? `, ${Math.round(best.emissionRateKgHr)}${best.emissionRateUncertaintyKgHr != null ? ` ± ${Math.round(best.emissionRateUncertaintyKgHr)}` : ""} kg/h`
        : ", no emission-rate estimate";
    return {
      independence: "sensor",
      signal: {
        id: `emit-${best.id}`,
        kind: "record",
        source: "nasa-jpl-emit",
        collection: "EMITL2BCH4PLM.002",
        datetime: best.datetime,
        ...(best.href ? { href: best.href } : {}),
        method: { name: "methane_plumes", version: "1.0", params: args },
        summary:
          `${plumes.length} EMIT CH₄ plume complex(es) inside the AOI in ${r.plumeWindow?.from ?? "?"}…${r.plumeWindow?.to ?? "?"}; ` +
          `strongest ${best.id} at ${best.lat.toFixed(4)}, ${best.lon.toFixed(4)} on ${best.datetime.slice(0, 10)}${rate}.`,
        values: { plumes: plumes.length, ...(best.emissionRateKgHr != null ? { emissionRateKgHr: best.emissionRateKgHr } : {}) },
      },
    };
  },
});
