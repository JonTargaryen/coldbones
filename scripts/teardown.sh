#!/usr/bin/env bash
# =============================================================================
# ColdBones Teardown Script
# =============================================================================
#
# Destroys CDK stacks to stop billing.  Use this when you're done with the
# app or want to spin everything down to zero cost.
#
# Usage:
#   ./scripts/teardown.sh [stack]
#   stack: all | api | queue | storage  (default: all)
#
# Teardown order (reverse of deploy):
#   Api → Queue → Storage
#
# CAUTION:
#   - 'all' destroys ALL stacks including S3 data, DynamoDB tables, and logs.
#   - S3 buckets must be empty before CloudFormation can delete them.  This
#     script empties the upload and site buckets automatically.
#   - DynamoDB tables with data will be deleted (PAY_PER_REQUEST tables have
#     no ongoing cost, but the data is lost).
#   - CloudFront distributions take 10-15 minutes to fully disable/delete.
#
# To spin back up:
#   ./scripts/deploy.sh all
#   ./scripts/deploy-frontend.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/../infrastructure"
STACK_ARG="${1:-all}"
REGION="${AWS_REGION:-us-east-1}"
CDK_OUTPUTS="$SCRIPT_DIR/cdk-outputs.json"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones Teardown  —  region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cd "$INFRA_DIR"

# Install CDK dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "→ Installing infrastructure dependencies…"
  npm ci
fi

# Helper: empty an S3 bucket (required before CloudFormation can delete it)
_empty_bucket() {
  local bucket="$1"
  if [ -z "$bucket" ]; then return; fi

  echo "  → Emptying S3 bucket: $bucket"
  # Delete all object versions (handles versioned buckets)
  aws s3 rm "s3://$bucket" --recursive --region "$REGION" 2>/dev/null || true

  # Also delete version markers if versioning is enabled
  local versions
  versions=$(aws s3api list-object-versions \
    --bucket "$bucket" \
    --region "$REGION" \
    --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
    --output json 2>/dev/null || echo '{"Objects": null}')

  if [ "$(echo "$versions" | jq '.Objects')" != "null" ]; then
    echo "$versions" | aws s3api delete-objects \
      --bucket "$bucket" \
      --delete "$(echo "$versions" | jq -c .)" \
      --region "$REGION" 2>/dev/null || true
  fi

  # Delete markers too
  local markers
  markers=$(aws s3api list-object-versions \
    --bucket "$bucket" \
    --region "$REGION" \
    --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' \
    --output json 2>/dev/null || echo '{"Objects": null}')

  if [ "$(echo "$markers" | jq '.Objects')" != "null" ]; then
    echo "$markers" | aws s3api delete-objects \
      --bucket "$bucket" \
      --delete "$(echo "$markers" | jq -c .)" \
      --region "$REGION" 2>/dev/null || true
  fi
}

_destroy_api() {
  echo "→ Destroying ColdbonesApi…"
  npx cdk destroy ColdbonesApi --force --region "$REGION"
  echo "  ✓ ColdbonesApi destroyed"
}

_destroy_queue() {
  echo "→ Destroying ColdbonesQueue…"
  npx cdk destroy ColdbonesQueue --force --region "$REGION"
  echo "  ✓ ColdbonesQueue destroyed"
}

_destroy_storage() {
  # Empty S3 buckets before destroying the stack
  if [ -f "$CDK_OUTPUTS" ]; then
    UPLOAD_BUCKET=$(jq -r '.ColdbonesStorage.UploadBucketName // empty' "$CDK_OUTPUTS" 2>/dev/null || true)
    SITE_BUCKET=$(jq -r '.ColdbonesStorage.SiteBucketName // empty' "$CDK_OUTPUTS" 2>/dev/null || true)
    [ -n "$UPLOAD_BUCKET" ] && _empty_bucket "$UPLOAD_BUCKET"
    [ -n "$SITE_BUCKET" ]   && _empty_bucket "$SITE_BUCKET"
  else
    echo "  ⚠ CDK outputs not found — buckets may need manual emptying"
  fi

  echo "→ Destroying ColdbonesStorage…"
  npx cdk destroy ColdbonesStorage --force --region "$REGION"
  echo "  ✓ ColdbonesStorage destroyed"
}

_destroy_all() {
  echo "→ Tearing down all stacks: Api → Queue → Storage"
  echo ""
  _destroy_api
  echo ""
  _destroy_queue
  echo ""
  _destroy_storage
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " ✓ All stacks destroyed!"
  echo ""
  echo "   To spin back up:"
  echo "   ./scripts/deploy.sh all"
  echo "   ./scripts/deploy-frontend.sh"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

case "$STACK_ARG" in
  api)
    _destroy_api
    ;;
  queue)
    _destroy_queue
    ;;
  storage)
    _destroy_storage
    ;;
  all|*)
    _destroy_all
    ;;
esac
