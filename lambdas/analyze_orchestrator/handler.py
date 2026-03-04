"""
Lambda: analyze-orchestrator  (fast-mode)

Flow:
  1. Download the uploaded file from S3
  2. Convert to base64 PNG data URL(s) — handles JPEG, PNG, WEBP, PDF
  3. Call vLLM (Qwen3.5-35B-A3B-AWQ) via the OpenAI-compatible chat API
  4. Save the *result JSON* back to S3 alongside the original file
  5. Return the full analysis payload to the caller (analyze_router)

The vLLM endpoint is discovered at runtime from SSM:
  /coldbones/gpu-ip   → private EC2 IP of the running GPU instance
  /coldbones/gpu-port → vLLM HTTP port (8000)

Event:
  { "jobId": "...", "s3Key": "uploads/<uuid>/photo.jpg",
    "lang": "en", "filename": "photo.jpg", "mode": "fast" }
"""

import base64
import io
import json
import logging
import os
import re
import sys
import time
import traceback
from typing import Any

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

import boto3
from botocore.exceptions import ClientError
from PIL import Image

# GPU client module (sibling of this package — included via Lambda asset bundling)
sys.path.insert(0, '/var/task')
from gpu_client import get_openai_client, ensure_gpu_running, emit_inference_metric

s3_client = boto3.client('s3')

UPLOAD_BUCKET  = os.environ['UPLOAD_BUCKET']
MAX_TOKENS     = int(os.environ.get('MAX_INFERENCE_TOKENS', 8192))
MAX_PDF_PAGES  = int(os.environ.get('MAX_PDF_PAGES', 20))
GPU_ASG_NAME   = os.environ.get('GPU_ASG_NAME', '')

HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
}

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully.
Think through what you see step by step, then respond with a JSON object
(no markdown fences, no extra text) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible.
Your final output must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    'en': '',
    'hi': 'IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.',
    'es': 'IMPORTANT: Respond entirely in Spanish. All JSON values must be in Spanish.',
    'bn': 'IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.',
}


def handler(event: dict, _context: Any) -> dict:
    job_id   = event.get('jobId', 'unknown')
    s3_key   = event.get('s3Key', '')
    lang     = event.get('lang', 'en')
    filename = event.get('filename', 'file')

    if not s3_key:
        return _error(400, 'Missing s3Key')

    start = time.time()

    # ── Download from S3 ────────────────────────────────────────────────────
    try:
        obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
        file_bytes = obj['Body'].read()
    except ClientError as e:
        return _error(502, f'S3 download failed: {e}')

    content_type = _detect_magic_type(file_bytes, s3_key)
    if not content_type:
        return _error(400, 'Unsupported or corrupt file content')

    # ── Convert to image data URLs ──────────────────────────────────────────
    if content_type == 'application/pdf':
        image_data_urls = _pdf_to_data_urls(file_bytes, job_id)
    else:
        url = _image_to_data_url(file_bytes)
        image_data_urls = [url] if url else []

    if not image_data_urls:
        return _error(400, 'Could not extract image data from file')

    # ── Ensure GPU is up (pre-warm trigger) ─────────────────────────────────
    ensure_gpu_running(wait_seconds=0)   # non-blocking — orchestrator will error if not ready

    # ── Build vLLM request ──────────────────────────────────────────────────
    content: list[dict] = [
        {'type': 'image_url', 'image_url': {'url': u}} for u in image_data_urls
    ]
    analysis_text = (
        'Analyze this image thoroughly.'
        if len(image_data_urls) == 1
        else f'Analyze these {len(image_data_urls)} pages thoroughly. Provide a holistic analysis.'
    )
    lang_instr = LANGUAGE_INSTRUCTIONS.get(lang, '')
    if lang_instr:
        analysis_text = f'{analysis_text}\n\n{lang_instr}'
    content.append({'type': 'text', 'text': analysis_text})

    # ── Call vLLM ───────────────────────────────────────────────────────────
    try:
        client, model_name = get_openai_client(timeout=580.0)
        logger.info('Calling vLLM model=%s job=%s', model_name, job_id)

        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user',   'content': content},
            ],
            max_tokens=MAX_TOKENS,
            temperature=0.6,
        )
    except Exception as e:
        logger.error('vLLM inference failed job=%s: %s\n%s', job_id, e, traceback.format_exc())
        return _error(502, f'vLLM inference failed: {e}')

    elapsed_ms = int((time.time() - start) * 1000)
    raw_content   = response.choices[0].message.content or ''
    finish_reason = response.choices[0].finish_reason or ''

    # Emit CloudWatch metric to reset idle-shutdown alarm
    emit_inference_metric(GPU_ASG_NAME)

    result = _parse_model_response(raw_content)

    body = {
        'jobId':                   job_id,
        'summary':                 result.get('summary', ''),
        'key_observations':        result.get('key_observations', []),
        'content_classification':  result.get('content_classification', ''),
        'extracted_text':          result.get('extracted_text', ''),
        'processing_time_ms':      elapsed_ms,
        'finish_reason':           finish_reason,
        'mode':                    'fast',
        'model':                   model_name,
        'provider':                'vLLM (AWS Cloud GPU)',
        'filename':                filename,
    }

    # ── Persist result alongside the upload (S3) ────────────────────────────
    result_key = re.sub(r'/[^/]+$', '/result.json', s3_key)
    try:
        s3_client.put_object(
            Bucket=UPLOAD_BUCKET,
            Key=result_key,
            Body=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            ContentType='application/json',
        )
        body['resultS3Key'] = result_key
    except Exception as e:
        logger.warning('Could not save result to S3: %s', e)

    return {'statusCode': 200, 'headers': HEADERS, 'body': json.dumps(body, ensure_ascii=False)}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _detect_magic_type(raw: bytes, s3_key: str) -> str:
    if len(raw) < 12:
        return ''
    if raw.startswith(b'%PDF-'):           return 'application/pdf'
    if raw.startswith(b'\xFF\xD8\xFF'):    return 'image/jpeg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if raw.startswith(b'GIF87a') or raw.startswith(b'GIF89a'): return 'image/gif'
    if raw.startswith(b'BM'):              return 'image/bmp'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': return 'image/webp'
    if raw.startswith((b'II*\x00', b'MM\x00*')): return 'image/tiff'
    ext = s3_key.rsplit('.', 1)[-1].lower() if '.' in s3_key else ''
    return {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp',
        'tiff': 'image/tiff', 'tif': 'image/tiff', 'pdf': 'application/pdf',
    }.get(ext, '')


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        logger.error('Image conversion error: %s', e)
        return None


def _pdf_to_data_urls(pdf_bytes: bytes, job_id: str) -> list[str]:
    try:
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(pdf_bytes, dpi=150, fmt='png')
        result = []
        for img in images[:MAX_PDF_PAGES]:
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            result.append('data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
        return result
    except Exception as e:
        logger.error('PDF conversion error job=%s: %s', job_id, e)
        return []


def _parse_model_response(text: str) -> dict:
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            'summary': text[:500],
            'key_observations': [],
            'content_classification': 'unknown',
            'extracted_text': 'No text detected.',
        }


def _error(status: int, message: str) -> dict:
    return {
        'statusCode': status,
        'headers': HEADERS,
        'body': json.dumps({'error': message}),
    }


Designed to complete in under 60 seconds (Lambda timeout set accordingly).

Event:
  { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/original.jpg",
    "lang": "en", "filename": "photo.jpg" }

Response:
  Full analysis JSON
"""

import base64
import io
import json
import logging
import os
import re
import time
import traceback
from typing import Any

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

import boto3
from botocore.exceptions import ClientError
from openai import OpenAI
from PIL import Image

s3_client = boto3.client("s3")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
# LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "https://seratonin.tail40ae2c.ts.net")  # local — removed
# LM_STUDIO_API_KEY = os.environ.get("LM_STUDIO_API_KEY", "lm-studio")  # local — removed
MAX_TOKENS = int(os.environ.get("MAX_INFERENCE_TOKENS", 8192))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))

# LM Studio OpenAI-compatible client (removed — was routing to local Tailscale/Seratonin)
# client = OpenAI(
#     base_url=f"{LM_STUDIO_URL.rstrip('/')}/v1",
#     api_key=LM_STUDIO_API_KEY,
#     timeout=55.0,
# )

# Cache model name at cold-start to avoid an extra round-trip on every invocation.
def _resolve_model() -> str:
    try:
        logger.info("_resolve_model: connecting to %s/v1/models", LM_STUDIO_URL)
        models = client.models.list()
        if models.data:
            name = models.data[0].id
            logger.info("_resolve_model: resolved model=%s", name)
            return name
    except Exception as exc:
        logger.warning("_resolve_model failed (using default): %s\n%s", exc, traceback.format_exc())
    return os.environ.get("LM_STUDIO_MODEL", "qwen3.5")

# MODEL_NAME: str = _resolve_model()  # removed — would connect to local LM Studio at cold-start

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

Be factual and specific. Do not speculate beyond what is clearly visible. Your final output must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    "en": "",
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.",
    "es": "IMPORTANT: Respond entirely in Spanish (Español). All JSON values must be in Spanish.",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.",
}


def _lm_studio_handler_legacy(event: dict, _context: Any) -> dict:  # renamed — not called
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

    detected_type = _detect_magic_type(file_bytes)
    if not detected_type:
        return _error(400, "Unsupported or corrupt file content")

    content_type = detected_type

    # Convert to data URLs
    image_data_urls: list[str] = []
    if content_type == "application/pdf" or s3_key.lower().endswith(".pdf"):
        image_data_urls = _pdf_to_data_urls(file_bytes, job_id)
    else:
        data_url = _image_to_data_url(file_bytes, content_type)
        if data_url:
            image_data_urls.append(data_url)

    if not image_data_urls:
        return _error(400, "Could not extract image data from file")

    # Build OpenAI message content
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

    # Use cached model name (resolved at cold-start)
    model_name = MODEL_NAME

    # Call LM Studio
    try:
        logger.info("Calling LM Studio: model=%s url=%s", model_name, LM_STUDIO_URL)
        # Quick connectivity probe (urllib, no OpenAI client) for diagnostics
        import urllib.request, ssl
        probe_url = f"{LM_STUDIO_URL.rstrip('/')}/v1/models"
        try:
            with urllib.request.urlopen(probe_url, timeout=5) as _r:
                logger.info("Connectivity probe OK: HTTP %s", _r.status)
        except Exception as _probe_exc:
            logger.warning("Connectivity probe FAILED (%s): %s", probe_url, _probe_exc)
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
        logger.error("LM Studio inference failed: %s\n%s", e, traceback.format_exc())
        return _error(502, f"LM Studio inference failed: {e}")

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

    result = _parse_model_response(raw_content) if raw_content.strip() else {
        "summary": "Model did not produce a structured answer. Try again.",
        "key_observations": [],
        "content_classification": "unknown",
        "extracted_text": "No text detected.",
    }

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
        "provider": "LM Studio (Seratonin)",
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


def _detect_magic_type(raw_bytes: bytes, s3_key: str = '') -> str:  # compat alias — s3_key ignored
    if len(raw_bytes) < 12:
        return ""
    if raw_bytes.startswith(b"%PDF-"):
        return "application/pdf"
    if raw_bytes.startswith(b"\xFF\xD8\xFF"):
        return "image/jpeg"
    if raw_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw_bytes.startswith(b"GIF87a") or raw_bytes.startswith(b"GIF89a"):
        return "image/gif"
    if raw_bytes.startswith(b"BM"):
        return "image/bmp"
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WEBP":
        return "image/webp"
    if raw_bytes.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    return ""


def _image_to_data_url(raw_bytes: bytes, mime_type: str = '') -> str | None:  # compat: mime_type optional
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


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": HEADERS,
        "body": json.dumps({"error": message}),
    }
