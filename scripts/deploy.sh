#!/usr/bin/env bash
# ColdBones CDK deployment script
#
# Usage: ./scripts/deploy.sh [stack]
#   stack: all | storage | queue | network | gpu | api  (default: all)
#
# Stack deploy order: Storage → Queue → Network → Gpu → Api
#
# NOTE: The 250 GB EBS volume created by ColdbonesGpu has RemovalPolicy=RETAIN.
#       Destroying the stack will NOT delete the volume. This is intentional —
#       the model data is stored there.  Delete manually if needed.
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

_deploy_all() {
  echo "→ Deploying all stacks: Storage → Queue → Network → Gpu → Api"
  npx cdk deploy \
    ColdbonesStorage \
    ColdbonesQueue \
    ColdbonesNetwork \
    ColdbonesGpu \
    ColdbonesApi \
    --require-approval never \
    --region "$REGION" \
    --outputs-file "$SCRIPT_DIR/cdk-outputs.json"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " ✓ Deployment complete!"
  echo "   Stack outputs → scripts/cdk-outputs.json"
  echo ""
  if [ -f "$SCRIPT_DIR/cdk-outputs.json" ]; then
    CLOUDFRONT=$(jq -r '.ColdbonesStorage.CloudFrontDomain // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
    APP_URL=$(jq -r '.ColdbonesStorage.AppUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
    WS_URL=$(jq -r '.ColdbonesApi.WsApiUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
    API_URL=$(jq -r '.ColdbonesApi.ApiUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)
    GPU_VOL=$(jq -r '.ColdbonesGpu.GpuEbsVolumeId // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)

    [ -n "$CLOUDFRONT" ] && echo "   CloudFront URL: https://$CLOUDFRONT"
    [ -n "$APP_URL"    ] && echo "   App URL:        $APP_URL"
    [ -n "$API_URL"    ] && echo "   API (REST):     $API_URL"
    [ -n "$WS_URL"     ] && echo "   API (WS):       $WS_URL"
    [ -n "$GPU_VOL"    ] && echo "   GPU EBS Volume: $GPU_VOL  ← DO NOT delete manually, stores model data"
    echo ""
    echo "   Run GPU health check:  ./scripts/gpu-startup-validate.sh"
    echo "   Run e2e validation:    ./scripts/validate.sh"
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

case "$STACK_ARG" in
  storage)
    echo "→ Deploying ColdbonesStorage…"
    npx cdk deploy ColdbonesStorage --require-approval never --region "$REGION"
    ;;
  queue)
    echo "→ Deploying ColdbonesQueue…"
    npx cdk deploy ColdbonesQueue --require-approval never --region "$REGION"
    ;;
  network)
    echo "→ Deploying ColdbonesNetwork…"
    npx cdk deploy ColdbonesNetwork --require-approval never --region "$REGION"
    ;;
  gpu)
    echo "→ Deploying ColdbonesGpu…"
    npx cdk deploy ColdbonesGpu --require-approval never --region "$REGION"
    ;;
  api)
    echo "→ Deploying ColdbonesApi…"
    npx cdk deploy ColdbonesApi --require-approval never --region "$REGION"
    ;;
  all|*)
    _deploy_all
    ;;
esac
