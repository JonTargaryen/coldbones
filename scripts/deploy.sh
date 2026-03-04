#!/usr/bin/env bash
# ColdBones CDK deployment script
# Usage: ./scripts/deploy.sh [stack-name]
#   stack-name: all | storage | queue | api (default: all)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infrastructure"
STACK_ARG="${1:-all}"
REGION="${AWS_REGION:-us-east-1}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones Deploy  —  region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$INFRA_DIR"

# Install CDK dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "→ Installing infrastructure dependencies…"
  npm ci
fi

# Bootstrap CDK (safe to re-run)
echo "→ Bootstrapping CDK (safe to re-run)…"
npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$REGION" \
  --region "$REGION" 2>&1 | tail -5

# Deploy stacks in dependency order
case "$STACK_ARG" in
  storage)
    echo "→ Deploying ColdbonesStorage…"
    npx cdk deploy ColdbonesStorage --require-approval never --region "$REGION"
    ;;
  queue)
    echo "→ Deploying ColdbonesQueue…"
    npx cdk deploy ColdbonesQueue --require-approval never --region "$REGION"
    ;;
  api)
    echo "→ Deploying ColdbonesApi…"
    npx cdk deploy ColdbonesApi --require-approval never --region "$REGION"
    ;;
  all|*)
    echo "→ Deploying all stacks (Storage → Queue → Api)…"
    npx cdk deploy ColdbonesStorage ColdbonesQueue ColdbonesApi \
      --require-approval never \
      --region "$REGION" \
      --outputs-file "$SCRIPT_DIR/cdk-outputs.json"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo " ✓ Deployment complete!"
    echo "   Stack outputs saved to: scripts/cdk-outputs.json"
    echo ""
    if [ -f "$SCRIPT_DIR/cdk-outputs.json" ]; then
      CLOUDFRONT=$(jq -r '.ColdbonesStorage.CloudFrontDomain // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
      APP_URL=$(jq -r '.ColdbonesStorage.AppUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
      NS=$(jq -r '.ColdbonesStorage.HostedZoneNameServers // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
      [ -n "$CLOUDFRONT" ] && echo "   CloudFront URL (works immediately): https://$CLOUDFRONT"
      [ -n "$APP_URL"    ] && echo "   App URL (after DNS propagation):    $APP_URL"
      if [ -n "$NS" ]; then
        echo ""
        echo " ⚡ ACTION REQUIRED — Paste these 4 nameservers into Squarespace:"
        echo "    Domains → omlahiri.com → DNS Settings → Custom Nameservers"
        echo ""
        echo "$NS" | tr ',' '\n' | sed 's/^ */    /'
        echo ""
        echo "   DNS propagation takes up to 48h. Use the CloudFront URL above in the meantime."
      fi
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ;;
esac
