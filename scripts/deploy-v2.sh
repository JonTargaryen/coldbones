#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infrastructure-v2"
STACK_ARG="${1:-all}"
REGION="${AWS_REGION:-us-east-1}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones V2 Deploy  —  region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$INFRA_DIR"

if [ ! -d "node_modules" ]; then
  echo "→ Installing infrastructure-v2 dependencies…"
  npm ci
fi

echo "→ Bootstrapping CDK (safe to re-run)…"
npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$REGION" \
  --region "$REGION" 2>&1 | tail -5

deploy_all() {
  echo "→ Deploying V2 stacks: Foundation → Messaging → Runtime → Api"
  npx cdk deploy \
    ColdbonesV2Foundation \
    ColdbonesV2Messaging \
    ColdbonesV2Runtime \
    ColdbonesV2Api \
    --require-approval never \
    --region "$REGION" \
    --outputs-file "$SCRIPT_DIR/cdk-outputs-v2.json"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " ✓ V2 deployment complete"
  echo "   Stack outputs → scripts/cdk-outputs-v2.json"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

case "$STACK_ARG" in
  foundation)
    npx cdk deploy ColdbonesV2Foundation --require-approval never --region "$REGION"
    ;;
  messaging)
    npx cdk deploy ColdbonesV2Messaging --require-approval never --region "$REGION"
    ;;
  runtime)
    npx cdk deploy ColdbonesV2Runtime --require-approval never --region "$REGION"
    ;;
  api)
    npx cdk deploy ColdbonesV2Api --require-approval never --region "$REGION"
    ;;
  all|*)
    deploy_all
    ;;
esac
