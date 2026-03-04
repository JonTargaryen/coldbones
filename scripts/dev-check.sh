#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="http://localhost:8000/api/health"
FRONTEND_URL="http://localhost:5173"
FRONTEND_PROXY_HEALTH_URL="http://localhost:5173/api/health"

fail() {
  echo "❌ $1"
  exit 1
}

echo "Checking backend health: $BACKEND_URL"
if ! curl -fsS "$BACKEND_URL" >/dev/null; then
  fail "Backend is not healthy or not running on port 8000."
fi

echo "Checking frontend server: $FRONTEND_URL"
if ! curl -fsS "$FRONTEND_URL" >/dev/null; then
  fail "Frontend is not reachable on port 5173."
fi

echo "Checking frontend API proxy: $FRONTEND_PROXY_HEALTH_URL"
if ! curl -fsS "$FRONTEND_PROXY_HEALTH_URL" >/dev/null; then
  fail "Frontend proxy to backend failed (/api/health)."
fi

echo "✅ Local dev check passed (backend, frontend, proxy)."
