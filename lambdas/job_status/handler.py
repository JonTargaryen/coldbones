"""
Lambda: job-status

Returns the current status of a slow-mode analysis job.

Event (API Gateway REST):
  GET /status/{jobId}

Response (queued/processing):
  { "jobId": "<uuid>", "status": "queued"|"processing",
    "createdAt": "...", "estimatedWait": <seconds> }

Response (complete):
  { "jobId": "<uuid>", "status": "complete", "result": { ...analysisResult } }

Response (failed):
  { "jobId": "<uuid>", "status": "failed", "error": "..." }
"""

import json
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
sqs = boto3.client("sqs")

JOBS_TABLE = os.environ["JOBS_TABLE"]
ANALYZE_QUEUE_URL = os.environ.get("ANALYZE_QUEUE_URL", "")

HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
}


def handler(event: dict, _context: Any) -> dict:
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": HEADERS, "body": ""}

    path_params = event.get("pathParameters") or {}
    job_id = path_params.get("jobId", "")

    if not job_id:
        return _error(400, "Missing jobId path parameter")

    table = dynamodb.Table(JOBS_TABLE)
    try:
        resp = table.get_item(Key={"jobId": job_id})
    except ClientError as e:
        return _error(500, f"DynamoDB error: {e}")

    item = resp.get("Item")
    if not item:
        return _error(404, f"Job {job_id!r} not found")

    status = item.get("status", "unknown")
    response_body: dict = {
        "jobId": job_id,
        "status": status,
        "mode": item.get("mode", "slow"),
        "filename": item.get("filename", ""),
        "createdAt": item.get("createdAt", ""),
        "updatedAt": item.get("updatedAt", ""),
    }

    if status == "complete":
        # Result may be stored as JSON string or dict
        raw_result = item.get("result")
        if isinstance(raw_result, str):
            try:
                response_body["result"] = json.loads(raw_result)
            except Exception:
                response_body["result"] = {}
        elif isinstance(raw_result, dict):
            response_body["result"] = raw_result

    elif status == "failed":
        response_body["error"] = item.get("errorMessage", "Unknown error")

    elif status in ("queued", "processing"):
        response_body["estimatedWait"] = _estimate_wait()

    return {"statusCode": 200, "headers": HEADERS, "body": json.dumps(response_body)}


def _estimate_wait() -> int:
    if not ANALYZE_QUEUE_URL:
        return 300
    try:
        attrs = sqs.get_queue_attributes(
            QueueUrl=ANALYZE_QUEUE_URL,
            AttributeNames=["ApproximateNumberOfMessages"],
        )
        depth = int(attrs["Attributes"].get("ApproximateNumberOfMessages", 0))
        return 240 + depth * 30
    except Exception:
        return 300


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps({"error": message}),
    }
