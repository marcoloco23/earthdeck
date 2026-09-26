// The analyst: autonomous narrate → review → publish over confirmed findings. The models
// are journaled steps; the deterministic layer (checks.ts + the ledger's trust contract)
// decides what counts. Narrator and reviewer are different models by construction.
//
//   confirmed, no narration ──► narrate (Opus) ──faithfulness──► `narrated`
//   narrated, no model review ─► review (Sonnet) ──forced rules──► `reviewed`
//        publish + gates pass ──► status_changed confirmed → published (with gates)
//        hold                 ──► stays confirmed (a human looks)
//        reject               ──► status_changed confirmed → false_positive

import { pushFindingCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import * as schema from "../ledger/schema.js";
import type { Finding } from "../ledger/schema.js";
import type { EventInput, Ledger } from "../ledger/store.js";
import { uuidv7 } from "../util.js";
import type { Journal } from "../watch/journal.js";
import type { QuotaGovernor } from "../watch/quota.js";
import { callJson, type JsonCallResult } from "./anthropic.js";
import {
  canPublish,
  dossier,
  faithfulness,
  isControl,
  NARRATION_JSON_SCHEMA,
  narrationSchema,
  REVIEW_JSON_SCHEMA,
  reviewSchema,
  type Narration,
  type Review,
} from "./checks.js";

/** Most capable Opus narrates; a different model family reviews (claude-api skill defaults). */
export const DEFAULT_NARRATOR = "claude-opus-5";
export const DEFAULT_REVIEWER = "claude-sonnet-5";

export type AnalystLedger = Pick<Ledger, "list" | "get" | "append">;
type Verdict = Review["verdict"];

export interface AnalystOptions {
  ledger: AnalystLedger;
  journal: Journal;
  apiKey: string | null | undefined;
  narrator?: string;
  reviewer?: string;
  max?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Daily case count + USD spend cap (quota.json). Omitted = no daily limits. */
  quota?: QuotaGovernor;
}

export interface AnalystReport {
  runId: string;
  dryRun: boolean;
  selected: number;
  narrated: string[];
  published: string[];
  held: string[];
  rejected: string[];
  errors: { findingId: string; message: string }[];
  calls: number;
  costUsd: number;
}

const NARRATOR_SYSTEM = `You write the public narration of one environmental finding for Earth Watch, an evidence-first public ledger. You are given the finding as JSON: its rule, evidence (with numeric values), the independent confirming signal, context (regional baseline ring, ENSO phase, nearby natural events), the rule's blind spots and the AOI tags.

Write for a general reader in plain language. The narrative covers three things: what was seen (with the numbers), what it is not or might not be (drawing on the blind spots and context — e.g. drought or fire rather than clearing), and what evidence would change our mind.

Rules:
- Every number you write must come from the finding. Each keyNumbers entry must copy its value exactly as it appears in the cited evidence's "values" or "summary" (same digits, same sign), and cite that evidence's id (the confirmation signal's id is allowed).
- Never name, describe or speculate about individual people. Assets, places and institutions only, and only as they appear in the finding.
- Do not assign blame or intent. The finding records a change on the ground, not who caused it.
- If the AOI is tagged "control" (expected quiet), say that this finding counts against the rule's error rate.
- headline: at most 120 characters. narrative: at most 1200 characters. caveats: short, concrete.`;

const REVIEWER_SYSTEM = `You are the independent second reviewer for Earth Watch, an evidence-first public ledger. You get one finding (JSON: evidence with values, the confirming signal, context, blind spots, AOI tags) and a narration written by a different model. Decide whether the narration may be published as-is.

- checks.evidenceSupportsClaims: every claim and number in the narration is supported by the finding's evidence.
- checks.blindSpotsAcknowledged: the narration is honest about what the rule cannot see and about innocent explanations.
- checks.noIndividualsNamed: no natural person is named or identifiable.
- checks.controlAoi: the AOI is tagged "control".

verdict: "publish" only if all of the above hold and the finding is fit for the public record; "hold" if a human should look (unclear, overclaiming, fixable); "reject" if the finding itself looks like a false positive or the AOI is a control. Give short, specific reasons.`;

export function select(ledger: AnalystLedger, max: number): { finding: Finding; needs: "narrate" | "review" }[] {
  const out: { finding: Finding; needs: "narrate" | "review" }[] = [];
  const confirmed = ledger.list({ status: ["confirmed"] }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const f of confirmed) {
    if (!f.narration) out.push({ finding: f, needs: "narrate" });
    else if (!f.reviews.some((r) => r.actor.startsWith("model:") && r.at >= f.narration!.at)) out.push({ finding: f, needs: "review" });
    if (out.length >= max) break;
  }
  return out;
}

export async function runAnalyst(o: AnalystOptions): Promise<AnalystReport> {
  const narrator = o.narrator ?? DEFAULT_NARRATOR;
  const reviewer = o.reviewer ?? DEFAULT_REVIEWER;
  const log = o.log ?? (() => {});
  if (!o.apiKey) throw new OverviewError("ANTHROPIC_API_KEY is not set — the analyst needs it to narrate and review (nothing was changed)");
  if (narrator === reviewer) throw new OverviewError(`narrator and reviewer must be different models (both are ${narrator})`);
  const apiKey = o.apiKey;
  const dryRun = Boolean(o.dryRun);
  const runId = uuidv7();
  const report: AnalystReport = { runId, dryRun, selected: 0, narrated: [], published: [], held: [], rejected: [], errors: [], calls: 0, costUsd: 0 };
  const j = (kind: string, rec: Record<string, unknown> = {}) => o.journal.append({ t: new Date().toISOString(), sweepId: runId, kind: `analyst_${kind}`, ...rec });

  const q = o.quota;
  const limit = Math.min(o.max ?? 5, q ? q.analystCasesLeft() : Infinity);
  const work = limit > 0 ? select(o.ledger, limit) : [];
  report.selected = work.length;
  if (q && q.analystCasesLeft() === 0) log(`daily analyst case cap reached (${q.caps.analystCases}) — nothing to do until tomorrow (UTC)`);
  j("start", { narrator, reviewer, dryRun, selected: work.length });

  const call = async (purpose: "narrate" | "review", findingId: string, attempt: number, model: string, system: string, user: string, jsonSchema: Record<string, unknown>): Promise<JsonCallResult> => {
    try {
      const r = await callJson({ apiKey, model, system, user, schema: jsonSchema });
      report.calls++;
      report.costUsd += r.costUsd ?? 0;
      j("call", { findingId, purpose, attempt, model: r.model, usage: r.usage, costUsd: r.costUsd, ms: r.ms, requestSha256: r.requestSha256, responseSha256: r.responseSha256 });
      if (q) j("spend", { day: q.day, callUsd: r.costUsd, dayUsd: q.addAnalystUsd(r.costUsd ?? 0), limitUsd: q.caps.analystUsd });
      log(`    ↳ ${purpose}#${attempt} ${r.model} · ${r.usage.input_tokens} in / ${r.usage.output_tokens} out · ${r.costUsd == null ? "cost n/a" : `$${r.costUsd.toFixed(4)}`} · ${(r.ms / 1000).toFixed(1)}s`);
      return r;
    } catch (err) {
      report.calls++;
      j("call", { findingId, purpose, attempt, model, message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  for (const { finding: f, needs } of work) {
    if (q?.analystBudgetSpent()) {
      log(`daily analyst budget spent ($${q.analystUsd().toFixed(4)} ≥ $${q.caps.analystUsd}) — stopping until tomorrow (UTC)`);
      j("budget_stop", { day: q.day, dayUsd: q.analystUsd(), limitUsd: q.caps.analystUsd });
      break;
    }
    q?.chargeAnalystCase();
    log(`• ${f.title} [${f.findingId}] tier ${f.tier}${isControl(f) ? " CONTROL" : ""} — ${needs}`);
    const facts = JSON.stringify(dossier(f), null, 2);
    try {
      let narrationText: string;
      let narratorActor: string;
      if (needs === "narrate") {
        const prompt = `Finding:\n${facts}`;
        let res = await call("narrate", f.findingId, 1, narrator, NARRATOR_SYSTEM, prompt, NARRATION_JSON_SCHEMA);
        let checked = checkNarration(f, res.data);
        if (checked.problems.length && dryRun) {
          log(`    ✗ narration fails checks (dry run: no retry): ${checked.problems.join(" | ")}`);
          j("narration_rejected", { findingId: f.findingId, attempt: 1, problems: checked.problems, dryRun });
          continue;
        }
        if (checked.problems.length) {
          j("narration_rejected", { findingId: f.findingId, attempt: 1, problems: checked.problems });
          log(`    ✗ narration rejected, retrying once: ${checked.problems.join(" | ")}`);
          const retry = `${prompt}\n\nYour previous answer was rejected by the deterministic checks:\n${checked.problems.map((p) => `- ${p}`).join("\n")}\n\nPrevious answer:\n${res.text}\n\nReturn a corrected answer that fixes every violation.`;
          res = await call("narrate", f.findingId, 2, narrator, NARRATOR_SYSTEM, retry, NARRATION_JSON_SCHEMA);
          checked = checkNarration(f, res.data);
          if (checked.problems.length) {
            j("narration_rejected", { findingId: f.findingId, attempt: 2, problems: checked.problems });
            throw new OverviewError(`narration rejected after retry: ${checked.problems.join(" | ")}`);
          }
        }
        const n = checked.narration!;
        narrationText = narrationToText(n);
        narratorActor = `model:${res.model}`;
        if (dryRun) {
          log(`    ✓ narration passes checks (dry run — not appended, not reviewed):`);
          for (const line of narrationText.split("\n")) log(`      ${line}`);
          log(`    would append narrated (${narratorActor}), then review with ${reviewer}`);
          continue;
        }
        append(o.ledger, {
          kind: "narrated",
          findingId: f.findingId,
          actor: narratorActor,
          text: narrationText,
          model: { id: res.model, provider: "anthropic" },
          promptSha256: res.requestSha256,
          transcriptSha256: res.responseSha256,
          evidenceRefs: [...new Set(n.keyNumbers.map((k) => k.evidenceId))],
        });
        report.narrated.push(f.findingId);
        j("append", { findingId: f.findingId, event: "narrated", actor: narratorActor });
        log(`    ✓ narrated: ${n.headline}`);
      } else {
        narrationText = f.narration!.text;
        narratorActor = f.narration!.actor;
        if (dryRun) {
          log(`    would review the existing narration (${narratorActor}) with ${reviewer}`);
          continue;
        }
      }

      if (narratorActor === `model:${reviewer}`) throw new OverviewError(`narration is by ${reviewer}; pick a different --model-reviewer`);
      const res = await call("review", f.findingId, 1, reviewer, REVIEWER_SYSTEM, `Finding:\n${facts}\n\nNarration to review (by ${narratorActor}):\n${narrationText}`, REVIEW_JSON_SCHEMA);
      const parsed = reviewSchema.safeParse(res.data);
      if (!parsed.success) throw new OverviewError(`review JSON invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const { verdict, reasons } = enforce(f, parsed.data);
      const outcome = record(o.ledger, f.findingId, `model:${res.model}`, verdict, reasons);
      j("append", { findingId: f.findingId, event: "reviewed", actor: `model:${res.model}`, verdict, reasons, outcome: outcome.status, gate: outcome.gate });
      if (outcome.status === "published") report.published.push(f.findingId);
      else if (outcome.status === "false_positive") report.rejected.push(f.findingId);
      else report.held.push(f.findingId);
      log(`    ${outcome.status === "published" ? "✓ published" : outcome.status === "false_positive" ? "✗ rejected → false_positive" : "○ held (stays confirmed)"} — ${outcome.gate ?? reasons.join("; ")}`);
      const now = o.ledger.get(f.findingId);
      if (now) await pushFindingCard(now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push({ findingId: f.findingId, message });
      j("error", { findingId: f.findingId, message });
      log(`    ✗ ${message}`);
    }
  }
  j("end", { published: report.published.length, held: report.held.length, rejected: report.rejected.length, narrated: report.narrated.length, errors: report.errors.length, calls: report.calls, costUsd: report.costUsd });
  return report;
}

function checkNarration(f: Finding, data: unknown): { narration: Narration | null; problems: string[] } {
  const p = narrationSchema.safeParse(data);
  if (!p.success) return { narration: null, problems: p.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`) };
  return { narration: p.data, problems: faithfulness(f, p.data) };
}

/** The deterministic layer overrides the reviewer where the policy is unambiguous. */
export function enforce(f: Finding, r: Review): { verdict: Verdict; reasons: string[] } {
  const reasons = [...r.reasons];
  if (isControl(f) || r.checks.controlAoi) {
    if (r.verdict !== "reject") reasons.push("forced reject: control AOI (expected quiet) — counts against the rule's error rate");
    return { verdict: "reject", reasons };
  }
  if (!r.checks.noIndividualsNamed) {
    if (r.verdict !== "hold") reasons.push("forced hold: reviewer flagged an identifiable individual");
    return { verdict: "hold", reasons };
  }
  if (r.verdict === "publish" && (!r.checks.evidenceSupportsClaims || !r.checks.blindSpotsAcknowledged)) {
    reasons.push("forced hold: verdict publish contradicts the reviewer's own checks");
    return { verdict: "hold", reasons };
  }
  return { verdict: r.verdict, reasons };
}

export function narrationToText(n: Narration): string {
  return [
    n.headline,
    "",
    n.narrative,
    "",
    "Key numbers:",
    ...n.keyNumbers.map((k) => `- ${k.label}: ${k.value} [${k.evidenceId}]`),
    "",
    `Confidence: ${n.confidence}`,
    ...(n.caveats.length ? ["Caveats:", ...n.caveats.map((c) => `- ${c}`)] : []),
  ].join("\n");
}

/**
 * Every ledger write the analyst makes. Events are shaped for the incoming publish policy
 * (`reviewed.verdict`, model reviewers, `status_changed.gates`); the cast is the only
 * bridge to the current `EventInput` type — drop it (and use schema.publishGates instead
 * of canPublish) once the sibling schema change lands.
 */
function append(ledger: AnalystLedger, ev: Record<string, unknown>): void {
  ledger.append(ev as unknown as EventInput);
}

function record(ledger: AnalystLedger, findingId: string, actor: string, verdict: Verdict, reasons: string[]): { status: "published" | "confirmed" | "false_positive"; gate?: string } {
  const f = ledger.get(findingId)!;
  append(ledger, { kind: "reviewed", findingId, actor, tier: f.tier, verdict, decision: verdict === "publish" ? "approve" : "reject", note: reasons.join("; ").slice(0, 2000) });
  if (verdict === "reject") {
    append(ledger, { kind: "status_changed", findingId, actor, from: "confirmed", to: "false_positive", reason: `analyst review: ${reasons.join("; ")}`.slice(0, 2000) });
    return { status: "false_positive" };
  }
  if (verdict === "hold") return { status: "confirmed" };
  // The contract itself decides (schema.publishGates); canPublish stays as the offline mirror for tests.
  const gate = schema.publishGates(ledger.get(findingId)!);
  if (!gate.ok || !gate.gates) return { status: "confirmed", gate: `publish gate: ${gate.missing.join("; ") || "not publishable"}` };
  append(ledger, {
    kind: "status_changed",
    findingId,
    actor,
    from: "confirmed",
    to: "published",
    gates: gate.gates,
    reason: `autonomous publish: narrated by ${gate.gates.narratedBy}, reviewed by ${gate.gates.reviewedBy.join(", ")} (policy ${gate.gates.policy})`,
  });
  return { status: "published" };
}
