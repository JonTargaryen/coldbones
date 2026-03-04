#!/usr/bin/env bash
# =============================================================================
# ColdBones Frontend Deploy
# =============================================================================
#
# Builds the React/Vite app and syncs it to the S3 site bucket, then
# invalidates the CloudFront cache so users immediately see the new version.
#
# Prerequisites:
#   - ./scripts/deploy.sh has been run (writes scripts/cdk-outputs.json)
#   - AWS CLI authenticated for the same account/region as the CDK stacks
#
# Usage:
#   ./scripts/deploy-frontend.sh
#   SITE_BUCKET=my-bucket ./scripts/deploy-frontend.sh  (override bucket)
#
# VITE_API_BASE_URL is intentionally left EMPTY for production.
# Reason: the frontend is served from CloudFront.  All /api/* requests should
# use the same origin (the CloudFront domain) so CloudFront can route them to
# API Gateway via the dedicated /api/* behavior added in StorageStack.
# Setting VITE_API_BASE_URL to the direct API Gateway URL would bypass
# CloudFront for API calls, causing CORS issues and breaking the routing setup.
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

CF_DIST_ID=$(jq -r '.ColdbonesStorage.DistributionId // .ColdbonesStorage.CloudFrontDistributionId // empty' "$CDK_OUTPUTS" 2>/dev/null || true)

echo "→ Bucket:          $BUCKET"
echo "→ CloudFront dist: ${CF_DIST_ID:-not found (manual invalidation needed)}"

# Install and build
cd "$FRONTEND_DIR"
if [ ! -d "node_modules" ]; then
  echo "→ Installing frontend dependencies…"
  npm ci
fi

# For production, VITE_API_BASE_URL must be empty so the browser uses same-origin
# CloudFront routing (/api/* → API Gateway). Setting it to the direct APIGW URL
# causes subtle errors when CloudFront is the actual entry point.
echo "→ Building production bundle (same-origin API routing via CloudFront)…"
VITE_API_BASE_URL="" npm run build

# Sync assets (JS, CSS, fonts) with long-lived immutable cache headers.
# The Vite build content-hashes all asset filenames (index-BsK3MpRv.js etc.),
# so serving stale bytes from a cached filename is impossible — a new deploy
# generates new filenames.  max-age=31536000 (1 year) tells CDN edges to
# never revalidate these files, giving maximum cache hit rates.
aws s3 sync dist/ "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=31536000,immutable" \
  --exclude "index.html" \
  --region "$REGION"

# Upload index.html with strict no-cache.
# index.html is the SPA entry point; it must never be cached so that:
#   - New deployments are picked up by returning users immediately.
#   - The hashed asset filenames referenced in the HTML always match what's in S3.
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
