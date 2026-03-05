#!/usr/bin/env bash
# =============================================================================
# ColdBones Spin Down — destroy all infrastructure
# =============================================================================
#
# One-command teardown: destroys all CDK stacks and empties S3 buckets.
# Run this to stop all AWS billing for ColdBones.
#
# Usage:
#   ./scripts/spin-down.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones — Full Spin Down"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "This will destroy ALL ColdBones infrastructure."
echo "S3 data, DynamoDB tables, and Lambda functions will be deleted."
echo ""

# Prompt for confirmation
read -r -p "Are you sure? (y/N) " response
case "$response" in
  [yY][eE][sS]|[yY])
    "$SCRIPT_DIR/teardown.sh" all
    ;;
  *)
    echo "Aborted."
    exit 0
    ;;
esac
