// The scheduled runner's logic, AWS-free: payload validation, S3 key ↔ local path mapping,
// content-type/cache-control choice, the ledger upload guard, and the job orchestration —
// all behind the tiny `RunnerDeps` interface so tests stub the cloud. `aws.ts` supplies the
// real SDK-backed deps and `lambda.ts` wires them into the handler.
//
// Nothing outside src/runner/ imports this directory: the MCP server's import graph never
// sees the runner (or the AWS SDK it types against).

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { PUBLIC_STATUSES } from "../ledger/schema.js";

// ── payload ──────────────────────────────────────────────────────────────────────────────

/** The hand-written watchlists (`watchlists/<name>.json`). */
export const WATCHLISTS = ["amazon", "congo-borneo", "controls", "methane", "flaring", "indicators", "weather", "good-news", "marine"] as const;
/**
 * A sweep target: one hand-written list, `all-handwritten` (all of those), `all-generated`
 * (every file in `watchlists/generated/`), or one generated list `generated/<name>`.
 */
export type WatchlistName = (typeof WATCHLISTS)[number] | "all-handwritten" | "all-generated" | `generated/${string}`;
export type JobName = "sweep" | "analyst" | "export";

const GENERATED = /^generated\/[a-z0-9][a-z0-9-]{0,63}$/;
const watchlistSchema = z.union([z.enum(WATCHLISTS), z.literal("all-handwritten"), z.literal("all-generated"), z.string().regex(GENERATED, "expected a hand-written name, all-handwritten, all-generated or generated/<name>")]) as z.ZodType<WatchlistName>;

const payloadSchema = z
  .object({
    job: z.enum(["sweep", "analyst", "export", "all"]),
    watchlist: watchlistSchema.optional(),
    shard: z.string().regex(/^\d{1,3}\/\d{1,3}$/, "expected i/n").refine((s) => { const [i, n] = s.split("/").map(Number); return n! >= 1 && i! < n!; }, "expected 0 ≤ i < n").optional(),
    timeBudgetSec: z.number().int().positive().max(900).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((p) => p.watchlist === undefined || p.job === "sweep", { message: "watchlist is only valid with job \"sweep\"" })
  .refine((p) => p.shard === undefined || p.job === "sweep", { message: "shard is only valid with job \"sweep\"" })
  .refine((p) => p.timeBudgetSec === undefined || p.job === "sweep", { message: "timeBudgetSec is only valid with job \"sweep\"" })
  .refine((p) => !p.dryRun || p.job === "sweep", { message: "dryRun is only valid with job \"sweep\"" });

export type Payload = z.infer<typeof payloadSchema>;

/** Validate an invocation payload (object, or a JSON string). Throws a one-line message. */
export function parsePayload(raw: unknown): Payload {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("payload: not valid JSON");
    }
  }
  const r = payloadSchema.safeParse(value);
  if (!r.success) throw new Error(`payload: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

export interface Step {
  job: JobName;
  watchlist?: WatchlistName;
  shard?: string;
  /** Sweep time budget in seconds (`--time-budget`); set by the runner from the remaining Lambda time. */
  timeBudgetSec?: number;
  dryRun: boolean;
}

/** `all` = every watchlist swept (for real), then the analyst, then the export. Manual use only (900 s cap). */
export function stepsFor(p: Payload): Step[] {
  if (p.job === "all") {
    return [...WATCHLISTS.map((w): Step => ({ job: "sweep", watchlist: w, dryRun: false })), { job: "analyst", dryRun: false }, { job: "export", dryRun: false }];
  }
  return [{ job: p.job, watchlist: p.watchlist, ...(p.shard ? { shard: p.shard } : {}), ...(p.timeBudgetSec ? { timeBudgetSec: p.timeBudgetSec } : {}), dryRun: p.dryRun ?? false }];
}

/** `--watchlist` paths for a sweep target (repeatable flag; a directory loads its top-level *.json). */
export function watchlistPaths(w: WatchlistName | undefined): string[] {
  if (w === undefined) return ["watchlists"];
  if (w === "all-handwritten") return WATCHLISTS.map((n) => `watchlists/${n}.json`);
  if (w === "all-generated") return ["watchlists/generated"];
  return [`watchlists/${w}.json`];
}

/** Soft reserve: the sweep's --time-budget ends this long before Lambda's deadline (verify + upload). */
export const SWEEP_SOFT_RESERVE_MS = 90_000;
/** Hard reserve: a budgeted sweep that overruns is SIGTERMed this long before the deadline. */
export const SWEEP_HARD_RESERVE_MS = 60_000;

/**
 * Budget math for a sweep given the Lambda time left: `--time-budget` = remaining − 90 s
 * (capped by an explicit request), and the child is killed at remaining − 60 s as a backstop.
 * `timeBudgetSec` ≤ 0 means there is no time to start.
 */
export function sweepTiming(remainingMs: number, requestedSec?: number): { timeBudgetSec: number; killAfterMs: number } {
  const fromLambda = Math.floor((remainingMs - SWEEP_SOFT_RESERVE_MS) / 1000);
  return { timeBudgetSec: requestedSec !== undefined ? Math.min(requestedSec, fromLambda) : fromLambda, killAfterMs: remainingMs - SWEEP_HARD_RESERVE_MS };
}

/** argv for `node dist/cli.js …`. A sweep without a watchlist sweeps the whole directory. */
export function cliArgs(step: Step, siteDir: string, repliesDir?: string): string[] {
  if (step.job === "sweep") {
    return [
      "watch",
      "--once",
      ...(step.dryRun ? ["--dry-run"] : []),
      ...watchlistPaths(step.watchlist).flatMap((p) => ["--watchlist", p]),
      ...(step.shard ? ["--shard", step.shard] : []),
      ...(step.timeBudgetSec !== undefined ? ["--time-budget", String(step.timeBudgetSec)] : []),
    ];
  }
  if (step.job === "analyst") return ["analyst", "--once", ...(repliesDir ? ["--replies", repliesDir] : [])];
  // Public-site metadata comes from the function's environment (set by the stack). No
  // --contact: the site is anonymous; replies go through the reply wall (EARTHDECK_REPLY_URL).
  const siteUrl = process.env.EARTHDECK_SITE_URL;
  const replyUrl = process.env.EARTHDECK_REPLY_URL;
  return [
    "watch",
    "export",
    "--out",
    siteDir,
    ...(siteUrl ? ["--base-url", siteUrl] : []),
    ...(replyUrl ? ["--reply-url", replyUrl] : []),
    ...(repliesDir ? ["--replies", repliesDir] : []),
    "--trust",
    "TRUST.md",
  ];
}

/** Which optional subcommands this build's CLI advertises in `--help`. */
export function availableJobs(helpText: string): Record<JobName, boolean> {
  return { sweep: true, analyst: /\banalyst\b/.test(helpText), export: /\bwatch export\b/.test(helpText) };
}

/** Jobs that append to the ledger — they need the signing key and the verify→upload guard. */
export function writesLedger(step: Step): boolean {
  return (step.job === "sweep" && !step.dryRun) || step.job === "analyst";
}

// ── secrets ──────────────────────────────────────────────────────────────────────────────

/** `/earthdeck/GFW_API_KEY` → `GFW_API_KEY`; `/earthdeck/ledger-key` → `EARTHDECK_LEDGER_KEY`. Anything else is ignored. */
export function envFromParameters(prefix: string, params: { name: string; value: string }[]): Record<string, string> {
  const base = prefix.replace(/\/+$/, "") + "/";
  const env: Record<string, string> = {};
  for (const { name, value } of params) {
    if (!name.startsWith(base)) continue;
    const leaf = name.slice(base.length);
    if (leaf === "ledger-key") env.EARTHDECK_LEDGER_KEY = value;
    else if (/^[A-Z][A-Z0-9_]*$/.test(leaf)) env[leaf] = value;
  }
  return env;
}

// ── S3 key ↔ local path ──────────────────────────────────────────────────────────────────

export const LEDGER_PREFIX = "ledger/";
/** Archived checkpoints live under the ledger prefix but are never part of the working copy. */
export const CHECKPOINT_ARCHIVE_PREFIX = "ledger/checkpoints/";
/** Never leaves the machine that holds it; production reads the seed from SSM. */
const NEVER_SYNC = new Set(["ledger.key"]);

/** State-bucket key → path relative to the local ledger dir, or null if the key is not part of the working copy. */
export function ledgerRelPath(key: string): string | null {
  if (!key.startsWith(LEDGER_PREFIX) || key.startsWith(CHECKPOINT_ARCHIVE_PREFIX) || key.endsWith("/")) return null;
  const rel = key.slice(LEDGER_PREFIX.length);
  if (rel === "" || rel.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  if (NEVER_SYNC.has(rel) || rel.endsWith(".tmp")) return null;
  return rel;
}

/** Local relative path → state-bucket key, or null if it must not be uploaded. */
export function ledgerKey(rel: string): string | null {
  const posix = rel.split(sep).join("/");
  const key = LEDGER_PREFIX + posix;
  return ledgerRelPath(key) === posix ? key : null;
}

/** `2026-09-26T06:00:12.345Z` → `ledger/checkpoints/2026-09-26T06-00-12Z` (colon-free, sortable). */
export function checkpointArchiveKey(at: Date): string {
  return `${CHECKPOINT_ARCHIVE_PREFIX}${at.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-")}`;
}

// ── reply wall mirror (state bucket `replies/` ↔ local dir) ─────────────────────────────

export const REPLIES_PREFIX = "replies/";
/** State-bucket key the reply intake reads to know which cases take replies. */
export const REPLY_CASE_INDEX_KEY = "replies/cases.json";
const REPLY_PARTS = new Set(["inbox", "public", "rejected"]);

/** `replies/<inbox|public|rejected>/<caseId>/<id>.json` → the same path relative to the local dir; anything else → null. */
export function repliesRelPath(key: string): string | null {
  const m = /^replies\/([a-z]+)\/([A-Za-z0-9-]{1,64})\/([0-9A-Z]{26})\.json$/.exec(key);
  return m && REPLY_PARTS.has(m[1]!) ? key.slice(REPLIES_PREFIX.length) : null;
}

/** Public case ids for the intake, from the export's api/map.json. */
export function caseIndexFrom(mapJson: string, publicStatuses: readonly string[]): { ids: string[] } {
  const j = JSON.parse(mapJson) as { cases?: { id?: unknown; status?: unknown }[] };
  const ids = (j.cases ?? []).filter((c) => typeof c.id === "string" && typeof c.status === "string" && publicStatuses.includes(c.status)).map((c) => c.id as string);
  return { ids: [...new Set(ids)].sort() };
}

// ── static-site headers ──────────────────────────────────────────────────────────────────

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  geojson: "application/geo+json",
  jsonl: "application/x-ndjson",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  pdf: "application/pdf",
  pub: "text/plain; charset=utf-8",
};

export function contentTypeFor(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  if (base === "checkpoint") return "text/plain; charset=utf-8"; // C2SP signed note
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return TYPES[ext] ?? "application/octet-stream";
}

export const CACHE_SHORT = "public, max-age=60";
export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export const CACHE_DEFAULT = "public, max-age=300";

/** Vite-style hashed asset: inside an `assets/` dir, `name-<8+ char hash>.ext`. */
export function isHashedAsset(key: string): boolean {
  return /(^|\/)assets\/[^/]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$/.test(key);
}

/** html + `api/*` + `ledger/*` → 60 s (they change every export); hashed assets → a year; anything else → 5 min. */
export function cacheControlFor(key: string): string {
  if (key.endsWith(".html") || key.startsWith("api/") || key.startsWith("ledger/")) return CACHE_SHORT;
  if (isHashedAsset(key)) return CACHE_IMMUTABLE;
  return CACHE_DEFAULT;
}

// ── ledger upload guard ─────────────────────────────────────────────────────────────────

export interface UploadInputs {
  dryRun: boolean;
  /** `earthdeck ledger verify` exit code (null = not run). */
  verifyExit: number | null;
  /** entries.jsonl line counts before (downloaded) and after the job. */
  entriesBefore: number;
  entriesAfter: number;
}

/**
 * Upload the working copy back only when it verifies and has not shrunk. The job's own exit
 * code is deliberately not an input: entries it appended before failing are signed and
 * verified, so keeping them is correct — the job is still reported as failed.
 */
export function uploadDecision(i: UploadInputs): { upload: boolean; reason: string } {
  if (i.dryRun) return { upload: false, reason: "dry run" };
  if (i.verifyExit !== 0) return { upload: false, reason: `ledger verify failed (exit ${i.verifyExit ?? "not run"})` };
  if (i.entriesAfter < i.entriesBefore) return { upload: false, reason: `ledger shrank (${i.entriesBefore} → ${i.entriesAfter} entries)` };
  return { upload: true, reason: i.entriesAfter === i.entriesBefore ? "verified, no new entries" : `verified, +${i.entriesAfter - i.entriesBefore} entries` };
}

// ── deps ─────────────────────────────────────────────────────────────────────────────────

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
}
export interface ObjectStore {
  list(bucket: string, prefix: string): Promise<string[]>;
  get(bucket: string, key: string): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer, opts?: PutOptions): Promise<void>;
  remove(bucket: string, keys: string[]): Promise<void>;
}
export interface ExecResult {
  code: number;
  output: string;
}
export type Exec = (args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export interface RunnerDeps {
  store: ObjectStore;
  invalidateAll(distributionId: string): Promise<void>;
  jobSuccess(): Promise<void>;
  exec: Exec;
  log(line: string): void;
  now(): Date;
}

export interface RunnerConfig {
  stateBucket: string;
  siteBucket: string;
  distributionId: string;
  ledgerDir: string;
  siteDir: string;
  /** Env for the CLI child (process env + secrets). */
  env: NodeJS.ProcessEnv;
  /** Wall-clock budget left for this step, ms. */
  budgetMs(): number;
  /** Raw time left in the invocation, ms (Lambda `getRemainingTimeInMillis`); enables sweep time budgets. */
  remainingMs?(): number;
  /** Local mirror of the state bucket's `replies/` (analyst: inbox; export: public). Omitted = no reply wall. */
  repliesDir?: string;
}

export interface StepResult {
  job: JobName;
  watchlist?: WatchlistName;
  shard?: string;
  timeBudgetSec?: number;
  dryRun: boolean;
  ok: boolean;
  status: "ok" | "failed" | "unavailable";
  exitCode?: number;
  reason?: string;
  verified?: boolean;
  uploaded?: boolean;
  entriesBefore?: number;
  entriesAfter?: number;
  filesUploaded?: number;
  filesDeleted?: number;
  checkpointArchived?: string;
  durationMs: number;
  outputTail?: string;
}

/** Default Exec: `node <cliPath> …` in `cwd`, output collected (tail kept) and mirrored to the log. */
export function spawnCli(cliPath: string, cwd: string, log: (s: string) => void): Exec {
  return (args, { env, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const onData = (b: Buffer) => {
        const s = b.toString("utf8");
        output = (output + s).slice(-64_000);
        for (const line of s.split("\n")) if (line) log(line);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        log(`[runner] ${args.join(" ")}: out of time budget, sending SIGTERM`);
        child.kill("SIGTERM");
      }, Math.max(1_000, timeoutMs));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 128 : 1), output });
      });
    });
}

// ── filesystem helpers ───────────────────────────────────────────────────────────────────

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

/** Relative POSIX paths of every file under `dir`. */
export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const rec = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  rec(dir);
  return out.sort();
}

function manifest(dir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const rel of walk(dir)) m.set(rel, md5(readFileSync(join(dir, rel))));
  return m;
}

export function countEntries(ledgerDir: string): number {
  const p = join(ledgerDir, "entries.jsonl");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter((l) => l !== "").length;
}

/** What to push/delete so the bucket mirrors the working copy (only uploadable paths). */
export function syncPlan(before: Map<string, string>, after: Map<string, string>): { put: string[]; remove: string[] } {
  const put = [...after].filter(([rel, h]) => ledgerKey(rel) && before.get(rel) !== h).map(([rel]) => rel);
  const remove = [...before.keys()].filter((rel) => !after.has(rel) && ledgerKey(rel));
  return { put: put.sort(), remove: remove.sort() };
}

// ── orchestration ────────────────────────────────────────────────────────────────────────

async function downloadLedger(cfg: RunnerConfig, deps: RunnerDeps): Promise<number> {
  rmSync(cfg.ledgerDir, { recursive: true, force: true }); // warm containers keep /tmp
  mkdirSync(cfg.ledgerDir, { recursive: true });
  let n = 0;
  for (const key of await deps.store.list(cfg.stateBucket, LEDGER_PREFIX)) {
    const rel = ledgerRelPath(key);
    if (!rel) continue;
    const dest = join(cfg.ledgerDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, await deps.store.get(cfg.stateBucket, key));
    n++;
  }
  return n;
}

/** Mirror `replies/<part>/` into `<repliesDir>/<part>/`; returns the keys pulled. */
async function downloadReplies(cfg: RunnerConfig, deps: RunnerDeps, part: "inbox" | "public"): Promise<string[]> {
  const dir = cfg.repliesDir!;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const keys: string[] = [];
  for (const key of await deps.store.list(cfg.stateBucket, `${REPLIES_PREFIX}${part}/`)) {
    const rel = repliesRelPath(key);
    if (!rel) continue;
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, await deps.store.get(cfg.stateBucket, key));
    keys.push(key);
  }
  return keys;
}

/** After the analyst: push public/ + rejected/ files, drop inbox keys that were moved. */
async function syncReplies(cfg: RunnerConfig, deps: RunnerDeps, pulled: string[]): Promise<{ put: number; removed: number }> {
  const dir = cfg.repliesDir!;
  const local = new Set(walk(dir));
  const put = [...local].filter((rel) => !rel.startsWith("inbox/") && repliesRelPath(REPLIES_PREFIX + rel));
  await uploadDir(cfg.stateBucket, dir, (rel) => REPLIES_PREFIX + rel, put, deps);
  const gone = pulled.filter((key) => !local.has(key.slice(REPLIES_PREFIX.length)));
  if (gone.length) await deps.store.remove(cfg.stateBucket, gone);
  return { put: put.length, removed: gone.length };
}

/** Site-bucket prefixes the export owns outright: anything there it no longer writes is stale. */
export const SITE_PRUNE_PREFIXES = ["api/", "watch/"] as const;

/**
 * Pure: site-bucket keys to delete after an export — under api/ and watch/ only, absent from the
 * new export. Never ledger/ (or anything else outside those prefixes), and never hashed bundles
 * under an assets/ folder: a page cached a few minutes ago may still ask for the old one.
 */
export function sitePruneKeys(existing: readonly string[], exported: ReadonlySet<string>): string[] {
  return existing
    .filter((k) => SITE_PRUNE_PREFIXES.some((p) => k.startsWith(p)) && !exported.has(k) && !k.split("/").includes("assets") && !k.split("/").includes(".."))
    .sort();
}

async function uploadDir(bucket: string, dir: string, keyOf: (rel: string) => string, rels: string[], deps: RunnerDeps): Promise<void> {
  for (const rel of rels) {
    const key = keyOf(rel);
    await deps.store.put(bucket, key, readFileSync(join(dir, rel)), { contentType: contentTypeFor(key), cacheControl: cacheControlFor(key) });
  }
}

export async function runStep(step: Step, cfg: RunnerConfig, deps: RunnerDeps, avail: Record<JobName, boolean>): Promise<StepResult> {
  const t0 = deps.now().getTime();
  const base: Pick<StepResult, "job" | "watchlist" | "shard" | "timeBudgetSec" | "dryRun"> = { job: step.job, ...(step.watchlist ? { watchlist: step.watchlist } : {}), ...(step.shard ? { shard: step.shard } : {}), dryRun: step.dryRun };
  const done = (r: Omit<StepResult, "job" | "dryRun" | "durationMs">): StepResult => ({ ...base, ...r, durationMs: deps.now().getTime() - t0 });

  if (!avail[step.job]) {
    return done({ ok: false, status: "unavailable", reason: `\`${cliArgs(step, cfg.siteDir).slice(0, 2).join(" ")}\` is not available in this build` });
  }
  const writing = writesLedger(step);
  if (writing && !cfg.env.EARTHDECK_LEDGER_KEY) {
    // Without the production seed the CLI would mint a fresh key and sign with it — never.
    return done({ ok: false, status: "failed", reason: "EARTHDECK_LEDGER_KEY missing (SSM /earthdeck/ledger-key) — refusing to write the ledger" });
  }

  const pulled = await downloadLedger(cfg, deps);
  deps.log(`[runner] ledger: ${pulled} file(s) from s3://${cfg.stateBucket}/${LEDGER_PREFIX}${pulled === 0 ? " (fresh ledger)" : ""}`);
  const before = manifest(cfg.ledgerDir);
  const entriesBefore = countEntries(cfg.ledgerDir);
  const cpBefore = before.get("checkpoint");
  const env = { ...cfg.env, EARTHDECK_LEDGER_DIR: cfg.ledgerDir };

  if (step.job === "export") rmSync(cfg.siteDir, { recursive: true, force: true });
  const pulledReplies = cfg.repliesDir && (step.job === "analyst" || step.job === "export") ? await downloadReplies(cfg, deps, step.job === "analyst" ? "inbox" : "public") : [];
  let runStepAs = step;
  let timeoutMs = cfg.budgetMs();
  if (step.job === "sweep" && cfg.remainingMs) {
    // Stop opening pairs 90 s before the deadline, leaving room for verify + upload.
    const t = sweepTiming(cfg.remainingMs(), step.timeBudgetSec);
    if (t.timeBudgetSec <= 0) return done({ ok: false, status: "failed", reason: `no time left to sweep (${Math.round(cfg.remainingMs() / 1000)} s remaining)` });
    runStepAs = { ...step, timeBudgetSec: t.timeBudgetSec };
    base.timeBudgetSec = t.timeBudgetSec;
    timeoutMs = t.killAfterMs;
  }
  const run = await deps.exec(cliArgs(runStepAs, cfg.siteDir, cfg.repliesDir), { env, timeoutMs });
  const outputTail = run.output.slice(-2_000);

  if (step.job === "export") {
    if (run.code !== 0) return done({ ok: false, status: "failed", exitCode: run.code, reason: "export failed", outputTail });
    const files = walk(cfg.siteDir);
    if (files.length === 0) return done({ ok: false, status: "failed", exitCode: 0, reason: `export wrote nothing to ${cfg.siteDir}`, outputTail });
    await uploadDir(cfg.siteBucket, cfg.siteDir, (rel) => rel, files, deps);
    // Mirror deletions too (e.g. a reply taken down → its api/replies/<case>.json goes away).
    const exported = new Set(files);
    const stale: string[] = [];
    for (const p of SITE_PRUNE_PREFIXES) stale.push(...sitePruneKeys(await deps.store.list(cfg.siteBucket, p), exported));
    if (stale.length) await deps.store.remove(cfg.siteBucket, stale);
    await deps.invalidateAll(cfg.distributionId); // "/*": covers the deleted paths as well
    if (cfg.repliesDir && existsSync(join(cfg.siteDir, "api", "map.json"))) {
      // The intake (reply Lambda) takes replies only for cases in this index.
      const index = caseIndexFrom(readFileSync(join(cfg.siteDir, "api", "map.json"), "utf8"), PUBLIC_STATUSES);
      await deps.store.put(cfg.stateBucket, REPLY_CASE_INDEX_KEY, Buffer.from(JSON.stringify(index)), { contentType: "application/json; charset=utf-8" });
    }
    return done({ ok: true, status: "ok", exitCode: 0, filesUploaded: files.length, filesDeleted: stale.length, outputTail });
  }

  if (!writing) {
    // dry-run sweep: nothing leaves /tmp
    return done({ ok: run.code === 0, status: run.code === 0 ? "ok" : "failed", exitCode: run.code, uploaded: false, reason: "dry run", outputTail });
  }

  const verify = await deps.exec(["ledger", "verify"], { env, timeoutMs: Math.max(60_000, cfg.budgetMs()) });
  const entriesAfter = countEntries(cfg.ledgerDir);
  const decision = uploadDecision({ dryRun: false, verifyExit: verify.code, entriesBefore, entriesAfter });
  const common = { exitCode: run.code, verified: verify.code === 0, entriesBefore, entriesAfter, outputTail };
  if (!decision.upload) return done({ ok: false, status: "failed", uploaded: false, reason: decision.reason, ...common });

  const after = manifest(cfg.ledgerDir);
  const plan = syncPlan(before, after);
  await uploadDir(cfg.stateBucket, cfg.ledgerDir, (rel) => ledgerKey(rel)!, plan.put, deps);
  if (plan.remove.length) await deps.store.remove(cfg.stateBucket, plan.remove.map((rel) => ledgerKey(rel)!));
  let checkpointArchived: string | undefined;
  const cpAfter = after.get("checkpoint");
  if (cpAfter && cpAfter !== cpBefore) {
    checkpointArchived = checkpointArchiveKey(deps.now());
    await deps.store.put(cfg.stateBucket, checkpointArchived, readFileSync(join(cfg.ledgerDir, "checkpoint")), { contentType: "text/plain; charset=utf-8" });
  }
  let repliesNote = "";
  if (step.job === "analyst" && cfg.repliesDir) {
    // Only after the ledger (with its `commented` events) is safely back in the bucket.
    const r = await syncReplies(cfg, deps, pulledReplies);
    if (r.put || r.removed) repliesNote = `; replies: ${r.put} written, ${r.removed} inbox removed`;
  }
  const ok = run.code === 0;
  return done({
    ok,
    status: ok ? "ok" : "failed",
    uploaded: true,
    reason: (ok ? decision.reason : `job exited ${run.code}; ${decision.reason} (kept)`) + repliesNote,
    filesUploaded: plan.put.length,
    filesDeleted: plan.remove.length,
    ...(checkpointArchived ? { checkpointArchived } : {}),
    ...common,
  });
}

export interface RunResult {
  ok: boolean;
  payload: Payload;
  steps: StepResult[];
}

/** Run every step of a payload; heartbeat + JobSuccess metric after each real (non-dry) success. */
export async function runPayload(payload: Payload, cfg: RunnerConfig, deps: RunnerDeps): Promise<RunResult> {
  const help = await deps.exec(["--help"], { env: cfg.env, timeoutMs: 30_000 });
  const avail = availableJobs(help.output);
  const steps: StepResult[] = [];
  for (const step of stepsFor(payload)) {
    let r: StepResult;
    try {
      r = await runStep(step, cfg, deps, avail);
    } catch (e) {
      r = { job: step.job, ...(step.watchlist ? { watchlist: step.watchlist } : {}), dryRun: step.dryRun, ok: false, status: "failed", reason: e instanceof Error ? e.message : String(e), durationMs: 0 };
    }
    deps.log(`[runner] ${JSON.stringify({ ...r, outputTail: undefined })}`);
    if (r.ok && !r.dryRun) {
      const hb = { at: deps.now().toISOString(), job: r.job, watchlist: r.watchlist ?? null, reason: r.reason ?? null, entries: r.entriesAfter ?? null, durationMs: r.durationMs };
      await deps.store.put(cfg.stateBucket, "state/heartbeat.json", Buffer.from(JSON.stringify(hb, null, 2)), { contentType: "application/json; charset=utf-8" });
      await deps.jobSuccess();
    }
    steps.push(r);
  }
  const ok = steps.every((s) => s.ok || s.status === "unavailable");
  return { ok, payload, steps };
}
