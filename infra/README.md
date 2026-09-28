# earthdeck on AWS — hosting Earth Watch

One CloudFormation stack (`infra/earthdeck.yaml`, stack name `earthdeck`, **us-east-1**)
runs the scheduled watch sweeps on Lambda, keeps the signed findings ledger in S3, and
serves the static Earth Watch site at `https://earthdeck.marcsperzel.com/`.

```
                EventBridge Scheduler (UTC, every 6 h from 00/06/12/18, staggered)
     +0:00…+1:10 generated shards 0–7   +1:20 analyst   +1:30 export   +1:40 hand-written lists
                               │  async invoke, JSON payload
                               ▼
  SSM /earthdeck/* ──► Lambda "earthdeck" (Node 22, arm64, 900 s, 1 GB, concurrency 1)
  (SecureString)        │ 1. secrets → env      2. s3://…state/ledger/ → /tmp/ledger
                        │ 3. node dist/cli.js watch --once | analyst --once | watch export
                        │ 4. ledger verify ✓ → push /tmp/ledger back (+ ledger/checkpoints/<iso>)
                        │ 5. state/heartbeat.json + metric earthdeck/JobSuccess
                        ▼                                   ▼
          S3 earthdeck-state-<acct>             S3 earthdeck-site-<acct> (export output)
          (versioned, private)                    │ OAC (private bucket)
                                                  ▼
          CloudWatch alarm: no JobSuccess   CloudFront (ACM cert, http2+3, IPv6)
          for 14 h → SNS → email                  ▲
                                          Route 53 A/AAAA alias earthdeck.marcsperzel.com
```

Files: `infra/earthdeck.yaml` (the whole stack) · `src/runner/` (Lambda handler; not part
of the MCP server) · `scripts/build-lambda.sh` · `scripts/deploy.sh` · `scripts/run-job.sh`
· `scripts/seed-state.sh` · `infra/placeholder/index.html`.

## First deploy

Prereqs: AWS CLI v2 with profile `personal` (account `185692190330`), Node 22, pnpm, and
`.env` in the repo root with `GFW_API_KEY`, `CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`,
`FIRMS_MAP_KEY`, `ANTHROPIC_API_KEY` (any left empty are skipped with a warning).

```bash
pnpm install --frozen-lockfile
scripts/deploy.sh
```

That one command:

1. checks the profile really is account `185692190330` (aborts otherwise);
2. builds `build/earthdeck-lambda.zip` (~5.5 MB) and names it by content hash;
3. **first run only**: deploys the stack with `DeployFunction=false` — buckets, ACM
   certificate (DNS-validated automatically in zone `Z00187933CPH1RMT9RKHT`), CloudFront,
   Route 53 records. **Expect 5–20 minutes** (ACM validation, then CloudFront rollout); the
   command waits. This phase exists because the function's zip must be in the artifacts
   bucket before the function can be created, and that bucket is part of the stack
   (the chicken-and-egg);
4. uploads the zip to `s3://earthdeck-artifacts-<acct>/lambda/earthdeck-<hash>.zip`;
5. creates the SSM SecureStrings `/earthdeck/<NAME>` **only if absent** (values read from
   `.env`, passed via a 0600 temp file, never printed) and `/earthdeck/ledger-key`:
   `EARTHDECK_LEDGER_KEY` from `.env` if set, else `data/ledger/ledger.key` if present
   (so a seeded local ledger keeps verifying), else a fresh random 32-byte seed. It prints
   the resulting **public** key — that is the `ledger.pub` to publish;
6. deploys the full stack (function, schedules, alarm) — ~1–2 min;
7. uploads the "first export pending" placeholder if the site bucket is empty; prints outputs.

Then:

- **Confirm the SNS subscription** email sent to `me@marcsperzel.com` (otherwise no alarms).
- Optional — carry the local ledger over (before the first scheduled sweep, or with
  `EARTHDECK_SCHEDULES=DISABLED scripts/deploy.sh` to pause schedules meanwhile):
  `scripts/seed-state.sh` (verifies locally, checks the key matches SSM, refuses to
  overwrite a non-empty production ledger without `--force`).
- Smoke test: `scripts/run-job.sh sweep controls --dry-run`, then
  `scripts/run-job.sh sweep controls`, then `scripts/run-job.sh export`.

Re-running `scripts/deploy.sh` any time is safe: a changed zip gets a new key and CFN
updates the function; unchanged code → "No changes to deploy"; existing secrets are never
touched. Pause/resume all schedules: `EARTHDECK_SCHEDULES=DISABLED|ENABLED scripts/deploy.sh`.

## How a run works

Payload: `{ "job": "sweep"|"analyst"|"export"|"all", "watchlist"?: W, "shard"?: "i/n", "timeBudgetSec"?: N, "dryRun"?: true }`
where `W` is a hand-written list (`amazon`|`congo-borneo`|`controls`|`methane`|`flaring` →
`watchlists/<W>.json`), `all-handwritten` (those five), `all-generated` (every file in
`watchlists/generated/`) or `generated/<name>` (`watchlists/generated/<name>.json`).
`watchlist`/`shard`/`timeBudgetSec`/`dryRun` only with `sweep`; no `watchlist` = every
top-level `watchlists/*.json`. `all` = five hand-written sweeps + analyst + export, manual use —
it may not fit in 900 s.

- **Every sweep in Lambda is time-budgeted**: the runner passes
  `--time-budget` = remaining invocation time − 90 s (or `timeBudgetSec`, whichever is smaller)
  to `node dist/cli.js watch --once`. The kernel stops opening new pairs when one more pair (as
  slow as the slowest so far) would overrun, finishes the current one, writes watermarks /
  journal / ledger as usual and exits 0 with `budget exhausted: k of n pairs done`. As a
  backstop the child is SIGTERMed at remaining − 60 s, leaving the rest for verify + upload.
- **Shards**: `--shard i/n` keeps only pairs with `sha256(aoi.id, rule) mod n == i` — disjoint,
  deterministic, independent of file order. Within a sweep, pairs run **least-recently-swept
  first** (never-swept first of all, by watermark), so a budget- or quota-cut sweep resumes
  where the last one left off and nothing starves.
- **Quotas** (below): pairs whose provider's daily cap is spent are `skipped` with reason
  `quota:<provider>` (journaled, watermark untouched).

- The ledger working copy is `ledger/` in the state bucket minus `ledger/checkpoints/` (the
  archive) and `ledger.key` (never stored). It is downloaded fresh every run.
- After a non-dry sweep / analyst the runner runs `earthdeck ledger verify`. Only if that
  passes **and** the ledger did not shrink does it push changed files back (and delete tiles
  the CLI removed), then archive the new checkpoint as `ledger/checkpoints/<iso>`.
  A sweep that crashed after appending still has its verified entries kept, but the job is
  reported failed.
- Writing jobs refuse to start without `/earthdeck/ledger-key` — otherwise the CLI would
  mint a new key and sign with it.
- `analyst` and `watch export` are probed via `node dist/cli.js --help`; if this build
  lacks them the step reports `unavailable` ("not available in this build") and is not an
  error. Export uploads `/tmp/site` with per-file `Content-Type`/`Cache-Control`
  (`*.html`, `api/*`, `ledger/*` 60 s; hashed `assets/*-<hash>.*` 1 year immutable; rest 5 min),
  then invalidates `/*`. Export does not delete stale site objects.
- Success (non-dry) → `state/heartbeat.json` + metric `earthdeck/JobSuccess = 1`.
  Failure → the invocation errors (visible in Lambda `Errors`); async retries are 0 —
  the next slot catches up via watermarks.

The AWS SDK v3 is **not** in the zip: the Lambda Node.js 22 runtime ships it. The
`@aws-sdk/client-*` packages are exact-pinned devDependencies for typechecking only; the
runner loads them lazily (`import()`, falling back to `require` via `NODE_PATH`).

## Schedule

Every 6 hours, windows starting 00:00 / 06:00 / 12:00 / 18:00 UTC (11 schedules, all behind
`SchedulesState`):

| Offset | Schedule | Payload |
| --- | --- | --- |
| +0:00 | `earthdeck-sweep-shard-0` | `{"job":"sweep","watchlist":"all-generated","shard":"0/8"}` |
| +0:10 … +1:10 | `earthdeck-sweep-shard-1` … `-7` (every 10 min) | same, `shard` `1/8` … `7/8` |
| +1:20 | `earthdeck-analyst` | `{"job":"analyst"}` |
| +1:30 | `earthdeck-export` | `{"job":"export"}` |
| +1:40 | `earthdeck-sweep-handwritten` | `{"job":"sweep","watchlist":"all-handwritten"}` |

- ~350 generated AOIs / 8 shards ≈ 44 pairs per shard; at 1.5 s politeness delay + a few
  seconds of API time per pair that is ~5–8 min, inside the ~13 min budget. A shard that runs
  long is cut by its budget and resumes least-recently-swept first next window.
- Slots are 10 min apart but a run may take up to 15: with concurrency 1 an overlapping
  invocation is throttled and Lambda's async queue retries it (event age ≤ 6 h), so the chain
  drifts later instead of dropping a run. Only one writer ever touches the ledger.
- The hand-written lists run after the export, so their findings are narrated/published in
  the next window (≤ 6 h later).
- 44 invocations/day; the 14 h no-success alarm is unchanged.

## Quotas

Per-UTC-day caps, counted in the ledger's `watch/quota.json` (synced with the ledger, so they
hold across invocations) and set as function env vars in the template:

| Env var | Default | Counts |
| --- | --- | --- |
| `EARTHDECK_MAX_CDSE_CALLS` | 60 | `eo_compare`, `methane_plumes`, `eo_*` tool calls (1 each) |
| `EARTHDECK_MAX_<PROVIDER>_CALLS_<RULE>` | `…_CDSE_CALLS_METHANE_ANOMALY` 10 | per-rule sub-cap inside a provider's cap (rule name upper-cased, `-`→`_`); keeps methane from spending the CDSE budget forest confirmations need |
| `EARTHDECK_MAX_GFW_CALLS` | 400 | `forest_alerts` calls (1 each) |
| `EARTHDECK_MAX_FIRMS_CALLS` | 300 | FIRMS transactions: `fires_in` 1; `flaring` ⌈days/5⌉ × sources (30 d × 2 = 12) |
| `EARTHDECK_MAX_ANALYST_CASES` | 10 | findings the analyst takes on per day (also the `--max` default) |
| `EARTHDECK_MAX_ANALYST_USD` | 3 | analyst API spend per day; journaled as `analyst_spend` |

A pair is skipped `quota:<provider>` when any provider its rule needs (from the rule's
`requires`) is spent — note `forest_loss` needs CDSE (for its NDVI confirmation), so it stops
when CDSE does. A call that would cross a cap mid-pair is refused (skip, not gap). An HTTP 429,
a 403 whose body says quota/limit, or FIRMS's "transaction limit" text marks that provider
exhausted for the rest of the run.

Expected demand for ~350 AOIs (assumed mix — one rule each: 170 `forest_loss`, 90
`fires_in_protected`, 45 `flaring`, 45 `methane_anomaly`; recompute when the generated lists
land):

| Provider | Per pair | Per full pass | Per day (4 passes) | Daily cap | Effective revisit under the cap | Provider's own limit |
| --- | --- | --- | --- | --- | --- | --- |
| GFW | forest 2 | 340 | 1,360 | 400 | forest pairs ~1.2×/day | rate-limited per key (UNCONFIRMED figure) |
| CDSE | forest 0–1 (confirm only; ~10% → 17), methane 1 | ~62 (45–215) | ~250 (180–860) | 60 | methane ~1×/day; forest capped with it | processing units / requests per month (UNCONFIRMED figure) |
| FIRMS | fires 2 (1 when quiet), flaring ~12 | 720 (180 + 540) | 2,880 | 300 | FIRMS pairs ~every 2.4 days | 5,000 transactions / 10 min per map key |
| Anthropic | ≈ $0.10 per case (narrate + review) | — | ≤ 10 cases | $3 | — | — |

The caps, not Lambda time, set the revisit rate. FIRMS's own limit is per 10 minutes, so
`EARTHDECK_MAX_FIRMS_CALLS` can be raised without risk (deployed: 6,000 — measured 2026-09-28,
a full pass now spends ~1,000–1,250, so 3,000 ran out by ~13:00 UTC and starved the evening sweep); raising CDSE needs the account's monthly PU budget checked first. Caps
reset at 00:00 UTC, so the 00:00 window's shards spend them first; later windows sweep what
is left, least-recently-swept first within each shard.

## Monthly cost (estimate)

| Item | Usage | ≈ USD/month |
| --- | --- | --- |
| Lambda (arm64, 1 GB) | 44 invocations/day ≈ 1,320/month; shards ~8 min, others ~2 min ≈ 500k GB-s (worst case 900 s each ≈ 1.19M GB-s) | ~1.5 over the 400k GB-s free tier; ≤ 11 worst case |
| S3 (3 buckets, versioned state) | tens of MB, a few thousand PUT/GET | < 0.20 |
| CloudFront | low traffic; 1 TB + 10M requests/month always-free; ~120 `/*` invalidations (1,000 free) | ~0 |
| Route 53 | existing zone (already paid); alias queries free | 0 extra |
| SSM + KMS | standard parameters free; `aws/ssm` key free; ~5k decrypts | < 0.05 |
| CloudWatch | 1 custom metric 0.30 + 1 alarm 0.10 + small log ingest (30-day retention) | ~0.50 |
| EventBridge Scheduler, ACM, SNS email | well inside free tiers | 0 |
| **Total** | | **~2–5** (analyst Anthropic spend is separate, capped at $3/day ≈ $90/month) |

## Key rotation

- **API keys** (`/earthdeck/GFW_API_KEY` etc.): `deploy.sh` never overwrites; rotate with
  `aws --profile personal --region us-east-1 ssm put-parameter --name /earthdeck/FIRMS_MAP_KEY --type SecureString --overwrite --value file://<(printf %s "$NEW")`
  (or delete the parameter and re-run `deploy.sh` with the new value in `.env`). The next
  invocation picks it up.
- **Ledger signing key**: do **not** simply overwrite `/earthdeck/ledger-key` — entries and
  the checkpoint signed by the old key would stop verifying under the new one, and every run
  would refuse to upload. Rotating needs ledger support for multiple verifying keys
  (C2SP notes allow extra signature lines; the store currently verifies with one key).
  Until then, keep the seed stable; it is recoverable from SSM
  (`get-parameter --with-decryption`) and should be backed up offline.

## Tear-down

```bash
P="--profile personal --region us-east-1"; A=185692190330
aws $P s3 rm s3://earthdeck-artifacts-$A --recursive     # the only bucket CFN deletes
aws $P cloudformation delete-stack --stack-name earthdeck
aws $P cloudformation wait stack-delete-complete --stack-name earthdeck
# kept on purpose (DeletionPolicy: Retain): earthdeck-state-$A (the ledger) and earthdeck-site-$A.
# Delete them by hand only if you mean it (versioned: remove all versions first).
aws $P ssm delete-parameters --names /earthdeck/GFW_API_KEY /earthdeck/CDSE_CLIENT_ID \
  /earthdeck/CDSE_CLIENT_SECRET /earthdeck/FIRMS_MAP_KEY /earthdeck/ANTHROPIC_API_KEY   # keep ledger-key unless abandoning the ledger
```

If you redeploy after a tear-down, delete or import the retained state/site buckets first —
CFN cannot create a bucket whose name already exists.

## Troubleshooting

- **Stack stuck on the certificate** — ACM DNS validation normally completes in minutes;
  check the `_…acm-validations.aws.` CNAME appeared in zone `marcsperzel.com.` and that no
  CAA record forbids `amazon.com`.
- **`ROLLBACK_COMPLETE` after a failed first create** — `deploy.sh` stops; delete the stack
  and re-run. Retained buckets from the failed attempt must be emptied/deleted first.
- **`ReservedConcurrentExecutions` rejected** ("decreases account's UnreservedConcurrentExecution
  below its minimum value") — new accounts can have a concurrency quota of 10; request a
  Lambda concurrent-executions quota increase (Service Quotas), then re-deploy.
- **`run-job.sh` gets `TooManyRequestsException`** — a scheduled job is running (concurrency 1). Retry.
- **Job fails with "EARTHDECK_LEDGER_KEY missing"** — `/earthdeck/ledger-key` absent; re-run `deploy.sh`.
- **"ledger verify failed" every run** — the production ledger was signed by a different key
  than `/earthdeck/ledger-key` (e.g. seeded with a mismatched key). Nothing was uploaded;
  fix the key or restore a previous object version (the state bucket is versioned).
- **Alarm email "no successful job for 14 h"** — `aws --profile personal --region us-east-1 logs tail /aws/lambda/earthdeck --since 1d`,
  and `s3://earthdeck-state-185692190330/state/heartbeat.json` for the last success.
- **Site shows the placeholder** — the export job is `unavailable` in this build or hasn't
  run yet; `scripts/run-job.sh export`.
- **Sweeps time out at 900 s** — should not happen (every Lambda sweep is time-budgeted); if
  one does, a single call hung past the budget. Watermarks mean a killed sweep resumes next
  slot. `budget exhausted: k of n pairs done` in the log is normal, not an error.
- **Many `quota:<provider>` skips** — the daily cap is spent (see Quotas); check
  `ledger/watch/quota.json` in the state bucket, raise the env var in the template if the
  provider allows it.
