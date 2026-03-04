"""
Lambda: analyze-orchestrator  (the inference workhorse)

This Lambda is NEVER called by API Gateway directly.  It is invoked
asynchronously by analyze_router with InvocationType='Event', which means:
  - It runs in the background after the router returns 202 to the browser.
  - It has up to 10 minutes (Lambda hard limit) to complete.
  - If it crashes, there is no automatic retry (fire-and-forget); the job
    status will stay PROCESSING until the frontend poll times out.  This is
    acceptable because the orchestrator writes its own FAILED status on error.

Full flow:
  1. Download the file from S3 using the s3Key written by the presign Lambda.
  2. Detect the true file type from magic bytes (not from the extension or the
     Content-Type header, which can be spoofed).
  3. Convert to one or more base64-encoded PNG data-URLs:
       - Images: PIL normalises to RGB PNG (handles EXIF rotation, palette
         modes, TIFF multi-strip, etc.).
       - PDFs: pdf2image renders each page at 150 DPI → PNG.  Capped at
         MAX_PDF_PAGES to keep request size and inference time bounded.
  4. Build a multimodal chat completion request and send it to LM Studio via
     the shared desktop_client.  The system prompt instructs the model to
     return a strict JSON object — no markdown fences, no prose.
  5. Parse and validate the JSON response.  Falls back gracefully if the model
     wraps the JSON in a code block (common with smaller models).
  6. Write the full result JSON back to S3 next to the original upload, so
     it can be retrieved without hitting DynamoDB (useful for debugging).
  7. Update the DynamoDB job record to COMPLETED (or FAILED on any error),
     which unblocks the frontend's polling loop.

Desktop endpoint discovered at runtime from SSM (see desktop_client.py):
  /coldbones/desktop-url  → Tailscale Funnel base URL
  /coldbones/desktop-port → LM Studio port (443 when using Funnel)

Event shape (sent by analyze_router):
  { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/photo.jpg",
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
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

import boto3
from botocore.exceptions import ClientError
from PIL import Image

# Desktop client — resolves LM Studio endpoint from SSM (Tailscale Funnel URL)
sys.path.insert(0, '/var/task')
from desktop_client import get_openai_client

s3_client  = boto3.client('s3')
dynamodb   = boto3.resource('dynamodb')

UPLOAD_BUCKET    = os.environ['UPLOAD_BUCKET']
JOBS_TABLE_NAME  = os.environ.get('JOBS_TABLE', '')
MAX_TOKENS       = int(os.environ.get('MAX_INFERENCE_TOKENS', 8192))
MAX_PDF_PAGES    = int(os.environ.get('MAX_PDF_PAGES', 20))

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
        return _error(400, 'Missing s3Key', job_id)

    start = time.time()

    # ── Download from S3 ────────────────────────────────────────────────────
    try:
        obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
        file_bytes = obj['Body'].read()
    except ClientError as e:
        return _error(502, f'S3 download failed: {e}', job_id)

    content_type = _detect_magic_type(file_bytes, s3_key)
    if not content_type:
        return _error(400, 'Unsupported or corrupt file content', job_id)

    # ── Convert to image data URLs ──────────────────────────────────────────
    if content_type == 'application/pdf':
        image_data_urls = _pdf_to_data_urls(file_bytes, job_id)
    else:
        url = _image_to_data_url(file_bytes)
        image_data_urls = [url] if url else []

    if not image_data_urls:
        return _error(400, 'Could not extract image data from file', job_id)

    # ── Build LM Studio request ─────────────────────────────────────────────
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

    # ── Call LM Studio ──────────────────────────────────────────────────────
    try:
        client, model_name = get_openai_client(timeout=580.0)
        logger.info('Calling LM Studio model=%s job=%s', model_name, job_id)

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
        logger.error('LM Studio inference failed job=%s: %s\n%s', job_id, e, traceback.format_exc())
        return _error(502, f'LM Studio inference failed: {e}', job_id)

    elapsed_ms = int((time.time() - start) * 1000)
    raw_content   = response.choices[0].message.content or ''
    finish_reason = response.choices[0].finish_reason or ''

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
        'provider':                'LM Studio (desktop RTX 5090)',
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

    # ── Write COMPLETED to DynamoDB so /api/status/{jobId} resolves ──────────
    if JOBS_TABLE_NAME and job_id != 'unknown':
        try:
            dynamodb.Table(JOBS_TABLE_NAME).update_item(
                Key={'jobId': job_id},
                UpdateExpression='SET #s = :s, completedAt = :ca, #r = :r',
                ExpressionAttributeNames={'#s': 'status', '#r': 'result'},
                ExpressionAttributeValues={
                    ':s': 'COMPLETED',
                    ':ca': datetime.now(timezone.utc).isoformat(),
                    ':r': body,
                },
            )
        except Exception as e:
            logger.warning('Could not update DynamoDB with result: %s', e)

    return {'statusCode': 200, 'headers': HEADERS, 'body': json.dumps(body, ensure_ascii=False)}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _detect_magic_type(raw: bytes, s3_key: str) -> str:
    """Identify file type from magic bytes, with s3_key extension as fallback.

    Why magic bytes instead of trusting the Content-Type header?
      The presign Lambda already validates the content-type, but that check
      happens before the file is uploaded.  A crafted PUT request could upload
      a file with a mismatched body.  Reading the first 12 bytes here catches
      that and prevents the orchestrator from passing garbage to PIL/pdf2image.

    Returns an IANA media type string, or '' if the file is unrecognised.
    """
    if len(raw) < 12:
        return ''
    # Magic bytes for each supported format:
    if raw.startswith(b'%PDF-'):                   return 'application/pdf'
    if raw.startswith(b'\xFF\xD8\xFF'):            return 'image/jpeg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):      return 'image/png'
    if raw.startswith(b'GIF87a') or raw.startswith(b'GIF89a'): return 'image/gif'
    if raw.startswith(b'BM'):                      return 'image/bmp'
    # RIFF WEBP: bytes 0-3 = 'RIFF', bytes 8-11 = 'WEBP'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': return 'image/webp'
    # TIFF: little-endian ('II') or big-endian ('MM') marker
    if raw.startswith((b'II*\x00', b'MM\x00*')):  return 'image/tiff'
    # Fall back to extension when magic bytes are inconclusive (e.g. a truncated
    # test file or an unusual TIFF variant).
    ext = s3_key.rsplit('.', 1)[-1].lower() if '.' in s3_key else ''
    return {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp',
        'tiff': 'image/tiff', 'tif': 'image/tiff', 'pdf': 'application/pdf',
    }.get(ext, '')


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    """Decode the image bytes with PIL and re-encode as a base64 PNG data-URL.

    Why re-encode to PNG instead of passing the original bytes?
      LM Studio (and the underlying model) expects a well-formed image.  PIL
      open-and-save handles edge cases that the raw bytes may have:
        - EXIF rotation metadata (PIL applies it on load)
        - Palette-mode PNGs ('P') and RGBA with alpha that confuse some models
        - Unusual TIFF compression variants
        - Badly-padded JPEG headers
      Normalising to RGB PNG removes all of those surprises at the cost of
      a small (~2×) size increase, which is always within the LM Studio limit.
    """
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        # RGBA and palette modes can't be saved as plain JPEG; converting to
        # RGB first makes the subsequent PNG save lossless and universally safe.
        if img.mode in ('RGBA', 'P'):
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        logger.error('Image conversion error: %s', e)
        return None


def _pdf_to_data_urls(pdf_bytes: bytes, job_id: str) -> list[str]:
    """Render each PDF page to a PNG data-URL using pypdfium2.

    pypdfium2 bundles the native PDFium binary inside the Python wheel, so
    no system-level poppler-utils installation is required.  This makes it
    work in AWS Lambda without a separate Lambda Layer.

    DPI choice (150):
      - 72 DPI is typical screen resolution; 150 gives 2× more pixels per
        dimension, making small text legible to the vision model.
      - Higher DPI (300) produces sharper results for dense documents but
        increases the base64 payload by 4×, which slows LM Studio and can
        exceed the model's context window.
      - 150 is a practical trade-off validated against invoices and medical forms.
      - scale = DPI / 72 (PDFium's base unit is 72 pts/inch).

    PAGE CAP (MAX_PDF_PAGES):
      Each page becomes one image in the multimodal request.  LM Studio /
      the underlying model has a context-length limit.  Capping pages prevents
      an oversized request that would error at the model level.  The default
      cap is 20 pages (configurable via MAX_PDF_PAGES env-var).
    """
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(pdf_bytes)
        result = []
        for i in range(min(len(pdf), MAX_PDF_PAGES)):
            page = pdf[i]
            bitmap = page.render(scale=150 / 72)
            pil_image = bitmap.to_pil()
            buf = io.BytesIO()
            pil_image.save(buf, format='PNG')
            result.append('data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode())
        return result
    except Exception as e:
        logger.error('PDF conversion error job=%s: %s', job_id, e)
        return []


def _parse_model_response(text: str) -> dict:
    """Extract the JSON object from the model's raw output.

    The system prompt asks the model to return ONLY a JSON object with no
    markdown fences.  In practice, smaller models (and even some large ones)
    sometimes wrap the JSON in a code block:

        ```json
        { ... }
        ```

    The regex strips both the opening fence (with optional language tag) and
    the closing fence.  After stripping, we attempt json.loads.  If that
    fails (malformed JSON, model hallucinated extra text), we return a minimal
    fallback dict with the raw text in 'summary' so the UI can still display
    something useful instead of a blank panel.
    """
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


def _error(status: int, message: str, job_id: str = 'unknown') -> dict:
    if JOBS_TABLE_NAME and job_id != 'unknown':
        try:
            dynamodb.Table(JOBS_TABLE_NAME).update_item(
                Key={'jobId': job_id},
                UpdateExpression='SET #s = :s, completedAt = :ca, #e = :e',
                ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
                ExpressionAttributeValues={
                    ':s': 'FAILED',
                    ':ca': datetime.now(timezone.utc).isoformat(),
                    ':e': message,
                },
            )
        except Exception:
            pass
    return {
        'statusCode': status,
        'headers': HEADERS,
        'body': json.dumps({'error': message}),
    }
