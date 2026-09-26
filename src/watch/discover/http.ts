// Counted, budgeted HTTP for `earthdeck discover`. Every upstream request goes through one
// `DiscoverHttp`, so the run can print exactly what it cost and refuse to exceed its budget.
//
// GFW Data API, tabular/vector datasets (live-verified 2026-09-26):
// - Queried with GET `/dataset/<ds>/<version>/query/json?sql=…` (no geometry needed; the
//   raster `gfw_integrated_alerts` dataset needs the POST+geometry form in src/clients/gfw.ts).
// - Pin the version: `latest` can point at a different asset kind — `ifl_intact_forest_landscapes`
//   `latest` = v2025 is raster-only, while v2021 still carries the vector table. We resolve
//   each dataset's newest version once (`GET /dataset/<ds>` → `versions`) and record it.
// - `AS` aliases are ignored and two aggregates of the same function collide: `SUM(a), SUM(b)`
//   comes back as ONE `sum` key. So a query asks for at most one SUM; area = AVG × COUNT(*).
// - Same `x-api-key` + `origin: localhost` headers as the raster client.

import { USER_AGENT } from "../../config.js";
import { OverviewError } from "../../errors.js";

const GFW_API = "https://data-api.globalforestwatch.org";

export interface CallRecord {
  source: string;
  url: string;
  status: number;
  ms: number;
  bytes: number;
}

export class DiscoverHttp {
  readonly calls: CallRecord[] = [];
  constructor(
    readonly opts: {
      gfwApiKey?: string | null;
      budget?: number;
      log?: (s: string) => void;
      timeoutMs?: number;
      /** Called with every response body (used to record test fixtures). */
      record?: (seq: number, source: string, url: string, body: string) => void;
    } = {},
  ) {}

  get count(): number {
    return this.calls.length;
  }

  bySource(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.calls) out[c.source] = (out[c.source] ?? 0) + 1;
    return out;
  }

  /** One counted request; returns the body text. Throws past the budget or on HTTP errors. */
  async text(source: string, url: string, init: RequestInit = {}): Promise<string> {
    const budget = this.opts.budget ?? 200;
    if (this.calls.length >= budget) throw new OverviewError(`discover: request budget of ${budget} exhausted (at ${source})`);
    const t = Date.now();
    const res = await fetch(url, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
    });
    const body = await res.text();
    const rec = { source, url: url.split("?")[0]!, status: res.status, ms: Date.now() - t, bytes: body.length };
    this.calls.push(rec);
    this.opts.record?.(this.calls.length, source, url, body);
    this.opts.log?.(`  ${source.padEnd(12)} ${res.status} ${String(rec.ms).padStart(6)} ms ${String(body.length).padStart(9)} B  ${rec.url}`);
    if (res.status === 429) throw new OverviewError(`${source} rate limit (429) — retry later`, 429);
    if (!res.ok) throw new OverviewError(`${source} request failed (${res.status})`, res.status, body.slice(0, 300));
    return body;
  }

  async json<T = unknown>(source: string, url: string, init: RequestInit = {}): Promise<T> {
    const body = await this.text(source, url, init);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new OverviewError(`${source} returned non-JSON`, 200, body.slice(0, 300));
    }
  }

  private gfwHeaders(): Record<string, string> {
    const key = this.opts.gfwApiKey;
    if (!key) throw new OverviewError("discover needs GFW_API_KEY for the forest, protected-area and control lists");
    return { "x-api-key": key, origin: "localhost" };
  }

  /** Newest published version of a GFW dataset (e.g. "v20260926"). */
  async gfwLatestVersion(dataset: string): Promise<string> {
    const j = await this.json<{ data?: { versions?: string[] } }>("gfw", `${GFW_API}/dataset/${dataset}`, { headers: this.gfwHeaders() });
    const v = j.data?.versions?.at(-1);
    if (!v) throw new OverviewError(`GFW dataset ${dataset} lists no versions`);
    return v;
  }

  /** SQL against a pinned GFW dataset version; returns the `data` rows. */
  async gfwSql(dataset: string, version: string, sql: string): Promise<Array<Record<string, unknown>>> {
    const url = `${GFW_API}/dataset/${dataset}/${version}/query/json?sql=${encodeURIComponent(sql)}`;
    const j = await this.json<{ data?: Array<Record<string, unknown>> }>("gfw", url, { headers: this.gfwHeaders() });
    return j.data ?? [];
  }
}

/** Number from a GFW cell (numbers sometimes arrive as strings). */
export function n(v: unknown): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : NaN;
}
