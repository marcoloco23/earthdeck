// `earthdeck discover` — generate the sweep's watchlists from data instead of by hand.
//
//   earthdeck discover --out watchlists/generated [--max-per-list N] [--only a,b] [--budget 200]
//
// Five lists, each from open data (see src/watch/discover/*.ts for sources + quirks):
//   forest-hotspots.json     GFW integrated alerts, top GADM level-2 areas, last 30 days
//   flaring-fields.json      EOG VIIRS Nightfire annual flare sites, clustered into fields
//   methane-basins.json      Climate TRACE v7 oil & gas CH₄ sources, clustered into basins
//   protected-fires.json     largest forested tropical WDPA protected areas (IUCN Ia–IV first)
//   controls-generated.json  expected-quiet cores of the largest tropical Intact Forest Landscapes
// plus `_summary.json` (counts, sources + versions, API calls). Every AOI passes
// `parseWatchlist`; ids derive from dataset ids (GADM, VNF site location, Climate TRACE source
// id, WDPA site id, IFL id) so watermarks and cooldowns survive re-runs. ~15 requests, no CDSE.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gfwApiKey } from "../config.js";
import type { BBox } from "../types.js";
import { isoDate } from "../util.js";
import { buildControls, fetchControls, IFL_DATASET, IFL_VERSION } from "./discover/controls.js";
import { buildFlaringFields, fetchFlaring } from "./discover/flaring.js";
import { ADM2_ALERTS_DATASET, buildForestHotspots, fetchForest, GADM_DATASET } from "./discover/forest.js";
import { DiscoverHttp } from "./discover/http.js";
import { buildMethaneBasins, fetchMethane } from "./discover/methane.js";
import { buildProtectedFires, fetchProtected, WDPA_ALERTS_DATASET, WDPA_DATASET } from "./discover/protected.js";
import { parseWatchlist, type Watchlist } from "./watchlist.js";

export const LISTS = {
  "forest-hotspots": 150,
  "flaring-fields": 60,
  "methane-basins": 40,
  "protected-fires": 80,
  "controls-generated": 20,
} as const;
export type ListName = keyof typeof LISTS;

export interface DiscoverOptions {
  out: string;
  maxPerList?: number;
  only?: ListName[];
  budget?: number;
  today?: string;
  log?: (s: string) => void;
  gfwKey?: string | null;
  record?: (seq: number, source: string, url: string, body: string) => void;
}

export interface ListSummary {
  file: string;
  entities: number;
  aois: number;
  source: string;
  versions: Record<string, string | number>;
  /** Entities dropped while building (with why). */
  skipped?: string[];
  notes?: string[];
  error?: string;
}

export interface DiscoverSummary {
  generatedAt: string;
  tool: string;
  lists: Partial<Record<ListName, ListSummary>>;
  totals: { aois: number; controls: number };
  requests: { total: number; bySource: Record<string, number>; budget: number };
  elapsedMs: number;
}

/** Validate (the same parser `earthdeck watch` uses) and write one list. */
function writeList(out: string, name: string, wl: Watchlist): string {
  const file = `${name}.json`;
  parseWatchlist(JSON.parse(JSON.stringify(wl)), file);
  writeFileSync(join(out, file), JSON.stringify(wl, null, 2) + "\n");
  return file;
}

export async function discover(o: DiscoverOptions): Promise<DiscoverSummary> {
  const t0 = Date.now();
  const log = o.log ?? (() => {});
  const today = o.today ?? isoDate(0);
  const budget = o.budget ?? 200;
  const http = new DiscoverHttp({ gfwApiKey: o.gfwKey === undefined ? gfwApiKey() : o.gfwKey, budget, log, record: o.record });
  const want = (l: ListName) => !o.only || o.only.includes(l);
  const max = (l: ListName) => o.maxPerList ?? LISTS[l];
  mkdirSync(o.out, { recursive: true });
  const lists: DiscoverSummary["lists"] = {};
  let hotspotBoxes: BBox[] = [];

  const run = async (name: ListName, source: string, fn: () => Promise<Omit<ListSummary, "source">>) => {
    if (!want(name)) return;
    log(`${name}:`);
    try {
      const s = await fn();
      lists[name] = { ...s, source };
      log(`  → ${s.file}: ${s.entities} ${name === "controls-generated" ? "cores" : "entities"}, ${s.aois} AOIs${s.skipped?.length ? ` (${s.skipped.length} skipped)` : ""}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lists[name] = { file: `${name}.json`, entities: 0, aois: 0, source, versions: {}, error: msg };
      log(`  ✗ ${name}: ${msg} — previous file (if any) left untouched`);
    }
  };

  // Sequential on purpose: polite to GFW, and the call log reads top to bottom.
  await run("forest-hotspots", "GFW Data API — integrated deforestation alerts (GLAD-L/GLAD-S2/RADD) + GADM 4.1", async () => {
    const raw = await fetchForest(http, max("forest-hotspots"));
    const r = buildForestHotspots(raw, today);
    hotspotBoxes = r.watchlist.aois.map((a) => a.bbox as BBox);
    return {
      file: writeList(o.out, "forest-hotspots", r.watchlist),
      entities: r.areas.length,
      aois: r.watchlist.aois.length,
      versions: { [ADM2_ALERTS_DATASET]: raw.alertsVersion, [GADM_DATASET]: raw.gadmVersion, window: `${raw.window.from}..${raw.window.to}` },
      skipped: r.skipped,
    };
  });
  await run("flaring-fields", "EOG VIIRS Nightfire annual global flare summary (Colorado School of Mines)", async () => {
    const raw = await fetchFlaring(http);
    const r = buildFlaringFields(raw, max("flaring-fields"), today);
    return { file: writeList(o.out, "flaring-fields", r.watchlist), entities: r.fields.length, aois: r.watchlist.aois.length, versions: { vnfYear: raw.year, vnfFile: raw.url.split("/").pop()!, sites: raw.sites.length } };
  });
  await run("methane-basins", "Climate TRACE v7 (CC BY 4.0) — oil & gas production, refining, transport", async () => {
    const raw = await fetchMethane(http);
    const r = buildMethaneBasins(raw, max("methane-basins"), today);
    return {
      file: writeList(o.out, "methane-basins", r.watchlist),
      entities: r.basins.length,
      aois: r.watchlist.aois.length,
      versions: { api: raw.base },
      notes: [`dropped ${r.dropped.otherBasins} OtherBasins residual rows, ${r.dropped.deepwater} deepwater/offshore rows, ${r.dropped.zero} zero-CH₄ rows before clustering`],
    };
  });
  await run("protected-fires", "WDPA via GFW Data API (IDs/stats only) + GFW integrated alerts per protected area", async () => {
    const raw = await fetchProtected(http, today);
    const r = buildProtectedFires(raw, max("protected-fires"), today);
    return {
      file: writeList(o.out, "protected-fires", r.watchlist),
      entities: r.sites.length,
      aois: r.watchlist.aois.length,
      versions: { [WDPA_DATASET]: raw.wdpaVersion, [WDPA_ALERTS_DATASET]: raw.alertsVersion },
    };
  });
  await run("controls-generated", "Intact Forest Landscapes 2020 (Potapov et al.) via GFW Data API", async () => {
    const raw = await fetchControls(http, max("controls-generated"));
    const r = buildControls(raw, max("controls-generated"), today, hotspotBoxes);
    return { file: writeList(o.out, "controls-generated", r.watchlist), entities: r.watchlist.aois.length, aois: r.watchlist.aois.length, versions: { [IFL_DATASET]: IFL_VERSION }, skipped: r.skipped };
  });

  const ok = Object.values(lists).filter((l) => !l.error);
  const summary: DiscoverSummary = {
    generatedAt: new Date().toISOString(),
    tool: "earthdeck discover",
    lists,
    totals: { aois: ok.reduce((s, l) => s + l.aois, 0), controls: lists["controls-generated"]?.error ? 0 : (lists["controls-generated"]?.aois ?? 0) },
    requests: { total: http.count, bySource: http.bySource(), budget },
    elapsedMs: Date.now() - t0,
  };
  writeFileSync(join(o.out, "_summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

export async function runDiscoverCli(argv: string[]): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    out("usage: earthdeck discover [--out watchlists/generated] [--max-per-list N] [--only forest-hotspots,flaring-fields,…] [--budget 200]");
    return;
  }
  const maxArg = opt("--max-per-list");
  const maxPerList = maxArg === undefined ? undefined : Number(maxArg);
  if (maxPerList !== undefined && !(Number.isInteger(maxPerList) && maxPerList > 0)) throw new Error("--max-per-list must be a positive integer");
  const only = opt("--only")?.split(",").map((s) => s.trim()) as ListName[] | undefined;
  for (const l of only ?? []) if (!(l in LISTS)) throw new Error(`--only: unknown list ${l} (have ${Object.keys(LISTS).join(", ")})`);
  const dir = opt("--out") ?? "watchlists/generated";
  const recordDir = opt("--record");
  if (recordDir) mkdirSync(recordDir, { recursive: true });
  const record = recordDir
    ? (seq: number, source: string, _url: string, body: string) => writeFileSync(join(recordDir, `${String(seq).padStart(2, "0")}-${source}.txt`), body)
    : undefined;

  out(`earthdeck discover → ${dir}${maxPerList ? ` (max ${maxPerList} per list)` : ""}`);
  const s = await discover({ out: dir, maxPerList, only, budget: opt("--budget") ? Number(opt("--budget")) : undefined, log: out, record });
  out("");
  for (const [name, l] of Object.entries(s.lists)) out(`  ${l.error ? "✗" : "✓"} ${name.padEnd(20)} ${l.error ? l.error : `${l.entities} → ${l.aois} AOIs`}`);
  out(`  API requests: ${s.requests.total} (${Object.entries(s.requests.bySource).map(([k, v]) => `${k} ${v}`).join(", ")}) of budget ${s.requests.budget}; ${(s.elapsedMs / 1000).toFixed(1)} s`);
  out(`  ${s.totals.aois} AOIs total (${s.totals.controls} control) — summary in ${join(dir, "_summary.json")}`);
  if (Object.values(s.lists).some((l) => l.error)) process.exitCode = 1;
}
