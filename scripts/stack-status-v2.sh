#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACKS=(
  "ColdbonesV2Foundation"
  "ColdbonesV2Messaging"
  "ColdbonesV2Runtime"
  "ColdbonesV2Api"
)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones V2 CloudFormation status ($REGION)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

for stack in "${STACKS[@]}"; do
  status=$(aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --query 'Stacks[0].StackStatus' \
    --output text \
    --region "$REGION" 2>/dev/null || echo "NOT_FOUND")
  printf "%-24s %s\n" "$stack" "$status"
done
