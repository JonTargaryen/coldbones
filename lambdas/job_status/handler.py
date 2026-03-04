"""
Lambda: job-status

Returns the current status and result of a slow-mode analysis job.

Event (API Gateway proxy):
  GET /api/status/{jobId}

DynamoDB item schema:
  {
    "jobId":       string (PK)
    "status":      "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED"
    "createdAt":   ISO timestamp
    "startedAt":   ISO timestamp (optional)
    "completedAt": ISO timestamp (optional)
    "result":      map (present when status=COMPLETED)
    "error":       string (present when status=FAILED)
  }
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

    return {
        "statusCode": 200,
        "body": json.dumps(out, default=_json_default),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }


def _json_default(obj: Any) -> Any:
    """Handle types not natively serializable by json.dumps.
    DynamoDB boto3 resource returns Decimal for Number attributes."""
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
