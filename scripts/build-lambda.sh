#!/usr/bin/env bash
# Build the Lambda deployment zip: build/earthdeck-lambda.zip
#
#   dist/ (server + runner + web)  watchlists/  package.json  node_modules/ (production only)
#
# The AWS SDK v3 is NOT included: the Lambda Node.js 22 runtime provides it, and the
# @aws-sdk/* packages are devDependencies (typechecking only), so a --prod install skips them.
# No AWS calls are made here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/build/lambda"
ZIP="$ROOT/build/earthdeck-lambda.zip"
cd "$ROOT"

pnpm build >/dev/null

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"
cp -R dist watchlists package.json pnpm-lock.yaml pnpm-workspace.yaml "$STAGE/"
rm -rf "$STAGE/dist/"*.tsbuildinfo

# Production deps only, flat (no symlinks in the zip), no lifecycle scripts (prepare = tsc).
(cd "$STAGE" && CI=1 pnpm install --prod --frozen-lockfile --ignore-scripts \
  --config.node-linker=hoisted --config.confirmModulesPurge=false >/dev/null)
rm -f "$STAGE/pnpm-lock.yaml" "$STAGE/pnpm-workspace.yaml"
rm -rf "$STAGE/node_modules/.pnpm" "$STAGE/node_modules/.bin" "$STAGE/node_modules/.modules.yaml"

if [ -d "$STAGE/node_modules/@aws-sdk" ]; then
  echo "error: @aws-sdk ended up in the production node_modules — it must stay a devDependency" >&2
  exit 1
fi

# Deterministic-ish zip: fixed order, no extra attributes.
(cd "$STAGE" && find . -type f | LC_ALL=C sort | zip -q -X -@ "$ZIP")

BYTES=$(wc -c <"$ZIP" | tr -d ' ')
UNZIPPED=$(du -sk "$STAGE" | cut -f1)
printf 'built %s — %s KB zipped, %s KB unzipped\n' "${ZIP#"$ROOT"/}" "$((BYTES / 1024))" "$UNZIPPED"
if [ "$BYTES" -ge $((50 * 1024 * 1024)) ]; then
  echo "error: zip is >= 50 MB (Lambda direct-upload limit via S3 is 250 MB unzipped; trim or move node_modules to a layer)" >&2
  exit 1
fi
