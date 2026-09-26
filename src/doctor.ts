// `earthdeck doctor` — setup checker. Verifies Node, env keys, and live reachability of
// every upstream data source, then says exactly which tool families are ready and how to
// unlock the rest. Friendly output, no jargon, exits 0 unless a zero-key source is down
// (or the Watch section finds a ledger that fails verification / an invalid watchlist).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cdseCreds, climateTraceBase, firmsMapKey, geeCreds, gfwApiKey, ledgerDir, overpassUrl, SERVER_VERSION, USER_AGENT } from "./config.js";
import { Ledger } from "./ledger/store.js";
import { readHeartbeat } from "./watch/journal.js";
import { RULES } from "./watch/rules/index.js";
import { loadWatchlists } from "./watch/watchlist.js";

const out = (s: string) => process.stdout.write(s + "\n");

interface Check {
  name: string;
  url: string;
  /** Treat any HTTP response (even 4xx) as reachable — for endpoints that 400 on bare GETs. */
  anyResponse?: boolean;
}

const ZERO_KEY_CHECKS: Check[] = [
  { name: "NASA EONET (events)", url: "https://eonet.gsfc.nasa.gov/api/v3/events?limit=1" },
  { name: "Earth Search STAC (stac_search)", url: "https://earth-search.aws.element84.com/v1" },
  { name: "NOAA ONI (enso)", url: "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt" },
  { name: "NOAA GML (co2)", url: "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt" },
  { name: "NASA GISTEMP (global_temp)", url: "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv" },
  { name: "NSIDC (sea_ice)", url: "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/" },
  { name: "ERDDAP OISST (ocean_temp)", url: "https://coastwatch.pfeg.noaa.gov/erddap/griddap/index.html", anyResponse: true },
  { name: "USGS (quakes)", url: "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=1" },
  { name: "NASA CMR (earthdata_search)", url: "https://cmr.earthdata.nasa.gov/search/collections.json?keyword=test&page_size=1" },
  { name: "Open-Meteo (climate/air/river)", url: "https://archive-api.open-meteo.com/v1/archive?latitude=0&longitude=0&start_date=2024-01-01&end_date=2024-01-01&daily=temperature_2m_mean" },
  { name: "OSM Overpass (protected_areas)", url: `${overpassUrl()}?data=${encodeURIComponent("[out:json];out;")}`, anyResponse: true }, // shared instance often 504s when busy — an answer means reachable
  { name: "Climate TRACE v7 (emitters)", url: `${climateTraceBase()}/definitions/sectors` },
];

async function probe(check: Check, timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(check.url, {
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    const ok = check.anyResponse ? true : res.ok;
    return { ok, detail: ok ? "reachable" : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCdse(): Promise<{ ok: boolean; detail: string }> {
  const creds = cdseCreds();
  if (!creds) return { ok: false, detail: "not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
        signal: controller.signal,
      },
    );
    return res.ok
      ? { ok: true, detail: "OAuth token OK" }
      : { ok: false, detail: `token request failed (HTTP ${res.status}) — check the client id/secret` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeFirms(): Promise<{ ok: boolean; detail: string }> {
  const key = firmsMapKey();
  if (!key) return { ok: false, detail: "not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(
      `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(key)}`,
      { headers: { "user-agent": USER_AGENT }, signal: controller.signal },
    );
    if (!res.ok) return { ok: false, detail: `status check failed (HTTP ${res.status})` };
    const body = (await res.json().catch(() => null)) as { current_transactions?: number; transaction_limit?: number } | null;
    if (body && typeof body.transaction_limit === "number") {
      return { ok: true, detail: `key valid (${body.current_transactions ?? 0}/${body.transaction_limit} transactions used)` };
    }
    return { ok: false, detail: "key not recognized by FIRMS" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeGfw(): Promise<{ ok: boolean; detail: string }> {
  const key = gfwApiKey();
  if (!key) return { ok: false, detail: "not configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    // Cheapest honest check: a COUNT over a ~1 km box (the validate endpoint needs a
    // bearer token, not the key). 401/403 = key rejected; 200 = ready.
    const res = await fetch(
      "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/latest/query/json",
      {
        method: "POST",
        headers: { "x-api-key": key, origin: "localhost", "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({
          sql: "SELECT COUNT(*) AS n FROM results",
          geometry: {
            type: "Polygon",
            coordinates: [[[-60.0, -3.0], [-59.99, -3.0], [-59.99, -2.99], [-60.0, -2.99], [-60.0, -3.0]]],
          },
        }),
        signal: controller.signal,
      },
    );
    if (res.status === 401 || res.status === 403) return { ok: false, detail: "key rejected by the GFW Data API" };
    return res.ok
      ? { ok: true, detail: "key valid (test query OK)" }
      : { ok: false, detail: `test query failed (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Offline config check for gee_query (no token request — that would need a registered project). */
export function geeDoctorLine(env: NodeJS.ProcessEnv = process.env): string {
  const name = "Google Earth Engine (gee_query)";
  try {
    const c = geeCreds(env);
    return c
      ? `    ✓ ${name}  configured (${c.clientEmail}, project ${c.project})`
      : `    · ${name}  not configured\n        → Cloud project registered for Earth Engine + service account key: see docs/research/2026-09-26_google-earth-engine.md`;
  } catch (err) {
    return `    ✗ ${name}  misconfigured: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function dirBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return n;
}

function kb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(iso: string, now: number): string {
  const h = (now - Date.parse(iso)) / 3_600_000;
  return h < 1 ? `${Math.max(0, Math.round(h * 60))} min ago` : h < 48 ? `${h.toFixed(1)} h ago` : `${(h / 24).toFixed(1)} days ago`;
}

export interface WatchCheckOptions {
  ledgerDir?: string;
  watchlistsPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * The Watch section (offline, no network): ledger presence/size/verify, each rule's keys,
 * watchlist validity, and the last sweep's heartbeat. `failed` = ledger verify or a
 * watchlist is broken (either makes `earthdeck watch` untrustworthy or unusable).
 */
export function watchChecks(o: WatchCheckOptions = {}): { lines: string[]; failed: boolean } {
  const dir = o.ledgerDir ?? ledgerDir();
  const wlPath = o.watchlistsPath ?? "watchlists";
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now();
  const lines: string[] = [];
  const line = (mark: string, name: string, detail: string) => lines.push(`    ${mark} ${name.padEnd(34)} ${detail}`);
  let failed = false;

  if (!existsSync(join(dir, "entries.jsonl"))) {
    line("·", "Ledger", `not created yet (${dir}) — \`earthdeck watch --once\` or \`earthdeck ledger seed\``);
  } else {
    const l = Ledger.open(dir, { createKey: false });
    const r = l.verify();
    const base = `${dir} — ${r.size} entries, ${r.findings} findings, ${kb(dirBytes(dir))}`;
    if (r.ok) line("✓", "Ledger", `${base}, verify OK`);
    else {
      failed = true;
      line("✗", "Ledger", `${base}, verify FAILED: ${r.problems[0]!.message}${r.problems.length > 1 ? ` (+${r.problems.length - 1} more)` : ""}`);
    }
  }

  for (const rule of RULES.values()) {
    const missing = rule.requires.filter((k) => !env[k]);
    line(
      missing.length ? "·" : "✓",
      `Rule ${rule.name}`,
      missing.length ? `missing ${missing.join(", ")} — sweeps skip it` : `keys present (${rule.requires.join(", ") || "none needed"})`,
    );
  }

  if (!existsSync(wlPath)) {
    line("·", "Watchlists", `none at ./${wlPath} — \`earthdeck watch\` needs --watchlist`);
  } else {
    try {
      const wls = loadWatchlists(wlPath);
      const aois = wls.flatMap((w) => w.aois);
      const unknown = [...new Set(aois.flatMap((a) => a.rules.map((r) => r.name)).filter((n) => !RULES.has(n)))];
      const detail = `${wls.length} watchlist(s), ${aois.length} AOIs (${aois.filter((a) => a.control).length} control) in ./${wlPath}`;
      line(unknown.length ? "·" : "✓", "Watchlists", unknown.length ? `${detail} — unknown rule(s): ${unknown.join(", ")}` : detail);
    } catch (err) {
      failed = true;
      line("✗", "Watchlists", `invalid: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }

  const hb = readHeartbeat(join(dir, "watch"));
  if (!hb) line("·", "Last sweep", "none yet");
  else {
    const n = (k: string) => (typeof hb[k] === "number" ? (hb[k] as number) : 0);
    line(
      "✓",
      "Last sweep",
      `${hb.at} (${ago(hb.at, now)})${hb.dryRun ? " [dry run]" : ""} — ${n("pairs")} pairs, ${n("created")} opened, ${n("confirmed")} confirmed, ${n("gaps")} gaps, ${n("skipped")} skipped`,
    );
  }
  return { lines, failed };
}

export async function runDoctor(): Promise<void> {
  out("");
  out(`  earthdeck doctor — v${SERVER_VERSION}, node ${process.version}`);
  out("");

  out("  Zero-key data sources (events, stac_search, geo_resolve, eo_snapshot + all 10 planetary indicators):");
  // One retry after a short pause — public NASA/NOAA endpoints throttle transiently, and a
  // doctor that calls a 503 blip "broken setup" is worse than a slightly slower check.
  const results = await Promise.all(
    ZERO_KEY_CHECKS.map(async (c) => {
      const first = await probe(c);
      if (first.ok) return first;
      await new Promise((r) => setTimeout(r, 2500));
      return probe(c);
    }),
  );
  let zeroKeyDown = 0;
  results.forEach((r, i) => {
    if (!r.ok) zeroKeyDown++;
    out(`    ${r.ok ? "✓" : "✗"} ${ZERO_KEY_CHECKS[i]!.name.padEnd(34)} ${r.detail}`);
  });

  out("");
  out("  Optional keys:");
  const [cdse, firms, gfw] = await Promise.all([probeCdse(), probeFirms(), probeGfw()]);
  out(
    `    ${cdse.ok ? "✓" : "·"} Copernicus CDSE (eo_render/eo_index/eo_search/eo_compare/sar_*)  ${cdse.detail}`,
  );
  if (!cdseCreds()) {
    out("        → free account: https://dataspace.copernicus.eu/ → user settings → OAuth client");
  }
  out(`    ${firms.ok ? "✓" : "·"} NASA FIRMS (fires_in)  ${firms.detail}`);
  if (!firmsMapKey()) {
    out("        → free key (instant): https://firms.modaps.eosdis.nasa.gov/api/map_key/");
  }
  out(`    ${gfw.ok ? "✓" : "·"} Global Forest Watch (forest_alerts)  ${gfw.detail}`);
  if (!gfwApiKey()) {
    out(
      "        → free key: https://www.globalforestwatch.org/help/developers/guides/create-and-use-an-api-key/",
    );
  }
  out(geeDoctorLine());

  out("");
  out("  Watch (earthdeck watch --once → findings ledger):");
  const watch = watchChecks();
  for (const l of watch.lines) out(l);

  out("");
  const keysOff = [cdse.ok ? null : "Copernicus", firms.ok ? null : "FIRMS", gfw.ok ? null : "GFW"].filter(Boolean);
  out(
    zeroKeyDown === 0
      ? `  All zero-key sources reachable — ${keysOff.length === 0 ? "every tool ready to use." : `tools needing ${keysOff.join(", ")} keys are off.`}`
      : `  ⚠️ ${zeroKeyDown} zero-key source(s) unreachable (network/proxy?) — some tools will fail.`,
  );
  out("  Try it now:  npx -y earthdeck demo");
  out("");
  if (zeroKeyDown > 0 || watch.failed) process.exitCode = 1;
}
