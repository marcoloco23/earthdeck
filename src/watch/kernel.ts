// The Watch Kernel: deterministic, journaled, no LLM. For every AOI × rule it (1) tries to
// confirm an open candidate with the rule's independent signal, (2) otherwise runs the
// detector, (3) opens a finding with context + blind spots + regional baseline, (4) expires
// stale candidates, and (5) advances the watermark only on success — so a failed or late
// sweep self-heals next time instead of leaving a silent hole.

import { pushFindingCard } from "../dashboard/push.js";
import { CANDIDATE_TTL_DAYS, TERMINAL_STATUSES, eventPayload, type Context, type Finding } from "../ledger/schema.js";
import type { Ledger } from "../ledger/store.js";
import { uuidv7 } from "../util.js";
import { createHash } from "node:crypto";
import { Journal } from "./journal.js";
import { costOf, providersForRequires, QuotaExceeded, type QuotaGovernor } from "./quota.js";
import { bboxPolygon, ringBBox, ToolError, type Rule, type RuleContext, type ToolCall } from "./rules/types.js";
import type { WatchAoi, Watchlist } from "./watchlist.js";

export interface SweepOptions {
  watchlists: Watchlist[];
  rules: ReadonlyMap<string, Rule>;
  ledger: Ledger;
  journal: Journal;
  call: ToolCall;
  now?: string;
  dryRun?: boolean;
  /** Only these rule names (default all). */
  onlyRules?: string[];
  /** Cap on AOI×rule pairs per sweep (quota protection). */
  maxPairs?: number;
  /** Pause between pairs, ms (be polite to the data APIs). */
  delayMs?: number;
  /** Env presence check for rule.requires; default reads process.env. */
  hasKey?: (name: string) => boolean;
  log?: (line: string) => void;
  /** Only pairs in this shard: stable hash(aoi.id, rule) mod count === index. */
  shard?: Shard;
  /** Wall-clock deadline (ms since epoch): stop opening new pairs when the next might not fit. */
  deadline?: number;
  /** Clock for the deadline (default Date.now). */
  clock?: () => number;
  /** Per-day provider caps; pairs needing an exhausted provider are skipped `quota:<provider>`. */
  quota?: QuotaGovernor;
}

export interface Shard {
  index: number;
  count: number;
}

/** `"3/8"` → { index: 3, count: 8 }. */
export function parseShard(s: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(s.trim());
  const index = m ? Number(m[1]) : NaN;
  const count = m ? Number(m[2]) : NaN;
  if (!m || count < 1 || index >= count) throw new Error(`--shard must be i/n with 0 ≤ i < n (got "${s}")`);
  return { index, count };
}

/** Deterministic shard of an AOI×rule pair (sha256, first 32 bits). */
export function shardOf(aoiId: string, rule: string, count: number): number {
  return createHash("sha256").update(`${aoiId}\n${rule}`).digest().readUInt32BE(0) % count;
}

export interface SweepReport {
  sweepId: string;
  startedAt: string;
  finishedAt: string;
  pairs: number;
  created: string[];
  confirmed: string[];
  evidenceAdded: string[];
  expired: string[];
  gaps: { aoi: string; rule: string; message: string }[];
  skipped: { aoi: string; rule: string; reason: string }[];
  dryRun: boolean;
  /** Set when the deadline stopped the sweep early: `done` of `total` pairs were visited. */
  budgetExhausted?: { done: number; total: number };
}

export async function sweep(o: SweepOptions): Promise<SweepReport> {
  const now = o.now ?? new Date().toISOString();
  const sweepId = uuidv7();
  const log = o.log ?? (() => {});
  const hasKey = o.hasKey ?? ((n) => Boolean(process.env[n]));
  const report: SweepReport = { sweepId, startedAt: now, finishedAt: now, pairs: 0, created: [], confirmed: [], evidenceAdded: [], expired: [], gaps: [], skipped: [], dryRun: Boolean(o.dryRun) };
  o.journal.append({ t: now, sweepId, kind: "sweep_start", dryRun: report.dryRun });

  // Memoize per-sweep context that doesn't depend on the AOI (ENSO is global).
  let enso: Context["enso"] | null | undefined;
  // One wrapper per rule: the rule's per-provider sub-cap (quota.caps.perRule) is enforced
  // here, since only the kernel knows which rule a tool call is spent for.
  const callFor = (rule: string): ToolCall => {
    const wrapped: ToolCall & { base?: ToolCall } = async (tool, args) => {
    const t0 = Date.now();
    const cost = o.quota ? costOf(tool, args) : null;
    try {
      if (cost) {
        if (o.quota!.blocked(cost.provider, cost.units, rule)) throw new QuotaExceeded(tool, cost.provider);
        o.quota!.chargeRule(rule, cost.provider, cost.units);
      }
      const res = await o.call(tool, args);
      o.journal.append({ t: new Date().toISOString(), sweepId, kind: "tool_call", tool, args, ms: Date.now() - t0, responseSha256: Journal.hash(res) });
      return res;
    } catch (err) {
      o.journal.append({ t: new Date().toISOString(), sweepId, kind: "tool_call", tool, args, ms: Date.now() - t0, message: String(err) });
      throw err instanceof ToolError ? err : new ToolError(tool, err instanceof Error ? err.message : String(err));
    }
    };
    wrapped.base = o.call; // lets rules memoise per sweep across their per-rule wrappers
    return wrapped;
  };

  // Housekeeping first: candidates past their TTL expire (GLAD's rule), regardless of watchlists.
  for (const f of o.ledger.list({ status: ["candidate"] })) {
    if (Date.parse(now) - Date.parse(f.createdAt) > CANDIDATE_TTL_DAYS * 86_400_000) {
      if (!report.dryRun) o.ledger.append({ kind: "status_changed", findingId: f.findingId, actor: `system:kernel@1.0`, from: "candidate", to: "expired", reason: `no independent confirmation within ${CANDIDATE_TTL_DAYS} days`, at: now });
      report.expired.push(f.findingId);
      o.journal.append({ t: now, sweepId, kind: "expired", findingId: f.findingId });
    }
  }

  const pairs: { aoi: WatchAoi; ruleName: string; params: Record<string, unknown> }[] = [];
  for (const wl of o.watchlists)
    for (const aoi of wl.aois)
      for (const r of aoi.rules) {
        if (o.onlyRules && !o.onlyRules.includes(r.name)) continue;
        if (o.shard && shardOf(aoi.id, r.name, o.shard.count) !== o.shard.index) continue;
        pairs.push({ aoi, ruleName: r.name, params: r.params });
      }
  // Least-recently-swept first (never-swept first of all), so a budget- or quota-cut sweep
  // rotates through the list instead of starving its tail. Stable for equal watermarks.
  const lastSwept = (p: (typeof pairs)[number]) => o.journal.watermark(p.aoi.id, p.ruleName) ?? "";
  pairs.sort((a, b) => (lastSwept(a) < lastSwept(b) ? -1 : lastSwept(a) > lastSwept(b) ? 1 : 0));
  const capped = o.maxPairs ? pairs.slice(0, o.maxPairs) : pairs;
  report.pairs = capped.length;

  const clock = o.clock ?? Date.now;
  let longestPairMs = 0;
  for (const [i, { aoi, ruleName, params }] of capped.entries()) {
    if (i > 0 && o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    // Budget: open the next pair only if one more (as long as the slowest so far) still fits.
    const pairStart = clock();
    if (o.deadline !== undefined && pairStart + longestPairMs > o.deadline) {
      report.budgetExhausted = { done: i, total: capped.length };
      o.journal.append({ t: new Date().toISOString(), sweepId, kind: "budget_exhausted", done: i, total: capped.length });
      log(`budget exhausted: ${i} of ${capped.length} pairs done`);
      break;
    }
    try {
      await runPair(aoi, ruleName, params);
    } finally {
      longestPairMs = Math.max(longestPairMs, clock() - pairStart);
    }
  }

  async function runPair(aoi: WatchAoi, ruleName: string, params: Record<string, unknown>): Promise<void> {
    const rule = o.rules.get(ruleName);
    if (!rule) {
      report.gaps.push({ aoi: aoi.id, rule: ruleName, message: "unknown rule" });
      o.journal.append({ t: now, sweepId, kind: "gap", aoi: aoi.id, rule: ruleName, message: "unknown rule" });
      return;
    }
    const missing = rule.requires.filter((k) => !hasKey(k));
    if (missing.length) {
      report.skipped.push({ aoi: aoi.id, rule: ruleName, reason: `missing ${missing.join(", ")}` });
      o.journal.append({ t: now, sweepId, kind: "skip", aoi: aoi.id, rule: ruleName, message: `missing ${missing.join(", ")}` });
      return;
    }
    // Only detect-time providers gate the pair; confirm-only providers defer confirmation instead.
    const detectRequires = rule.requires.filter((k) => !(rule.confirmRequires ?? []).includes(k));
    const quotaBlock = o.quota ? providersForRequires(detectRequires).map((p) => o.quota!.blocked(p, 1, rule.name)).find(Boolean) : null;
    const confirmBlocked = (): string | null => (o.quota ? providersForRequires(rule.confirmRequires ?? []).map((p) => o.quota!.blocked(p, 1, rule.name)).find(Boolean) ?? null : null);
    if (quotaBlock) {
      report.skipped.push({ aoi: aoi.id, rule: ruleName, reason: quotaBlock });
      o.journal.append({ t: now, sweepId, kind: "skip", aoi: aoi.id, rule: ruleName, message: quotaBlock });
      return;
    }
    const call = callFor(rule.name);
    const ctx: RuleContext = { aoi, params, now, since: o.journal.watermark(aoi.id, rule.name), call };
    const key = Journal.findingKey(rule.name, rule.version, aoi.id);
    const actor = `system:${rule.name}@${rule.version}`;
    const existingId = o.journal.findingFor(key);
    const existing = existingId ? o.ledger.get(existingId) : undefined;
    const open = existing && !TERMINAL_STATUSES.includes(existing.status) ? existing : undefined;

    try {
      if (open?.status === "candidate") {
        // An unconfirmed candidate: try the independent signal again.
        const deferred = confirmBlocked();
        if (deferred) log(`· ${rule.name} @ ${aoi.id}: confirmation deferred (${deferred})`);
        const conf = deferred ? null : await rule.confirm(ctx, { observedAt: open.observedAt, evidence: open.evidence, values: valuesOf(open), geometry: open.geometry });
        if (conf) {
          if (!report.dryRun) o.ledger.append({ kind: "confirmed", findingId: open.findingId, actor, signal: conf.signal, independence: conf.independence, at: now });
          report.confirmed.push(open.findingId);
          o.journal.append({ t: now, sweepId, kind: "confirmed", aoi: aoi.id, rule: rule.name, findingId: open.findingId });
          log(`✓ confirmed ${rule.name} @ ${aoi.id} (${conf.independence})`);
          await card(open.findingId, o.ledger, report.dryRun);
        } else log(`· ${rule.name} @ ${aoi.id}: candidate, no independent signal yet`);
        o.journal.setWatermark(aoi.id, rule.name, now);
        return;
      }

      const candidate = await rule.detect(ctx);
      if (!candidate) {
        log(`· ${rule.name} @ ${aoi.id}: quiet`);
        o.journal.setWatermark(aoi.id, rule.name, now);
        return;
      }
      o.journal.append({ t: now, sweepId, kind: "candidate", aoi: aoi.id, rule: rule.name, values: candidate.values });

      const withinCooldown = open && Date.parse(now) - Date.parse(open.updatedAt) < aoi.cooldownDays * 86_400_000;
      if (open && withinCooldown) {
        // Same story continuing: add evidence to the open case, don't open a duplicate.
        const fresh = candidate.evidence.filter((e) => !open.evidence.some((x) => x.id === e.id));
        if (fresh.length && !report.dryRun) o.ledger.append({ kind: "evidence_added", findingId: open.findingId, actor, evidence: fresh, at: now });
        if (fresh.length) {
          report.evidenceAdded.push(open.findingId);
          o.journal.append({ t: now, sweepId, kind: "evidence_added", aoi: aoi.id, rule: rule.name, findingId: open.findingId });
        }
        log(`+ ${rule.name} @ ${aoi.id}: ${fresh.length} new evidence on open case`);
        o.journal.setWatermark(aoi.id, rule.name, now);
        return;
      }

      // New finding: context first (best-effort), then the created event, then a confirmation attempt.
      const context: Context = { notes: [] };
      if (candidate.baseline) context.baseline = candidate.baseline;
      if (enso === undefined) {
        try {
          const e = (await call("enso", { months: 12 })) as { phase: string; latest: { oni: number } };
          enso = { phase: e.phase, oni: e.latest.oni };
        } catch {
          enso = null;
        }
      }
      if (enso) context.enso = enso;
      try {
        const ev = (await call("events", { bbox: ringBBox(aoi.bbox, 100), days: 30, limit: 20 })) as { events: { id: string; title: string; category: string }[] };
        context.events = ev.events.slice(0, 20).map((e) => ({ id: e.id, title: e.title, category: e.category }));
      } catch {
        context.notes!.push("EONET context unavailable at sweep time");
      }
      for (const note of candidate.notes ?? []) context.notes!.push(note.slice(0, 500));
      if (aoi.control) context.notes!.push("CONTROL AOI: expected quiet — this finding counts against the rule's error rate");
      if (context.notes!.length === 0) delete context.notes;

      const findingId = uuidv7();
      const created = {
        kind: "created" as const,
        findingId,
        actor,
        rule: { name: rule.name, version: rule.version, params: { ...rule.defaults, ...params } },
        title: candidate.title,
        summary: candidate.summary,
        tier: rule.tier,
        geometry: candidate.geometry ?? bboxPolygon(aoi.bbox),
        bbox: aoi.bbox,
        // Case tags = the AOI tags + what the rule learned about this candidate (e.g. new-flare, improvement).
        aoi: { id: aoi.id, name: aoi.name, tags: [...(aoi.control ? [...aoi.tags, "control"] : aoi.tags), ...(candidate.tags ?? [])] },
        observedAt: candidate.observedAt,
        evidence: candidate.evidence,
        context,
        blindSpots: rule.blindSpots,
        at: now,
      };
      if (report.dryRun) {
        // A dry run must still fail where the real run would: validate against the contract
        // (with the envelope fields Ledger.append would add).
        eventPayload.parse({ ...created, v: 1, eventId: uuidv7(), prev: null });
      } else {
        o.ledger.append(created);
        o.journal.setFinding(key, findingId);
      }
      report.created.push(findingId);
      o.journal.append({ t: now, sweepId, kind: "created", aoi: aoi.id, rule: rule.name, findingId, control: aoi.control });
      log(`● ${rule.name} @ ${aoi.id}: candidate opened${aoi.control ? " (CONTROL — counts as a false positive)" : ""}`);

      const deferredNew = confirmBlocked();
      if (deferredNew) log(`· ${rule.name} @ ${aoi.id}: confirmation deferred (${deferredNew})`);
      const conf = deferredNew ? null : await rule.confirm(ctx, candidate);
      if (conf) {
        if (!report.dryRun) o.ledger.append({ kind: "confirmed", findingId, actor, signal: conf.signal, independence: conf.independence, at: now });
        report.confirmed.push(findingId);
        o.journal.append({ t: now, sweepId, kind: "confirmed", aoi: aoi.id, rule: rule.name, findingId });
        log(`✓ confirmed ${rule.name} @ ${aoi.id} (${conf.independence})`);
      }
      await card(findingId, o.ledger, report.dryRun);
      o.journal.setWatermark(aoi.id, rule.name, now);
    } catch (err) {
      if (err instanceof QuotaExceeded) {
        // Cap reached mid-pair: a skip, not a gap — watermark untouched, retried on a later day.
        report.skipped.push({ aoi: aoi.id, rule: rule.name, reason: `quota:${err.provider}` });
        o.journal.append({ t: now, sweepId, kind: "skip", aoi: aoi.id, rule: rule.name, message: `quota:${err.provider}` });
        log(`○ ${rule.name} @ ${aoi.id}: quota:${err.provider}`);
        return;
      }
      // A failed pair is a coverage gap: recorded, watermark untouched, sweep continues.
      const message = err instanceof Error ? err.message : String(err);
      report.gaps.push({ aoi: aoi.id, rule: rule.name, message });
      o.journal.append({ t: now, sweepId, kind: "gap", aoi: aoi.id, rule: rule.name, message });
      log(`✗ ${rule.name} @ ${aoi.id}: ${message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  o.journal.append({ t: report.finishedAt, sweepId, kind: "sweep_end", ...summary(report) });
  o.journal.heartbeat(sweepId, report.finishedAt, summary(report));
  return report;
}

function summary(r: SweepReport): Record<string, unknown> {
  return { pairs: r.pairs, created: r.created.length, confirmed: r.confirmed.length, evidenceAdded: r.evidenceAdded.length, expired: r.expired.length, gaps: r.gaps.length, skipped: r.skipped.length, dryRun: r.dryRun, ...(r.budgetExhausted ? { budgetExhausted: r.budgetExhausted } : {}) };
}

function valuesOf(f: Finding): Record<string, number> {
  return Object.assign({}, ...f.evidence.map((e) => e.values ?? {})) as Record<string, number>;
}

/** Best-effort dashboard card for a finding (never blocks the sweep). */
async function card(findingId: string, ledger: Ledger, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const f = ledger.get(findingId);
  if (!f) return;
  await pushFindingCard(f);
}
