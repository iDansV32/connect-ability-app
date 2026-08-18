#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$REPO_DIR"

export CONNECT_API_PORT="${CONNECT_API_PORT:-3030}"

if [[ -z "${CONNECT_API_TOKEN:-}" && "${CONNECT_API_ALLOW_UNAUTHENTICATED_LOCALHOST:-}" != "true" ]]; then
  echo "CONNECT_API_TOKEN is required for the HTTP API. For explicit local-only development, set CONNECT_API_ALLOW_UNAUTHENTICATED_LOCALHOST=true." >&2
  exit 1
fi

exec /opt/homebrew/bin/node "$REPO_DIR/connect-mcp-server.js" --http-only --port "$CONNECT_API_PORT"
