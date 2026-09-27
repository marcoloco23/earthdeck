// The public reply wall's intake, AWS-free: `POST /reply` with `{caseId, text, role?}` from
// the site. Nobody reads an inbox — a reply is only stored here, and the analyst's reviewer
// model decides (src/replies/review.ts) whether it appears under the case.
//
// Rules (each one tested in test/replies.test.ts):
//   - JSON body ≤ 8 KB; `website` is a honeypot and must be empty (bots get a fake 202);
//   - text: HTML stripped, 20–2000 chars, no email / @handle, no phone number, no URL;
//   - role ∈ ROLES (default "other"); no name / email / URL fields exist at all;
//   - caseId must be in the public case index (state bucket `replies/cases.json`);
//   - at most DAILY_CAP replies per IP per UTC day, counted under a salted SHA-256 of the
//     IP — the raw IP is never stored, logged or returned.
// Stored as `replies/inbox/<caseId>/<ulid>.json` = {caseId, text, role, receivedAt, ipHash}.

import { createHash, randomBytes } from "node:crypto";

export const ROLES = ["resident", "operator", "company", "official", "researcher", "other"] as const;
export type Role = (typeof ROLES)[number];
export const TEXT_MIN = 20;
export const TEXT_MAX = 2000;
export const DAILY_CAP = 5;
export const MAX_BODY = 8 * 1024;
export const INBOX_PREFIX = "replies/inbox/";
export const PUBLIC_PREFIX = "replies/public/";
export const REJECTED_PREFIX = "replies/rejected/";
export const RATE_PREFIX = "replies/rate/";
export const CASE_INDEX_KEY = "replies/cases.json";
export const CASE_ID = /^[A-Za-z0-9-]{1,64}$/;
export const REPLY_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface InboxReply {
  caseId: string;
  text: string;
  role: Role;
  receivedAt: string;
  ipHash: string;
}

// ── ids + hashing ────────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms time + 80 random bits, Crockford base32 (sortable by arrival). */
export function ulid(now = Date.now(), rand: Buffer = randomBytes(10)): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of rand) bits = (bits << 8n) | BigInt(b);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[Number(bits & 31n)]! + r;
    bits >>= 5n;
  }
  return time + r;
}

/** Salted SHA-256 of an IP — the only form an IP ever takes after the request. */
export function ipHash(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}\n${ip.trim().toLowerCase()}`).digest("hex");
}

// ── text rules ──────────────────────────────────────────────────────────────────────────

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g;

/** Tags out, common entities decoded, whitespace tidied (newlines kept, max one blank line). */
export function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, e: string) => ({ nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!)
    .replace(/[<>]/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EMAIL = /[\w.+-]+\s*(@|\(at\)|\[at\])\s*[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i;
const HANDLE = /(^|[^\w])@[A-Za-z0-9_]{2,}/;
const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co|info|biz|ru|cn|xyz|top|me|ly|gl|gd|app|dev|link|site|online|shop|to|tk|click|live)\b/i;
const DATE_LIKE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/;

/** A phone number: a run of ≥ 9 digits allowing spaces/dots/dashes/brackets (dates excluded). */
export function hasPhone(text: string): boolean {
  for (const m of text.matchAll(/\+?\d[\d ().-]{6,}\d/g)) {
    const run = m[0].trim();
    if (DATE_LIKE.test(run)) continue;
    if ((run.match(/\d/g) ?? []).length >= 9) return true;
  }
  return false;
}

export type Rejection = "method" | "path" | "too_large" | "bad_json" | "bad_case" | "bad_role" | "too_short" | "too_long" | "contact_info" | "phone" | "link" | "unknown_case" | "rate_limited" | "unavailable";

export const MESSAGES: Record<Rejection, string> = {
  method: "Use POST.",
  path: "Not found.",
  too_large: "That reply is too long.",
  bad_json: "The reply could not be read.",
  bad_case: "Unknown case.",
  bad_role: "Pick one of the listed roles.",
  too_short: `Please write at least ${TEXT_MIN} characters.`,
  too_long: `Please keep it under ${TEXT_MAX} characters.`,
  contact_info: "Please leave out email addresses and @handles — replies are anonymous.",
  phone: "Please leave out phone numbers — replies are anonymous.",
  link: "Please leave out links — describe what you see instead.",
  unknown_case: "Replies are open on published cases only.",
  rate_limited: `That is ${DAILY_CAP} replies from here today — please come back tomorrow.`,
  unavailable: "Replies are closed for a moment. Please try again later.",
};

export type Checked = { ok: true; caseId: string; text: string; role: Role; honeypot: boolean } | { ok: false; reason: Rejection };

/** Everything that needs no storage: shape, honeypot, text rules. */
export function checkBody(raw: string): Checked {
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY) return { ok: false, reason: "too_large" };
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, reason: "bad_json" };
  const o = b as Record<string, unknown>;
  const honeypot = o.website !== undefined && o.website !== "" && o.website !== null;
  if (typeof o.caseId !== "string" || !CASE_ID.test(o.caseId)) return { ok: false, reason: "bad_case" };
  const role = o.role === undefined || o.role === null || o.role === "" ? "other" : o.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) return { ok: false, reason: "bad_role" };
  if (typeof o.text !== "string") return { ok: false, reason: "too_short" };
  const text = stripHtml(o.text);
  if (text.length < TEXT_MIN) return { ok: false, reason: "too_short" };
  if (text.length > TEXT_MAX) return { ok: false, reason: "too_long" };
  if (EMAIL.test(text) || HANDLE.test(text)) return { ok: false, reason: "contact_info" };
  if (URL_RE.test(text)) return { ok: false, reason: "link" };
  if (hasPhone(text)) return { ok: false, reason: "phone" };
  return { ok: true, caseId: o.caseId, text, role: role as Role, honeypot };
}

// ── the request ─────────────────────────────────────────────────────────────────────────

export interface IntakeStore {
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer): Promise<void>;
}

export interface IntakeDeps {
  store: IntakeStore;
  /** SSM /earthdeck/REPLY_SALT; null/empty = intake closed (503). */
  salt(): Promise<string | null>;
  /** Public case ids (from CASE_INDEX_KEY), cached by the caller. */
  caseIds(): Promise<Set<string>>;
  now(): Date;
  id?(): string;
}

export interface IntakeRequest {
  method: string;
  path: string;
  body: string;
  ip: string;
}

export interface IntakeResponse {
  status: number;
  body: { id?: string; error?: Rejection; message?: string };
}

const fail = (status: number, reason: Rejection): IntakeResponse => ({ status, body: { error: reason, message: MESSAGES[reason] } });

export async function handleReply(req: IntakeRequest, deps: IntakeDeps): Promise<IntakeResponse> {
  if (req.path.replace(/\/+$/, "") !== "/reply") return fail(404, "path");
  if (req.method !== "POST") return fail(405, "method");
  const c = checkBody(req.body);
  if (!c.ok) return fail(c.reason === "too_large" ? 413 : 400, c.reason);
  const now = deps.now();
  const id = deps.id ? deps.id() : ulid(now.getTime());
  if (c.honeypot) return { status: 202, body: { id } }; // looks accepted; nothing is stored

  const salt = await deps.salt();
  if (!salt) return fail(503, "unavailable");
  let ids: Set<string>;
  try {
    ids = await deps.caseIds();
  } catch {
    return fail(503, "unavailable");
  }
  if (!ids.has(c.caseId)) return fail(404, "unknown_case");

  const hash = ipHash(req.ip, salt);
  const rateKey = `${RATE_PREFIX}${now.toISOString().slice(0, 10)}/${hash}.json`;
  const prev = await deps.store.get(rateKey);
  let count = 0;
  if (prev) {
    try {
      count = Number((JSON.parse(prev.toString("utf8")) as { n?: unknown }).n) || 0;
    } catch {
      count = 0;
    }
  }
  if (count >= DAILY_CAP) return fail(429, "rate_limited");
  await deps.store.put(rateKey, Buffer.from(JSON.stringify({ n: count + 1 })));

  const reply: InboxReply = { caseId: c.caseId, text: c.text, role: c.role, receivedAt: now.toISOString(), ipHash: hash };
  await deps.store.put(`${INBOX_PREFIX}${c.caseId}/${id}.json`, Buffer.from(JSON.stringify(reply)));
  return { status: 202, body: { id } };
}

/** Public case ids out of a case index body: `{ids: [...]}` (written by the runner after each export). */
export function parseCaseIndex(buf: Buffer): Set<string> {
  const j = JSON.parse(buf.toString("utf8")) as { ids?: unknown };
  return new Set(Array.isArray(j.ids) ? j.ids.filter((x): x is string => typeof x === "string" && CASE_ID.test(x)) : []);
}
