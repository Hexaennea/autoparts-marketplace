#!/usr/bin/env bash
# Seeds an isolated PostgreSQL database, starts the app on :8100, runs the browser journeys, stops the app.
# Needs E2E_DATABASE_URL (a database the run may wipe), e.g. postgres://partpilot:...@localhost:5432/partpilot_e2e
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
: "${E2E_DATABASE_URL:?Set E2E_DATABASE_URL to a throwaway PostgreSQL database}"
export DATABASE_URL="$E2E_DATABASE_URL" PARTPILOT_UPLOAD_DIR="$WORK/uploads" PARTPILOT_RATE_LIMIT=0 \
       PARTPILOT_PUBLIC_URL="http://127.0.0.1:8100" PORT=8100

cd "$ROOT/server"
npx tsx src/cli.ts seed --reset >/dev/null
npx tsx src/main.ts >/dev/null &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 100); do curl -sf http://127.0.0.1:8100/api/health >/dev/null && break; sleep 0.2; done

cd "$ROOT/e2e"
E2E_BASE=http://127.0.0.1:8100 node --test --test-concurrency=1 flows.test.mjs
