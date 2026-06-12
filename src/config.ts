// Centralized environment configuration.

export const SERVER_NAME = "earthdeck";
export const SERVER_VERSION = "0.3.1";

/** Descriptive User-Agent — required/encouraged by NASA and Nominatim. */
export const USER_AGENT =
  "earthdeck/0.3.1 (+https://github.com/marcoloco23/earthdeck)";

/** EARTHDECK_* is the documented prefix; OVERVIEW_* still works (pre-rename installs). */
function env(name: string): string | undefined {
  return process.env[`EARTHDECK_${name}`] ?? process.env[`OVERVIEW_${name}`];
}

/** Where tools push dashboard cards. */
export function dashboardUrl(): string {
  return env("DASHBOARD_URL") ?? `http://127.0.0.1:${dashboardPort()}`;
}

/** Port the dashboard server listens on. */
export function dashboardPort(): number {
  const raw = env("DASHBOARD_PORT");
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 5005;
}

export interface CdseCreds {
  clientId: string;
  clientSecret: string;
}

/** Copernicus Data Space OAuth client, or null if not configured. */
export function cdseCreds(): CdseCreds | null {
  const clientId = process.env.CDSE_CLIENT_ID;
  const clientSecret = process.env.CDSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** NASA FIRMS map key, or null if not configured. */
export function firmsMapKey(): string | null {
  return process.env.FIRMS_MAP_KEY ?? null;
}

/** Global Forest Watch Data API key (forest_alerts), or null if not configured. */
export function gfwApiKey(): string | null {
  return process.env.GFW_API_KEY ?? null;
}

/**
 * Base URL of the open STAC API used by `stac_search`. Defaults to Earth Search (Element 84),
 * which is anonymous (no key). Override to swap in Planetary Computer or a self-hosted STAC.
 */
export function stacUrl(): string {
  return env("STAC_URL") ?? "https://earth-search.aws.element84.com/v1";
}
