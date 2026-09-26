// flaring@1.0 — primary: at least one FIRMS night-time cluster with FRP ≥ minFrp lit on
// ≥ minNights of the last `days` nights; confirmation: the cluster sits on a site in the EOG
// VIIRS Nightfire ANNUAL flare summary (different provider + product, redistributable
// aggregate) or it is re-detected on a later FIRMS pass (revisit). Geometry is the brightest
// persistent cluster's centroid — an industrial asset, never a person.

import type { Evidence } from "../../ledger/schema.js";
import type { FlareCluster } from "../../clients/vnf.js";
import { EOG_VNF_HREF, FIRMS_HREF, kmBetween, VNF_CREDIT } from "../../clients/vnf.js";
import { dayStart, defineRule, num, type Candidate, type Confirmation, type RuleContext } from "./types.js";

interface FlaringResult {
  window: { from: string; to: string; days: number };
  counts: { hotNightDetections: number; persistentClusters: number };
  clusters: FlareCluster[];
  vnf: { available: boolean; year?: number; sensor?: string; matchedClusters?: number };
  provenance: { sensors: string[] };
}

export const flaring = defineRule({
  name: "flaring",
  version: "1.0",
  tier: 2,
  description: "Persistent night-time high-FRP heat (VIIRS) consistent with gas flaring at a watched oil & gas area.",
  blindSpots: [
    "Cannot tell a gas flare from an industrial furnace, refinery, steel or cement kiln, or a volcano — only persistence and the VNF site match argue 'flare'.",
    "Cloud and heavy smoke hide nights; a cloudy month under-counts persistence and can look like a flare was turned off.",
    "FRP is not flared volume: the VIIRS I-band saturates on the largest flares and the FIRMS FRP is a single-pixel estimate — volumes come only from the VNF annual summary.",
    "Venting and unlit (cold) methane releases are invisible to thermal sensors — pair with S5P / EMIT methane.",
    "No ownership or operator attribution: a cluster is a place, not a company; attribution needs asset registries (GEM, GGFR) and human review.",
    "Two VIIRS passes per night at ~01:30 local; short or intermittent flaring between passes is missed. S-NPP ends Nov 2026, so NOAA-20/21 only.",
    "The VNF confirmation is an annual aggregate from a past year: it proves the site is a known flare, not that it flared this week.",
  ],
  requires: ["FIRMS_MAP_KEY"],
  ringKm: 0, // no regional ring: a flare is a point source, and a ring would double the FIRMS pulls
  defaults: { days: 30, minFrp: 5, minNights: 5, clusterKm: 1, revisitHours: 18 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const p = { ...flaring.defaults, ...ctx.params };
    const args = { bbox: ctx.aoi.bbox, days: num(p.days, 30), minFrp: num(p.minFrp, 5), minNights: num(p.minNights, 5), clusterKm: num(p.clusterKm, 1), limit: 20 };
    const r = (await ctx.call("flaring", args)) as FlaringResult;
    if (r.counts.persistentClusters < 1 || r.clusters.length === 0) return null;

    // Headline = the brightest of the most persistent clusters (the tool sorts by nights, then max FRP).
    const top = r.clusters[0]!;
    const lastNight = r.clusters.map((c) => c.lastNight).sort().pop()!;
    const observedAt = dayStart(lastNight);
    const maxFrp = Math.max(...r.clusters.map((c) => c.maxFrp));
    const vnfMatched = r.clusters.filter((c) => c.vnf).length;
    const topVnf = r.clusters.find((c) => c.vnf)?.vnf ?? null;

    const values: Record<string, number> = {
      persistentClusters: r.counts.persistentClusters,
      maxNights: top.nights,
      maxFrp,
      hotNightDetections: r.counts.hotNightDetections,
      vnfMatched,
    };
    if (topVnf && r.vnf.year) Object.assign(values, { vnfYear: r.vnf.year, vnfTopBcm: topVnf.bcm, vnfTopKm: topVnf.km });

    const source = `firms-${r.provenance.sensors.map((s) => s.toLowerCase()).join("+")}`;
    const evidence: Evidence[] = [
      {
        id: `firms-flaring-${ctx.aoi.id}-${r.window.from}-${r.window.to}`,
        kind: "alert",
        source,
        datetime: observedAt,
        href: FIRMS_HREF,
        method: { name: "flaring", version: "1.0", params: args },
        summary:
          `${r.counts.persistentClusters} night-time cluster(s) with FRP ≥ ${args.minFrp} MW lit on ≥ ${args.minNights} of ${r.window.days} nights ` +
          `(${r.window.from}…${r.window.to}); top cluster ${top.nights} nights, max ${top.maxFrp} MW at ${top.lat}, ${top.lon}.`,
        values,
      },
    ];
    return {
      title: `Persistent flaring${ctx.aoi.name ? ` in ${ctx.aoi.name}` : ""}: ${r.counts.persistentClusters} cluster(s), up to ${top.nights} nights`,
      summary:
        `${r.counts.persistentClusters} VIIRS night-time heat cluster(s) with FRP ≥ ${args.minFrp} MW persisted on ≥ ${args.minNights} of the last ${r.window.days} nights; ` +
        `the most persistent was lit ${top.nights} nights (max ${top.maxFrp} MW). ` +
        (vnfMatched ? `${vnfMatched} sit on known VNF ${r.vnf.year} flare sites.` : "None matched a VNF annual flare site; awaiting a later pass."),
      observedAt,
      evidence,
      values,
      geometry: { type: "Point", coordinates: [round(top.lon, 3), round(top.lat, 3)] },
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    const p = { ...flaring.defaults, ...ctx.params };
    // 1. Different provider/product: the cluster is on a site in the EOG VNF annual flare summary.
    const v = candidate.values;
    const matched = v.vnfMatched ?? 0;
    if (matched >= 1 && v.vnfYear) {
      return {
        independence: "provider",
        signal: {
          id: `eog-vnf-annual-${v.vnfYear}-${ctx.aoi.id}`,
          kind: "record",
          source: "eog-vnf-annual",
          datetime: `${v.vnfYear}-12-31T00:00:00Z`,
          href: EOG_VNF_HREF,
          method: { name: "flaring", version: "1.0", params: { vnfYear: v.vnfYear } },
          summary: `${matched} persistent cluster(s) coincide with sites in the VNF ${v.vnfYear} annual flare summary (top site ${v.vnfTopBcm ?? "?"} BCM, ${v.vnfTopKm ?? "?"} km away). Credit: ${VNF_CREDIT}.`,
          values: { vnfMatched: matched, ...(v.vnfTopBcm != null ? { bcm: v.vnfTopBcm } : {}) },
        },
      };
    }
    // 2. Revisit: the same place lit again on a later FIRMS pass (next sweep).
    const hours = (Date.parse(ctx.now) - Date.parse(candidate.observedAt)) / 3_600_000;
    if (hours < num(p.revisitHours, 18)) return null;
    const args = { bbox: ctx.aoi.bbox, days: 2, minFrp: num(p.minFrp, 5), minNights: 1, clusterKm: num(p.clusterKm, 1), vnf: false, limit: 50 };
    const r = (await ctx.call("flaring", args)) as FlaringResult;
    const [lon, lat] = candidate.geometry?.type === "Point" ? (candidate.geometry.coordinates as number[]) : [NaN, NaN];
    const near = (c: FlareCluster) => !Number.isFinite(lat) || kmBetween(lat!, lon!, c.lat, c.lon) <= Math.max(2, num(p.clusterKm, 1) * 2);
    const later = r.clusters.filter((c) => dayStart(c.lastNight) > candidate.observedAt && near(c));
    if (later.length === 0) return null;
    const last = later.map((c) => c.lastNight).sort().pop()!;
    return {
      independence: "revisit",
      signal: {
        id: `firms-flaring-${ctx.aoi.id}-${last}-revisit`,
        kind: "alert",
        source: `firms-${r.provenance.sensors.map((s) => s.toLowerCase()).join("+")}`,
        datetime: dayStart(last),
        href: FIRMS_HREF,
        method: { name: "flaring", version: "1.0", params: args },
        summary: `Night-time heat with FRP ≥ ${args.minFrp} MW again at the flagged cluster on a later pass (${last}).`,
        values: { clusters: later.length, maxFrp: Math.max(...later.map((c) => c.maxFrp)) },
      },
    };
  },
});

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
