// Quota governor: keeps the scheduled sweeps inside the free API tiers. Every tool call the
// watch makes goes through `wrap()`, which maps the tool to a provider, charges its cost
// against a per-UTC-day cap persisted in the journal dir (`quota.json`), and refuses the
// call (QuotaExceeded) once the cap would be crossed. A 429 — or a 403 that says quota —
// marks the provider exhausted for the rest of the run. The analyst's case count and USD
// spend ride in the same file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError, type ToolCall } from "./rules/types.js";

/** `gfw` = Global *Forest* Watch Data API; `gfw_fishing` = Global *Fishing* Watch API (separate token + terms). */
export type Provider = "cdse" | "gfw" | "firms" | "gfw_fishing";
export const PROVIDERS: readonly Provider[] = ["cdse", "gfw", "firms", "gfw_fishing"];

export interface QuotaCaps {
  cdse: number;
  gfw: number;
  firms: number;
  /** Optional so older callers' caps objects stay valid; missing → the default (200). */
  gfw_fishing?: number;
  analystCases: number;
  analystUsd: number;
  /** Per-rule sub-caps inside a provider's cap, keyed by ruleKey(rule name): e.g. methane may
   *  spend at most 10 CDSE calls so forest confirmations keep the rest. */
  perRule?: Record<string, Partial<Record<Provider, number>>>;
}

// gfw_fishing: conservative — GFW publishes no hard daily cap for the 4Wings report API; 200/day
// covers the marine watchlist (~46 tiles, 1 call each) + confirmations with room to spare.
const DEFAULT_CAPS: QuotaCaps = { cdse: 60, gfw: 400, firms: 300, gfw_fishing: 200, analystCases: 10, analystUsd: 3, perRule: { METHANE_ANOMALY: { cdse: 10 } } };

/** `methane-anomaly` / `methane_anomaly` → `METHANE_ANOMALY` (the env-var suffix form). */
export function ruleKey(rule: string): string {
  return rule.toUpperCase().replace(/[-_\s]+/g, "_");
}

/**
 * Caps from EARTHDECK_MAX_{CDSE,GFW,FIRMS,GFW_FISHING}_CALLS, EARTHDECK_MAX_ANALYST_CASES, EARTHDECK_MAX_ANALYST_USD,
 * plus per-rule sub-caps EARTHDECK_MAX_<PROVIDER>_CALLS_<RULE> (rule name upper-cased).
 */
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
    gfw_fishing: n("EARTHDECK_MAX_GFW_FISHING_CALLS", DEFAULT_CAPS.gfw_fishing!),
    analystCases: n("EARTHDECK_MAX_ANALYST_CASES", DEFAULT_CAPS.analystCases),
    analystUsd: n("EARTHDECK_MAX_ANALYST_USD", DEFAULT_CAPS.analystUsd),
    perRule: perRuleFromEnv(env, n),
  };
}

function perRuleFromEnv(env: NodeJS.ProcessEnv, n: (name: string, dflt: number) => number): NonNullable<QuotaCaps["perRule"]> {
  const out: NonNullable<QuotaCaps["perRule"]> = Object.fromEntries(Object.entries(DEFAULT_CAPS.perRule!).map(([k, v]) => [k, { ...v }]));
  for (const name of Object.keys(env).sort()) {
    const m = /^EARTHDECK_MAX_(CDSE|GFW_FISHING|GFW|FIRMS)_CALLS_(.+)$/.exec(name);
    if (!m || env[name] === undefined || env[name]!.trim() === "") continue;
    const provider = m[1]!.toLowerCase() as Provider;
    (out[ruleKey(m[2]!)] ??= {})[provider] = n(name, 0);
  }
  return out;
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
  fishing_activity: "gfw_fishing",
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
  // One 4Wings report for flag/daily/cells, plus one for the gear breakdown unless byGear: false.
  if (tool === "fishing_activity") return { provider, units: args.byGear === false ? 1 : 2 };
  return { provider, units: 1 };
}

/** Env keys a rule requires → the providers it will spend. */
export function providersForRequires(requires: readonly string[]): Provider[] {
  const out = new Set<Provider>();
  for (const k of requires) {
    if (k === "GFW_API_KEY") out.add("gfw");
    else if (k.startsWith("CDSE_")) out.add("cdse");
    else if (k === "FIRMS_MAP_KEY") out.add("firms");
    else if (k === "GFW_FISHING_TOKEN") out.add("gfw_fishing");
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
  gfw_fishing?: number;
  /** Per-rule provider usage (only for rules with a sub-cap), keyed by ruleKey. */
  rules?: Record<string, Partial<Record<Provider, number>>>;
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

  /** Calls `rule` spent on `provider` today (counted only when the rule has a sub-cap). */
  ruleUsed(rule: string, provider: Provider): number {
    return this.today.rules?.[ruleKey(rule)]?.[provider] ?? 0;
  }

  /** Why the provider can't be used now (by `rule`, when given — its sub-cap applies too), or null. */
  blocked(provider: Provider, units = 1, rule?: string): string | null {
    const hit = this.exhausted.get(provider);
    if (hit) return hit;
    if (this.used(provider) + units > (this.caps[provider] ?? DEFAULT_CAPS[provider]!)) return `quota:${provider}`;
    const sub = rule === undefined ? undefined : this.caps.perRule?.[ruleKey(rule)]?.[provider];
    return sub !== undefined && this.ruleUsed(rule!, provider) + units > sub ? `quota:${provider}` : null;
  }

  /** Count a rule's spend against its sub-cap (no-op for rules without one). */
  chargeRule(rule: string, provider: Provider, units: number): void {
    const key = ruleKey(rule);
    if (this.caps.perRule?.[key]?.[provider] === undefined) return;
    const r = ((this.today.rules ??= {})[key] ??= {});
    r[provider] = (r[provider] ?? 0) + units;
    this.save();
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

// ── news (GDELT) ─────────────────────────────────────────────────────────────────────────
// Per export, not per day: the site export is the only caller, and GDELT asks for pacing
// (≤1 req / 5 s) rather than a daily cap. A rate-limit answer stops fetching for the run.

const DEFAULT_GDELT_CALLS = 40;

/** EARTHDECK_MAX_GDELT_CALLS — news lookups one export may make (default 40). */
export function gdeltCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EARTHDECK_MAX_GDELT_CALLS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GDELT_CALLS;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) throw new Error(`EARTHDECK_MAX_GDELT_CALLS must be a non-negative number (got "${raw}")`);
  return Math.floor(v);
}

/** In-memory call budget for one run; `stop()` after a rate limit refuses the rest. */
export class CallBudget {
  private used = 0;
  private stopped = false;
  constructor(readonly cap: number) {}
  take(): boolean {
    if (this.stopped || this.used >= this.cap) return false;
    this.used += 1;
    return true;
  }
  stop(): void {
    this.stopped = true;
  }
  get spent(): number {
    return this.used;
  }
  get halted(): boolean {
    return this.stopped;
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
