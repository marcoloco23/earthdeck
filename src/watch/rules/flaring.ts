// flaring@1.0 — primary: at least one FIRMS night-time cluster with FRP ≥ minFrp lit on
// ≥ minNights of the last `days` nights; confirmation: the cluster sits on a site in the EOG
// VIIRS Nightfire ANNUAL flare summary (different provider + product, redistributable
// aggregate) or it is re-detected on a later FIRMS pass (revisit). Geometry is the brightest
// persistent cluster's centroid — an industrial asset, never a person.
//
// New flare: a persistent cluster with no VNF site within 2 km in the latest AND the previous
// annual summary → title "New flaring near <place>", values.new_flare = 1, tag `new-flare`.
// The VNF match cannot confirm it (it is not in the registry), so only the revisit does.
//
// flaring_stopped@1.0 — the first *positive* case type: registered VNF sites in the AOI that
// flared ≥ 0.05 BCM in the latest year show no FIRMS night detection at all in the window.
// A separate rule, so a separate case per AOI; same tool call as `flaring`, shared per sweep.
// Confirmation: the next consecutive window is dark at the same sites too (revisit).

import type { Evidence } from "../../ledger/schema.js";
import type { FlareCluster, StoppedSite } from "../../clients/vnf.js";
import { EOG_VNF_HREF, FIRMS_HREF, kmBetween, NOVEL_KM, STOPPED_MIN_BCM, VNF_CREDIT } from "../../clients/vnf.js";
import { addDays } from "../../util.js";
import type { WatchAoi } from "../watchlist.js";
import { dayStart, defineRule, num, type Candidate, type Confirmation, type RuleContext, type ToolCall } from "./types.js";

interface FlaringResult {
  window: { from: string; to: string; days: number };
  counts: { nightDetections?: number; hotNightDetections: number; persistentClusters: number };
  clusters: FlareCluster[];
  vnf: {
    available: boolean;
    year?: number;
    sensor?: string;
    matchedClusters?: number;
    previous?: { available: boolean; year?: number };
    stopped?: { count: number; bcm: number; sites: StoppedSite[]; note?: string };
  };
  provenance: { sensors: string[] };
}

/** The place an AOI is about: "Dehloran, Ilam (Iran)" from a discovered name, else the AOI name. */
export function flarePlace(aoi: Pick<WatchAoi, "id" | "name">): string {
  const m = /^Flare field near (.+?) — /.exec(aoi.name ?? "");
  return m?.[1] ?? aoi.name ?? aoi.id;
}

/** Detect-time tool arguments — identical for `flaring` and `flaring_stopped`, so one pull serves both. */
function detectArgs(ctx: RuleContext) {
  const p = { ...flaring.defaults, ...ctx.params };
  return { bbox: ctx.aoi.bbox, days: num(p.days, 30), minFrp: num(p.minFrp, 5), minNights: num(p.minNights, 5), clusterKm: num(p.clusterKm, 1), limit: 20 };
}

// One FIRMS pull per AOI per sweep: `sweep` builds a fresh `call` each run, so memoising on
// that function scopes the cache to one sweep (and to one test).
const shared = new WeakMap<ToolCall, Map<string, Promise<unknown>>>();
function sharedCall(call: ToolCall, tool: string, args: Record<string, unknown>): Promise<unknown> {
  let m = shared.get(call);
  if (!m) shared.set(call, (m = new Map()));
  const key = `${tool} ${JSON.stringify(args)}`;
  let p = m.get(key);
  if (!p) {
    p = call(tool, args);
    m.set(key, p);
    p.catch(() => m.delete(key));
  }
  return p;
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
    "'New flaring' only means no site of the VNF 2023/2024 annual summaries within 2 km: a flare too small or too cloudy for EOG's annual product, or a new furnace, also qualifies.",
  ],
  requires: ["FIRMS_MAP_KEY"],
  ringKm: 0, // no regional ring: a flare is a point source, and a ring would double the FIRMS pulls
  defaults: { days: 30, minFrp: 5, minNights: 5, clusterKm: 1, revisitHours: 18 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const args = detectArgs(ctx);
    const r = (await sharedCall(ctx.call, "flaring", args)) as FlaringResult;
    if (r.counts.persistentClusters < 1 || r.clusters.length === 0) return null;

    // Headline = the brightest of the most persistent clusters (the tool sorts by nights, then
    // max FRP) — unless one is new (in neither year's registry): then the first new one.
    const novel = r.clusters.filter((c) => c.novel === true);
    const top = novel[0] ?? r.clusters[0]!;
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
    if (novel.length) Object.assign(values, { new_flare: 1, newClusters: novel.length });
    const place = flarePlace(ctx.aoi);
    const years = `VNF ${r.vnf.previous?.year ?? "?"} and ${r.vnf.year ?? "?"}`;

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
          `(${r.window.from}…${r.window.to}); ${novel.length ? `new cluster (no ${years} site within ${NOVEL_KM} km)` : "top cluster"} ${top.nights} nights, max ${top.maxFrp} MW at ${top.lat}, ${top.lon}.`,
        values,
      },
    ];
    if (novel.length) {
      return {
        title: `New flaring near ${place}`.slice(0, 200),
        summary:
          `${novel.length} persistent VIIRS night-time heat cluster(s) near ${place} are not in the flare registry: no site of the ${years} annual summaries within ${NOVEL_KM} km. ` +
          `One was lit ${top.nights} of the last ${r.window.days} nights (max ${top.maxFrp} MW) at ${top.lat}, ${top.lon}. ` +
          `It may be a new flare — or a furnace, or a flare too small for EOG's annual product; a later pass confirms the heat, not its cause.`,
        observedAt,
        evidence,
        values,
        geometry: { type: "Point", coordinates: [round(top.lon, 3), round(top.lat, 3)] },
        tags: ["new-flare"],
      };
    }
    return {
      title: `Persistent flaring near ${place}: ${r.counts.persistentClusters} cluster(s), up to ${top.nights} nights`.slice(0, 200),
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
    // A new flare is by definition not in the registry: VNF matches elsewhere in the box say nothing about it.
    if (matched >= 1 && v.vnfYear && !v.new_flare) {
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

/** Stopped sites travel with the case in the evidence's method params (values stay flat numbers). */
function stoppedPoints(evidence: readonly Evidence[]): [number, number][] {
  const pts = evidence.find((e) => e.method.name === "flaring_stopped")?.method.params?.stoppedSites;
  return Array.isArray(pts) ? (pts.filter((x) => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)) as [number, number][]) : [];
}

export const flaringStopped = defineRule({
  name: "flaring_stopped",
  version: "1.0",
  tier: 2,
  description:
    "Good news if it holds: registered gas-flare sites (VIIRS Nightfire annual summary, ≥ 0.05 BCM last year) showing no night-time heat at all for a whole window.",
  blindSpots: [
    "Cloud, smoke or haze can hide a flare for weeks; a cloudy window looks exactly like a shutdown until the next clear one.",
    "Sensor or processing gaps (a FIRMS outage, a NOAA-20/21 safe-mode) look like darkness; if the whole box has no night detection at all, no case is opened.",
    "Seasonal, maintenance or market shutdowns stop a flare for a while without anything having improved for good — a second dark window is required, and a relit site ends the claim.",
    "A dark flare is not proof of less gas wasted: gas may be vented cold (invisible to thermal sensors), re-routed to another flare, or the field may simply have stopped producing.",
    "Registry sites are EOG annual-product locations from last year; a flare that moved more than 2 km counts as stopped here and new elsewhere.",
    "No ownership or operator attribution: a site is a place, not a company.",
  ],
  requires: ["FIRMS_MAP_KEY"],
  ringKm: 0,
  defaults: { days: 30, minFrp: 5, minNights: 5, clusterKm: 1 },

  async detect(ctx: RuleContext): Promise<Candidate | null> {
    const args = detectArgs(ctx);
    const r = (await sharedCall(ctx.call, "flaring", args)) as FlaringResult;
    const stopped = r.vnf.available ? r.vnf.stopped : undefined;
    if (!stopped || stopped.count < 1 || stopped.sites.length === 0) return null;

    const place = flarePlace(ctx.aoi);
    const n = stopped.count;
    const bcm = round(stopped.bcm, 3);
    const sites = n === 1 ? "site" : "sites";
    const observedAt = dayStart(r.window.to);
    const values: Record<string, number> = { stopped_sites: n, stopped_bcm: bcm, windowDays: r.window.days };
    if (r.vnf.year) values.vnfYear = r.vnf.year;
    if (r.counts.nightDetections != null) values.nightDetections = r.counts.nightDetections;
    const lead = stopped.sites[0]!;
    const evidence: Evidence[] = [
      {
        id: `firms-flaring-stopped-${ctx.aoi.id}-${r.window.from}-${r.window.to}`,
        kind: "alert",
        source: `firms-${r.provenance.sensors.map((s) => s.toLowerCase()).join("+")}`,
        datetime: observedAt,
        href: FIRMS_HREF,
        method: {
          name: "flaring_stopped",
          version: "1.0",
          params: { ...args, minBcm: STOPPED_MIN_BCM, km: NOVEL_KM, stoppedSites: stopped.sites.map((s) => [round(s.lon, 4), round(s.lat, 4)]) },
        },
        summary:
          `${n} registered flare ${sites} (${bcm} BCM in VNF ${r.vnf.year ?? "?"}) had no VIIRS night-time detection of any FRP within ${NOVEL_KM} km ` +
          `on any night of ${r.window.from}…${r.window.to}, while the box held ${r.counts.nightDetections ?? "some"} night detection(s) elsewhere. Largest: ${lead.id} (${lead.bcm} BCM).`,
        values,
      },
    ];
    return {
      title: `Flaring stopped at ${n} registered ${sites} near ${place}`.slice(0, 200),
      summary:
        `Good news, if it holds: ${n} gas-flare ${sites} near ${place} that burned ${bcm} billion m³ of gas in ${r.vnf.year ?? "the latest year"} ` +
        `(VIIRS Nightfire annual summary) showed no night-time heat at all in the last ${r.window.days} nights. ` +
        `Cloud, a sensor gap or a temporary shutdown can look the same, so this counts only if the next ${r.window.days}-night window is dark there too.`,
      observedAt,
      evidence,
      values,
      geometry: { type: "Point", coordinates: [round(lead.lon, 3), round(lead.lat, 3)] },
      notes: [`Case type: improvement — flaring stopped at ${n} registered ${sites} (${bcm} BCM last year).`],
      tags: ["improvement"],
    };
  },

  async confirm(ctx, candidate): Promise<Confirmation | null> {
    // Revisit: the next consecutive window, once it has fully elapsed, is dark at the same sites.
    const days = num(candidate.values.windowDays, num(ctx.params.days, 30));
    const from = addDays(candidate.observedAt.slice(0, 10), 1);
    const to = addDays(candidate.observedAt.slice(0, 10), days);
    if (Date.parse(ctx.now) < Date.parse(dayStart(addDays(to, 1)))) return null;
    const pts = stoppedPoints(candidate.evidence);
    if (pts.length === 0) return null;
    const base = detectArgs(ctx);
    const args = { ...base, days, endDate: to };
    const r = (await ctx.call("flaring", args)) as FlaringResult;
    const still = r.vnf.available ? (r.vnf.stopped?.sites ?? []) : null;
    if (!still) return null;
    const dark = pts.filter(([lon, lat]) => still.some((s) => kmBetween(lat, lon, s.lat, s.lon) <= 0.1));
    if (dark.length < pts.length) return null; // at least one site relit (or data missing): not confirmed
    return {
      independence: "revisit",
      signal: {
        id: `firms-flaring-stopped-${ctx.aoi.id}-${r.window.from}-${r.window.to}-revisit`,
        kind: "alert",
        source: `firms-${r.provenance.sensors.map((s) => s.toLowerCase()).join("+")}`,
        datetime: dayStart(r.window.to),
        href: FIRMS_HREF,
        method: { name: "flaring_stopped", version: "1.0", params: args },
        summary: `Second consecutive dark window (${from}…${to}): all ${pts.length} registered site(s) still show no VIIRS night-time detection within ${NOVEL_KM} km.`,
        values: { stopped_sites: pts.length, windowDays: days },
      },
    };
  },
});

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
