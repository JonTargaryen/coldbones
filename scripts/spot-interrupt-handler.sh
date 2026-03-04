#!/usr/bin/env bash
# =============================================================================
# spot-interrupt-handler.sh
# Polls EC2 instance metadata for a Spot interruption notice.
# When 2-minute warning arrives, gracefully drains any in-flight job and
# re-enqueues it to SQS so it can be retried on a new instance.
#
# Run as a systemd service or launched from user-data alongside llama-server.
#
# Required environment variables:
#   SQS_QUEUE_URL   URL of the coldbones-analysis SQS queue
#   JOBS_TABLE      DynamoDB table name (coldbones-jobs)
#   AWS_DEFAULT_REGION
#
# Optional:
#   POLL_INTERVAL   Seconds between metadata polls (default: 5)
#   LLAMA_PORT      llama.cpp server port (default: 8080)
# =============================================================================
set -euo pipefail

POLL_INTERVAL="${POLL_INTERVAL:-5}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
LLAMA_BASE="http://127.0.0.1:${LLAMA_PORT}"
METADATA_BASE="http://169.254.169.254/latest"
LOG_TAG="spot-interrupt-handler"

log() { logger -t "$LOG_TAG" -- "$*"; echo "[$(date -u +%H:%M:%S)] $*"; }

# ── Obtain IMDSv2 token ──────────────────────────────────────────────────────
get_imds_token() {
  curl -sf -X PUT \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" \
    "${METADATA_BASE}/api/token" 2>/dev/null || echo ""
}

# ── Read instance metadata ───────────────────────────────────────────────────
imds_get() {
  local path="$1"
  local token
  token=$(get_imds_token)
  curl -sf -H "X-aws-ec2-metadata-token: ${token}" \
    "${METADATA_BASE}/meta-data/${path}" 2>/dev/null || echo ""
}

# ── Check Spot interruption notice ───────────────────────────────────────────
check_spot_interruption() {
  local token
  token=$(get_imds_token)
  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "X-aws-ec2-metadata-token: ${token}" \
    "${METADATA_BASE}/meta-data/spot/instance-action" 2>/dev/null || echo "404")
  [[ "$http_code" == "200" ]]
}

# ── Find in-flight job ────────────────────────────────────────────────────────
get_current_job() {
  # The batch_processor writes the active jobId to a well-known temp file
  if [[ -f /tmp/coldbones-active-job ]]; then
    cat /tmp/coldbones-active-job
  else
    echo ""
  fi
}

# ── Stop llama-server gracefully ──────────────────────────────────────────────
drain_llama_server() {
  log "Draining llama-server..."
  # Signal llama.cpp to reject new requests (no official endpoint; use SIGTERM)
  if systemctl is-active --quiet llama-server; then
    systemctl stop llama-server || true
  fi
  sleep 2
}

# ── Re-enqueue interrupted job ────────────────────────────────────────────────
requeue_job() {
  local job_id="$1"

  if [[ -z "$job_id" ]]; then
    log "No active job to requeue"
    return
  fi

  log "Requeueing job ${job_id} due to Spot interruption"

  # 1. Mark job as queued again in DynamoDB
  aws dynamodb update-item \
    --table-name "${JOBS_TABLE}" \
    --key "{\"jobId\":{\"S\":\"${job_id}\"}}" \
    --update-expression "SET #s = :s, #m = :m, updatedAt = :ts" \
    --expression-attribute-names '{"#s":"status","#m":"message"}' \
    --expression-attribute-values "{
      \":s\":{\"S\":\"queued\"},
      \":m\":{\"S\":\"Re-queued after Spot interruption\"},
      \":ts\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}
    }" \
    --region "${AWS_DEFAULT_REGION}" \
    2>/dev/null || log "WARNING: Failed to update DynamoDB for job ${job_id}"

  # 2. Read job details from DynamoDB for SQS payload
  local item
  item=$(aws dynamodb get-item \
    --table-name "${JOBS_TABLE}" \
    --key "{\"jobId\":{\"S\":\"${job_id}\"}}" \
    --region "${AWS_DEFAULT_REGION}" \
    --output json 2>/dev/null || echo "{}")

  local s3_key bucket
  s3_key=$(echo "$item" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Item',{}).get('s3Key',{}).get('S',''))" 2>/dev/null || echo "")
  bucket=$(echo "$item" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Item',{}).get('bucket',{}).get('S',''))" 2>/dev/null || echo "")

  # 3. Send to SQS
  if [[ -n "$s3_key" ]] && [[ -n "${SQS_QUEUE_URL:-}" ]]; then
    local msg
    msg=$(python3 -c "
import json
print(json.dumps({
    'jobId': '${job_id}',
    's3Key': '${s3_key}',
    'bucket': '${bucket}',
    'retryFromInterruption': True
}))
")
    aws sqs send-message \
      --queue-url "${SQS_QUEUE_URL}" \
      --message-body "$msg" \
      --region "${AWS_DEFAULT_REGION}" \
      && log "Job ${job_id} requeued to SQS" \
      || log "WARNING: Failed to requeue job ${job_id} to SQS"
  else
    log "WARNING: Missing s3Key or SQS_QUEUE_URL — cannot requeue job ${job_id}"
  fi

  # 4. Clean up active-job marker
  rm -f /tmp/coldbones-active-job
}

# ── Complete lifecycle hook ───────────────────────────────────────────────────
complete_lifecycle_hook() {
  local instance_id
  local asg_name
  instance_id=$(imds_get "instance-id")
  asg_name=$(imds_get "tags/instance/aws:autoscaling:groupName" 2>/dev/null || echo "")

  if [[ -z "$asg_name" ]]; then
    log "Could not determine ASG name — skipping lifecycle hook completion"
    return
  fi

  log "Completing lifecycle hook for instance ${instance_id} in ASG ${asg_name}"
  aws autoscaling complete-lifecycle-action \
    --lifecycle-hook-name "coldbones-spot-terminate" \
    --auto-scaling-group-name "${asg_name}" \
    --instance-id "${instance_id}" \
    --lifecycle-action-result CONTINUE \
    --region "${AWS_DEFAULT_REGION}" \
    2>/dev/null || log "WARNING: Failed to complete lifecycle hook"
}

# ─────────────────────────────────────────────────────────────────────────────
# Main loop
# ─────────────────────────────────────────────────────────────────────────────
log "Spot interrupt handler started (poll interval: ${POLL_INTERVAL}s)"

while true; do
  if check_spot_interruption; then
    log "!!! SPOT INTERRUPTION NOTICE RECEIVED !!!"

    ACTIVE_JOB=$(get_current_job)
    log "Active job: ${ACTIVE_JOB:-none}"

    drain_llama_server
    requeue_job "$ACTIVE_JOB"
    complete_lifecycle_hook

    log "Graceful drain complete — instance will terminate shortly"
    # Block until AWS terminates the instance (≈2 min after notice)
    sleep 300
  fi

  sleep "$POLL_INTERVAL"
done
