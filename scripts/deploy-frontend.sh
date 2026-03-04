#!/usr/bin/env bash
# Build and deploy the React frontend to S3 + CloudFront
# Must be run after `./deploy.sh` (needs CDK outputs)
#
# Usage:
#   ./scripts/deploy-frontend.sh
#   SITE_BUCKET=my-bucket ./scripts/deploy-frontend.sh  (override bucket)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$SCRIPT_DIR/../frontend"
CDK_OUTPUTS="$SCRIPT_DIR/cdk-outputs.json"
REGION="${AWS_REGION:-us-east-1}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones Frontend Deploy"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Resolve S3 bucket and CloudFront dist ID from CDK outputs
if [ -n "${SITE_BUCKET:-}" ]; then
  BUCKET="$SITE_BUCKET"
else
  if [ ! -f "$CDK_OUTPUTS" ]; then
    echo "✗ CDK outputs not found. Run ./deploy.sh first, or set SITE_BUCKET manually."
    exit 1
  fi
  BUCKET=$(jq -r '.ColdbonesStorage.SiteBucketName // empty' "$CDK_OUTPUTS" 2>/dev/null || true)
  if [ -z "$BUCKET" ]; then
    echo "✗ Could not read SiteBucketName from CDK outputs."
    echo "  Try: SITE_BUCKET=your-bucket-name ./scripts/deploy-frontend.sh"
    exit 1
  fi
fi

CF_DIST_ID=$(jq -r '.ColdbonesStorage.CloudFrontDistributionId // empty' "$CDK_OUTPUTS" 2>/dev/null || true)

echo "→ Bucket:          $BUCKET"
echo "→ CloudFront dist: ${CF_DIST_ID:-not found (manual invalidation needed)}"

# Install and build
cd "$FRONTEND_DIR"
if [ ! -d "node_modules" ]; then
  echo "→ Installing frontend dependencies…"
  npm ci
fi

echo "→ Building production bundle…"
npm run build

# Sync to S3
echo "→ Uploading to s3://$BUCKET …"
aws s3 sync dist/ "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html" \
  --region "$REGION"

# Upload index.html with no-cache
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --region "$REGION"

# Invalidate CloudFront cache
if [ -n "$CF_DIST_ID" ]; then
  echo "→ Invalidating CloudFront cache…"
  INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text)
  echo "   Invalidation ID: $INVALIDATION_ID"
  echo "   (Cache clears in ~30 seconds)"
else
  echo "⚠  CloudFront dist ID unknown — invalidate manually in the AWS console."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✓ Frontend deployed!"
if [ -f "$CDK_OUTPUTS" ]; then
  CF=$(jq -r '.ColdbonesStorage.CloudFrontDomain // empty' "$CDK_OUTPUTS" 2>/dev/null || true)
  [ -n "$CF" ] && echo " URL: https://$CF"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
