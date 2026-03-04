#!/usr/bin/env bash
set -euo pipefail

stop_port() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN -n -P || true)"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnp "( sport = :$port )" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u || true)"
  fi

  if [[ -z "$pids" ]]; then
    echo "No listener found on port $port"
    return 0
  fi

  echo "Stopping process(es) on port $port: $pids"
  kill $pids 2>/dev/null || true
}

stop_port 8000
stop_port 5173
