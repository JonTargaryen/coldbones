#!/usr/bin/env bash
set -euo pipefail
# ──────────────────────────────────────────────────────────────────────────────
# setup-bedrock-model.sh
#
# Downloads a Qwen2.5-VL model from Hugging Face, uploads it to S3, and
# creates a Bedrock Custom Model Import job.
#
# Prerequisites:
#   pip install huggingface_hub boto3
#   aws configure  (with Bedrock + S3 permissions)
#
# Usage:
#   bash scripts/setup-bedrock-model.sh [model-id] [region]
#
# Examples:
#   bash scripts/setup-bedrock-model.sh                                    # defaults
#   bash scripts/setup-bedrock-model.sh Qwen/Qwen2.5-VL-7B-Instruct       # specify model
#   bash scripts/setup-bedrock-model.sh Qwen/Qwen2.5-VL-72B-Instruct us-west-2
# ──────────────────────────────────────────────────────────────────────────────

HF_MODEL_ID="${1:-Qwen/Qwen2.5-VL-7B-Instruct}"
AWS_REGION="${2:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Derive names from model ID
MODEL_SHORT=$(echo "$HF_MODEL_ID" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
S3_BUCKET="coldbones-models-${ACCOUNT_ID}"
S3_PREFIX="${MODEL_SHORT}/"
LOCAL_DIR="/tmp/coldbones-model-download/${MODEL_SHORT}"
IMPORT_JOB_NAME="coldbones-import-${MODEL_SHORT}"
IMPORTED_MODEL_NAME="coldbones-${MODEL_SHORT}"
SSM_PARAM="/coldbones/bedrock-model-arn"
BEDROCK_ROLE_NAME="ColdbonesBedRockModelImportRole"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Bedrock Custom Model Import Setup"
echo "  Model:  ${HF_MODEL_ID}"
echo "  Bucket: s3://${S3_BUCKET}/${S3_PREFIX}"
echo "  Region: ${AWS_REGION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Create S3 bucket (idempotent) ─────────────────────────────────────
echo ""
echo "▸ Step 1: Creating S3 bucket (if needed)..."
if aws s3api head-bucket --bucket "${S3_BUCKET}" 2>/dev/null; then
  echo "  Bucket already exists: s3://${S3_BUCKET}"
else
  if [ "${AWS_REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${S3_BUCKET}" --region "${AWS_REGION}"
  else
    aws s3api create-bucket --bucket "${S3_BUCKET}" --region "${AWS_REGION}" \
      --create-bucket-configuration LocationConstraint="${AWS_REGION}"
  fi
  echo "  Created bucket: s3://${S3_BUCKET}"
fi

# ── Step 2: Create IAM role for Bedrock import ────────────────────────────────
echo ""
echo "▸ Step 2: Creating IAM role for Bedrock model import..."
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" }
      }
    }
  ]
}
EOF
)

S3_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/*"
      ]
    }
  ]
}
EOF
)

ROLE_ARN=""
if aws iam get-role --role-name "${BEDROCK_ROLE_NAME}" >/dev/null 2>&1; then
  ROLE_ARN=$(aws iam get-role --role-name "${BEDROCK_ROLE_NAME}" --query 'Role.Arn' --output text)
  echo "  Role already exists: ${ROLE_ARN}"
else
  ROLE_ARN=$(aws iam create-role \
    --role-name "${BEDROCK_ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --query 'Role.Arn' --output text)
  echo "  Created role: ${ROLE_ARN}"

  aws iam put-role-policy \
    --role-name "${BEDROCK_ROLE_NAME}" \
    --policy-name "BedrockS3Access" \
    --policy-document "${S3_POLICY}"
  echo "  Attached S3 access policy"
  echo "  Waiting 10s for IAM propagation..."
  sleep 10
fi

# ── Step 3: Download model from Hugging Face ──────────────────────────────────
echo ""
echo "▸ Step 3: Downloading model from Hugging Face..."
echo "  This may take 15–60 minutes depending on model size and bandwidth."
python3 - <<PYEOF
import os
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="${HF_MODEL_ID}",
    local_dir="${LOCAL_DIR}",
    ignore_patterns=["*.md", "*.txt", "*.git*", "*.gguf"],
)
print("  Download complete.")
PYEOF

# ── Step 4: Upload to S3 ─────────────────────────────────────────────────────
echo ""
echo "▸ Step 4: Uploading model to S3..."
aws s3 sync "${LOCAL_DIR}" "s3://${S3_BUCKET}/${S3_PREFIX}" \
  --exclude "*.md" --exclude "*.txt" --exclude "*.git*" --exclude "*.gguf"
echo "  Upload complete: s3://${S3_BUCKET}/${S3_PREFIX}"

# ── Step 5: Create Bedrock import job ─────────────────────────────────────────
echo ""
echo "▸ Step 5: Creating Bedrock Custom Model Import job..."
IMPORT_RESPONSE=$(aws bedrock create-model-import-job \
  --job-name "${IMPORT_JOB_NAME}" \
  --imported-model-name "${IMPORTED_MODEL_NAME}" \
  --role-arn "${ROLE_ARN}" \
  --model-data-source "{\"s3DataSource\": {\"s3Uri\": \"s3://${S3_BUCKET}/${S3_PREFIX}\"}}" \
  --region "${AWS_REGION}" \
  --output json 2>&1) || true

echo "  Import job response:"
echo "  ${IMPORT_RESPONSE}"

# ── Step 6: Wait for import and store ARN in SSM ─────────────────────────────
echo ""
echo "▸ Step 6: Waiting for import job to complete..."
echo "  (This can take 15–45 minutes. Ctrl+C is safe — you can check status later.)"

JOB_ARN=$(echo "${IMPORT_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobArn',''))" 2>/dev/null || echo "")

if [ -z "${JOB_ARN}" ]; then
  echo "  ⚠ Could not extract job ARN. Check the response above."
  echo "  You can monitor the import job in the Bedrock console."
  echo ""
  echo "  After import completes, store the model ARN in SSM manually:"
  echo "    aws ssm put-parameter --name ${SSM_PARAM} --type String --value <MODEL_ARN> --overwrite"
  exit 0
fi

for i in $(seq 1 90); do
  STATUS=$(aws bedrock get-model-import-job \
    --job-identifier "${JOB_ARN}" \
    --region "${AWS_REGION}" \
    --query 'status' --output text 2>/dev/null || echo "UNKNOWN")

  if [ "${STATUS}" = "Completed" ]; then
    MODEL_ARN=$(aws bedrock get-model-import-job \
      --job-identifier "${JOB_ARN}" \
      --region "${AWS_REGION}" \
      --query 'importedModelArn' --output text)
    echo "  ✓ Import complete! Model ARN: ${MODEL_ARN}"

    # Store in SSM for Lambda to discover at runtime
    aws ssm put-parameter \
      --name "${SSM_PARAM}" \
      --type String \
      --value "${MODEL_ARN}" \
      --overwrite \
      --region "${AWS_REGION}"
    echo "  ✓ Stored model ARN in SSM: ${SSM_PARAM}"
    break
  elif [ "${STATUS}" = "Failed" ]; then
    echo "  ✗ Import FAILED. Check the Bedrock console for details."
    exit 1
  else
    echo "  Status: ${STATUS} (attempt ${i}/90, will retry in 30s)"
    sleep 30
  fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Deploy updated infrastructure: bash scripts/deploy.sh api"
echo "    2. Test Bedrock inference via the frontend (select 'Cloud' provider)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
