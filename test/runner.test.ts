// The scheduled Lambda runner's AWS-free core: payload validation, S3 key ↔ path mapping,
// site headers, the ledger upload guard, and the orchestration against stubbed deps.
// No AWS SDK is loaded and no AWS call is made here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableJobs,
  cacheControlFor,
  checkpointArchiveKey,
  cliArgs,
  contentTypeFor,
  envFromParameters,
  ledgerKey,
  ledgerRelPath,
  parsePayload,
  runPayload,
  stepsFor,
  sweepTiming,
  watchlistPaths,
  syncPlan,
  uploadDecision,
  CACHE_DEFAULT,
  CACHE_IMMUTABLE,
  CACHE_SHORT,
  type Exec,
  type ObjectStore,
  type RunnerConfig,
  type RunnerDeps,
} from "../src/runner/core.js";

test("parsePayload accepts the scheduled shapes (object or JSON string)", () => {
  assert.deepEqual(parsePayload({ job: "sweep", watchlist: "amazon" }), { job: "sweep", watchlist: "amazon" });
  assert.deepEqual(parsePayload('{"job":"sweep","watchlist":"congo-borneo","dryRun":true}'), { job: "sweep", watchlist: "congo-borneo", dryRun: true });
  assert.deepEqual(parsePayload({ job: "analyst" }), { job: "analyst" });
  assert.deepEqual(parsePayload({ job: "export" }), { job: "export" });
  assert.deepEqual(parsePayload({ job: "all" }), { job: "all" });
});

test("parsePayload rejects bad jobs, watchlists, extra keys, and misplaced flags", () => {
  assert.throws(() => parsePayload({ job: "deploy" }), /payload: job/);
  assert.throws(() => parsePayload({ job: "sweep", watchlist: "../etc" }), /payload: watchlist/);
  assert.throws(() => parsePayload({ job: "sweep", extra: 1 }), /payload/);
  assert.throws(() => parsePayload({ job: "export", dryRun: true }), /dryRun is only valid/);
  assert.throws(() => parsePayload({ job: "analyst", watchlist: "amazon" }), /watchlist is only valid/);
  assert.throws(() => parsePayload("{nope"), /not valid JSON/);
  assert.throws(() => parsePayload(null), /payload/);
});

test("stepsFor + cliArgs map payloads to CLI invocations", () => {
  assert.deepEqual(cliArgs({ job: "sweep", watchlist: "methane", dryRun: true }, "/tmp/site"), ["watch", "--once", "--dry-run", "--watchlist", "watchlists/methane.json"]);
  assert.deepEqual(cliArgs({ job: "sweep", dryRun: false }, "/tmp/site"), ["watch", "--once", "--watchlist", "watchlists"]);
  assert.deepEqual(cliArgs({ job: "analyst", dryRun: false }, "/tmp/site"), ["analyst", "--once"]);
  delete process.env.EARTHDECK_SITE_URL;
  delete process.env.EARTHDECK_CONTACT;
  assert.deepEqual(cliArgs({ job: "export", dryRun: false }, "/tmp/site"), ["watch", "export", "--out", "/tmp/site", "--trust", "TRUST.md"]);
  process.env.EARTHDECK_SITE_URL = "https://example.org";
  process.env.EARTHDECK_CONTACT = "me@example.org";
  assert.deepEqual(cliArgs({ job: "export", dryRun: false }, "/tmp/site"), ["watch", "export", "--out", "/tmp/site", "--base-url", "https://example.org", "--contact", "me@example.org", "--trust", "TRUST.md"]);
  delete process.env.EARTHDECK_SITE_URL;
  delete process.env.EARTHDECK_CONTACT;
  const all = stepsFor({ job: "all" });
  assert.deepEqual(all.map((s) => s.watchlist ?? s.job), ["amazon", "congo-borneo", "controls", "methane", "flaring", "indicators", "weather", "good-news", "analyst", "export"]);
  assert.ok(all.every((s) => !s.dryRun));
});

test("availableJobs probes --help for optional subcommands", () => {
  assert.deepEqual(availableJobs("earthdeck watch --once    sweep"), { sweep: true, analyst: false, export: false });
  assert.deepEqual(availableJobs("earthdeck analyst --once\nearthdeck watch export --out DIR"), { sweep: true, analyst: true, export: true });
});

test("envFromParameters maps /earthdeck/* to env names and ignores the rest", () => {
  const env = envFromParameters("/earthdeck", [
    { name: "/earthdeck/GFW_API_KEY", value: "g" },
    { name: "/earthdeck/ledger-key", value: "seed" },
    { name: "/earthdeck/weird-name", value: "x" },
    { name: "/other/FIRMS_MAP_KEY", value: "no" },
  ]);
  assert.deepEqual(env, { GFW_API_KEY: "g", EARTHDECK_LEDGER_KEY: "seed" });
});

test("ledger key ↔ path mapping excludes the archive, the private key, temp files and traversal", () => {
  assert.equal(ledgerRelPath("ledger/entries.jsonl"), "entries.jsonl");
  assert.equal(ledgerRelPath("ledger/tile/0/x001.p/3"), "tile/0/x001.p/3");
  assert.equal(ledgerRelPath("ledger/watch/journal.jsonl"), "watch/journal.jsonl");
  assert.equal(ledgerRelPath("ledger/checkpoints/2026-09-26T00-00-00Z"), null);
  assert.equal(ledgerRelPath("ledger/ledger.key"), null);
  assert.equal(ledgerRelPath("ledger/checkpoint.tmp"), null);
  assert.equal(ledgerRelPath("ledger/../state/heartbeat.json"), null);
  assert.equal(ledgerRelPath("ledger/"), null);
  assert.equal(ledgerRelPath("state/heartbeat.json"), null);
  assert.equal(ledgerKey("checkpoint"), "ledger/checkpoint");
  assert.equal(ledgerKey("ledger.key"), null);
  assert.equal(ledgerKey("checkpoints/x"), null);
  assert.equal(checkpointArchiveKey(new Date("2026-09-26T06:00:12.345Z")), "ledger/checkpoints/2026-09-26T06-00-12Z");
});

test("content-type and cache-control choosers", () => {
  assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("watch/assets/index-B8CLGuF_.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeFor("api/findings.json"), "application/json; charset=utf-8");
  assert.equal(contentTypeFor("ledger/checkpoint"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("ledger/tile/0/000"), "application/octet-stream");
  assert.equal(contentTypeFor("img/a.PNG"), "image/png");

  assert.equal(cacheControlFor("index.html"), CACHE_SHORT);
  assert.equal(cacheControlFor("watch/index.html"), CACHE_SHORT);
  assert.equal(cacheControlFor("api/findings.json"), CACHE_SHORT);
  assert.equal(cacheControlFor("ledger/checkpoint"), CACHE_SHORT);
  assert.equal(cacheControlFor("assets/index-B8CLGuF_.js"), CACHE_IMMUTABLE);
  assert.equal(cacheControlFor("watch/assets/index-BkMkhwHR.css"), CACHE_IMMUTABLE);
  assert.equal(cacheControlFor("favicon.ico"), CACHE_DEFAULT);
  assert.equal(cacheControlFor("assets/logo.svg"), CACHE_DEFAULT); // not hashed
});

test("uploadDecision: only a verified, non-shrinking, non-dry ledger goes back", () => {
  assert.equal(uploadDecision({ dryRun: true, verifyExit: 0, entriesBefore: 1, entriesAfter: 2 }).upload, false);
  assert.equal(uploadDecision({ dryRun: false, verifyExit: 1, entriesBefore: 1, entriesAfter: 2 }).upload, false);
  assert.equal(uploadDecision({ dryRun: false, verifyExit: null, entriesBefore: 1, entriesAfter: 2 }).upload, false);
  assert.equal(uploadDecision({ dryRun: false, verifyExit: 0, entriesBefore: 5, entriesAfter: 4 }).upload, false);
  assert.deepEqual(uploadDecision({ dryRun: false, verifyExit: 0, entriesBefore: 5, entriesAfter: 5 }), { upload: true, reason: "verified, no new entries" });
  assert.deepEqual(uploadDecision({ dryRun: false, verifyExit: 0, entriesBefore: 5, entriesAfter: 7 }), { upload: true, reason: "verified, +2 entries" });
});

test("syncPlan uploads changed files, deletes vanished ones, never touches the key", () => {
  const before = new Map([["entries.jsonl", "a"], ["tile/0/000.p/1", "b"], ["checkpoint", "c"]]);
  const after = new Map([["entries.jsonl", "a2"], ["tile/0/000.p/2", "d"], ["checkpoint", "c"], ["ledger.key", "k"]]);
  assert.deepEqual(syncPlan(before, after), { put: ["entries.jsonl", "tile/0/000.p/2"], remove: ["tile/0/000.p/1"] });
});

// ── orchestration with stubs ────────────────────────────────────────────────────────────

class MemStore implements ObjectStore {
  objects = new Map<string, { body: Buffer; contentType?: string; cacheControl?: string }>();
  async list(bucket: string, prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1));
  }
  async get(bucket: string, key: string) {
    const o = this.objects.get(`${bucket}/${key}`);
    if (!o) throw new Error(`NoSuchKey ${key}`);
    return o.body;
  }
  async put(bucket: string, key: string, body: Buffer, opts: { contentType?: string; cacheControl?: string } = {}) {
    this.objects.set(`${bucket}/${key}`, { body, ...opts });
  }
  async remove(bucket: string, keys: string[]) {
    for (const k of keys) this.objects.delete(`${bucket}/${k}`);
  }
  text(bucket: string, key: string) {
    return this.objects.get(`${bucket}/${key}`)?.body.toString("utf8");
  }
}

interface FakeCli {
  help?: string;
  job?: (args: string[], dir: string, site: string) => number;
  verifyExit?: number;
}

function harness(cli: FakeCli, env: NodeJS.ProcessEnv = { EARTHDECK_LEDGER_KEY: "seed" }) {
  const root = mkdtempSync(join(tmpdir(), "earthdeck-runner-"));
  const store = new MemStore();
  const calls: string[][] = [];
  let invalidations = 0;
  let metrics = 0;
  const cfg: RunnerConfig = {
    stateBucket: "state",
    siteBucket: "site",
    distributionId: "E123",
    ledgerDir: join(root, "ledger"),
    siteDir: join(root, "site"),
    env,
    budgetMs: () => 600_000,
  };
  const exec: Exec = async (args, opts) => {
    calls.push(args);
    assert.ok(args[0] === "--help" || opts.env.EARTHDECK_LEDGER_DIR === cfg.ledgerDir);
    if (args[0] === "--help") return { code: 0, output: cli.help ?? "earthdeck watch --once" };
    if (args[0] === "ledger") return { code: cli.verifyExit ?? 0, output: "verify" };
    return { code: cli.job ? cli.job(args, cfg.ledgerDir, cfg.siteDir) : 0, output: "ran" };
  };
  const deps: RunnerDeps = {
    store,
    invalidateAll: async () => void invalidations++,
    jobSuccess: async () => void metrics++,
    exec,
    log: () => {},
    now: () => new Date("2026-09-26T06:00:00Z"),
  };
  return { cfg, deps, store, calls, counts: () => ({ invalidations, metrics }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const appendEntry = (dir: string, line: string) => {
  appendFileSync(join(dir, "entries.jsonl"), `${line}\n`);
  writeFileSync(join(dir, "checkpoint"), `cp ${line}\n`);
};

test("sweep: download → run → verify → upload changes + archive checkpoint → heartbeat + metric", async () => {
  const h = harness({
    job: (_args, dir) => {
      appendEntry(dir, "e2");
      mkdirSync(join(dir, "tile/0"), { recursive: true });
      writeFileSync(join(dir, "tile/0/000"), "t");
      rmSync(join(dir, "tile/old"));
      return 0;
    },
  });
  await h.store.put("state", "ledger/entries.jsonl", Buffer.from("e1\n"));
  await h.store.put("state", "ledger/checkpoint", Buffer.from("cp e1\n"));
  await h.store.put("state", "ledger/tile/old", Buffer.from("x"));
  await h.store.put("state", "ledger/checkpoints/2026-01-01T00-00-00Z", Buffer.from("old cp"));
  const r = await runPayload({ job: "sweep", watchlist: "amazon" }, h.cfg, h.deps);
  assert.equal(r.ok, true);
  const s = r.steps[0]!;
  assert.equal(s.status, "ok");
  assert.equal(s.uploaded, true);
  assert.equal(s.entriesBefore, 1);
  assert.equal(s.entriesAfter, 2);
  assert.equal(s.filesDeleted, 1);
  assert.equal(h.store.text("state", "ledger/entries.jsonl"), "e1\ne2\n");
  assert.equal(h.store.text("state", "ledger/tile/old"), undefined);
  assert.equal(h.store.text("state", "ledger/checkpoints/2026-09-26T06-00-00Z"), "cp e2\n");
  assert.equal(h.store.text("state", "ledger/checkpoints/2026-01-01T00-00-00Z"), "old cp"); // archive untouched
  assert.deepEqual(h.calls.map((c) => c[0]), ["--help", "watch", "ledger"]);
  assert.deepEqual(h.calls[1], ["watch", "--once", "--watchlist", "watchlists/amazon.json"]);
  assert.match(h.store.text("state", "state/heartbeat.json") ?? "", /"job": "sweep"/);
  assert.equal(h.counts().metrics, 1);
  h.cleanup();
});

test("sweep: a failed verify uploads nothing and emits no metric", async () => {
  const h = harness({ job: (_a, dir) => (appendEntry(dir, "bad"), 0), verifyExit: 1 });
  await h.store.put("state", "ledger/entries.jsonl", Buffer.from("e1\n"));
  const r = await runPayload({ job: "sweep", watchlist: "controls" }, h.cfg, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.steps[0]!.uploaded, false);
  assert.match(r.steps[0]!.reason ?? "", /verify failed/);
  assert.equal(h.store.text("state", "ledger/entries.jsonl"), "e1\n");
  assert.equal(h.store.text("state", "state/heartbeat.json"), undefined);
  assert.equal(h.counts().metrics, 0);
  h.cleanup();
});

test("sweep: fresh ledger (nothing in S3) works; a crashed sweep keeps verified entries but fails the job", async () => {
  const h = harness({ job: (_a, dir) => (appendEntry(dir, "e1"), 1) });
  const r = await runPayload({ job: "sweep" }, h.cfg, h.deps);
  assert.equal(r.ok, false);
  assert.equal(r.steps[0]!.uploaded, true);
  assert.equal(h.store.text("state", "ledger/entries.jsonl"), "e1\n");
  assert.equal(h.counts().metrics, 0);
  h.cleanup();
});

test("dry-run sweep never writes to S3 and never runs verify", async () => {
  const h = harness({ job: () => 0 });
  const r = await runPayload({ job: "sweep", watchlist: "flaring", dryRun: true }, h.cfg, h.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.map((c) => c[0]), ["--help", "watch"]);
  assert.equal(h.store.objects.size, 0);
  assert.equal(h.counts().metrics, 0);
  h.cleanup();
});

test("writing jobs refuse to run without the production ledger key", async () => {
  const h = harness({ job: () => 0 }, {});
  const r = await runPayload({ job: "sweep", watchlist: "amazon" }, h.cfg, h.deps);
  assert.equal(r.ok, false);
  assert.match(r.steps[0]!.reason ?? "", /EARTHDECK_LEDGER_KEY missing/);
  assert.deepEqual(h.calls.map((c) => c[0]), ["--help"]);
  h.cleanup();
});

test("analyst/export missing from the build → 'unavailable', not a failure", async () => {
  const h = harness({});
  const r = await runPayload({ job: "export" }, h.cfg, h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.steps[0]!.status, "unavailable");
  assert.match(r.steps[0]!.reason ?? "", /not available in this build/);
  assert.equal(h.counts().metrics, 0);
  h.cleanup();
});

test("export: uploads the site with headers, then invalidates", async () => {
  const h = harness({
    help: "earthdeck watch export --out DIR",
    job: (_a, _dir, site) => {
      mkdirSync(join(site, "watch/assets"), { recursive: true });
      writeFileSync(join(site, "index.html"), "<h1>hi</h1>");
      writeFileSync(join(site, "watch/assets/app-AbCd1234.js"), "x");
      return 0;
    },
  });
  const r = await runPayload({ job: "export" }, h.cfg, h.deps);
  assert.equal(r.ok, true);
  assert.equal(r.steps[0]!.filesUploaded, 2);
  assert.equal(h.store.objects.get("site/index.html")?.cacheControl, CACHE_SHORT);
  assert.equal(h.store.objects.get("site/index.html")?.contentType, "text/html; charset=utf-8");
  assert.equal(h.store.objects.get("site/watch/assets/app-AbCd1234.js")?.cacheControl, CACHE_IMMUTABLE);
  assert.equal(h.counts().invalidations, 1);
  assert.equal(h.counts().metrics, 1);
  assert.equal([...h.store.objects.keys()].some((k) => k.startsWith("state/ledger/")), false); // export never writes the ledger
  h.cleanup();
});

test("src/runner stays out of the MCP server / CLI import graph", () => {
  const offenders: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p !== join("src", "runner")) rec(p);
      } else if (/\.ts$/.test(e.name) && /from\s+["'][^"']*runner\/|@aws-sdk\//.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  rec("src");
  assert.deepEqual(offenders, []);
});

// ── scale: generated watchlists, shards, time budgets ──────────────────────────────────

test("parsePayload: generated lists, all-generated/all-handwritten, shard, timeBudgetSec", () => {
  assert.deepEqual(parsePayload({ job: "sweep", watchlist: "all-generated", shard: "3/8" }), { job: "sweep", watchlist: "all-generated", shard: "3/8" });
  assert.deepEqual(parsePayload({ job: "sweep", watchlist: "generated/forest-hotspots", timeBudgetSec: 300 }), { job: "sweep", watchlist: "generated/forest-hotspots", timeBudgetSec: 300 });
  assert.deepEqual(parsePayload('{"job":"sweep","watchlist":"all-handwritten"}'), { job: "sweep", watchlist: "all-handwritten" });
  assert.throws(() => parsePayload({ job: "sweep", watchlist: "generated/../x" }), /payload: watchlist/);
  assert.throws(() => parsePayload({ job: "sweep", watchlist: "generated/" }), /payload: watchlist/);
  assert.throws(() => parsePayload({ job: "sweep", watchlist: "nope" }), /payload: watchlist/);
  assert.throws(() => parsePayload({ job: "sweep", shard: "8/8" }), /payload: shard/);
  assert.throws(() => parsePayload({ job: "sweep", shard: "a/b" }), /payload: shard/);
  assert.throws(() => parsePayload({ job: "sweep", timeBudgetSec: 0 }), /payload: timeBudgetSec/);
  assert.throws(() => parsePayload({ job: "sweep", timeBudgetSec: 12.5 }), /payload: timeBudgetSec/);
  assert.throws(() => parsePayload({ job: "analyst", shard: "0/8" }), /shard is only valid/);
  assert.throws(() => parsePayload({ job: "export", timeBudgetSec: 60 }), /timeBudgetSec is only valid/);
});

test("cliArgs: watchlist targets map to --watchlist paths; shard and budget pass through", () => {
  assert.deepEqual(watchlistPaths("all-generated"), ["watchlists/generated"]);
  assert.deepEqual(watchlistPaths("generated/methane-basins"), ["watchlists/generated/methane-basins.json"]);
  assert.deepEqual(watchlistPaths("all-handwritten"), ["watchlists/amazon.json", "watchlists/congo-borneo.json", "watchlists/controls.json", "watchlists/methane.json", "watchlists/flaring.json", "watchlists/indicators.json", "watchlists/weather.json", "watchlists/good-news.json"]);
  assert.deepEqual(cliArgs({ job: "sweep", watchlist: "all-generated", shard: "2/8", timeBudgetSec: 681, dryRun: false }, "/s"), ["watch", "--once", "--watchlist", "watchlists/generated", "--shard", "2/8", "--time-budget", "681"]);
  assert.equal(cliArgs({ job: "sweep", watchlist: "all-handwritten", dryRun: true }, "/s").filter((a) => a === "--watchlist").length, 8);
  assert.deepEqual(stepsFor({ job: "sweep", watchlist: "all-generated", shard: "1/8", timeBudgetSec: 100 }), [{ job: "sweep", watchlist: "all-generated", shard: "1/8", timeBudgetSec: 100, dryRun: false }]);
});

test("sweepTiming: --time-budget = remaining − 90 s (capped by a request), kill at remaining − 60 s", () => {
  assert.deepEqual(sweepTiming(895_000), { timeBudgetSec: 805, killAfterMs: 835_000 });
  assert.deepEqual(sweepTiming(895_000, 300), { timeBudgetSec: 300, killAfterMs: 835_000 });
  assert.deepEqual(sweepTiming(895_000, 900), { timeBudgetSec: 805, killAfterMs: 835_000 });
  assert.deepEqual(sweepTiming(90_500), { timeBudgetSec: 0, killAfterMs: 30_500 });
  assert.ok(sweepTiming(60_000).timeBudgetSec < 0);
});

test("runStep: in Lambda (remainingMs) a sweep gets --time-budget from the remaining time; too little time → failed, nothing run", async () => {
  const h = harness({ job: () => 0 });
  let remaining = 880_400;
  h.cfg.remainingMs = () => remaining;
  const seen: number[] = [];
  const exec = h.deps.exec;
  h.deps.exec = async (args, opts) => {
    if (args[0] === "watch") seen.push(opts.timeoutMs);
    return exec(args, opts);
  };
  const r = await runPayload({ job: "sweep", watchlist: "all-generated", shard: "0/8" }, h.cfg, h.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls[1], ["watch", "--once", "--watchlist", "watchlists/generated", "--shard", "0/8", "--time-budget", "790"]);
  assert.equal(r.steps[0]!.timeBudgetSec, 790);
  assert.equal(r.steps[0]!.shard, "0/8");
  assert.deepEqual(seen, [820_400]);

  remaining = 80_000;
  const r2 = await runPayload({ job: "sweep", watchlist: "all-generated" }, h.cfg, h.deps);
  assert.equal(r2.ok, false);
  assert.match(r2.steps[0]!.reason ?? "", /no time left to sweep/);
  h.cleanup();
});

test("infra: every schedule Input is a valid payload; 8 shards + hand-written + analyst + export", () => {
  const yaml = readFileSync("infra/earthdeck.yaml", "utf8");
  const inputs = [...yaml.matchAll(/^\s+Input: '(.+)'$/gm)].map((m) => parsePayload(m[1]!));
  const shards = inputs.filter((p) => p.watchlist === "all-generated").map((p) => p.shard).sort();
  assert.deepEqual(shards, ["0/8", "1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8"]);
  assert.equal(inputs.filter((p) => p.watchlist === "all-handwritten").length, 1);
  assert.equal(inputs.filter((p) => p.job === "analyst").length, 1);
  assert.equal(inputs.filter((p) => p.job === "export").length, 1);
  assert.equal(inputs.length, 11);
  assert.match(yaml, /EARTHDECK_MAX_ANALYST_CASES: "10"/);
});
