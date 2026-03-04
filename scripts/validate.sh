#!/usr/bin/env bash
# validate.sh — End-to-end ColdBones API validation
#
# Validates the full upload → analyze → result flow using real test files.
# Requires: AWS CLI, curl, jq, python3
#
# Usage:
#   ./scripts/validate.sh                           # use default test files
#   ./scripts/validate.sh /path/to/image.jpg        # use custom image
#   ./scripts/validate.sh /path/to/image.jpg /path/to/doc.pdf  # image + pdf
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"

# Resolve API URL from cdk-outputs.json or env
OUTPUTS_FILE="$SCRIPT_DIR/cdk-outputs.json"
API_URL="${API_URL:-}"
if [ -z "$API_URL" ] && [ -f "$OUTPUTS_FILE" ]; then
  API_URL=$(jq -r '.ColdbonesApi.ApiUrl // empty' "$OUTPUTS_FILE" 2>/dev/null || true)
fi
API_URL="${API_URL:-https://api.omlahiri.com}"

# Test files — look for test1.jpeg and AWS-Certified.pdf in the repo
TEST_IMAGE="${1:-}"
TEST_PDF="${2:-}"
for candidate in \
    "$SCRIPT_DIR/../test1.jpeg" \
    "$SCRIPT_DIR/../test1.jpg" \
    "$SCRIPT_DIR/test1.jpeg"; do
  if [ -f "$candidate" ] && [ -z "$TEST_IMAGE" ]; then
    TEST_IMAGE="$(realpath "$candidate")"
  fi
done
for candidate in \
    "$SCRIPT_DIR/../AWS-Certified.pdf" \
    "$SCRIPT_DIR/AWS-Certified.pdf"; do
  if [ -f "$candidate" ] && [ -z "$TEST_PDF" ]; then
    TEST_PDF="$(realpath "$candidate")"
  fi
done

PASS=0
FAIL=0
_pass() { echo "  ✓ $1"; PASS=$((PASS+1)); }
_fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
_section() { echo ""; echo "── $1 ──────────────────────────────────────────"; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones End-to-End Validation"
echo " API: $API_URL"
echo " Region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

_section "1. HTTP API health"
HEALTH=$(curl -sf "${API_URL}/api/health" 2>/dev/null || echo '{"status":"error"}')
HSTATUS=$(echo "$HEALTH" | jq -r '.status // "error"')
if [ "$HSTATUS" == "ok" ]; then
  _pass "Health check: $HSTATUS  ($(echo "$HEALTH" | jq -r '.model // "?"'))"
else
  _fail "Health check returned: $HSTATUS"
fi

_section "2. GPU status"
GPU_IP=$(aws ssm get-parameter --name /coldbones/gpu-ip \
  --query Parameter.Value --output text --region "$REGION" 2>/dev/null || echo "")
if [ -n "$GPU_IP" ] && [ "$GPU_IP" != "not-yet-assigned" ]; then
  _pass "GPU IP from SSM: $GPU_IP"
else
  echo "  ⚠  GPU not running (SSM = '${GPU_IP:-empty}')"
  echo "     Starting GPU via API…"
  curl -sf -X POST "${API_URL}/api/gpu/start" -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true
  echo "     Scale-up sent. Run ./scripts/gpu-startup-validate.sh --wait then retry."
  echo ""
  echo "     Tests that require GPU will be skipped."
  GPU_IP=""
fi

# ── Image analyze (fast mode) ──────────────────────────────────────────────
if [ -n "$TEST_IMAGE" ] && [ -f "$TEST_IMAGE" ]; then
  _section "3. Image analyze — fast mode ($(basename "$TEST_IMAGE"))"
  FILENAME=$(basename "$TEST_IMAGE")
  CONTENT_TYPE="image/jpeg"
  [[ "$FILENAME" == *.png ]] && CONTENT_TYPE="image/png"
  [[ "$FILENAME" == *.webp ]] && CONTENT_TYPE="image/webp"

  # Presign
  PRESIGN=$(curl -sf -X POST "${API_URL}/api/presign" \
    -H "Content-Type: application/json" \
    -d "{\"filename\":\"${FILENAME}\",\"contentType\":\"${CONTENT_TYPE}\"}" 2>/dev/null || echo '{}')
  UPLOAD_URL=$(echo "$PRESIGN" | jq -r '.uploadUrl // empty')
  S3_KEY=$(echo "$PRESIGN" | jq -r '.s3Key // empty')
  JOB_ID=$(echo "$PRESIGN" | jq -r '.jobId // empty')

  if [ -n "$UPLOAD_URL" ] && [ -n "$S3_KEY" ]; then
    _pass "Presign: s3Key=$S3_KEY  jobId=$JOB_ID"

    # Upload
    HTTP=$(curl -sf -X PUT "$UPLOAD_URL" \
      -H "Content-Type: $CONTENT_TYPE" \
      --data-binary "@$TEST_IMAGE" \
      -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
    if [[ "$HTTP" == "2"* ]]; then
      _pass "Upload: HTTP $HTTP"

      # Analyze (fast mode — sync invoke)
      echo "     Invoking analyze (may take 30-120s on cold GPU)…"
      RESULT=$(curl -sf --max-time 180 -X POST "${API_URL}/api/analyze" \
        -H "Content-Type: application/json" \
        -d "{\"s3Key\":\"${S3_KEY}\",\"lang\":\"en\",\"mode\":\"fast\"}" 2>/dev/null || echo '{}')
      SUMMARY=$(echo "$RESULT" | jq -r '.summary // empty')
      RESULT_KEY=$(echo "$RESULT" | jq -r '.resultS3Key // empty')
      if [ -n "$SUMMARY" ]; then
        _pass "Analyze returned summary (${#SUMMARY} chars)"
        [ -n "$RESULT_KEY" ] && _pass "Result saved to S3: $RESULT_KEY"
      else
        _fail "Analyze returned no summary ($(echo "$RESULT" | jq -c . | head -c 200))"
      fi
    else
      _fail "Upload failed: HTTP $HTTP"
    fi
  else
    _fail "Presign failed: $(echo "$PRESIGN" | jq -c . | head -c 200)"
  fi
else
  echo ""
  echo "  (skipping image test — no test1.jpeg found in repo root)"
fi

# ── PDF analyze ─────────────────────────────────────────────────────────────
if [ -n "$TEST_PDF" ] && [ -f "$TEST_PDF" ]; then
  _section "4. PDF analyze — fast mode ($(basename "$TEST_PDF"))"
  PDF_NAME=$(basename "$TEST_PDF")

  PRESIGN=$(curl -sf -X POST "${API_URL}/api/presign" \
    -H "Content-Type: application/json" \
    -d "{\"filename\":\"${PDF_NAME}\",\"contentType\":\"application/pdf\"}" 2>/dev/null || echo '{}')
  UPLOAD_URL=$(echo "$PRESIGN" | jq -r '.uploadUrl // empty')
  S3_KEY=$(echo "$PRESIGN" | jq -r '.s3Key // empty')

  if [ -n "$UPLOAD_URL" ] && [ -n "$S3_KEY" ]; then
    _pass "Presign: s3Key=$S3_KEY"
    HTTP=$(curl -sf -X PUT "$UPLOAD_URL" \
      -H "Content-Type: application/pdf" \
      --data-binary "@$TEST_PDF" \
      -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
    if [[ "$HTTP" == "2"* ]]; then
      _pass "Upload: HTTP $HTTP"
      echo "     Invoking analyze on PDF (may take 1-3 min)…"
      RESULT=$(curl -sf --max-time 300 -X POST "${API_URL}/api/analyze" \
        -H "Content-Type: application/json" \
        -d "{\"s3Key\":\"${S3_KEY}\",\"lang\":\"en\",\"mode\":\"fast\"}" 2>/dev/null || echo '{}')
      SUMMARY=$(echo "$RESULT" | jq -r '.summary // empty')
      if [ -n "$SUMMARY" ]; then
        _pass "PDF analyze returned summary (${#SUMMARY} chars)"
      else
        _fail "PDF analyze returned no summary"
      fi
    else
      _fail "PDF upload failed: HTTP $HTTP"
    fi
  else
    _fail "PDF presign failed"
  fi
else
  echo ""
  echo "  (skipping PDF test — AWS-Certified.pdf not found in repo root)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS+FAIL))
echo " Results: $PASS/$TOTAL passed  ($FAIL failed)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
