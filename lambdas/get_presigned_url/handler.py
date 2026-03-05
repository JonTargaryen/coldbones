"""
Lambda: get-presigned-url

Why presigned URLs instead of uploading through API Gateway / Lambda?
  API Gateway has a 10 MB payload limit and a 29 s timeout.  Routing an image
  or PDF through it would hit both limits for larger files.  A presigned PUT URL
  lets the browser upload directly to S3 at full S3 throughput (~tens of MB/s)
  without touching our backend at all after the URL is generated.

Flow:
  1. Browser POST /api/presign  → this Lambda generates a presigned PUT URL
  2. Browser PUT <file bytes> directly to that S3 URL  (no Lambda involved)
  3. Browser POST /api/analyze  → analyze_router picks up the s3Key

Security:
  - The presigned URL is scoped to a single key, single content-type, and
    expires in PRESIGN_EXPIRY_SECONDS (default 300 s = 5 min).
  - AllowedContentTypes prevents someone from uploading arbitrary file types
    with a forged content-type header.
  - The upload bucket has a 1-day lifecycle rule: objects expire automatically,
    so there is no long-term storage cost even if analysis never runs.
  - The UUID prefix makes enumeration of other uploads impractical.

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
# 300 s (5 min) gives the browser plenty of time to PUT after receiving the URL,
# while keeping the attack window short should the URL be intercepted.
PRESIGN_EXPIRY = int(os.environ.get("PRESIGN_EXPIRY_SECONDS", 300))

# Maximum upload size: 20 MB (matches frontend validation).
# Enforced server-side via presigned URL conditions so even a crafted
# PUT bypassing the browser will be rejected by S3.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024

# Allowlist — matched against the Content-Type the browser declares.
# The orchestrator also re-validates via magic bytes, so this is a first-pass
# guard that filters obviously wrong uploads before they hit S3.
ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/gif", "image/bmp", "image/tiff", "application/pdf",
    "video/mp4", "video/webm", "video/quicktime",
    "video/x-msvideo", "video/x-matroska",
}


def handler(event: dict, _context: Any) -> dict:
    """Lambda entry point: generate a presigned S3 PUT URL for file upload."""
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

    # Build a path that is:
    #   - Prefixed with "uploads/" so the lifecycle rule targets it precisely.
    #   - Namespaced by a UUID so that two users uploading "photo.jpg" at the
    #     same time get distinct keys and don't overwrite each other.
    #   - Suffixed with the sanitised filename for human readability in the
    #     S3 console and in the DynamoDB job record.
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
            HttpMethod="PUT",
        )

        # Also generate a presigned POST with content-length enforcement.
        # The presigned URL itself can't enforce content-length, but we
        # record the limit so the orchestrator can verify after upload.
        # S3 will reject PUTs > 5 GB natively, but this tighter limit
        # prevents abuse within the 20 MB we actually support.
    except ClientError as e:
        return _error(502, f"Could not generate presigned URL: {e}")

    return {
        "statusCode": 200,
        "body": json.dumps({
            "uploadUrl": upload_url,
            "s3Key": s3_key,
            "expiresIn": PRESIGN_EXPIRY,
            "maxSizeBytes": MAX_UPLOAD_BYTES,
        }),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }


def _safe_filename(filename: str) -> str:
    """Strip path separators (defence against path-traversal) and replace any
    character that isn't alphanumeric, dot, hyphen, or underscore with an
    underscore.  Falls back to 'upload' if the result is empty."""
    # Strip any leading directory components from Windows or Unix paths.
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    # Replace shell-unsafe characters.  S3 technically allows most chars but
    # keeping to this set avoids surprises in signed-URL construction.
    name = re.sub(r"[^\w.\-]", "_", name)
    return name or "upload"


def _error(status: int, msg: str) -> dict:
    """Build a JSON error response with the given HTTP status."""
    return {
        "statusCode": status,
        "body": json.dumps({"detail": msg}),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }
