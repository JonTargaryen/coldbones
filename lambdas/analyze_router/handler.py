"""
Lambda: analyze-router

Inspects the `mode` field on an incoming analysis request and routes accordingly:
  - mode=fast  → invoke analyze-orchestrator Lambda synchronously, return result inline
  - mode=slow  → enqueue to SQS, write queued job to DynamoDB, return jobId

Event (API Gateway REST):
  POST /analyze
  Body: { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/original.jpg",
          "mode": "fast"|"slow", "lang": "en", "filename": "photo.jpg" }

Fast Response:
  AnalysisResult JSON (same schema as /api/analyze in the local FastAPI dev server)

Slow Response:
  { "jobId": "<uuid>", "status": "queued", "estimatedWait": <seconds> }
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

lambda_client = boto3.client("lambda")
sqs = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")

ORCHESTRATOR_FUNCTION = os.environ["ORCHESTRATOR_FUNCTION"]
ANALYZE_QUEUE_URL = os.environ["ANALYZE_QUEUE_URL"]
JOBS_TABLE = os.environ["JOBS_TABLE"]

HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
}


def handler(event: dict, context: Any) -> dict:
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": HEADERS, "body": ""}

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return _error(400, "Invalid JSON body")

    mode = body.get("mode", "fast")
    job_id = body.get("jobId") or str(uuid.uuid4())
    s3_key = body.get("s3Key", "")
    lang = body.get("lang", "en")
    filename = body.get("filename", "")

    if not s3_key:
        return _error(400, "Missing required field: s3Key")

    if mode == "fast":
        return _handle_fast(job_id, s3_key, lang, filename)
    else:
        return _handle_slow(job_id, s3_key, lang, filename)


def _handle_fast(job_id: str, s3_key: str, lang: str, filename: str) -> dict:
    """Invoke the orchestrator Lambda synchronously and return the result inline."""
    payload = json.dumps({
        "jobId": job_id,
        "s3Key": s3_key,
        "lang": lang,
        "filename": filename,
    })

    try:
        response = lambda_client.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION,
            InvocationType="RequestResponse",
            Payload=payload,
        )
        result_payload = json.loads(response["Payload"].read())

        if response.get("FunctionError"):
            error_msg = result_payload.get("errorMessage", "Inference Lambda failed")
            return _error(502, f"Fast-mode inference failed: {error_msg}")

        # Pass through the orchestrator's response body directly
        if isinstance(result_payload, dict) and "statusCode" in result_payload:
            return result_payload
        return {
            "statusCode": 200,
            "headers": HEADERS,
            "body": json.dumps(result_payload),
        }

    except ClientError as e:
        return _error(502, f"Failed to invoke orchestrator: {e}")


def _handle_slow(job_id: str, s3_key: str, lang: str, filename: str) -> dict:
    """Enqueue the job to SQS and write a queued record to DynamoDB."""
    table = dynamodb.Table(JOBS_TABLE)
    now = datetime.now(timezone.utc).isoformat()
    ttl = int(datetime.now(timezone.utc).timestamp() + 86400)

    # Write job record
    try:
        table.put_item(
            Item={
                "jobId": job_id,
                "status": "queued",
                "mode": "slow",
                "s3Key": s3_key,
                "filename": filename,
                "lang": lang,
                "createdAt": now,
                "updatedAt": now,
                "expiresAt": ttl,
            }
        )
    except ClientError as e:
        print(f"ERROR: DynamoDB put failed: {e}")
        return _error(500, "Failed to create job record")

    # Enqueue SQS message
    try:
        sqs.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps({
                "jobId": job_id,
                "s3Key": s3_key,
                "lang": lang,
                "filename": filename,
            }),
            MessageGroupId=job_id,  # For FIFO queues; ignored for standard
        )
    except Exception as e:
        # If using standard queue (not FIFO), MessageGroupId is unsupported — retry without it
        try:
            sqs.send_message(
                QueueUrl=ANALYZE_QUEUE_URL,
                MessageBody=json.dumps({
                    "jobId": job_id,
                    "s3Key": s3_key,
                    "lang": lang,
                    "filename": filename,
                }),
            )
        except ClientError as e2:
            print(f"ERROR: SQS send failed: {e2}")
            return _error(500, "Failed to enqueue analysis job")

    # Estimate wait time based on SQS queue depth
    estimated_wait = _estimate_wait_seconds()

    return {
        "statusCode": 202,
        "headers": HEADERS,
        "body": json.dumps({
            "jobId": job_id,
            "status": "queued",
            "estimatedWait": estimated_wait,
            "message": "Job queued for processing. Use the jobId to poll /status/{jobId} for results.",
        }),
    }


def _estimate_wait_seconds() -> int:
    """Rough estimate: assume 4-min GPU cold start + 30s per queued job ahead."""
    try:
        attrs = sqs.get_queue_attributes(
            QueueUrl=ANALYZE_QUEUE_URL,
            AttributeNames=["ApproximateNumberOfMessages"],
        )
        depth = int(attrs["Attributes"].get("ApproximateNumberOfMessages", 0))
        return 240 + depth * 30  # 4 min cold start + 30s per job
    except Exception:
        return 300  # Default 5-minute estimate


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps({"error": message}),
    }
