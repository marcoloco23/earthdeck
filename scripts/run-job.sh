#!/usr/bin/env bash
# Invoke the earthdeck Lambda synchronously, print its result, then tail its log group.
#
#   scripts/run-job.sh sweep controls --dry-run
#   scripts/run-job.sh sweep amazon
#   scripts/run-job.sh sweep all-generated --shard 3/8
#   scripts/run-job.sh sweep generated/forest-hotspots --time-budget 300 --dry-run
#   scripts/run-job.sh analyst
#   scripts/run-job.sh export
#
# Concurrency is 1: if a scheduled job is running, this invoke is throttled — retry later.
set -euo pipefail

PROFILE=${AWS_PROFILE:-personal}
REGION=us-east-1
FUNCTION=earthdeck

usage() { echo "usage: $0 <sweep|analyst|export|all> [watchlist] [--shard i/n] [--time-budget SEC] [--dry-run]" >&2; exit 2; }
[ $# -ge 1 ] || usage
JOB=$1
shift
WATCHLIST=""
SHARD=""
BUDGET=""
DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true ;;
    --shard) [ $# -ge 2 ] || usage; SHARD=$2; shift ;;
    --time-budget) [ $# -ge 2 ] || usage; BUDGET=$2; shift ;;
    -*) usage ;;
    *) WATCHLIST=$1 ;;
  esac
  shift
done
case "$SHARD" in "" | [0-9]*/[0-9]*) ;; *) usage ;; esac
case "$BUDGET" in "" | *[!0-9]*) [ -z "$BUDGET" ] || usage ;; esac
case "$JOB" in sweep | analyst | export | all) ;; *) usage ;; esac

PAYLOAD="{\"job\":\"$JOB\""
[ -n "$WATCHLIST" ] && PAYLOAD="$PAYLOAD,\"watchlist\":\"$WATCHLIST\""
[ -n "$SHARD" ] && PAYLOAD="$PAYLOAD,\"shard\":\"$SHARD\""
[ -n "$BUDGET" ] && PAYLOAD="$PAYLOAD,\"timeBudgetSec\":$BUDGET"
[ "$DRY" = true ] && PAYLOAD="$PAYLOAD,\"dryRun\":true"
PAYLOAD="$PAYLOAD}"

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
echo "invoking $FUNCTION with $PAYLOAD (sync, up to 15 min)…"
START=$(date +%s)
META=$(aws --profile "$PROFILE" --region "$REGION" lambda invoke \
  --function-name "$FUNCTION" \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 960 \
  --payload "$PAYLOAD" \
  "$OUT")
echo "$META"
echo "--- result ---"
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");try{console.log(JSON.stringify(JSON.parse(t),null,2))}catch{console.log(t)}' "$OUT"

MINUTES=$(( ( $(date +%s) - START ) / 60 + 2 ))
echo "--- log (last ${MINUTES} min) ---"
aws --profile "$PROFILE" --region "$REGION" logs tail "/aws/lambda/$FUNCTION" --since "${MINUTES}m" --format short || true

case "$META" in *FunctionError*) exit 1 ;; esac
