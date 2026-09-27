// The public reply wall, offline: intake validation (every rejection rule), IP hashing (the raw
// IP is never stored), the reviewer verdict parser, the analyst-side review over a local mirror
// (accepted → public + a valid `commented` ledger event; rejected → rejected/, never shown), the
// export of public replies, and the runner's S3 ↔ local mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDemo } from "../src/ledger/cli.js";
import { eventPayload } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";
import { DAILY_CAP, handleReply, ipHash, stripHtml, ulid, type IntakeDeps } from "../src/replies/intake.js";
import { parseVerdict, readPublicReplies, reviewReplies } from "../src/replies/review.js";
import type { JsonCallResult } from "../src/analyst/anthropic.js";
import { caseIndexFrom, repliesRelPath } from "../src/runner/core.js";
import { exportSite } from "../src/watch/export.js";

const PUB_ID = "01994a2e-0000-7000-8000-00000000d001";
const IP = "203.0.113.77";
const SALT = "test-salt";
const GOOD = "The river bank here was cleared in August; I walk past it every week.";

function memDeps(o: { salt?: string | null; ids?: string[] } = {}) {
  const objects = new Map<string, Buffer>();
  let n = 0;
  const deps: IntakeDeps = {
    store: { get: async (k) => objects.get(k) ?? null, put: async (k, b) => void objects.set(k, b) },
    salt: async () => (o.salt === undefined ? SALT : o.salt),
    caseIds: async () => new Set(o.ids ?? [PUB_ID]),
    now: () => new Date("2026-09-27T10:00:00Z"),
    id: () => ulid(Date.parse("2026-09-27T10:00:00Z") + n++),
  };
  return { deps, objects };
}
const post = (body: unknown, ip = IP) => ({ method: "POST", path: "/reply", body: typeof body === "string" ? body : JSON.stringify(body), ip });
const inbox = (objects: Map<string, Buffer>) => [...objects.keys()].filter((k) => k.startsWith("replies/inbox/"));

test("intake: a good reply is stored in the inbox with a salted IP hash — never the IP", async () => {
  const { deps, objects } = memDeps();
  const r = await handleReply(post({ caseId: PUB_ID, text: `<b>${GOOD}</b>`, role: "resident" }), deps);
  assert.equal(r.status, 202);
  assert.match(r.body.id!, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const keys = inbox(objects);
  assert.deepEqual(keys, [`replies/inbox/${PUB_ID}/${r.body.id}.json`]);
  const raw = objects.get(keys[0]!)!.toString("utf8");
  const stored = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), ["caseId", "ipHash", "receivedAt", "role", "text"]);
  assert.equal(stored.text, GOOD, "HTML stripped");
  assert.equal(stored.ipHash, ipHash(IP, SALT));
  for (const [k, v] of objects) assert.ok(!v.toString("utf8").includes(IP) && !k.includes(IP), `${k} holds the raw IP`);
  assert.equal(stored.role, "resident");
});

test("ipHash: salted, stable, 64 hex; a different salt or IP gives a different hash", () => {
  assert.match(ipHash(IP, SALT), /^[0-9a-f]{64}$/);
  assert.equal(ipHash(IP, SALT), ipHash(` ${IP} `, SALT));
  assert.notEqual(ipHash(IP, SALT), ipHash(IP, "other"));
  assert.notEqual(ipHash(IP, SALT), ipHash("203.0.113.78", SALT));
});

test("intake: every rejection rule, and nothing stored for any of them", async () => {
  const cases: [string, ReturnType<typeof post>, number, string][] = [
    ["path", { ...post({ caseId: PUB_ID, text: GOOD }), path: "/other" }, 404, "path"],
    ["method", { ...post({ caseId: PUB_ID, text: GOOD }), method: "GET" }, 405, "method"],
    ["too large", post(JSON.stringify({ caseId: PUB_ID, text: "x".repeat(9000) })), 413, "too_large"],
    ["bad json", post("{not json"), 400, "bad_json"],
    ["array body", post("[1]"), 400, "bad_json"],
    ["bad case id", post({ caseId: "../../etc", text: GOOD }), 400, "bad_case"],
    ["bad role", post({ caseId: PUB_ID, text: GOOD, role: "ceo" }), 400, "bad_role"],
    ["too short", post({ caseId: PUB_ID, text: "Looks wrong." }), 400, "too_short"],
    ["short after stripping HTML", post({ caseId: PUB_ID, text: "<div><span>hi</span></div><img src=x onerror=alert(1)>" }), 400, "too_short"],
    ["too long", post({ caseId: PUB_ID, text: "a ".repeat(1100) }), 400, "too_long"],
    ["email", post({ caseId: PUB_ID, text: `${GOOD} Write me: someone.else@example.org` }), 400, "contact_info"],
    ["obfuscated email", post({ caseId: PUB_ID, text: `${GOOD} someone (at) example.org` }), 400, "contact_info"],
    ["@handle", post({ caseId: PUB_ID, text: `${GOOD} ask @river_watch_42` }), 400, "contact_info"],
    ["phone", post({ caseId: PUB_ID, text: `${GOOD} Call +55 (91) 98765-4321` }), 400, "phone"],
    ["url", post({ caseId: PUB_ID, text: `${GOOD} see https://example.org/photos` }), 400, "link"],
    ["bare domain", post({ caseId: PUB_ID, text: `${GOOD} photos at cheap-pills.shop` }), 400, "link"],
    ["www", post({ caseId: PUB_ID, text: `${GOOD} www.example` }), 400, "link"],
    ["unknown case", post({ caseId: "01994a2e-0000-7000-8000-00000000ffff", text: GOOD }), 404, "unknown_case"],
  ];
  for (const [name, req, status, error] of cases) {
    const { deps, objects } = memDeps();
    const r = await handleReply(req, deps);
    assert.equal(r.status, status, name);
    assert.equal(r.body.error, error, name);
    assert.ok(r.body.message, `${name}: a plain-language message`);
    assert.equal(inbox(objects).length, 0, `${name}: nothing stored`);
  }
});

test("intake: dates and measurements are not phone numbers", async () => {
  const { deps } = memDeps();
  const r = await handleReply(post({ caseId: PUB_ID, text: "Cleared between 2026-08-01 and 2026-09-15, about 38.2 ha, 420 alerts." }), deps);
  assert.equal(r.status, 202, JSON.stringify(r.body));
});

test("intake: honeypot filled → a fake 202 and nothing stored", async () => {
  const { deps, objects } = memDeps();
  const r = await handleReply(post({ caseId: PUB_ID, text: GOOD, website: "http://spam" }), deps);
  assert.equal(r.status, 202);
  assert.equal(objects.size, 0);
});

test("intake: per-IP daily cap, counted under the hash; other IPs unaffected", async () => {
  const { deps, objects } = memDeps();
  for (let i = 0; i < DAILY_CAP; i++) assert.equal((await handleReply(post({ caseId: PUB_ID, text: GOOD }), deps)).status, 202);
  const r = await handleReply(post({ caseId: PUB_ID, text: GOOD }), deps);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, "rate_limited");
  assert.equal(inbox(objects).length, DAILY_CAP);
  assert.equal((await handleReply(post({ caseId: PUB_ID, text: GOOD }, "198.51.100.1"), deps)).status, 202);
  assert.ok([...objects.keys()].some((k) => k === `replies/rate/2026-09-27/${ipHash(IP, SALT)}.json`));
});

test("intake: no salt → closed (503), nothing stored", async () => {
  const { deps, objects } = memDeps({ salt: null });
  const r = await handleReply(post({ caseId: PUB_ID, text: GOOD }), deps);
  assert.equal(r.status, 503);
  assert.equal(objects.size, 0);
});

test("stripHtml + ulid", () => {
  assert.equal(stripHtml("a <script>alert(1)</script> b &amp; c\n\n\n\nd"), "a b & c\n\nd");
  const a = ulid(1_000, Buffer.alloc(10));
  const b = ulid(2_000, Buffer.alloc(10, 255));
  assert.equal(a.length, 26);
  assert.ok(a < b, "sortable by time");
});

test("parseVerdict: strict shape; any flag forces a reject", () => {
  assert.deepEqual(parseVerdict({ accept: true, reason: "On topic.", flags: [] }), { accept: true, reason: "On topic.", flags: [] });
  assert.deepEqual(parseVerdict({ accept: true, reason: "ok", flags: ["names_person"] }), { accept: false, reason: "ok", flags: ["names_person"] });
  assert.equal(parseVerdict({ accept: "yes", reason: "x", flags: [] }), null);
  assert.equal(parseVerdict({ accept: true, reason: "", flags: [] }), null);
  assert.equal(parseVerdict({ accept: true, reason: "x", flags: ["rude"] }), null);
  assert.equal(parseVerdict({ accept: true, reason: "x", flags: [], extra: 1 }), null);
  assert.equal(parseVerdict([true]), null);
  assert.equal(parseVerdict(null), null);
});

function fakeCall(verdicts: unknown[], calls: string[] = []) {
  return async (_system: string, user: string): Promise<JsonCallResult> => {
    calls.push(user);
    const data = verdicts.shift();
    return { data, text: JSON.stringify(data), model: "claude-sonnet-5", usage: { input_tokens: 900, output_tokens: 60 }, costUsd: 0.0024, ms: 5, requestSha256: "0".repeat(64), responseSha256: "1".repeat(64) };
  };
}

function mirror(replies: { caseId: string; text: string; role?: string }[]): { dir: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-replies-"));
  const ids: string[] = [];
  replies.forEach((r, i) => {
    const id = ulid(Date.parse("2026-09-27T10:00:00Z") + i);
    ids.push(id);
    mkdirSync(join(dir, "inbox", r.caseId), { recursive: true });
    writeFileSync(join(dir, "inbox", r.caseId, `${id}.json`), JSON.stringify({ caseId: r.caseId, text: r.text, role: r.role ?? "resident", receivedAt: "2026-09-27T10:00:00.000Z", ipHash: "a".repeat(64) }));
  });
  return { dir, ids };
}

test("reviewReplies: accepted → public/ (no ipHash) + a valid signed `commented` event; rejected → rejected/ with the verdict", async () => {
  const lDir = mkdtempSync(join(tmpdir(), "earthdeck-replies-ledger-"));
  const ledger = Ledger.open(lDir);
  seedDemo(ledger);
  const candidate = ledger.list().find((f) => f.status === "candidate")!;
  const { dir, ids } = mirror([
    { caseId: PUB_ID, text: GOOD },
    { caseId: PUB_ID, text: "Buy cheap watches, best prices anywhere in the region!" },
    { caseId: candidate.findingId, text: GOOD },
  ]);
  const before = ledger.get(PUB_ID)!;
  const calls: string[] = [];
  const r = await reviewReplies({
    dir,
    ledger,
    reviewer: "claude-sonnet-5",
    call: fakeCall([{ accept: true, reason: "A first-hand, on-topic observation.", flags: [] }, { accept: false, reason: "Advertising.", flags: ["spam"] }], calls),
  });
  assert.deepEqual(r.accepted, [ids[0]]);
  assert.deepEqual(r.rejected, [ids[1], ids[2]]);
  assert.equal(r.left, 0);
  assert.equal(calls.length, 2, "a reply on a non-public case costs no model call");
  assert.match(calls[0]!, /The reply \(writer says they are: resident\)/);

  const pub = JSON.parse(readFileSync(join(dir, "public", PUB_ID, `${ids[0]}.json`), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(pub).sort(), ["caseId", "id", "receivedAt", "role", "text"]);
  const rej = JSON.parse(readFileSync(join(dir, "rejected", PUB_ID, `${ids[1]}.json`), "utf8")) as { verdict: { flags: string[] }; reviewedBy: string };
  assert.deepEqual(rej.verdict.flags, ["spam"]);
  assert.equal(rej.reviewedBy, "model:claude-sonnet-5");
  assert.ok(existsSync(join(dir, "rejected", candidate.findingId, `${ids[2]}.json`)));
  assert.ok(!existsSync(join(dir, "inbox", PUB_ID, `${ids[0]}.json`)));

  const after = ledger.get(PUB_ID)!;
  assert.equal(after.status, before.status, "a comment changes no status");
  assert.equal(after.eventCount, before.eventCount + 1);
  const entries = readFileSync(join(lDir, "entries.jsonl"), "utf8").trim().split("\n");
  const last = JSON.parse(entries[entries.length - 1]!) as { payload: string };
  const ev = eventPayload.parse((JSON.parse(Buffer.from(last.payload, "base64").toString("utf8")) as { predicate: unknown }).predicate) as Extract<ReturnType<typeof eventPayload.parse>, { kind: "commented" }>;
  assert.equal(ev.kind, "commented");
  assert.equal(ev.actor, "model:claude-sonnet-5");
  assert.equal(ev.reply.id, ids[0]);
  assert.ok(!JSON.stringify(ev).includes("river bank"), "only the text hash is signed");
  assert.deepEqual(readPublicReplies(dir, PUB_ID).map((x) => x.id), [ids[0]]);
});

test("ledger: `commented` only on public cases, only from a model:/reviewer: actor, never flagged", () => {
  const ledger = Ledger.open(mkdtempSync(join(tmpdir(), "earthdeck-replies-ledger-")));
  seedDemo(ledger);
  const candidate = ledger.list().find((f) => f.status === "candidate")!;
  const ev = (findingId: string, actor = "model:claude-sonnet-5", flags: string[] = []) => ({
    kind: "commented" as const,
    findingId,
    actor,
    reply: { id: ulid(), role: "resident" as const, receivedAt: "2026-09-27T10:00:00Z", textSha256: "a".repeat(64) },
    verdict: { accept: true as const, reason: "ok", flags },
  });
  assert.throws(() => ledger.append(ev(candidate.findingId)), /only taken on public cases/);
  assert.throws(() => ledger.append(ev(PUB_ID, "system:forest_loss@1.0")), /model: or reviewer:/);
  assert.throws(() => ledger.append(ev(PUB_ID, "model:x", ["spam"])));
  assert.doesNotThrow(() => ledger.append(ev(PUB_ID)));
});

test("reviewReplies: invalid model output → rejected (never shown); a call error leaves it in the inbox", async () => {
  const ledger = Ledger.open(mkdtempSync(join(tmpdir(), "earthdeck-replies-ledger-")));
  seedDemo(ledger);
  const { dir, ids } = mirror([{ caseId: PUB_ID, text: GOOD }, { caseId: PUB_ID, text: GOOD }]);
  let n = 0;
  const r = await reviewReplies({
    dir,
    ledger,
    reviewer: "claude-sonnet-5",
    call: async (s, u) => {
      if (n++ === 0) return fakeCall([{ accept: true }])(s, u);
      throw new Error("Anthropic API 529");
    },
  });
  assert.deepEqual(r.rejected, [ids[0]]);
  assert.equal(r.errors.length, 1);
  assert.equal(r.left, 1);
  assert.ok(existsSync(join(dir, "inbox", PUB_ID, `${ids[1]}.json`)));
});

test("export: public replies render under the case (+ api/replies/<id>.json) with the form mount; no raw IP, no ipHash, no @", async () => {
  const lDir = mkdtempSync(join(tmpdir(), "earthdeck-replies-ledger-"));
  seedDemo(Ledger.open(lDir));
  const repliesDir = mkdtempSync(join(tmpdir(), "earthdeck-replies-"));
  const id = ulid(Date.parse("2026-09-27T10:00:00Z"));
  mkdirSync(join(repliesDir, "public", PUB_ID), { recursive: true });
  writeFileSync(join(repliesDir, "public", PUB_ID, `${id}.json`), JSON.stringify({ id, caseId: PUB_ID, text: "Line one <b>x</b>\nline two of what I see here.", role: "resident", receivedAt: "2026-09-27T10:00:00.000Z" }));
  const out = join(mkdtempSync(join(tmpdir(), "earthdeck-replies-out-")), "site");
  await exportSite({ out, ledgerDir: lDir, baseUrl: null, siteDir: null, pulse: "off", repliesDir, replyUrl: "https://abc123.lambda-url.us-east-1.on.aws/", trustFile: join(lDir, "none.md") });

  const api = JSON.parse(readFileSync(join(out, "api", "replies", `${PUB_ID}.json`), "utf8")) as { replies: Record<string, unknown>[] };
  assert.equal(api.replies.length, 1);
  assert.deepEqual(Object.keys(api.replies[0]!).sort(), ["id", "receivedAt", "role", "text"]);
  const html = readFileSync(join(out, "watch", "case", PUB_ID, "index.html"), "utf8");
  assert.match(html, /Lives nearby/);
  assert.match(html, /Line one &lt;b&gt;x&lt;\/b&gt;<br \/>line two/);
  assert.match(html, /read and accepted by a second AI model/);
  assert.match(html, /class="reply-box" data-case="[^"]+" data-endpoint="https:\/\/abc123\.lambda-url\.us-east-1\.on\.aws\/reply"/);
  assert.match(html, /Know this place\? Say what you see\. Replies are checked before they appear\. No account, no email\./);
  assert.match(html, /Replies are open on the interactive site/);
  assert.ok(!html.slice(html.indexOf("<body")).includes("@"));
  assert.ok(!/ipHash|mailto:/.test(html));
  // Header has no email "Reply" link any more.
  assert.ok(!/<nav class="site-nav"[^]*?>Reply<\/a>/.test(html));
  // A non-public case takes no replies.
  const cand = readFileSync(join(out, "watch", "index.html"), "utf8");
  assert.ok(cand.length > 0);
});

test("export: without --reply-url there is no form (and no endpoint anywhere)", async () => {
  const lDir = mkdtempSync(join(tmpdir(), "earthdeck-replies-ledger-"));
  seedDemo(Ledger.open(lDir));
  const out = join(mkdtempSync(join(tmpdir(), "earthdeck-replies-out-")), "site");
  await exportSite({ out, ledgerDir: lDir, baseUrl: null, siteDir: null, pulse: "off", repliesDir: join(lDir, "nope"), trustFile: join(lDir, "none.md") });
  const html = readFileSync(join(out, "watch", "case", PUB_ID, "index.html"), "utf8");
  assert.ok(!html.includes("reply-box"));
  assert.match(html, /No replies yet\./);
  await assert.rejects(exportSite({ out, ledgerDir: lDir, baseUrl: null, siteDir: null, pulse: "off", replyUrl: "http://insecure.example", trustFile: join(lDir, "none.md") }), /https/);
});

test("runner: reply keys map safely; the case index holds public cases only", () => {
  assert.equal(repliesRelPath(`replies/inbox/${PUB_ID}/01K66Z2ZQ0000000000000000Z.json`), `inbox/${PUB_ID}/01K66Z2ZQ0000000000000000Z.json`);
  assert.equal(repliesRelPath("replies/rate/2026-09-27/abc.json"), null);
  assert.equal(repliesRelPath("replies/cases.json"), null);
  assert.equal(repliesRelPath("replies/inbox/../x/01K66Z2ZQ0000000000000000Z.json"), null);
  assert.equal(repliesRelPath("replies/secret/a/01K66Z2ZQ0000000000000000Z.json"), null);
  const idx = caseIndexFrom(JSON.stringify({ cases: [{ id: "a", status: "published" }, { id: "b", status: "candidate" }, { id: "c", status: "notified" }] }), ["published", "notified"]);
  assert.deepEqual(idx, { ids: ["a", "c"] });
});
