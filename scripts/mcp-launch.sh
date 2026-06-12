#!/usr/bin/env bash
# Launch the earthdeck MCP server with .env loaded (for local dev / Cursor MCP config).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
# Push cards to the local dashboard when it's running (default :5005).
export EARTHDECK_DASHBOARD_URL="${EARTHDECK_DASHBOARD_URL:-http://127.0.0.1:5005}"
exec node "$ROOT/dist/cli.js"
