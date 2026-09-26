#!/usr/bin/env bash
# Deploy (or update) the earthdeck stack. Idempotent — safe to re-run after any change.
#
#   1. build build/earthdeck-lambda.zip (content-addressed S3 key → CFN sees code changes)
#   2. first deploy only: create the stack without the function (DeployFunction=false) so the
#      artifacts bucket exists before the function that needs a zip in it (chicken-and-egg)
#   3. upload the zip to the artifacts bucket
#   4. SSM SecureStrings under /earthdeck/ — created only if absent, values from ./.env,
#      /earthdeck/ledger-key adopted from .env / data/ledger/ledger.key or freshly generated.
#      Done before the function deploy so the first scheduled run already has them.
#   5. full deploy (function, schedules, alarm)
#   6. placeholder page into the site bucket if it is empty; print outputs
#
# Optional env: AWS_PROFILE (default personal), EARTHDECK_SCHEDULES=ENABLED|DISABLED.
set -euo pipefail

PROFILE=${AWS_PROFILE:-personal}
REGION=us-east-1
STACK=earthdeck
EXPECTED_ACCOUNT=185692190330
DOMAIN=${EARTHDECK_DOMAIN:-vitalearth.io}
HOSTED_ZONE_ID=${EARTHDECK_HOSTED_ZONE_ID:-Z07362552JHZID1QJ2DSR}
NOTIFY_EMAIL=me@marcsperzel.com
SSM_PREFIX=/earthdeck
SECRETS=(GFW_API_KEY CDSE_CLIENT_ID CDSE_CLIENT_SECRET FIRMS_MAP_KEY ANTHROPIC_API_KEY)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMPD=$(mktemp -d)
chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

awsx() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# KEY's value from ./.env without sourcing it (last assignment wins; surrounding quotes stripped).
env_value() {
  [ -f "$ROOT/.env" ] || return 0
  local line
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ROOT/.env" | tail -n 1 || true)
  [ -n "$line" ] || return 0
  line=${line#*=}
  line=${line%$'\r'}
  case "$line" in
    \"*\") line=${line#\"}; line=${line%\"} ;;
    \'*\') line=${line#\'}; line=${line%\'} ;;
  esac
  printf '%s' "$line"
}

stack_output() {
  awsx cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text 2>/dev/null || true
}

cfn_deploy() { # $1 = DeployFunction, $2 = ArtifactKey
  local extra=()
  [ -n "${EARTHDECK_SCHEDULES:-}" ] && extra+=("SchedulesState=$EARTHDECK_SCHEDULES")
  awsx cloudformation deploy \
    --stack-name "$STACK" \
    --template-file infra/earthdeck.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --tags Project=earthdeck \
    --parameter-overrides \
      "DomainName=$DOMAIN" \
      "HostedZoneId=$HOSTED_ZONE_ID" \
      "NotifyEmail=$NOTIFY_EMAIL" \
      "DeployFunction=$1" \
      "ArtifactKey=$2" \
      ${extra[@]+"${extra[@]}"}
}

# SecureString create-if-absent. The value goes through a 0600 temp file, never argv/stdout.
put_secret() { # $1 = name, $2 = value
  local name=$1 value=$2 err
  if err=$(awsx ssm get-parameter --name "$name" --query Parameter.Name --output text 2>&1 >/dev/null); then
    echo "  = $name (exists, left unchanged)"
    return 0
  fi
  case "$err" in *ParameterNotFound*) ;; *) die "ssm get-parameter $name: $err" ;; esac
  if [ -z "$value" ]; then
    echo "  ! $name: no value in .env — skipped (the jobs that need it will report missing keys)"
    return 0
  fi
  printf '%s' "$value" >"$TMPD/v"
  awsx ssm put-parameter --name "$name" --type SecureString --value "file://$TMPD/v" \
    --tags Key=Project,Value=earthdeck >/dev/null
  rm -f "$TMPD/v"
  echo "  + $name (created)"
}

command -v aws >/dev/null || die "aws CLI v2 not found"
say "account check (profile $PROFILE, $REGION)"
ACCOUNT=$(awsx sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "profile $PROFILE is account $ACCOUNT, expected $EXPECTED_ACCOUNT"
echo "  account $ACCOUNT ✓"

say "build lambda zip"
bash scripts/build-lambda.sh
ZIP=build/earthdeck-lambda.zip
ARTIFACT_KEY="lambda/earthdeck-$(shasum -a 256 "$ZIP" | cut -c1-16).zip"

STATUS=$(awsx cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)
case "$STATUS" in
  ROLLBACK_COMPLETE | ROLLBACK_FAILED | DELETE_FAILED)
    die "stack $STACK is $STATUS — delete it first: aws --profile $PROFILE --region $REGION cloudformation delete-stack --stack-name $STACK" ;;
  *_IN_PROGRESS) die "stack $STACK is $STATUS — wait for it to finish, then re-run" ;;
esac

ARTIFACTS=$(stack_output ArtifactsBucketName)
if [ "$STATUS" = NONE ] || [ -z "$ARTIFACTS" ] || [ "$ARTIFACTS" = None ]; then
  say "first deploy, phase 1: buckets, certificate, CloudFront, DNS (no function yet)"
  echo "  ACM DNS validation + CloudFront creation usually take 5–20 min; the command waits."
  cfn_deploy false pending
  ARTIFACTS=$(stack_output ArtifactsBucketName)
fi
[ -n "$ARTIFACTS" ] && [ "$ARTIFACTS" != None ] || die "stack has no ArtifactsBucketName output"

say "upload $ZIP → s3://$ARTIFACTS/$ARTIFACT_KEY"
awsx s3 cp "$ZIP" "s3://$ARTIFACTS/$ARTIFACT_KEY" --only-show-errors

say "secrets under $SSM_PREFIX/ (create-if-absent; values never printed)"
for name in "${SECRETS[@]}"; do
  put_secret "$SSM_PREFIX/$name" "$(env_value "$name")"
done

# Ledger signing seed: base64 of 32 bytes (what src/ledger/checkpoint.ts keyFromSeed loads).
# Prefer an existing seed so a seeded ledger keeps verifying under the same key.
LK_NAME="$SSM_PREFIX/ledger-key"
if awsx ssm get-parameter --name "$LK_NAME" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "  = $LK_NAME (exists, left unchanged)"
else
  SEED=$(env_value EARTHDECK_LEDGER_KEY)
  SRC=".env EARTHDECK_LEDGER_KEY"
  if [ -z "$SEED" ] && [ -f data/ledger/ledger.key ]; then
    SEED=$(tr -d '[:space:]' <data/ledger/ledger.key)
    SRC="data/ledger/ledger.key"
  fi
  if [ -z "$SEED" ]; then
    SEED=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")
    SRC="freshly generated"
  fi
  PUB=$(printf '%s' "$SEED" | node scripts/ledger-pubkey.mjs) || die "ledger key from $SRC is not a base64 32-byte seed"
  put_secret "$LK_NAME" "$SEED"
  unset SEED
  echo "    source: $SRC — public key (publish this as ledger.pub): $PUB"
fi

say "deploy stack (function + schedules + alarm)"
cfn_deploy true "$ARTIFACT_KEY"

SITE=$(stack_output SiteBucketName)
if [ -z "$(awsx s3 ls "s3://$SITE/" 2>/dev/null || true)" ]; then
  say "site bucket empty → placeholder page"
  awsx s3 cp infra/placeholder/index.html "s3://$SITE/index.html" \
    --content-type 'text/html; charset=utf-8' --cache-control 'public, max-age=60' --only-show-errors
fi

say "outputs"
awsx cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
echo
echo "Next: confirm the SNS email sent to $NOTIFY_EMAIL, then smoke-test:"
echo "  scripts/run-job.sh sweep controls --dry-run"
