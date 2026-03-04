"""
Lambda: analyze-orchestrator

Fast-mode: downloads file from S3, preprocesses it (convert to PNG, handle PDFs),
then calls the warm GPU instance via OpenAI-compatible /v1/chat/completions endpoint.

Designed to complete in under 60 seconds (Lambda timeout set accordingly).
GPU URL is injected via environment variable pointing to the EC2 internal LB.

Event:
  { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/original.jpg",
    "lang": "en", "filename": "photo.jpg" }

Response:
  Full analysis JSON (same schema as the local FastAPI /api/analyze endpoint)
"""

import base64
import io
import json
import os
import re
import time
from typing import Any

import boto3
from botocore.exceptions import ClientError
from openai import OpenAI
from PIL import Image

s3_client = boto3.client("s3")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
GPU_ENDPOINT = os.environ.get("GPU_ENDPOINT", "http://localhost:1234/v1")
GPU_API_KEY = os.environ.get("GPU_API_KEY", "llama.cpp")
MAX_TOKENS = int(os.environ.get("MAX_INFERENCE_TOKENS", 16384))
MODEL_NAME = os.environ.get("MODEL_NAME", "")
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))

client = OpenAI(base_url=GPU_ENDPOINT, api_key=GPU_API_KEY, timeout=55.0)

HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
}

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully. Think through what you see step by step, then respond with a JSON object (no markdown fences) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible. Your final output after any thinking must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    "en": "",
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.",
    "es": "IMPORTANT: Respond entirely in Spanish (Español). All JSON values must be in Spanish.",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.",
}


def handler(event: dict, _context: Any) -> dict:
    job_id = event.get("jobId", "unknown")
    s3_key = event.get("s3Key", "")
    lang = event.get("lang", "en")

    if not s3_key:
        return _error(400, "Missing s3Key")

    start = time.time()

    # Download file from S3
    try:
        obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
        file_bytes = obj["Body"].read()
        content_type = obj.get("ContentType", "") or _guess_type(s3_key)
    except ClientError as e:
        return _error(502, f"Failed to download file from S3: {e}")

    # Build image data URLs
    image_data_urls: list[str] = []

    if content_type == "application/pdf" or s3_key.lower().endswith(".pdf"):
        image_data_urls = _pdf_to_data_urls(file_bytes, job_id)
    else:
        data_url = _image_to_data_url(file_bytes, content_type)
        if data_url:
            image_data_urls.append(data_url)

    if not image_data_urls:
        return _error(400, "Could not extract image data from file")

    # Build message content
    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": url}}
        for url in image_data_urls
    ]

    analysis_text = (
        "Analyze this image thoroughly."
        if len(image_data_urls) == 1
        else f"Analyze these {len(image_data_urls)} pages thoroughly. Provide a holistic analysis."
    )
    lang_instruction = LANGUAGE_INSTRUCTIONS.get(lang, "")
    if lang_instruction:
        analysis_text = f"{analysis_text}\n\n{lang_instruction}"

    content.append({"type": "text", "text": analysis_text})

    # Detect model name
    model_name = MODEL_NAME or _detect_model()

    # Call GPU inference
    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            max_tokens=MAX_TOKENS,
            temperature=0.6,
        )
    except Exception as e:
        return _error(502, f"GPU inference failed: {e}")

    elapsed_ms = int((time.time() - start) * 1000)

    message = response.choices[0].message
    raw_content = message.content or ""
    finish_reason = response.choices[0].finish_reason or ""

    reasoning = ""
    try:
        msg_dict = message.model_dump() if hasattr(message, "model_dump") else message.__dict__
        reasoning = msg_dict.get("reasoning_content", "") or ""
    except Exception:
        pass

    if not raw_content.strip() and reasoning:
        result = {
            "summary": "Model completed reasoning but did not produce a structured answer. Increase MAX_INFERENCE_TOKENS.",
            "key_observations": _extract_observations(reasoning),
            "content_classification": "unknown (inference incomplete)",
            "extracted_text": "No text detected.",
        }
    else:
        result = _parse_model_response(raw_content)

    body = {
        "jobId": job_id,
        "summary": result.get("summary", ""),
        "key_observations": result.get("key_observations", []),
        "content_classification": result.get("content_classification", ""),
        "extracted_text": result.get("extracted_text", ""),
        "reasoning": reasoning,
        "reasoning_token_count": len(reasoning.split()) if reasoning else 0,
        "processing_time_ms": elapsed_ms,
        "finish_reason": finish_reason,
        "mode": "fast",
        "model": model_name,
    }

    return {"statusCode": 200, "headers": HEADERS, "body": json.dumps(body)}


# ── Helpers ──────────────────────────────────────────────────────────────


def _guess_type(key: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "webp": "image/webp",
        "gif": "image/gif", "bmp": "image/bmp",
        "tiff": "image/tiff", "tif": "image/tiff",
        "pdf": "application/pdf",
    }.get(ext, "application/octet-stream")


def _image_to_data_url(raw_bytes: bytes, mime_type: str) -> str | None:
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/png;base64,{b64}"
    except Exception as e:
        print(f"Image conversion error: {e}")
        return None


def _pdf_to_data_urls(pdf_bytes: bytes, job_id: str) -> list[str]:
    try:
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(pdf_bytes, dpi=150, fmt="png")
        result = []
        for img in images[:MAX_PDF_PAGES]:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            result.append(f"data:image/png;base64,{b64}")
        return result
    except Exception as e:
        print(f"PDF conversion error for job {job_id}: {e}")
        return []


def _detect_model() -> str:
    try:
        models = client.models.list()
        if models.data:
            return models.data[0].id
    except Exception:
        pass
    return "default"


def _parse_model_response(text: str) -> dict:
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


def _extract_observations(reasoning: str) -> list[str]:
    observations = []
    for line in reasoning.split("\n"):
        line = line.strip()
        if (
            line and len(line) > 20
            and not line.startswith(("Thinking", "Let me"))
            and (
                line.startswith(("- ", "* ", "• "))
                or re.match(r"^\d+[.)]", line)
                or any(kw in line.lower() for kw in ["i see", "i notice", "the image", "this shows"])
            )
        ):
            cleaned = re.sub(r"^[-*•\d.)]+\s*", "", line).strip()
            if cleaned and len(cleaned) > 10:
                observations.append(cleaned)
        if len(observations) >= 10:
            break
    return observations


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps({"error": message}),
    }
