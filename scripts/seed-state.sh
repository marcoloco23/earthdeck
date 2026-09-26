#!/usr/bin/env bash
# Seed the production ledger (s3://earthdeck-state-<acct>/ledger/) from a local ledger dir.
#
#   scripts/seed-state.sh            refuses if production already has entries
#   scripts/seed-state.sh --force    overwrite (the bucket is versioned — old objects recoverable)
#
# Checks first: the local ledger verifies, and its public key matches the production seed in
# SSM /earthdeck/ledger-key (otherwise every scheduled run would fail `ledger verify` and
# refuse to upload). ledger.key itself never leaves this machine.
set -euo pipefail

PROFILE=${AWS_PROFILE:-personal}
REGION=us-east-1
EXPECTED_ACCOUNT=185692190330
SRC=${EARTHDECK_LEDGER_DIR:-data/ledger}
FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
awsx() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$SRC/entries.jsonl" ] || die "no ledger at $SRC (entries.jsonl missing)"
ACCOUNT=$(awsx sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "$EXPECTED_ACCOUNT" ] || die "profile $PROFILE is account $ACCOUNT, expected $EXPECTED_ACCOUNT"
BUCKET="earthdeck-state-$ACCOUNT"

[ -f dist/cli.js ] || pnpm build >/dev/null
echo "verifying $SRC …"
EARTHDECK_LEDGER_DIR="$SRC" node dist/cli.js ledger verify || die "local ledger does not verify — not seeding"

# Key match: derive the public key from the SSM seed (in memory only) and compare.
SEED=$(awsx ssm get-parameter --name /earthdeck/ledger-key --with-decryption --query Parameter.Value --output text 2>/dev/null || true)
[ -n "$SEED" ] || die "SSM /earthdeck/ledger-key not found — run scripts/deploy.sh first (it adopts $SRC/ledger.key if present)"
REMOTE_PUB=$(printf '%s' "$SEED" | node scripts/ledger-pubkey.mjs)
unset SEED
if [ -f "$SRC/ledger.key" ]; then
  LOCAL_PUB=$(tr -d '[:space:]' <"$SRC/ledger.key" | node scripts/ledger-pubkey.mjs)
elif [ -f "$SRC/ledger.pub" ]; then
  LOCAL_PUB=$(tr -d '[:space:]' <"$SRC/ledger.pub")
else
  die "$SRC has neither ledger.key nor ledger.pub — cannot check the signing key"
fi
[ "$LOCAL_PUB" = "$REMOTE_PUB" ] || die "local ledger key ($LOCAL_PUB) ≠ production key ($REMOTE_PUB) — seeding would break verify"
echo "signing key matches production ✓ ($LOCAL_PUB)"

if awsx s3api head-object --bucket "$BUCKET" --key ledger/entries.jsonl >/dev/null 2>&1 && [ "$FORCE" != true ]; then
  die "s3://$BUCKET/ledger/ already has entries — pass --force to overwrite (bucket is versioned)"
fi

awsx s3 sync "$SRC" "s3://$BUCKET/ledger" --delete \
  --exclude ledger.key --exclude '*.tmp' --exclude 'checkpoints/*'
echo "seeded s3://$BUCKET/ledger from $SRC"
