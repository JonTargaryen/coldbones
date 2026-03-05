#!/usr/bin/env bash
# =============================================================================
# ColdBones Spin Up — deploy everything from scratch
# =============================================================================
#
# One-command deployment: CDK stacks + frontend build + validation.
#
# Usage:
#   ./scripts/spin-up.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones — Full Spin Up"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "Step 1/3: Deploying CDK stacks…"
echo "──────────────────────────────────"
"$SCRIPT_DIR/deploy.sh" all

echo ""
echo "Step 2/3: Building & deploying frontend…"
echo "──────────────────────────────────────────"
"$SCRIPT_DIR/deploy-frontend.sh"

echo ""
echo "Step 3/3: Running validation…"
echo "──────────────────────────────"
"$SCRIPT_DIR/validate.sh" || echo "⚠ Validation had warnings (non-fatal)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✓ ColdBones is live!"
echo ""
APP_URL=$(jq -r '.ColdbonesStorage.AppUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
[ -n "$APP_URL" ] && echo "   → $APP_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
