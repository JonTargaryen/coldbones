"""
Lambda: pdf-to-images

Converts PDF pages to PNG images and stores them in S3 under:
  uploads/{jobId}/pages/page_{n:04d}.png

Used by analyze-orchestrator when PDFs are submitted via S3 key.
Requires Poppler and pdf2image installed in a Lambda layer.

Event:
  { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/original.pdf",
    "maxPages": 20, "dpi": 150 }

Response:
  { "jobId": "<uuid>", "pageKeys": [...], "pageCount": N }
"""

import io
import json
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

s3_client = boto3.client("s3")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
DEFAULT_MAX_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))
DEFAULT_DPI = int(os.environ.get("PDF_DPI", 150))


def handler(event: dict, _context: Any) -> dict:
    job_id = event.get("jobId", "unknown")
    s3_key = event.get("s3Key", "")
    max_pages = int(event.get("maxPages", DEFAULT_MAX_PAGES))
    dpi = int(event.get("dpi", DEFAULT_DPI))

    if not s3_key:
        raise ValueError("Missing required field: s3Key")

    # Download PDF from S3
    try:
        obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
        pdf_bytes = obj["Body"].read()
    except ClientError as e:
        raise RuntimeError(f"Failed to download PDF from S3: {e}") from e

    if not _is_valid_pdf(pdf_bytes):
        raise ValueError("Uploaded file is not a valid PDF (signature mismatch or corruption)")

    # Convert using pdf2image (backed by Poppler)
    try:
        from pdf2image import convert_from_bytes

        images = convert_from_bytes(pdf_bytes, dpi=dpi, fmt="png", thread_count=2)
    except Exception as e:
        raise RuntimeError(f"PDF conversion failed. Poppler may not be installed: {e}") from e

    pages = images[:max_pages]
    page_keys: list[str] = []

    for i, img in enumerate(pages, start=1):
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False)
        page_key = f"uploads/{job_id}/pages/page_{i:04d}.png"
        try:
            s3_client.put_object(
                Bucket=UPLOAD_BUCKET,
                Key=page_key,
                Body=buf.getvalue(),
                ContentType="image/png",
            )
            page_keys.append(page_key)
        except ClientError as e:
            raise RuntimeError(f"Failed to upload page {i} to S3: {e}") from e

    return {
        "jobId": job_id,
        "pageKeys": page_keys,
        "pageCount": len(page_keys),
        "totalPages": len(images),
        "truncated": len(images) > max_pages,
    }


def _is_valid_pdf(raw_bytes: bytes) -> bool:
    if len(raw_bytes) < 8:
        return False
    return raw_bytes.startswith(b"%PDF-")
