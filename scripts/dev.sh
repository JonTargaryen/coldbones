#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PORT="8000"
FRONTEND_PORT="5173"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but not found."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but not found."
  exit 1
fi

is_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" | tail -n +2 | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1
  else
    return 1
  fi
}

if is_port_in_use "$BACKEND_PORT"; then
  echo "Error: port $BACKEND_PORT is already in use."
  echo "Stop the existing process (or run: npm run dev:stop) and retry."
  exit 1
fi

if is_port_in_use "$FRONTEND_PORT"; then
  echo "Error: port $FRONTEND_PORT is already in use."
  echo "Stop the existing process (or run: npm run dev:stop) and retry."
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo
  echo "Stopping dev servers..."
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Starting backend on http://localhost:8000 ..."
(
  cd "$BACKEND_DIR"
  python3 main.py
) &
BACKEND_PID=$!

echo "Starting frontend on http://localhost:5173 ..."
(
  cd "$FRONTEND_DIR"
  npm run dev -- --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!

echo "Both dev servers are running. Press Ctrl+C to stop."
wait -n "$BACKEND_PID" "$FRONTEND_PID"

echo "A dev server exited."
