#!/usr/bin/env bash
# =============================================================================
# deploy.sh
# Full deployment orchestration for Coldbones.
# Builds and deploys frontend + CDK infrastructure in the correct order.
#
# Usage:
#   ./scripts/deploy.sh [OPTIONS]
#
# Options:
#   --env          Deployment environment tag (default: prod)
#   --region       AWS region (default: us-east-1)
#   --account      AWS account ID (auto-detected if omitted)
#   --skip-infra   Skip CDK deployment (frontend only)
#   --skip-front   Skip frontend build/upload (infra only)
#   --force        Pass --require-approval never to CDK
#   --profile      AWS CLI profile to use
#
# Pre-requisites:
#   - Node.js ≥20, pnpm/npm
#   - Python ≥3.12, pip
#   - AWS CLI v2, configured credentials
#   - aws-cdk CLI: npm install -g aws-cdk
# =============================================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
ENV_NAME="${DEPLOY_ENV:-prod}"
AWS_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
AWS_ACCOUNT="${AWS_ACCOUNT_ID:-}"
SKIP_INFRA=false
SKIP_FRONT=false
FORCE=false
AWS_PROFILE="${AWS_PROFILE:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Color helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()    { echo -e "${YELLOW}[deploy]${NC} $*"; }
error()   { echo -e "${RED}[deploy]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

# ── CLI args ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)         ENV_NAME="$2";    shift 2 ;;
    --region)      AWS_REGION="$2";  shift 2 ;;
    --account)     AWS_ACCOUNT="$2"; shift 2 ;;
    --skip-infra)  SKIP_INFRA=true;  shift ;;
    --skip-front)  SKIP_FRONT=true;  shift ;;
    --force)       FORCE=true;       shift ;;
    --profile)     AWS_PROFILE="$2"; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

# ── AWS profile ───────────────────────────────────────────────────────────────
if [[ -n "$AWS_PROFILE" ]]; then
  export AWS_PROFILE
fi

export AWS_DEFAULT_REGION="$AWS_REGION"

# ── Detect account ────────────────────────────────────────────────────────────
if [[ -z "$AWS_ACCOUNT" ]]; then
  info "Detecting AWS account..."
  AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  info "Account: ${AWS_ACCOUNT}"
fi

export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT"
export CDK_DEFAULT_REGION="$AWS_REGION"

# ── Check prerequisites ───────────────────────────────────────────────────────
check_cmd() { command -v "$1" &>/dev/null || die "Required command not found: $1"; }
check_cmd aws
check_cmd node
check_cmd npm
check_cmd cdk

info "Starting Coldbones deployment"
info "  Environment : ${ENV_NAME}"
info "  Region      : ${AWS_REGION}"
info "  Account     : ${AWS_ACCOUNT}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Infrastructure (CDK)
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$SKIP_INFRA" == "false" ]]; then
  info "=== Deploying infrastructure (CDK) ==="
  cd "${REPO_ROOT}/infrastructure"

  info "Installing CDK dependencies..."
  npm ci --silent

  CDK_ARGS="--all"
  if [[ "$FORCE" == "true" ]]; then
    CDK_ARGS="${CDK_ARGS} --require-approval never"
  fi

  info "CDK bootstrap..."
  cdk bootstrap "aws://${AWS_ACCOUNT}/${AWS_REGION}" || true

  info "CDK synthesize..."
  cdk synth $CDK_ARGS

  info "Deploying: ColdbonesNetwork..."
  cdk deploy ColdbonesNetwork $CDK_ARGS

  info "Deploying: ColdbonesStorage..."
  cdk deploy ColdbonesStorage $CDK_ARGS

  info "Deploying: ColdbonesQueue..."
  cdk deploy ColdbonesQueue $CDK_ARGS

  info "Deploying: ColdbonesModel..."
  cdk deploy ColdbonesModel $CDK_ARGS

  info "Deploying: ColdbonesSpotModel..."
  cdk deploy ColdbonesSpotModel $CDK_ARGS

  info "Deploying: ColdbonesApi..."
  cdk deploy ColdbonesApi $CDK_ARGS

  info "Deploying: ColdbonesSchedule..."
  cdk deploy ColdbonesSchedule $CDK_ARGS

  info "CDK deployment complete"
  cd "$REPO_ROOT"
else
  warn "Skipping infrastructure deployment"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Frontend build + upload
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$SKIP_FRONT" == "false" ]]; then
  info "=== Building frontend ==="
  cd "${REPO_ROOT}/frontend"

  # Resolve API URL from CDK output
  REST_API_URL=$(
    aws cloudformation describe-stacks \
      --stack-name ColdbonesApi \
      --query "Stacks[0].Outputs[?OutputKey=='RestApiUrl'].OutputValue" \
      --output text 2>/dev/null || echo ""
  )
  WS_API_URL=$(
    aws cloudformation describe-stacks \
      --stack-name ColdbonesApi \
      --query "Stacks[0].Outputs[?OutputKey=='WsApiUrl'].OutputValue" \
      --output text 2>/dev/null || echo ""
  )
  SITE_BUCKET=$(
    aws cloudformation describe-stacks \
      --stack-name ColdbonesStorage \
      --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" \
      --output text 2>/dev/null || echo ""
  )
  CF_DIST_ID=$(
    aws cloudformation describe-stacks \
      --stack-name ColdbonesStorage \
      --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
      --output text 2>/dev/null || echo ""
  )

  if [[ -z "$SITE_BUCKET" ]]; then
    warn "Could not detect site bucket from CloudFormation outputs."
    warn "Set SITE_BUCKET env var or run with --skip-front."
    read -rp "Site S3 bucket name: " SITE_BUCKET
  fi

  info "Installing frontend dependencies..."
  npm ci --silent

  info "Building frontend..."
  VITE_API_BASE_URL="${REST_API_URL%/}" \
  VITE_WS_URL="${WS_API_URL}" \
    npm run build

  info "Uploading to s3://${SITE_BUCKET}/..."
  aws s3 sync dist/ "s3://${SITE_BUCKET}/" \
    --delete \
    --cache-control "public,max-age=31536000,immutable" \
    --exclude "index.html"

  aws s3 cp dist/index.html "s3://${SITE_BUCKET}/index.html" \
    --cache-control "no-cache,no-store,must-revalidate"

  if [[ -n "$CF_DIST_ID" ]]; then
    info "Invalidating CloudFront distribution ${CF_DIST_ID}..."
    INVALIDATION_ID=$(
      aws cloudfront create-invalidation \
        --distribution-id "$CF_DIST_ID" \
        --paths "/*" \
        --query "Invalidation.Id" \
        --output text
    )
    info "Invalidation ${INVALIDATION_ID} created"
  fi

  SITE_URL=$(
    aws cloudformation describe-stacks \
      --stack-name ColdbonesStorage \
      --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" \
      --output text 2>/dev/null || echo "https://${SITE_BUCKET}.s3.amazonaws.com"
  )

  info "Frontend deployed!"
  info "  Site URL : ${SITE_URL}"
  info "  API URL  : ${REST_API_URL}"
  info "  WS URL   : ${WS_API_URL}"

  cd "$REPO_ROOT"
else
  warn "Skipping frontend deployment"
fi

info ""
info "=== Coldbones deployment complete ==="
