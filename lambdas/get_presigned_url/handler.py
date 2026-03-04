"""
Lambda: get-presigned-url

Generates an S3 pre-signed PUT URL so the browser can upload directly to S3
without going through the backend. Also writes an initial job record to DynamoDB.

Event (API Gateway REST):
  POST /upload
  Body: { "filename": "photo.jpg", "contentType": "image/jpeg", "mode": "fast" }

Response:
  { "uploadUrl": "https://...", "s3Key": "uploads/<jobId>/original.<ext>", "jobId": "<uuid>" }
"""

import json
import os
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
JOBS_TABLE = os.environ["JOBS_TABLE"]
URL_EXPIRES_IN = int(os.environ.get("URL_EXPIRES_IN", 300))  # 5 minutes


def handler(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return _error(400, "Invalid JSON body")

    filename = body.get("filename", "upload")
    content_type = body.get("contentType", "application/octet-stream")
    mode = body.get("mode", "fast")

    # Sanitise filename and derive extension
    safe_name = "".join(c for c in filename if c.isalnum() or c in (".", "-", "_"))
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "bin"

    job_id = str(uuid.uuid4())
    s3_key = f"uploads/{job_id}/original.{ext}"

    # Generate pre-signed PUT URL
    try:
        presigned_url = s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": UPLOAD_BUCKET,
                "Key": s3_key,
                "ContentType": content_type,
            },
            ExpiresIn=URL_EXPIRES_IN,
        )
    except ClientError as e:
        return _error(500, f"Failed to generate pre-signed URL: {e}")

    # Write initial job record to DynamoDB
    table = dynamodb.Table(JOBS_TABLE)
    ttl = int((datetime.now(timezone.utc).timestamp()) + 86400)  # 24h TTL
    try:
        table.put_item(
            Item={
                "jobId": job_id,
                "status": "pending",
                "mode": mode,
                "s3Key": s3_key,
                "filename": filename,
                "contentType": content_type,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "expiresAt": ttl,
            }
        )
    except ClientError as e:
        # Non-fatal — still return the URL
        print(f"WARNING: Failed to write job to DynamoDB: {e}")

    return _ok(
        {
            "uploadUrl": presigned_url,
            "s3Key": s3_key,
            "jobId": job_id,
        }
    )


def _ok(body: dict) -> dict:
    return {
        "statusCode": 200,
        "headers": _cors_headers(),
        "body": json.dumps(body),
    }


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": _cors_headers(),
        "body": json.dumps({"error": message}),
    }


def _cors_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    }
