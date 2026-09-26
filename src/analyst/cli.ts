// `earthdeck analyst --once` — narrate, review and (when the gates pass) publish confirmed
// findings. Like `watch`, there is no loop: schedule `--once` after each sweep.

import { join } from "node:path";
import { anthropicApiKey, ledgerDir } from "../config.js";
import { OverviewError } from "../errors.js";
import { Ledger } from "../ledger/store.js";
import { Journal } from "../watch/journal.js";
import { capsFromEnv, QuotaGovernor } from "../watch/quota.js";
import { DEFAULT_NARRATOR, DEFAULT_REVIEWER, runAnalyst } from "./analyst.js";

const out = (s: string) => process.stdout.write(`${s}\n`);

export async function runAnalystCli(args: string[]): Promise<void> {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!args.includes("--once")) {
    out("usage: earthdeck analyst --once [--max N] [--dry-run] [--model-narrator id] [--model-reviewer id]");
    out("       --max defaults to EARTHDECK_MAX_ANALYST_CASES (10), which is also the per-UTC-day case cap;");
    out("       the run stops once today's API spend reaches EARTHDECK_MAX_ANALYST_USD (3).");
    out(`       Narrates confirmed findings (${DEFAULT_NARRATOR}), has a different model review them (${DEFAULT_REVIEWER}),`);
    out("       and publishes those that pass the gates. Needs ANTHROPIC_API_KEY.");
    process.exitCode = 2;
    return;
  }
  const caps = capsFromEnv();
  const max = opt("--max") ? Number(opt("--max")) : caps.analystCases;
  if (!Number.isInteger(max) || max < 1) throw new Error("--max must be a positive integer");
  const dryRun = args.includes("--dry-run");
  const dir = ledgerDir();
  const ledger = Ledger.open(dir, { createKey: !dryRun });
  const journal = new Journal(join(dir, "watch"));
  const quota = new QuotaGovernor(journal.dir, caps);
  out(`earthdeck analyst — ledger ${dir}${dryRun ? " — DRY RUN (one narration call per finding, nothing appended)" : ""}`);
  let r: Awaited<ReturnType<typeof runAnalyst>>;
  try {
    r = await runAnalyst({ ledger, journal, apiKey: anthropicApiKey(), narrator: opt("--model-narrator"), reviewer: opt("--model-reviewer"), max, dryRun, quota, log: out });
  } catch (err) {
    if (!(err instanceof OverviewError)) throw err;
    process.stderr.write(`earthdeck analyst: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  out("");
  out(`analyst ${r.runId}: ${r.selected} selected · ${r.narrated.length} narrated · ${r.published.length} published · ${r.held.length} held · ${r.rejected.length} rejected · ${r.errors.length} errors · ${r.calls} API calls ≈ $${r.costUsd.toFixed(4)} · today $${quota.analystUsd().toFixed(4)} of $${caps.analystUsd}`);
  if (r.errors.length) process.exitCode = 1;
}
