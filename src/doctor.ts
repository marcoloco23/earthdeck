// `earthdeck doctor` — setup checker. Verifies Node, env keys, and live reachability of
// every upstream data source, then says exactly which tool families are ready and how to
// unlock the rest. Friendly output, no jargon, exits 0 unless a zero-key source is down.

import { cdseCreds, firmsMapKey, gfwApiKey, SERVER_VERSION, USER_AGENT } from "./config.js";

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

  out("");
  const readyTools = 17 + (cdse.ok ? 7 : 0) + (firms.ok ? 1 : 0) + (gfw.ok ? 1 : 0);
  out(
    zeroKeyDown === 0
      ? `  All zero-key sources reachable — ${readyTools}/26 tools ready to use.`
      : `  ⚠️ ${zeroKeyDown} zero-key source(s) unreachable (network/proxy?) — some tools will fail.`,
  );
  out("  Try it now:  npx -y earthdeck demo");
  out("");
  if (zeroKeyDown > 0) process.exitCode = 1;
}
