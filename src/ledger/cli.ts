// `earthdeck ledger verify | show [id] | seed` — the ledger from the command line.
// `verify` is the same code path a third party would run against a mirror.

import { readFileSync } from "node:fs";
import { ledgerDir } from "../config.js";
import { Ledger, type EventInput } from "./store.js";
import type { Evidence } from "./schema.js";

export async function runLedgerCli(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const dir = ledgerDir();
  const out = (s: string) => process.stdout.write(`${s}\n`);

  if (sub === "verify") {
    const ti = rest.indexOf("--trusted");
    const trusted = ti >= 0 && rest[ti + 1] ? readFileSync(rest[ti + 1]!, "utf8") : undefined;
    const report = Ledger.open(dir, { createKey: false }).verify({ trustedCheckpoint: trusted });
    out(`ledger: ${dir}`);
    out(`entries: ${report.size}   findings: ${report.findings}   root: ${report.root}`);
    out(`checkpoint signed by: ${report.signedBy.join(", ") || "(nobody known)"}`);
    for (const p of report.problems) out(`  ✗ ${p.index !== undefined ? `entry ${p.index}: ` : ""}${p.message}`);
    out(report.ok ? "✓ OK — every entry is signed, canonical, rule-abiding, and the checkpoint matches." : `✗ FAILED with ${report.problems.length} problem(s)`);
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (sub === "show") {
    const l = Ledger.open(dir, { createKey: false });
    const id = rest[0];
    if (id) {
      const f = l.get(id);
      if (!f) throw new Error(`no such finding ${id}`);
      out(JSON.stringify({ finding: f, events: l.eventsOf(id) }, null, 2));
      return;
    }
    out(`${l.size} entries, ${l.list().length} findings, root ${l.root().toString("hex").slice(0, 16)}…`);
    for (const f of l.list()) out(`${f.findingId}  ${f.status.padEnd(14)} T${f.tier}  ${f.rule.name}@${f.rule.version}  ${f.title}`);
    return;
  }

  if (sub === "seed") {
    const l = Ledger.open(dir);
    if (l.size > 0) throw new Error(`refusing to seed a non-empty ledger (${l.size} entries in ${dir})`);
    const n = seedDemo(l);
    out(`seeded ${n} demo events into ${dir} (all titled "[demo] …", aoi tag "demo"). Public key: ${l.publicKeyBase64}`);
    return;
  }

  throw new Error("usage: earthdeck ledger verify [--trusted <checkpoint-file>] | show [findingId] | seed");
}

/** Three clearly-labelled demo findings exercising the tiers, so the Watch tab has something to show. */
export function seedDemo(l: Ledger): number {
  const sys = "system:forest_loss@1.0";
  const gfw: Evidence = {
    id: "gfw-integrated-2026-06-01..2026-08-30-T21LYH",
    kind: "alert",
    source: "gfw-integrated-alerts",
    datetime: "2026-08-30T00:00:00Z",
    href: "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts",
    method: { name: "forest_alerts", version: "1.0", params: { minConfidence: "high", days: 90 } },
    summary: "2,784 high-confidence alerts, 34.0 ha, São Félix do Xingu window.",
    values: { alerts: 2784, ha: 34.0 },
  };
  const ndvi: Evidence = {
    id: "S2A_MSIL2A_20260828T134711_N0511_R124_T21LYH",
    kind: "scene",
    source: "sentinel-2-l2a",
    datetime: "2026-08-28T13:47:11Z",
    method: { name: "eo_compare", version: "1.0", params: { index: "NDVI", composite: "median" } },
    summary: "Median-composite NDVI fell 0.146 vs the 2025 baseline; 96 % valid pixels.",
    values: { deltaNdvi: -0.146, validPct: 96 },
  };
  const events: EventInput[] = [
    {
      kind: "created",
      findingId: "01994a2e-0000-7000-8000-00000000d001",
      actor: sys,
      rule: { name: "forest_loss", version: "1.0" },
      title: "[demo] Forest loss, São Félix do Xingu (PA, Brazil)",
      summary: "High-confidence GFW integrated alerts over 34 ha inside a 90-day window; confirmed by an NDVI drop in a cloud-free median composite.",
      tier: 1,
      geometry: { type: "Polygon", coordinates: [[[-52.15, -6.75], [-52.0, -6.75], [-52.0, -6.6], [-52.15, -6.6], [-52.15, -6.75]]] },
      bbox: [-52.15, -6.75, -52.0, -6.6],
      aoi: { id: "br-sfx-01", name: "São Félix do Xingu", tags: ["demo", "amazon"] },
      observedAt: "2026-08-30T00:00:00Z",
      evidence: [gfw],
      at: "2026-09-01T06:00:00Z",
    },
    { kind: "confirmed", findingId: "01994a2e-0000-7000-8000-00000000d001", actor: sys, signal: ndvi, independence: "sensor", at: "2026-09-01T06:05:00Z" },
    { kind: "reviewed", findingId: "01994a2e-0000-7000-8000-00000000d001", actor: "reviewer:demo-ana", decision: "approve", tier: 1, note: "Clear-cut pattern, roads visible.", at: "2026-09-02T09:00:00Z" },
    { kind: "status_changed", findingId: "01994a2e-0000-7000-8000-00000000d001", actor: "reviewer:demo-ana", from: "confirmed", to: "published", at: "2026-09-02T09:01:00Z" },
    { kind: "notified", findingId: "01994a2e-0000-7000-8000-00000000d001", actor: "reviewer:demo-ana", to: { kind: "authority", name: "IBAMA (federal environmental agency)", channel: "https://www.gov.br/ibama/" }, publicAt: "2026-10-02T09:01:00Z", at: "2026-09-02T09:02:00Z" },
    {
      kind: "created",
      findingId: "01994a2e-0000-7000-8000-00000000d002",
      actor: "system:fires_in_protected@1.0",
      rule: { name: "fires_in_protected", version: "1.0" },
      title: "[demo] Fire cluster inside Terra Indígena Kayapó",
      summary: "17 VIIRS detections (FRP > 20 MW) in 48 h inside a protected boundary; awaiting a second pass.",
      tier: 1,
      geometry: { type: "Point", coordinates: [-52.9, -7.9] },
      bbox: [-53.0, -8.0, -52.8, -7.8],
      aoi: { id: "br-kayapo", name: "TI Kayapó", tags: ["demo", "indigenous-land"] },
      observedAt: "2026-09-24T17:30:00Z",
      evidence: [
        {
          id: "firms-viirs-noaa20-2026-09-24-cluster-7",
          kind: "alert",
          source: "firms-viirs-noaa20-nrt",
          datetime: "2026-09-24T17:30:00Z",
          method: { name: "fires_in", version: "1.0", params: { dayRange: 2, minFrp: 20 } },
          values: { detections: 17, maxFrp: 88.4 },
        },
      ],
      at: "2026-09-25T02:00:00Z",
    },
    {
      kind: "created",
      findingId: "01994a2e-0000-7000-8000-00000000d003",
      actor: "system:methane_anomaly@1.0",
      rule: { name: "methane_anomaly", version: "1.0" },
      title: "[demo] Methane column anomaly, Permian Basin (TX, USA)",
      summary: "S5P XCH₄ +38 ppb above the 90-day window mean over 3 consecutive passes; a Climate TRACE oil & gas asset lies at the centroid. Tier 2 — naming needs two reviewers.",
      tier: 2,
      geometry: { type: "Polygon", coordinates: [[[-103.2, 31.6], [-103.0, 31.6], [-103.0, 31.8], [-103.2, 31.8], [-103.2, 31.6]]] },
      bbox: [-103.2, 31.6, -103.0, 31.8],
      aoi: { id: "us-permian-03", name: "Permian Basin, Delaware sub-basin", tags: ["demo", "oil-gas"] },
      observedAt: "2026-09-20T19:00:00Z",
      evidence: [
        {
          id: "s5p-ch4-2026-09-18..20-anomaly",
          kind: "series",
          source: "sentinel-5p-l2-ch4",
          datetime: "2026-09-20T19:00:00Z",
          method: { name: "methane_plumes", version: "1.0", params: { windowDays: 90, minPpb: 30, passes: 3 } },
          values: { anomalyPpb: 38, passes: 3 },
        },
      ],
      at: "2026-09-21T03:00:00Z",
    },
    {
      kind: "confirmed",
      findingId: "01994a2e-0000-7000-8000-00000000d003",
      actor: "system:methane_anomaly@1.0",
      signal: {
        id: "climatetrace-v7-asset-demo-0001",
        kind: "record",
        source: "climate-trace-v7",
        datetime: "2026-09-21T03:00:00Z",
        href: "https://climatetrace.org/",
        method: { name: "emitters", version: "1.0" },
        summary: "Oil & gas production asset within 2 km of the anomaly centroid.",
      },
      independence: "provider",
      at: "2026-09-21T03:01:00Z",
    },
  ];
  for (const e of events) l.append(e);
  return events.length;
}
