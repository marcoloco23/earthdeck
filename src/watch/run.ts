// `earthdeck watch --once` — run the kernel over the watchlists against the real tools,
// in-process (the same InMemoryTransport trick `earthdeck demo` uses), writing findings to
// the ledger and cards to the dashboard if one is up. `--every` (a persistent loop) is
// deliberately absent in v1: schedule `--once` (cron / GitHub Actions) and let watermarks
// do the catch-up — see the plan's scheduling section for why.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ledgerDir } from "../config.js";
import { buildServer } from "../index.js";
import { Ledger } from "../ledger/store.js";
import { Journal } from "./journal.js";
import { parseShard, sweep } from "./kernel.js";
import { capsFromEnv, QuotaGovernor } from "./quota.js";
import { RULES, ToolError, type ToolCall } from "./rules/index.js";
import { loadWatchlists } from "./watchlist.js";

const out = (s: string) => process.stdout.write(`${s}\n`);

export async function runWatch(args: string[]): Promise<void> {
  const startedMs = Date.now();
  const flag = (name: string) => args.includes(name);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!flag("--once")) {
    out("usage: earthdeck watch --once [--watchlist <file|dir>]... [--dry-run] [--max N] [--rules a,b] [--delay-ms N]");
    out("                            [--shard i/n] [--time-budget <seconds>]");
    out("       Runs one sweep. Schedule it (cron / GitHub Actions); watermarks handle late or missed runs.");
    process.exitCode = 2;
    return;
  }
  const wlPaths = args.flatMap((a, i) => (a === "--watchlist" && args[i + 1] ? [args[i + 1]!] : []));
  if (!wlPaths.length && existsSync("watchlists")) wlPaths.push("watchlists");
  if (!wlPaths.length) throw new Error("no watchlists: pass --watchlist <file|dir> or create ./watchlists/*.json");
  const watchlists = wlPaths.flatMap((p) => loadWatchlists(p));
  const dryRun = flag("--dry-run");
  const maxPairs = opt("--max") ? Number(opt("--max")) : undefined;
  const onlyRules = opt("--rules")?.split(",").map((s) => s.trim());
  const delayMs = opt("--delay-ms") ? Number(opt("--delay-ms")) : 1500;
  const shard = opt("--shard") ? parseShard(opt("--shard")!) : undefined;
  const budgetSec = opt("--time-budget") ? Number(opt("--time-budget")) : undefined;
  if (budgetSec !== undefined && !(budgetSec > 0)) throw new Error("--time-budget must be a positive number of seconds");
  const deadline = budgetSec !== undefined ? startedMs + budgetSec * 1000 : undefined;

  const dir = ledgerDir();
  const ledger = Ledger.open(dir);
  const journal = new Journal(join(dir, "watch"));
  const quota = new QuotaGovernor(journal.dir, capsFromEnv());

  const server = buildServer();
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "earthdeck-watch", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const rawCall: ToolCall = async (tool, a) => {
    const res = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 120_000 });
    const texts = (res.content as { type: string; text?: string }[]).filter((c) => c.type === "text" && typeof c.text === "string");
    const text = texts[texts.length - 1]?.text ?? "";
    if (res.isError) {
      const d = errorDetail(text);
      throw new ToolError(tool, d.message, d.status, d.body);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(tool, "non-JSON result");
    }
  };
  // Every governed tool call is counted against today's per-provider cap (quota.json).
  const call = quota.wrap(rawCall);
  const usage = () => `cdse ${quota.used("cdse")}/${quota.caps.cdse} · gfw ${quota.used("gfw")}/${quota.caps.gfw} · firms ${quota.used("firms")}/${quota.caps.firms}`;

  out(`earthdeck watch — ${watchlists.length} watchlist(s), ${watchlists.reduce((n, w) => n + w.aois.length, 0)} AOIs, rules: ${[...RULES.keys()].join(", ")}${dryRun ? " — DRY RUN" : ""}`);
  out(`ledger: ${dir}${shard ? ` · shard ${shard.index}/${shard.count}` : ""}${budgetSec !== undefined ? ` · time budget ${budgetSec}s` : ""}`);
  out(`quota ${quota.day} before: ${usage()}`);
  const report = await sweep({ watchlists, rules: RULES, ledger, journal, call, dryRun, maxPairs, onlyRules, delayMs, shard, deadline, quota, log: out });
  out("");
  out(`sweep ${report.sweepId}: ${report.pairs} pairs · ${report.created.length} opened · ${report.confirmed.length} confirmed · ${report.evidenceAdded.length} evidence added · ${report.expired.length} expired · ${report.gaps.length} gaps · ${report.skipped.length} skipped`);
  for (const s of report.skipped) out(`  ○ ${s.rule} @ ${s.aoi}: ${s.reason}`);
  for (const g of report.gaps) out(`  ✗ ${g.rule} @ ${g.aoi}: ${g.message}`);
  if (report.budgetExhausted) out(`budget exhausted: ${report.budgetExhausted.done} of ${report.budgetExhausted.total} pairs done`);
  out(`quota ${quota.day} after: ${usage()}`);
  if (!dryRun) {
    const v = ledger.verify();
    out(v.ok ? `ledger verified ✓ (${v.size} entries, root ${v.root.slice(0, 16)}…)` : `ledger verify FAILED: ${v.problems.map((p) => p.message).join("; ")}`);
  }
  await client.close();
  await server.close();
}

/** The tool's error message, plus the upstream status/body when `errorResult` reported them. */
function errorDetail(text: string): { message: string; status?: number; body?: unknown } {
  try {
    const j = JSON.parse(text) as { error?: string; status?: number; body?: unknown };
    if (j.error) return { message: j.error, ...(typeof j.status === "number" ? { status: j.status } : {}), ...(j.body !== undefined ? { body: j.body } : {}) };
  } catch {
    /* plain text */
  }
  return { message: text.split("\n")[0]?.slice(0, 200) ?? "error" };
}
