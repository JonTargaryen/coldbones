#!/usr/bin/env bash
# =============================================================================
# ColdBones CDK deployment script
# =============================================================================
#
# Usage:
#   ./scripts/deploy.sh [stack]
#   stack: all | storage | queue | api  (default: all)
#
# Stack deploy order and dependencies:
#
#   Storage ──┬─> API
#   Queue ───┘
#
#   Storage owns: S3 (upload + site), CloudFront, DynamoDB, Route53, ACM
#   Queue owns:   SQS analysis queue + DLQ, SNS notification topic
#   Api owns:     Lambda functions + HTTP API Gateway (V2)
#
# First-time deploy order:
#   1. deploy.sh storage   → creates S3, CloudFront, DynamoDB
#   2. deploy.sh queue     → creates SQS (needed by Api Lambdas)
#   3. deploy.sh api       → creates Lambdas + API Gateway
#   4. Update cdk.json:    set coldbones.apiGatewayDomain = <the APIGW hostname>
#                         from scripts/cdk-outputs.json → ColdbonesApi.ApiUrl
#   5. deploy.sh storage   → adds the CloudFront /api/* behavior
#   6. deploy-frontend.sh  → builds React app and uploads to S3
#
# The separation between Storage and Api exists because of a circular CDK
# dependency if we tried to reference the API Gateway URL *as a CDK token*
# from inside StorageStack — Storage needs Api's domain for the CloudFront
# behavior, but Api needs Storage's bucket and table.  The workaround is to
# deploy Api first, hardcode the domain in cdk.json, then redeploy Storage.
#
# NOTE: After running 'deploy.sh api', copy the new API domain from
#       scripts/cdk-outputs.json → ColdbonesApi.ApiDomain  into
#       infrastructure/cdk.json → coldbones.apiGatewayDomain, then run
#       'deploy.sh storage' to update the CloudFront origin.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infrastructure"
STACK_ARG="${1:-all}"
REGION="${AWS_REGION:-us-east-1}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones Deploy  —  region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$INFRA_DIR"

# Install CDK dependencies if needed (node_modules may not be committed).
if [ ! -d "node_modules" ]; then
  echo "→ Installing infrastructure dependencies…"
  npm ci
fi

# Bootstrap CDK: creates the CDK staging bucket and IAM roles in the account.
# Safe to re-run — it only creates resources that don't already exist.
echo "→ Bootstrapping CDK (safe to re-run)…"
npx cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$REGION" \
  --region "$REGION" 2>&1 | tail -5

_deploy_all() {
  echo "→ Deploying all stacks: Storage → Queue → Api"
  npx cdk deploy \
    ColdbonesStorage \
    ColdbonesQueue \
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
    API_URL=$(jq -r '.ColdbonesApi.ApiUrl // empty' "$SCRIPT_DIR/cdk-outputs.json" 2>/dev/null || true)

    [ -n "$CLOUDFRONT" ] && echo "   CloudFront URL: https://$CLOUDFRONT"
    [ -n "$APP_URL"    ] && echo "   App URL:        $APP_URL"
    [ -n "$API_URL"    ] && echo "   API (HTTP):     $API_URL"
    echo ""
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
  api)
    echo "→ Deploying ColdbonesApi…"
    npx cdk deploy ColdbonesApi --require-approval never --region "$REGION"
    ;;
  all|*)
    _deploy_all
    ;;
esac
