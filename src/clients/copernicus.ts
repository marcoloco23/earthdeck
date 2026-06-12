import { USER_AGENT, cdseCreds } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

const TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const SH = "https://sh.dataspace.copernicus.eu/api/v1";
const CRS = "http://www.opengis.net/def/crs/EPSG/0/4326";
export const S2_COLLECTION = "sentinel-2-l2a";
const COLLECTION = S2_COLLECTION;

const startIso = (d: string) => `${d}T00:00:00Z`;
const endIso = (d: string) => `${d}T23:59:59Z`;

export interface SceneInfo {
  id: string;
  datetime: string;
  cloudCover: number | null;
}

export interface IndexStats {
  mean: number;
  min: number;
  max: number;
  stDev: number;
  sampleCount: number;
  noDataCount: number;
  validPct: number; // % of pixels that survived cloud/shadow/water masking — a quality flag
  p25: number | null;
  p50: number | null;
  p75: number | null;
  intervalFrom: string;
  intervalTo: string;
}

/**
 * Describes which collection a Process/Statistics call targets and how to filter/process it.
 * S2 callers fall back to `s2Source()`; SAR (and future collections) pass their own spec.
 */
export interface DataSourceSpec {
  collection: string;
  mosaickingOrder?: string;
  dataFilter?: Record<string, unknown>; // extra fields (acquisitionMode, polarization, orbitDirection, …)
  processing?: Record<string, unknown>; // S1: { orthorectify, backCoeff }
  maxCloud?: number; // S2 only → maxCloudCoverage
}

interface ProcessOpts {
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  evalscript: string;
  width: number;
  height: number;
  maxCloud?: number;
  source?: DataSourceSpec; // override the default Sentinel-2 source (e.g. Sentinel-1 GRD)
}

interface StatsOpts {
  dateFrom: string;
  dateTo: string;
  evalscript: string;
  width?: number;
  height?: number;
  source?: DataSourceSpec; // override the default Sentinel-2 source (e.g. Sentinel-1 GRD)
}

interface SearchOpts {
  dateFrom: string;
  dateTo: string;
  limit?: number;
  maxCloud?: number;
}

/** Sentinel Hub client on the Copernicus Data Space Ecosystem (OAuth client-credentials). */
export class CopernicusClient {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async getToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    // De-dupe concurrent refreshes (e.g. eo_compare fires 4 calls) so we only POST once.
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": USER_AGENT },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OverviewError(`Copernicus auth failed (${res.status})`, res.status, text.slice(0, 300));
    }
    const j = JSON.parse(text) as { access_token: string; expires_in?: number };
    this.token = j.access_token;
    this.expiresAt = Date.now() + (j.expires_in ?? 600) * 1000;
    return this.token;
  }

  /** POST JSON with a bearer token, refreshing once on a 401. */
  private async authed(url: string, body: unknown, accept: string): Promise<Response> {
    const send = async (token: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    let res = await send(await this.getToken());
    if (res.status === 401) res = await send(await this.getToken(true));
    return res;
  }

  /** The default Sentinel-2 L2A source: least-cloudy mosaic, optional max-cloud filter. */
  private s2Source(maxCloud?: number): DataSourceSpec {
    return { collection: COLLECTION, mosaickingOrder: "leastCC", ...(maxCloud != null ? { maxCloud } : {}) };
  }

  /** Build the Process/Statistics `input` block for a given data source. */
  private buildInput(bbox: BBox, dateFrom: string, dateTo: string, source: DataSourceSpec) {
    const dataFilter: Record<string, unknown> = { timeRange: { from: startIso(dateFrom), to: endIso(dateTo) } };
    if (source.mosaickingOrder) dataFilter.mosaickingOrder = source.mosaickingOrder;
    if (source.maxCloud != null) dataFilter.maxCloudCoverage = source.maxCloud;
    if (source.dataFilter) Object.assign(dataFilter, source.dataFilter);
    const entry: Record<string, unknown> = { type: source.collection, dataFilter };
    if (source.processing) entry.processing = source.processing;
    return { bounds: { bbox, properties: { crs: CRS } }, data: [entry] };
  }

  /** Render a Sentinel-2 image (PNG) for a bbox/time window via an evalscript. */
  async process(bbox: BBox, opts: ProcessOpts): Promise<Buffer> {
    assertBBox(bbox);
    const source = opts.source ?? this.s2Source(opts.maxCloud);
    const body = {
      input: this.buildInput(bbox, opts.dateFrom, opts.dateTo, source),
      output: {
        width: opts.width,
        height: opts.height,
        responses: [{ identifier: "default", format: { type: "image/png" } }],
      },
      evalscript: opts.evalscript,
    };
    const res = await this.authed(`${SH}/process`, body, "image/png");
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || !ct.startsWith("image/")) {
      const t = await res.text().catch(() => "");
      throw new OverviewError(`Copernicus Process failed (${res.status})`, res.status, t.slice(0, 300));
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Compute index statistics over a least-cloudy composite for the window (one bucket). */
  async statistics(bbox: BBox, opts: StatsOpts): Promise<IndexStats> {
    assertBBox(bbox);
    const from = startIso(opts.dateFrom);
    const to = endIso(opts.dateTo);
    // One aggregation bucket that FITS inside [from, to]: a bucket longer than the range
    // overshoots `to` and gets dropped (→ empty result). floor(span) keeps it inside.
    const days = Math.max(1, Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000));
    const body = {
      input: this.buildInput(bbox, opts.dateFrom, opts.dateTo, opts.source ?? this.s2Source()),
      aggregation: {
        timeRange: { from, to },
        aggregationInterval: { of: `P${days}D` },
        width: opts.width ?? 256,
        height: opts.height ?? 256,
        evalscript: opts.evalscript,
      },
      calculations: { default: { statistics: { default: { percentiles: { k: [25, 50, 75] } } } } },
    };
    const res = await this.authed(`${SH}/statistics`, body, "application/json");
    const text = await res.text();
    if (!res.ok) {
      throw new OverviewError(`Copernicus Statistics failed (${res.status})`, res.status, text.slice(0, 300));
    }
    const j = JSON.parse(text) as {
      data?: Array<{
        interval?: { from: string; to: string };
        outputs?: { data?: { bands?: { B0?: { stats?: RawStats } } } };
      }>;
    };
    const entry = j.data?.[0];
    const st = entry?.outputs?.data?.bands?.B0?.stats;
    if (!st || st.sampleCount - (st.noDataCount ?? 0) <= 0) {
      throw new OverviewError(
        "No valid Sentinel-2 data for this area/time window (too cloudy or no acquisition). Try a wider window or smaller area.",
      );
    }
    const pct = st.percentiles ?? {};
    const noData = st.noDataCount ?? 0;
    return {
      mean: st.mean,
      min: st.min,
      max: st.max,
      stDev: st.stDev,
      sampleCount: st.sampleCount,
      noDataCount: noData,
      validPct: st.sampleCount > 0 ? Math.round((100 * (st.sampleCount - noData)) / st.sampleCount) : 0,
      p25: pct["25.0"] ?? null,
      p50: pct["50.0"] ?? null,
      p75: pct["75.0"] ?? null,
      intervalFrom: entry?.interval?.from ?? opts.dateFrom,
      intervalTo: entry?.interval?.to ?? opts.dateTo,
    };
  }

  /** Search the Sentinel-2 archive (STAC). Cloud filtering is applied client-side. */
  async search(bbox: BBox, opts: SearchOpts): Promise<SceneInfo[]> {
    assertBBox(bbox);
    const limit = opts.limit ?? 10;
    const body = {
      collections: [COLLECTION],
      datetime: `${startIso(opts.dateFrom)}/${endIso(opts.dateTo)}`,
      bbox,
      limit: Math.min(50, Math.max(limit, 1)),
    };
    // The STAC catalog responds with application/geo+json; don't over-restrict Accept.
    const res = await this.authed(`${SH}/catalog/1.0.0/search`, body, "*/*");
    const text = await res.text();
    if (!res.ok) {
      throw new OverviewError(`Copernicus Catalog failed (${res.status})`, res.status, text.slice(0, 300));
    }
    const j = JSON.parse(text) as {
      features?: Array<{ id: string; properties?: { datetime?: string; "eo:cloud_cover"?: number } }>;
    };
    let scenes: SceneInfo[] = (j.features ?? []).map((f) => ({
      id: f.id,
      datetime: f.properties?.datetime ?? "",
      cloudCover: f.properties?.["eo:cloud_cover"] ?? null,
    }));
    if (opts.maxCloud != null) {
      scenes = scenes.filter((s) => s.cloudCover == null || s.cloudCover <= opts.maxCloud!);
    }
    return scenes;
  }
}

interface RawStats {
  mean: number;
  min: number;
  max: number;
  stDev: number;
  sampleCount: number;
  noDataCount?: number;
  percentiles?: Record<string, number>;
}

let singleton: CopernicusClient | null = null;

/** Get the shared Copernicus client, or throw a clear error if creds aren't configured. */
export function getCopernicus(): CopernicusClient {
  if (singleton) return singleton;
  const creds = cdseCreds();
  if (!creds) {
    throw new OverviewError(
      "Copernicus credentials are not set. Create a free OAuth client at " +
        "dataspace.copernicus.eu (Dashboard → User Settings → OAuth clients) and set " +
        "CDSE_CLIENT_ID and CDSE_CLIENT_SECRET.",
    );
  }
  singleton = new CopernicusClient(creds.clientId, creds.clientSecret);
  return singleton;
}
