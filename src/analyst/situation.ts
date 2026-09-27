// The daily Situation briefing: the level comes from fixed rules (src/watch/situation.ts); the
// narrator writes a short briefing around it from a dossier, the deterministic checks
// (numbers, no persons, known ids) and a second model decide whether it may go out. Any
// failure → the rules-only text. One model briefing per UTC day, inside the analyst's $ budget.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Finding } from "../ledger/schema.js";
import {
  buildDossier,
  dossierHash,
  fallbackBriefing,
  readSituation,
  SITUATION_NOTE,
  writeSituation,
  type Briefing,
  type Dossier,
  type IndicatorInputs,
  type SituationRecord,
} from "../watch/situation.js";
import type { QuotaGovernor } from "../watch/quota.js";
import type { JsonCallResult } from "./anthropic.js";
import { numbersNotIn, personalNames } from "./checks.js";

export const briefingSchema = z.object({
  headline: z.string().min(1).max(90),
  summary: z.string().min(1).max(1200),
  items: z
    .array(z.object({ caseId: z.string().min(1).optional(), indicator: z.string().min(1).optional(), line: z.string().min(1).max(240) }).refine((i) => Boolean(i.caseId) !== Boolean(i.indicator), "each item names exactly one of caseId or indicator"))
    .max(6),
});
export const verdictSchema = z.object({ accept: z.boolean(), reason: z.string().min(1).max(600) });

const str = { type: "string" };
export const BRIEFING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "items"],
  properties: {
    headline: str,
    summary: str,
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["line"], properties: { caseId: str, indicator: str, line: str } } },
  },
};
export const VERDICT_JSON_SCHEMA = { type: "object", additionalProperties: false, required: ["accept", "reason"], properties: { accept: { type: "boolean" }, reason: str } };

export const BRIEFER_SYSTEM = `You write the daily Situation briefing for TerraKeep, an evidence-first public watch of the planet. You are given a dossier as JSON: today's level (quiet, watch or urgent — decided by fixed rules, not by you) with the reasons behind it, counts of case changes since yesterday, newly published cases with their headlines, good-news cases, planet indicators with their latest value and what normal is, and the false alarms our own checks caught.

Write for a general reader in plain language: what, if anything, is urgent on the planet today, and a short summary of our findings.

Rules:
- Return JSON: headline (at most 90 characters), summary (3 to 5 sentences), items (at most 6, each one line, pointing at exactly one caseId or one indicator from the dossier).
- Do not change or argue with the level; explain it. If the level is quiet, say so plainly.
- Every number you write must appear in the dossier (you may round it). Do not compute new numbers (no differences, percentages or totals that are not in the dossier).
- Never name, describe or speculate about individual people. Places, assets and institutions only, as they appear in the dossier.
- No blame, no alarmism, no advice. Good news counts as news.`;

export const CHECKER_SYSTEM = `You are the independent second reviewer of TerraKeep's daily Situation briefing. You get the dossier (JSON facts) and a draft briefing written by a different model. Accept only if every statement and number is supported by the dossier, the level is reported as given (not upgraded or downplayed), no individual person is named or identifiable, and the tone is calm and plain. Return {accept, reason} with a short, specific reason.`;

/** Deterministic checks on a parsed briefing: numbers from the dossier, ids from the dossier, no persons. */
export function checkBriefing(d: Dossier, b: Briefing): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(d);
  const out = [b.headline, b.summary, ...b.items.map((i) => i.line)].join("\n");
  for (const v of numbersNotIn(out, text)) problems.push(`the number ${v} does not appear (even rounded) in the dossier`);
  const caseIds = new Set([...d.reasons.flatMap((r) => r.caseIds), ...d.newPublished.map((c) => c.caseId), ...d.goodNews.map((c) => c.caseId), ...d.falseAlarmsCaught.caseIds]);
  const indicators = new Set([...d.indicators.map((i) => i.indicator), ...d.reasons.flatMap((r) => (r.indicator ? [r.indicator] : []))]);
  for (const i of b.items) {
    if (i.caseId && !caseIds.has(i.caseId)) problems.push(`item cites case ${i.caseId}, which is not in the dossier`);
    if (i.indicator && !indicators.has(i.indicator)) problems.push(`item cites indicator ${i.indicator}, which is not in the dossier`);
  }
  for (const name of personalNames(out, text)) problems.push(`possible personal name "${name}"`);
  const sentences = b.summary.split(/(?<=[.!?])\s+/).filter((s) => s.trim()).length;
  if (sentences < 3 || sentences > 5) problems.push(`summary has ${sentences} sentences, not 3–5`);
  return problems;
}

/** Pure: does the draft parse and pass the deterministic checks? */
export function parseBriefing(d: Dossier, data: unknown): { briefing: Briefing | null; problems: string[] } {
  const p = briefingSchema.safeParse(data);
  if (!p.success) return { briefing: null, problems: p.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`) };
  return { briefing: p.data, problems: checkBriefing(d, p.data) };
}

export type SituationCall = (purpose: "situation_brief" | "situation_review", model: string, system: string, user: string, schema: Record<string, unknown>) => Promise<JsonCallResult>;

export interface SituationOptions {
  findings: readonly Finding[];
  indicators: IndicatorInputs;
  ledgerDir: string;
  narrator: string;
  reviewer: string;
  call: SituationCall;
  quota?: QuotaGovernor;
  /** Compute and call the models, but write nothing. */
  dryRun?: boolean;
  now?: Date;
  log?: (s: string) => void;
}

export interface SituationResult {
  record: SituationRecord;
  skipped: boolean;
  written: boolean;
}

/** Once per UTC day: skip when today's record exists and the dossier is unchanged. */
export async function runSituation(o: SituationOptions): Promise<SituationResult> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const dossier = buildDossier(o.findings, o.indicators, now);
  const hash = dossierHash(dossier);
  const prior = readSituation(o.ledgerDir, dossier.date);
  if (prior && prior.dossierHash === hash) {
    log(`situation ${dossier.date}: ${prior.level}, inputs unchanged — skipped`);
    return { record: prior, skipped: true, written: false };
  }
  const base = { v: 1 as const, date: dossier.date, generatedAt: now.toISOString(), level: dossier.level, reasons: dossier.reasons, dossierHash: hash, dossier, note: SITUATION_NOTE };
  const rules = (problems: string[], verdict: SituationRecord["verdict"], cost: number, briefings: number): SituationRecord => ({ ...base, text: fallbackBriefing(dossier.level, dossier.reasons), source: "rules", models: null, verdict, problems, modelBriefings: briefings, costUsd: cost });

  let rec: SituationRecord;
  const used = prior?.modelBriefings ?? 0;
  if (used >= 1) {
    // The day's one model briefing is spent. Same level → keep its text (its numbers were checked
    // against the earlier dossier, which is kept with it); a new level → the rules-only text.
    if (prior && prior.source === "model" && prior.level === dossier.level) {
      rec = { ...prior, generatedAt: now.toISOString() };
      log(`situation ${dossier.date}: ${dossier.level} unchanged — keeping today's briefing (1 per day)`);
    } else {
      rec = rules(["daily briefing already written; the level changed since, so the rules-only text is shown"], null, prior?.costUsd ?? 0, used);
      log(`situation ${dossier.date}: level now ${dossier.level} — rules-only text (1 model briefing per day)`);
    }
  } else if (o.quota?.analystBudgetSpent()) {
    rec = rules(["daily analyst budget spent"], null, 0, 0);
    log(`situation ${dossier.date}: ${dossier.level} — budget spent, rules-only text`);
  } else {
    let cost = 0;
    const facts = JSON.stringify(dossier, null, 2);
    try {
      const draft = await o.call("situation_brief", o.narrator, BRIEFER_SYSTEM, `Dossier:\n${facts}`, BRIEFING_JSON_SCHEMA);
      cost += draft.costUsd ?? 0;
      const { briefing, problems } = parseBriefing(dossier, draft.data);
      if (!briefing || problems.length) {
        rec = { ...rules(problems, null, cost, 1), draft: briefing ?? null };
        log(`situation: draft failed the checks → rules-only: ${problems.join(" | ")}`);
      } else {
        const rv = await o.call("situation_review", o.reviewer, CHECKER_SYSTEM, `Dossier:\n${facts}\n\nDraft briefing (by ${draft.model}):\n${JSON.stringify(briefing, null, 2)}`, VERDICT_JSON_SCHEMA);
        cost += rv.costUsd ?? 0;
        const v = verdictSchema.safeParse(rv.data);
        if (!v.success) rec = rules([`review JSON invalid: ${v.error.issues.map((i) => i.message).join("; ")}`], null, cost, 1);
        else if (!v.data.accept) rec = { ...rules([], v.data, cost, 1), models: { narrator: draft.model, reviewer: rv.model }, draft: briefing };
        else rec = { ...base, text: briefing, source: "model", models: { narrator: draft.model, reviewer: rv.model }, verdict: v.data, problems: [], modelBriefings: 1, costUsd: cost };
        log(`situation: reviewer ${v.success ? (v.data.accept ? "accepted" : `rejected — ${v.data.reason}`) : "returned invalid JSON"}`);
      }
    } catch (err) {
      rec = rules([`model call failed: ${err instanceof Error ? err.message : String(err)}`], null, cost, 1);
      log(`situation: ${rec.problems[0]} → rules-only`);
    }
  }
  if (!o.dryRun) writeSituation(o.ledgerDir, rec);
  else log(`situation (dry run — not written):\n${JSON.stringify({ level: rec.level, reasons: rec.reasons, text: rec.text, source: rec.source, verdict: rec.verdict, problems: rec.problems, draft: rec.draft, costUsd: rec.costUsd }, null, 2)}`);
  log(`situation ${dossier.date}: ${rec.level} (${rec.source}) — ${rec.text.headline}`);
  return { record: rec, skipped: false, written: !o.dryRun };
}

/** Best-effort indicator inputs: ONI + both poles' sea ice live, world pulse live with the cache as fallback. */
export async function fetchIndicatorInputs(pulseCache: string | null, timeoutMs = 45_000, log: (s: string) => void = () => {}): Promise<IndicatorInputs> {
  const guard = <T>(p: Promise<T>, what: string): Promise<T | null> => {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<null>((res) => (timer = setTimeout(() => (log(`  situation: ${what} timed out`), res(null)), timeoutMs)));
    return Promise.race([p.catch((e: Error) => (log(`  situation: ${what} unavailable (${e.message})`), null)), t]).finally(() => clearTimeout(timer));
  };
  const ind = await import("../clients/indicators.js");
  const pole = async (p: "north" | "south") => ({ pole: p, daily: await ind.fetchSeaIce(p), clim: await ind.fetchSeaIceClimatology(p) });
  const { worldPulse } = await import("../tools/worldpulse.js");
  const [oni, north, south, pulse] = await Promise.all([guard(ind.fetchOni(), "ONI"), guard(pole("north"), "Arctic sea ice"), guard(pole("south"), "Antarctic sea ice"), guard(worldPulse(), "world pulse")]);
  let rows = pulse && pulse.rows.some((r) => r.status === "ok") ? pulse.rows : null;
  if (!rows && pulseCache && existsSync(pulseCache)) {
    try {
      rows = (JSON.parse(readFileSync(pulseCache, "utf8")) as { rows?: typeof rows }).rows ?? null;
    } catch {
      rows = null;
    }
  }
  return { oni, seaIce: [north, south].filter((x): x is NonNullable<typeof x> => x !== null), pulse: rows };
}
