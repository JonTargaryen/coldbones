#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

cd "$REPO_ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " MultiSwarm Sync"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

python3 scripts/multiswarm.py status

echo ""
echo "Ready queue by suggested owner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for agent in \
  swarm-orchestrator \
  inference-agent \
  worker-agent \
  api-agent \
  frontend-agent \
  infra-agent \
  security-agent \
  reliability-agent \
  docs-agent; do
  echo ""
  echo "[$agent]"
  python3 scripts/multiswarm.py ready --agent "$agent" || true
done
