"""
Lambda: get-presigned-url

Generates an S3 pre-signed PUT URL so the browser can upload directly
to S3 without routing through API Gateway.

Event (API Gateway proxy):
  POST /api/presign
  Body: { "filename": "photo.jpg", "contentType": "image/jpeg" }

Returns:
  { "uploadUrl": "https://…", "s3Key": "uploads/<uuid>/photo.jpg",
    "expiresIn": 300 }
"""

import json
import os
import re
import uuid
from typing import Any

import boto3
from botocore.exceptions import ClientError

s3_client = boto3.client("s3")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
PRESIGN_EXPIRY = int(os.environ.get("PRESIGN_EXPIRY_SECONDS", 300))

ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/gif", "image/bmp", "image/tiff", "application/pdf",
}


def handler(event: dict, _context: Any) -> dict:
    raw_body = event.get("body") or "{}"
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return _error(400, "Invalid JSON body")

    filename = body.get("filename", "").strip()
    content_type = body.get("contentType", "").strip().lower()

    if not filename:
        return _error(400, "Missing filename")
    if not content_type:
        return _error(400, "Missing contentType")
    if content_type not in ALLOWED_CONTENT_TYPES:
        return _error(400, f"Unsupported content type: {content_type}")

    safe_name = _safe_filename(filename)
    file_uuid = str(uuid.uuid4())
    s3_key = f"uploads/{file_uuid}/{safe_name}"

    try:
        upload_url = s3_client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": UPLOAD_BUCKET,
                "Key": s3_key,
                "ContentType": content_type,
            },
            ExpiresIn=PRESIGN_EXPIRY,
        )
    except ClientError as e:
        return _error(502, f"Could not generate presigned URL: {e}")

    return {
        "statusCode": 200,
        "body": json.dumps({
            "uploadUrl": upload_url,
            "s3Key": s3_key,
            "expiresIn": PRESIGN_EXPIRY,
        }),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }


def _safe_filename(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    name = re.sub(r"[^\w.\-]", "_", name)
    return name or "upload"


def _error(status: int, msg: str) -> dict:
    return {
        "statusCode": status,
        "body": json.dumps({"detail": msg}),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }
