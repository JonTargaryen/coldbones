"""
Lambda: job-status

Serves GET /api/status/{jobId} — the polling endpoint the browser calls after
submitting an analysis job and receiving a 202 response.

Why poll instead of WebSockets or SSE?
  - Simple to implement and debug.
  - Lambda + API Gateway REST support WebSockets only via a separate API type
    (API Gateway WebSocket API).  Adding that doubles the infrastructure surface.
  - Poll interval is 4 s (fast mode) / 4 s (slow mode).  For typical inference
    times of 15–90 s this means 4–23 extra round trips — negligible cost and
    latency overhead.
  - If we ever want push notifications we can add SNS → browser without changing
    this Lambda at all.

DynamoDB item schema (relevant fields):
  {
    "jobId":       string (PK)  — UUID set by analyze_router
    "status":      "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED"
    "createdAt":   ISO-8601 UTC — when the job was accepted
    "startedAt":   ISO-8601 UTC — when the orchestrator picked it up
    "completedAt": ISO-8601 UTC — when inference finished
    "result":      map          — full analysis payload (status=COMPLETED only)
    "error":       string       — error message (status=FAILED only)
    "ttl":         epoch secs   — DynamoDB TTL; items auto-delete after 24 h
  }

Event (API Gateway proxy):
  GET /api/status/{jobId}
"""

import json
import os
from decimal import Decimal
from typing import Any

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
JOBS_TABLE = os.environ["JOBS_TABLE"]


def handler(event: dict, _context: Any) -> dict:
    path_params = event.get("pathParameters") or {}
    job_id = path_params.get("jobId", "").strip()

    if not job_id:
        return _error(400, "Missing jobId in path")

    table = dynamodb.Table(JOBS_TABLE)
    try:
        resp = table.get_item(Key={"jobId": job_id})
    except ClientError as e:
        return _error(502, f"DynamoDB read failed: {e}")

    item = resp.get("Item")
    if not item:
        return _error(404, f"Job '{job_id}' not found")

    status = item.get("status", "UNKNOWN")
    out: dict = {
        "jobId": job_id,
        "status": status,
        "createdAt": item.get("createdAt"),
        "startedAt": item.get("startedAt"),
        "completedAt": item.get("completedAt"),
    }

    if status == "COMPLETED":
        out["result"] = item.get("result", {})
    elif status == "FAILED":
        out["error"] = item.get("error", "Unknown error")

    # Surface streaming partial text for in-flight jobs
    if status == "PROCESSING":
        partial = item.get("partial_text")
        if partial:
            out["partial_text"] = partial
            out["partial_len"] = int(item.get("partial_len", 0))

    return {
        "statusCode": 200,
        "body": json.dumps(out, default=_json_default),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }


def _json_default(obj: Any) -> Any:
    """Custom json.dumps serialiser for types DynamoDB boto3 returns.

    The boto3 DynamoDB resource deserialises Number attributes as Python
    Decimal, not int/float, to avoid floating-point precision loss.  json.dumps
    cannot serialize Decimal by default, so we convert it here:
      - Whole numbers (e.g. Decimal('42')) → int (preserves JSON integer type)
      - Fractional numbers (e.g. Decimal('3.14')) → float
      - Anything else → str (fallback so serialisation never crashes)
    """
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    return str(obj)


def _error(status: int, msg: str) -> dict:
    return {
        "statusCode": status,
        "body": json.dumps({"detail": msg}),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }
