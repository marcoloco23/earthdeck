// AWS Lambda entry point (handler `dist/runner/lambda.handler`, Node.js 22). EventBridge
// Scheduler invokes it with `{ job, watchlist?, shard?, timeBudgetSec?, dryRun? }`; it loads secrets from SSM, pulls
// the ledger from the state bucket into /tmp, runs `node dist/cli.js …`, and — only when
// `ledger verify` passes — pushes the ledger back. See infra/README.md.
//
// Not imported by the MCP server / CLI; only Lambda loads this module.

import { fileURLToPath } from "node:url";
import { cloudFrontInvalidator, jobSuccessMetric, readParameters, s3Store } from "./aws.js";
import { envFromParameters, parsePayload, runPayload, spawnCli, type RunResult } from "./core.js";

interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

/** Leave this much of the 900 s for verify + upload after the CLI child. */
const RESERVE_MS = 120_000;

export async function handler(event: unknown, context?: LambdaContext): Promise<RunResult> {
  const payload = parsePayload(event);
  const region = process.env.AWS_REGION ?? "us-east-1";
  const prefix = process.env.EARTHDECK_SSM_PREFIX ?? "/earthdeck";
  const log = (s: string) => console.log(s);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

  const secrets = envFromParameters(prefix, await readParameters(region, prefix));
  log(`[runner] payload ${JSON.stringify(payload)}; secrets loaded: ${Object.keys(secrets).sort().join(", ") || "(none)"}`);

  const result = await runPayload(
    payload,
    {
      stateBucket: need("EARTHDECK_STATE_BUCKET"),
      siteBucket: need("EARTHDECK_SITE_BUCKET"),
      distributionId: need("EARTHDECK_DISTRIBUTION_ID"),
      ledgerDir: "/tmp/ledger",
      siteDir: "/tmp/site",
      env: { ...process.env, ...secrets, HOME: "/tmp" },
      budgetMs: () => (context ? context.getRemainingTimeInMillis() - RESERVE_MS : 780_000),
      // Sweeps get `--time-budget` = remaining − 90 s from this (see sweepTiming in core.ts).
      ...(context ? { remainingMs: () => context.getRemainingTimeInMillis() } : {}),
    },
    {
      store: await s3Store(region),
      invalidateAll: await cloudFrontInvalidator(region),
      jobSuccess: await jobSuccessMetric(region),
      exec: spawnCli(cliPath, root, log),
      log,
      now: () => new Date(),
    },
  );
  // A thrown error marks the invocation failed (Lambda Errors metric, async retry policy);
  // "unavailable" steps (subcommand not in this build) are reported but are not failures.
  if (!result.ok) throw new Error(`earthdeck job failed: ${JSON.stringify(result.steps.map((s) => ({ job: s.job, watchlist: s.watchlist, status: s.status, reason: s.reason, exitCode: s.exitCode })))}`);
  return result;
}
