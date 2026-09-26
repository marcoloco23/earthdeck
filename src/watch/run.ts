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
import { sweep } from "./kernel.js";
import { RULES, ToolError, type ToolCall } from "./rules/index.js";
import { loadWatchlists } from "./watchlist.js";

const out = (s: string) => process.stdout.write(`${s}\n`);

export async function runWatch(args: string[]): Promise<void> {
  const flag = (name: string) => args.includes(name);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!flag("--once")) {
    out("usage: earthdeck watch --once [--watchlist <file|dir>] [--dry-run] [--max N] [--rules a,b] [--delay-ms N]");
    out("       Runs one sweep. Schedule it (cron / GitHub Actions); watermarks handle late or missed runs.");
    process.exitCode = 2;
    return;
  }
  const wlPath = opt("--watchlist") ?? (existsSync("watchlists") ? "watchlists" : undefined);
  if (!wlPath) throw new Error("no watchlists: pass --watchlist <file|dir> or create ./watchlists/*.json");
  const watchlists = loadWatchlists(wlPath);
  const dryRun = flag("--dry-run");
  const maxPairs = opt("--max") ? Number(opt("--max")) : undefined;
  const onlyRules = opt("--rules")?.split(",").map((s) => s.trim());
  const delayMs = opt("--delay-ms") ? Number(opt("--delay-ms")) : 1500;

  const dir = ledgerDir();
  const ledger = Ledger.open(dir);
  const journal = new Journal(join(dir, "watch"));

  const server = buildServer();
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "earthdeck-watch", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const call: ToolCall = async (tool, a) => {
    const res = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 120_000 });
    const texts = (res.content as { type: string; text?: string }[]).filter((c) => c.type === "text" && typeof c.text === "string");
    const text = texts[texts.length - 1]?.text ?? "";
    if (res.isError) throw new ToolError(tool, firstLine(text));
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(tool, "non-JSON result");
    }
  };

  out(`earthdeck watch — ${watchlists.length} watchlist(s), ${watchlists.reduce((n, w) => n + w.aois.length, 0)} AOIs, rules: ${[...RULES.keys()].join(", ")}${dryRun ? " — DRY RUN" : ""}`);
  out(`ledger: ${dir}`);
  const report = await sweep({ watchlists, rules: RULES, ledger, journal, call, dryRun, maxPairs, onlyRules, delayMs, log: out });
  out("");
  out(`sweep ${report.sweepId}: ${report.pairs} pairs · ${report.created.length} opened · ${report.confirmed.length} confirmed · ${report.evidenceAdded.length} evidence added · ${report.expired.length} expired · ${report.gaps.length} gaps · ${report.skipped.length} skipped`);
  for (const s of report.skipped) out(`  ○ ${s.rule} @ ${s.aoi}: ${s.reason}`);
  for (const g of report.gaps) out(`  ✗ ${g.rule} @ ${g.aoi}: ${g.message}`);
  if (!dryRun) {
    const v = ledger.verify();
    out(v.ok ? `ledger verified ✓ (${v.size} entries, root ${v.root.slice(0, 16)}…)` : `ledger verify FAILED: ${v.problems.map((p) => p.message).join("; ")}`);
  }
  await client.close();
  await server.close();
}

function firstLine(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string };
    if (j.error) return j.error;
  } catch {
    /* plain text */
  }
  return text.split("\n")[0]?.slice(0, 200) ?? "error";
}
