// The reply wall's only moderator: the same reviewer model that reviews cases. Runs inside
// the analyst job over a local mirror of the state bucket's `replies/` prefix
//
//   <dir>/inbox/<caseId>/<id>.json     waiting (written by the intake Lambda)
//   <dir>/public/<caseId>/<id>.json    accepted → shown under the case {id, caseId, text, role, receivedAt}
//   <dir>/rejected/<caseId>/<id>.json  rejected, with the verdict (never shown)
//
// Accepted = the model says accept AND raises no flag. Every accepted reply also gets a
// signed `commented` ledger event (text hash only). The runner syncs the moves back to S3.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventInput } from "../ledger/store.js";
import { PUBLIC_STATUSES, type Finding } from "../ledger/schema.js";
import type { QuotaGovernor } from "../watch/quota.js";
import type { JsonCallResult } from "../analyst/anthropic.js";
import { CASE_ID, REPLY_ID, ROLES, TEXT_MAX, type InboxReply, type Role } from "./intake.js";

export const FLAGS = ["spam", "abuse", "pii", "off_topic", "names_person", "legal_threat"] as const;
export type Flag = (typeof FLAGS)[number];
export interface ReplyVerdict {
  accept: boolean;
  reason: string;
  flags: Flag[];
}
export interface PublicReply {
  id: string;
  caseId: string;
  text: string;
  role: Role;
  receivedAt: string;
}

/** At most this many replies reviewed per analyst run (≈ $0.005 each with Sonnet at low effort). */
export const MAX_REPLIES_PER_RUN = 50;

export const REPLY_REVIEWER_SYSTEM = `You screen anonymous public replies left under one case on Earth Watch, a public, evidence-first record of environmental change seen from satellites. Nobody else reads them before they appear: your verdict decides.

Accept a reply only if it is a good-faith contribution about this case or this place: what the writer sees on the ground, context, a correction, a disagreement, a question. Disagreement and criticism of the case are welcome.

Reject, and set the matching flags, if the reply:
- spam: advertising, promotion, repeated or meaningless text;
- abuse: insults, harassment, hate, threats of violence;
- pii: contact details or anything that identifies a private person (addresses, plates, ids);
- off_topic: has nothing to do with this case or place;
- names_person: names or points at an individual natural person (companies, agencies and places are fine);
- legal_threat: threatens legal action or makes defamatory accusations of crimes against someone.

accept must be false whenever any flag is set. reason: one short sentence.`;

export const REPLY_VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["accept", "reason", "flags"],
  properties: {
    accept: { type: "boolean" },
    reason: { type: "string" },
    flags: { type: "array", items: { type: "string", enum: [...FLAGS] } },
  },
} as const;

/** Strict: exactly {accept: boolean, reason: non-empty string, flags: known flags}; else null. Any flag forces accept = false. */
export function parseVerdict(data: unknown): ReplyVerdict | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "accept,flags,reason") return null;
  if (typeof o.accept !== "boolean" || typeof o.reason !== "string" || !o.reason.trim() || !Array.isArray(o.flags)) return null;
  if (!o.flags.every((f) => typeof f === "string" && (FLAGS as readonly string[]).includes(f))) return null;
  const flags = [...new Set(o.flags as Flag[])];
  return { accept: o.accept && flags.length === 0, reason: o.reason.trim().slice(0, 500), flags };
}

/** An inbox file's content, or null if it is not a well-formed reply for this case. */
export function parseInbox(raw: string, caseId: string): InboxReply | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.caseId !== caseId || typeof o.text !== "string" || !o.text.trim() || o.text.length > TEXT_MAX) return null;
    if (typeof o.role !== "string" || !(ROLES as readonly string[]).includes(o.role)) return null;
    if (typeof o.receivedAt !== "string" || Number.isNaN(Date.parse(o.receivedAt))) return null;
    return { caseId, text: o.text, role: o.role as Role, receivedAt: o.receivedAt, ipHash: typeof o.ipHash === "string" ? o.ipHash : "" };
  } catch {
    return null;
  }
}

/** Inbox entries oldest first (ULIDs sort by time). */
export function listInbox(dir: string): { caseId: string; id: string; path: string }[] {
  const inbox = join(dir, "inbox");
  if (!existsSync(inbox)) return [];
  const out: { caseId: string; id: string; path: string }[] = [];
  for (const caseId of readdirSync(inbox)) {
    if (!CASE_ID.test(caseId)) continue;
    for (const f of readdirSync(join(inbox, caseId))) {
      const id = f.replace(/\.json$/, "");
      if (f.endsWith(".json") && REPLY_ID.test(id)) out.push({ caseId, id, path: join(inbox, caseId, f) });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Public replies of one case, oldest first. */
export function readPublicReplies(dir: string, caseId: string): PublicReply[] {
  const d = join(dir, "public", caseId);
  if (!CASE_ID.test(caseId) || !existsSync(d)) return [];
  const out: PublicReply[] = [];
  for (const f of readdirSync(d).sort()) {
    const id = f.replace(/\.json$/, "");
    if (!f.endsWith(".json") || !REPLY_ID.test(id)) continue;
    try {
      const o = JSON.parse(readFileSync(join(d, f), "utf8")) as Record<string, unknown>;
      if (typeof o.text !== "string" || typeof o.receivedAt !== "string" || typeof o.role !== "string" || !(ROLES as readonly string[]).includes(o.role)) continue;
      out.push({ id, caseId, text: o.text.slice(0, TEXT_MAX), role: o.role as Role, receivedAt: o.receivedAt });
    } catch {
      /* unreadable → not shown */
    }
  }
  return out;
}

export interface ReviewRepliesOptions {
  dir: string;
  ledger: { get(id: string): Finding | null | undefined; append(ev: EventInput): unknown };
  reviewer: string;
  /** One reviewer call (the analyst wires callJson + spend accounting). */
  call(system: string, user: string, schema: Record<string, unknown>): Promise<JsonCallResult>;
  quota?: QuotaGovernor;
  max?: number;
  log?: (s: string) => void;
  journal?: (kind: string, rec: Record<string, unknown>) => void;
}

export interface ReviewRepliesReport {
  accepted: string[];
  rejected: string[];
  errors: { id: string; message: string }[];
  left: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function move(dir: string, from: string, bucket: "public" | "rejected", caseId: string, id: string, body: unknown): void {
  const d = join(dir, bucket, caseId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${id}.json`), JSON.stringify(body));
  rmSync(from, { force: true });
}

export async function reviewReplies(o: ReviewRepliesOptions): Promise<ReviewRepliesReport> {
  const log = o.log ?? (() => {});
  const j = o.journal ?? (() => {});
  const report: ReviewRepliesReport = { accepted: [], rejected: [], errors: [], left: 0 };
  const inbox = listInbox(o.dir);
  const max = Math.min(o.max ?? MAX_REPLIES_PER_RUN, MAX_REPLIES_PER_RUN);
  let done = 0;
  for (const item of inbox) {
    if (done >= max) break;
    if (o.quota?.analystBudgetSpent()) {
      log(`  replies: daily analyst budget spent — ${inbox.length - done} left for tomorrow`);
      break;
    }
    done++;
    const reject = (verdict: ReplyVerdict, reply: unknown, by: string | null) => {
      move(o.dir, item.path, "rejected", item.caseId, item.id, { id: item.id, reply, verdict, reviewedBy: by, reviewedAt: new Date().toISOString() });
      report.rejected.push(item.id);
      j("reply_rejected", { caseId: item.caseId, replyId: item.id, reason: verdict.reason, flags: verdict.flags, by });
      log(`  ✗ reply ${item.id} on ${item.caseId}: ${verdict.reason}${verdict.flags.length ? ` [${verdict.flags.join(", ")}]` : ""}`);
    };
    const reply = parseInbox(readFileSync(item.path, "utf8"), item.caseId);
    if (!reply) {
      reject({ accept: false, reason: "malformed inbox entry", flags: [] }, null, null);
      continue;
    }
    const f = o.ledger.get(item.caseId);
    if (!f || !PUBLIC_STATUSES.includes(f.status) || f.status === "retracted") {
      reject({ accept: false, reason: `case is not open for replies (${f ? f.status : "not in the ledger"})`, flags: [] }, reply, null);
      continue;
    }
    try {
      const caseText = f.narration?.text ?? `${f.title}\n\n${f.summary}`;
      const user = `The case (${f.aoi?.name ?? f.aoi?.id ?? "unnamed place"}):\n${caseText}\n\nThe reply (writer says they are: ${reply.role}):\n"""\n${reply.text}\n"""`;
      const res = await o.call(REPLY_REVIEWER_SYSTEM, user, REPLY_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>);
      const verdict = parseVerdict(res.data);
      const by = `model:${res.model}`;
      if (!verdict) {
        reject({ accept: false, reason: "reviewer returned no valid verdict", flags: [] }, reply, by);
        continue;
      }
      if (!verdict.accept) {
        reject(verdict, reply, by);
        continue;
      }
      o.ledger.append({
        kind: "commented",
        findingId: item.caseId,
        actor: by,
        reply: { id: item.id, role: reply.role, receivedAt: reply.receivedAt, textSha256: sha256(reply.text) },
        verdict: { accept: true, reason: verdict.reason, flags: [] },
      });
      const pub: PublicReply = { id: item.id, caseId: item.caseId, text: reply.text, role: reply.role, receivedAt: reply.receivedAt };
      move(o.dir, item.path, "public", item.caseId, item.id, pub);
      report.accepted.push(item.id);
      j("reply_accepted", { caseId: item.caseId, replyId: item.id, reason: verdict.reason, by });
      log(`  ✓ reply ${item.id} on ${item.caseId} accepted (${reply.role})`);
    } catch (err) {
      // Left in the inbox: retried next run.
      const message = err instanceof Error ? err.message : String(err);
      report.errors.push({ id: item.id, message });
      j("reply_error", { caseId: item.caseId, replyId: item.id, message });
      log(`  ! reply ${item.id}: ${message}`);
    }
  }
  report.left = listInbox(o.dir).length;
  return report;
}
