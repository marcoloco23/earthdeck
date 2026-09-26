// Quota governor: keeps the scheduled sweeps inside the free API tiers. Every tool call the
// watch makes goes through `wrap()`, which maps the tool to a provider, charges its cost
// against a per-UTC-day cap persisted in the journal dir (`quota.json`), and refuses the
// call (QuotaExceeded) once the cap would be crossed. A 429 — or a 403 that says quota —
// marks the provider exhausted for the rest of the run. The analyst's case count and USD
// spend ride in the same file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError, type ToolCall } from "./rules/types.js";

export type Provider = "cdse" | "gfw" | "firms";
export const PROVIDERS: readonly Provider[] = ["cdse", "gfw", "firms"];

export interface QuotaCaps {
  cdse: number;
  gfw: number;
  firms: number;
  analystCases: number;
  analystUsd: number;
}

const DEFAULT_CAPS: QuotaCaps = { cdse: 60, gfw: 400, firms: 300, analystCases: 10, analystUsd: 3 };

/** Caps from EARTHDECK_MAX_{CDSE,GFW,FIRMS}_CALLS, EARTHDECK_MAX_ANALYST_CASES, EARTHDECK_MAX_ANALYST_USD. */
export function capsFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaCaps {
  const n = (name: string, dflt: number) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number (got "${raw}")`);
    return v;
  };
  return {
    cdse: n("EARTHDECK_MAX_CDSE_CALLS", DEFAULT_CAPS.cdse),
    gfw: n("EARTHDECK_MAX_GFW_CALLS", DEFAULT_CAPS.gfw),
    firms: n("EARTHDECK_MAX_FIRMS_CALLS", DEFAULT_CAPS.firms),
    analystCases: n("EARTHDECK_MAX_ANALYST_CASES", DEFAULT_CAPS.analystCases),
    analystUsd: n("EARTHDECK_MAX_ANALYST_USD", DEFAULT_CAPS.analystUsd),
  };
}

const TOOL_PROVIDER: Record<string, Provider> = {
  forest_alerts: "gfw",
  eo_compare: "cdse",
  eo_render: "cdse",
  eo_index: "cdse",
  eo_search: "cdse",
  methane_plumes: "cdse",
  fires_in: "firms",
  flaring: "firms",
};

/** Provider + billable units for one tool call (null = not governed, e.g. EONET/ENSO). */
export function costOf(tool: string, args: Record<string, unknown>): { provider: Provider; units: number } | null {
  const provider = TOOL_PROVIDER[tool];
  if (!provider) return null;
  if (tool === "flaring") {
    // FIRMS area API: one transaction per ≤5-day chunk per VIIRS source (default 30 d × 2 sources = 12).
    const days = typeof args.days === "number" ? args.days : 30;
    const sources = Array.isArray(args.sources) ? args.sources.length : 2;
    return { provider, units: Math.max(1, Math.ceil(days / 5)) * sources };
  }
  return { provider, units: 1 };
}

/** Env keys a rule requires → the providers it will spend. */
export function providersForRequires(requires: readonly string[]): Provider[] {
  const out = new Set<Provider>();
  for (const k of requires) {
    if (k === "GFW_API_KEY") out.add("gfw");
    else if (k.startsWith("CDSE_")) out.add("cdse");
    else if (k === "FIRMS_MAP_KEY") out.add("firms");
  }
  return [...out];
}

/** Does this tool error mean "the provider's quota is spent"? 429 always; 403 only when it says so. */
export function isQuotaError(message: string, status?: number, body?: unknown): boolean {
  const text = `${message} ${typeof body === "string" ? body : JSON.stringify(body ?? "")}`;
  if (status === 429 || /\(429\)|too many requests|rate limit/i.test(text)) return true;
  const is403 = status === 403 || /\(403\)/.test(message);
  if (is403 && /quota|limit|exceed|processing units/i.test(text)) return true;
  return /transaction limit|exceed(?:ed|ing)? (?:the )?allowed/i.test(text); // FIRMS plain-text limit notice
}

export class QuotaExceeded extends ToolError {
  constructor(
    tool: string,
    readonly provider: Provider,
  ) {
    super(tool, `quota:${provider}`);
    this.name = "QuotaExceeded";
  }
}

interface DayRecord {
  cdse?: number;
  gfw?: number;
  firms?: number;
  analystCases?: number;
  analystUsd?: number;
}

const KEEP_DAYS = 14;

export class QuotaGovernor {
  private days: Record<string, DayRecord>;
  private readonly exhausted = new Map<Provider, string>();
  private readonly file: string | null;

  /** `dir` = the journal dir (null = in-memory only); `day` = UTC YYYY-MM-DD the counters belong to. */
  constructor(
    dir: string | null,
    readonly caps: QuotaCaps,
    readonly day: string = new Date().toISOString().slice(0, 10),
  ) {
    this.file = dir ? join(dir, "quota.json") : null;
    this.days = this.file && existsSync(this.file) ? readDays(this.file) : {};
  }

  private get today(): DayRecord {
    return (this.days[this.day] ??= {});
  }

  used(provider: Provider): number {
    return this.today[provider] ?? 0;
  }

  /** Why the provider can't be used now, or null. */
  blocked(provider: Provider, units = 1): string | null {
    const hit = this.exhausted.get(provider);
    if (hit) return hit;
    return this.used(provider) + units > this.caps[provider] ? `quota:${provider}` : null;
  }

  markExhausted(provider: Provider): void {
    this.exhausted.set(provider, `quota:${provider}`);
  }

  /** Charge units (also when the call later fails — the provider still counted the request). */
  charge(provider: Provider, units: number): void {
    this.today[provider] = this.used(provider) + units;
    this.save();
  }

  /** Wrap a ToolCall: refuse over-cap calls, charge the rest, learn from 429/403-quota errors. */
  wrap(call: ToolCall): ToolCall {
    return async (tool, args) => {
      const cost = costOf(tool, args);
      if (!cost) return call(tool, args);
      if (this.blocked(cost.provider, cost.units)) throw new QuotaExceeded(tool, cost.provider);
      this.charge(cost.provider, cost.units);
      try {
        return await call(tool, args);
      } catch (err) {
        const e = err as { message?: string; status?: number; body?: unknown };
        if (isQuotaError(String(e.message ?? err), e.status, e.body)) this.markExhausted(cost.provider);
        throw err;
      }
    };
  }

  // ── analyst ──────────────────────────────────────────────────────────────────────────

  analystCasesLeft(): number {
    return Math.max(0, this.caps.analystCases - (this.today.analystCases ?? 0));
  }
  chargeAnalystCase(): void {
    this.today.analystCases = (this.today.analystCases ?? 0) + 1;
    this.save();
  }
  analystUsd(): number {
    return this.today.analystUsd ?? 0;
  }
  /** Add spend; returns today's running total. */
  addAnalystUsd(usd: number): number {
    this.today.analystUsd = Math.round((this.analystUsd() + usd) * 1e6) / 1e6;
    this.save();
    return this.today.analystUsd;
  }
  analystBudgetSpent(): boolean {
    return this.analystUsd() >= this.caps.analystUsd;
  }

  snapshot(): DayRecord {
    return { ...this.today };
  }

  private save(): void {
    if (!this.file) return;
    const keep = Object.keys(this.days).sort().slice(-KEEP_DAYS);
    this.days = Object.fromEntries(keep.map((d) => [d, this.days[d]!]));
    writeFileSync(this.file, JSON.stringify(this.days, null, 2));
  }
}

function readDays(file: string): Record<string, DayRecord> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, DayRecord>) : {};
  } catch {
    return {};
  }
}
