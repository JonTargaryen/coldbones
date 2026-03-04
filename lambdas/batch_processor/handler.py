"""
Lambda: batch-processor

Slow-mode SQS consumer. Triggered by SQS event source mapping.
For each job: downloads file from S3, sends to LM Studio on Seratonin via the
OpenAI-compatible API, writes result to DynamoDB, publishes SNS notification.

Environment variables:
  UPLOAD_BUCKET       — S3 bucket for uploads + results
  LM_STUDIO_URL       — Base URL of LM Studio (e.g. https://seratonin.tail40ae2c.ts.net)
  LM_STUDIO_API_KEY   — API key (any non-empty value, LM Studio doesn't enforce)
  JOBS_TABLE          — DynamoDB table name
  ANALYZE_QUEUE_URL   — SQS queue URL
  SNS_TOPIC_ARN       — SNS topic for job completion notifications
  MAX_INFERENCE_TOKENS— Max tokens for model response (default: 8192)
  MAX_PDF_PAGES       — Max PDF pages to process (default: 20)
"""

import base64
import io
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError
from openai import OpenAI
from PIL import Image

s3_client = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
sns_client = boto3.client("sns")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "https://seratonin.tail40ae2c.ts.net")
LM_STUDIO_API_KEY = os.environ.get("LM_STUDIO_API_KEY", "lm-studio")
JOBS_TABLE = os.environ["JOBS_TABLE"]
ANALYZE_QUEUE_URL = os.environ["ANALYZE_QUEUE_URL"]
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
MAX_TOKENS = int(os.environ.get("MAX_INFERENCE_TOKENS", 8192))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))

client = OpenAI(
    base_url=f"{LM_STUDIO_URL.rstrip('/')}/v1",
    api_key=LM_STUDIO_API_KEY,
    timeout=300.0,
)

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully and respond with a JSON object (no markdown fences) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible. Your output must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    "en": "",
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.",
    "es": "IMPORTANT: Respond entirely in Spanish (Español). All JSON values must be in Spanish.",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.",
}

ACCEPTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


def handler(event: dict, _context: Any) -> dict:
    table = dynamodb.Table(JOBS_TABLE)
    records = event.get("Records", [])

    for record in records:
        body_raw = record.get("body", "{}")
        try:
            payload = json.loads(body_raw)
        except json.JSONDecodeError:
            print(f"[batch_processor] Skipping unparseable SQS record: {body_raw[:200]}")
            continue

        job_id = payload.get("jobId", "unknown")
        s3_key = payload.get("s3Key", "")
        lang = payload.get("lang", "en")

        _update_job(table, job_id, {"status": "PROCESSING", "startedAt": _now()})

        try:
            result = _process(s3_key, lang)
            _update_job(table, job_id, {
                "status": "COMPLETED",
                "completedAt": _now(),
                "result": result,
            })
            if SNS_TOPIC_ARN:
                _notify(job_id, "COMPLETED")
        except Exception as e:
            print(f"[batch_processor] job={job_id} FAILED: {e}")
            _update_job(table, job_id, {
                "status": "FAILED",
                "completedAt": _now(),
                "error": str(e)[:500],
            })
            if SNS_TOPIC_ARN:
                _notify(job_id, "FAILED")

    return {"batchItemFailures": []}


def _process(s3_key: str, lang: str) -> dict:
    obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
    file_bytes = obj["Body"].read()
    content_type = _detect_type(file_bytes, s3_key)

    if content_type == "application/pdf" or s3_key.lower().endswith(".pdf"):
        image_data_urls = _pdf_to_data_urls(file_bytes)
    elif content_type in ACCEPTED_IMAGE_TYPES or content_type.startswith("image/"):
        url = _image_to_data_url(file_bytes)
        image_data_urls = [url] if url else []
    else:
        raise ValueError(f"Unsupported content type: {content_type}")

    if not image_data_urls:
        raise ValueError("Could not extract images from file")

    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": url}}
        for url in image_data_urls
    ]
    analysis_text = (
        "Analyze this image thoroughly."
        if len(image_data_urls) == 1
        else f"Analyze these {len(image_data_urls)} pages from a document. Provide a holistic analysis."
    )
    lang_instr = LANGUAGE_INSTRUCTIONS.get(lang, "")
    if lang_instr:
        analysis_text = f"{analysis_text}\n\n{lang_instr}"
    content.append({"type": "text", "text": analysis_text})

    model_name = _detect_model()
    start = time.time()
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        max_tokens=MAX_TOKENS,
        temperature=0.6,
    )
    raw_text = response.choices[0].message.content or ""
    elapsed_ms = int((time.time() - start) * 1000)

    parsed = _parse(raw_text)
    return {
        "summary": parsed.get("summary", ""),
        "key_observations": parsed.get("key_observations", []),
        "content_classification": parsed.get("content_classification", ""),
        "extracted_text": parsed.get("extracted_text", ""),
        "processing_time_ms": elapsed_ms,
        "model": model_name,
        "provider": "LM Studio (Seratonin)",
        "mode": "slow",
    }


def _detect_type(raw: bytes, s3_key: str) -> str:
    if raw.startswith(b"%PDF-"):
        return "application/pdf"
    if raw.startswith(b"\xFF\xD8\xFF"):
        return "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw.startswith(b"GIF87a") or raw.startswith(b"GIF89a"):
        return "image/gif"
    ext = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else ""
    return {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "webp": "image/webp", "gif": "image/gif", "pdf": "application/pdf"}.get(ext, "")


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


def _pdf_to_data_urls(pdf_bytes: bytes) -> list[str]:
    try:
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(pdf_bytes, dpi=150, fmt="png")
        result = []
        for img in images[:MAX_PDF_PAGES]:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            result.append("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
        return result
    except Exception as e:
        print(f"PDF conversion error: {e}")
        return []


def _detect_model() -> str:
    try:
        models = client.models.list()
        if models.data:
            return models.data[0].id
    except Exception:
        pass
    return "qwen3.5"


def _parse(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "summary": text[:500],
            "key_observations": [],
            "content_classification": "unknown",
            "extracted_text": "No text detected.",
        }


def _update_job(table: Any, job_id: str, fields: dict) -> None:
    expr_parts, attr_names, attr_values = [], {}, {}
    for k, v in fields.items():
        safe, val_key = f"#f_{k}", f":v_{k}"
        expr_parts.append(f"{safe} = {val_key}")
        attr_names[safe] = k
        attr_values[val_key] = v
    table.update_item(
        Key={"jobId": job_id},
        UpdateExpression="SET " + ", ".join(expr_parts),
        ExpressionAttributeNames=attr_names,
        ExpressionAttributeValues=attr_values,
    )


def _notify(job_id: str, status: str) -> None:
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=f"ColdBones job {status}",
            Message=json.dumps({"jobId": job_id, "status": status}),
        )
    except Exception as e:
        print(f"[batch_processor] SNS notify failed: {e}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
