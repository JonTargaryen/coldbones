#!/usr/bin/env bash
# gpu-startup-validate.sh
#
# Checks whether the cloud GPU (vLLM) is running and reachable.
# Reads the GPU IP from SSM Parameter Store.
#
# Usage:
#   ./scripts/gpu-startup-validate.sh           # non-blocking check
#   ./scripts/gpu-startup-validate.sh --wait    # poll until healthy (up to 20 min)
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
GPU_IP_PARAM="/coldbones/gpu-ip"
GPU_PORT_PARAM="/coldbones/gpu-port"
GPU_ASG_PARAM="/coldbones/gpu-asg-name"
WAIT_MODE=false
POLL_INTERVAL=20
TIMEOUT_S=1200  # 20 minutes

if [[ "${1:-}" == "--wait" ]]; then
  WAIT_MODE=true
fi

_ssm() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text --region "$REGION" 2>/dev/null || echo ""; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ColdBones — GPU Startup Validation"
echo " Region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. Check SSM for GPU IP
GPU_IP=$(_ssm "$GPU_IP_PARAM")
GPU_PORT=$(_ssm "$GPU_PORT_PARAM")
GPU_ASG=$(_ssm "$GPU_ASG_PARAM")
GPU_PORT="${GPU_PORT:-8000}"

echo "  SSM $GPU_IP_PARAM  = ${GPU_IP:-<empty>}"
echo "  SSM $GPU_PORT_PARAM = ${GPU_PORT}"
echo "  SSM $GPU_ASG_PARAM  = ${GPU_ASG:-<empty>}"
echo ""

# 2. Check ASG capacity
if [ -n "$GPU_ASG" ]; then
  DESIRED=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$GPU_ASG" \
    --query 'AutoScalingGroups[0].DesiredCapacity' \
    --output text --region "$REGION" 2>/dev/null || echo "?")
  INSERVICE=$(aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$GPU_ASG" \
    --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`] | length(@)' \
    --output text --region "$REGION" 2>/dev/null || echo "?")
  echo "  ASG $GPU_ASG → desired=$DESIRED  in-service=$INSERVICE"
  echo ""
fi

if [ "$GPU_IP" == "not-yet-assigned" ] || [ -z "$GPU_IP" ]; then
  if $WAIT_MODE; then
    echo "  GPU not yet assigned — polling SSM every ${POLL_INTERVAL}s (timeout ${TIMEOUT_S}s)…"
    deadline=$((SECONDS + TIMEOUT_S))
    while [ $SECONDS -lt $deadline ]; do
      GPU_IP=$(_ssm "$GPU_IP_PARAM")
      if [ -n "$GPU_IP" ] && [ "$GPU_IP" != "not-yet-assigned" ]; then
        echo "  GPU IP assigned: $GPU_IP"
        break
      fi
      printf "."
      sleep $POLL_INTERVAL
    done
    if [ "$GPU_IP" == "not-yet-assigned" ] || [ -z "$GPU_IP" ]; then
      echo ""
      echo "  TIMEOUT: GPU never became available."
      exit 1
    fi
  else
    echo "  GPU not running (SSM shows: ${GPU_IP:-<empty>})"
    echo ""
    echo "  To start the GPU:  POST to https://api.omlahiri.com/api/gpu/start"
    echo "  or run:  aws autoscaling set-desired-capacity \\"
    echo "             --auto-scaling-group-name $GPU_ASG \\"
    echo "             --desired-capacity 1 --region $REGION"
    echo ""
    exit 0
  fi
fi

VLLM_BASE="http://${GPU_IP}:${GPU_PORT}"

# 3. vLLM /health check
echo "  Checking vLLM health: ${VLLM_BASE}/health"
if $WAIT_MODE; then
  deadline=$((SECONDS + TIMEOUT_S))
  while [ $SECONDS -lt $deadline ]; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${VLLM_BASE}/health" 2>/dev/null || echo "000")
    if [ "$STATUS" == "200" ]; then break; fi
    printf "."
    sleep $POLL_INTERVAL
  done
else
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "${VLLM_BASE}/health" 2>/dev/null || echo "000")
fi

if [ "$STATUS" != "200" ]; then
  echo ""
  echo "  FAIL: /health returned HTTP $STATUS (vLLM may still be loading)"
  if ! $WAIT_MODE; then echo "  Try: ./scripts/gpu-startup-validate.sh --wait"; fi
  exit 1
fi
echo ""
echo "  OK: vLLM health check passed (HTTP 200)"

# 4. vLLM /v1/models — print loaded model name
echo ""
echo "  Checking loaded model:"
MODELS=$(curl -s --connect-timeout 5 "${VLLM_BASE}/v1/models" 2>/dev/null || echo "{}")
MODEL_ID=$(echo "$MODELS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'] if d.get('data') else 'unknown')" 2>/dev/null || echo "parse-error")
echo "  Active model: $MODEL_ID"

# 5. Quick completion smoke-test (non-streaming, short prompt)
echo ""
echo "  Running inference smoke-test…"
SMOKE=$(curl -s --connect-timeout 10 --max-time 30 \
  -X POST "${VLLM_BASE}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"'"$MODEL_ID"'","messages":[{"role":"user","content":"Reply with one word: ready"}],"max_tokens":10}' \
  2>/dev/null || echo "{}")
SMOKE_TEXT=$(echo "$SMOKE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'].strip())" 2>/dev/null || echo "parse-error")
echo "  Smoke-test response: \"$SMOKE_TEXT\""

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " GPU is healthy and serving $MODEL_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
