"""
Lambda: analyze-router

Routes incoming /api/analyze requests.
  - fast mode  → directly invokes analyze-orchestrator Lambda (synchronous)
  - slow mode  → enqueues message to SQS for async batch processing

Event (API Gateway proxy event):
  POST /api/analyze
  Body: { "s3Key": "uploads/…", "lang": "en", "mode": "fast|slow",
          "filename": "photo.jpg" }
"""

import json
import os
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError

lambda_client = boto3.client("lambda")
sqs_client = boto3.client("sqs")

ORCHESTRATOR_FUNCTION_ARN = os.environ.get("ORCHESTRATOR_FUNCTION_ARN", "")
ANALYZE_QUEUE_URL = os.environ.get("ANALYZE_QUEUE_URL", "")


def handler(event: dict, _context: Any) -> dict:
    # Parse body
    raw_body = event.get("body") or "{}"
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return _error(400, "Invalid JSON body")

    s3_key = body.get("s3Key", "").strip()
    lang = body.get("lang", "en").strip()
    mode = body.get("mode", "fast").strip().lower()
    filename = body.get("filename", "file").strip()

    if not s3_key:
        return _error(400, "Missing s3Key")

    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "s3Key": s3_key,
        "lang": lang,
        "filename": filename,
        "mode": mode,
    }

    if mode == "slow":
        return _enqueue(payload)
    else:
        return _invoke_sync(payload)


def _invoke_sync(payload: dict) -> dict:
    if not ORCHESTRATOR_FUNCTION_ARN:
        return _error(500, "ORCHESTRATOR_FUNCTION_ARN not configured")
    try:
        resp = lambda_client.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION_ARN,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        result_raw = resp["Payload"].read()
        result = json.loads(result_raw)
        return result
    except ClientError as e:
        return _error(502, f"Orchestrator invocation failed: {e}")


def _enqueue(payload: dict) -> dict:
    if not ANALYZE_QUEUE_URL:
        return _error(500, "ANALYZE_QUEUE_URL not configured")
    try:
        sqs_client.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps(payload),
        )
        return {
            "statusCode": 202,
            "body": json.dumps({
                "jobId": payload["jobId"],
                "status": "queued",
                "message": "Job queued for processing. Poll /api/status/{jobId} for results.",
            }),
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        }
    except ClientError as e:
        return _error(502, f"SQS enqueue failed: {e}")


def _error(status: int, msg: str) -> dict:
    return {
        "statusCode": status,
        "body": json.dumps({"detail": msg}),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }
