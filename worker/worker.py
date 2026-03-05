#!/usr/bin/env python3
"""
Coldbones Desktop Worker

Runs on the RTX 5090 desktop. Long-polls SQS for analysis jobs, runs
inference locally via LM Studio, and writes results back to AWS (DynamoDB + S3).

No inbound ports required — all traffic is outbound:
  SQS  ← long-poll (outbound HTTPS)
  S3   ← download upload, upload result (outbound HTTPS)
  DynamoDB ← read/write job state (outbound HTTPS)

Setup:
  pip install -r requirements.txt
  cp .env.example .env          # fill in AWS creds and queue URL
  python worker.py

Or run as a systemd service — see coldbones-worker.service.
"""

import base64
import io
import json
import logging
import os
import re
import signal
import sys
import time
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from openai import OpenAI
from PIL import Image

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%S',
)
logger = logging.getLogger('coldbones.worker')

# ── Config ────────────────────────────────────────────────────────────────────

QUEUE_URL     = os.environ['ANALYZE_QUEUE_URL']
UPLOAD_BUCKET = os.environ['UPLOAD_BUCKET']
JOBS_TABLE    = os.environ['JOBS_TABLE']
LM_STUDIO_URL     = os.environ.get('LM_STUDIO_URL', 'http://localhost:1234')
LM_STUDIO_API_KEY = os.environ.get('LM_STUDIO_API_KEY', 'lm-studio')
MODEL_NAME    = os.environ.get('MODEL_NAME', 'Qwen/Qwen3.5-35B-A3B-AWQ')

MAX_TOKENS    = int(os.environ.get('MAX_INFERENCE_TOKENS', 8192))
MAX_PDF_PAGES = int(os.environ.get('MAX_PDF_PAGES', 20))

# SQS polling settings
WAIT_SECONDS       = 20    # long-poll timeout
MAX_MESSAGES       = 1     # process one at a time (GPU is the bottleneck)
VISIBILITY_TIMEOUT = 900   # 15 min — enough time for a large multi-page PDF

# ── AWS clients ───────────────────────────────────────────────────────────────

sqs      = boto3.client('sqs')
s3       = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')

# ── Prompt ────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully.
Think through what you see step by step, then respond with a JSON object
(no markdown fences, no extra text) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Your final output must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    'hi': 'IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.',
    'es': 'IMPORTANT: Respond entirely in Spanish. All JSON values must be in Spanish.',
    'bn': 'IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.',
}

# ── LM Studio client ──────────────────────────────────────────────────────────

_lm_client: OpenAI | None = None


def get_lm_client() -> OpenAI:
    """Return a lazily-initialized OpenAI client pointing at local LM Studio."""
    global _lm_client
    if _lm_client is None:
        _lm_client = OpenAI(
            base_url=f'{LM_STUDIO_URL.rstrip("/")}/v1',
            api_key=LM_STUDIO_API_KEY,
            timeout=840.0,   # 14 min for large PDFs
        )
        logger.info('LM Studio client initialised → %s (model=%s)', LM_STUDIO_URL, MODEL_NAME)
    return _lm_client


def check_lm_health() -> bool:
    """Return True if LM Studio's /v1/models endpoint is reachable."""
    import urllib.request

    try:
        with urllib.request.urlopen(f'{LM_STUDIO_URL.rstrip("/")}/v1/models', timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


# ── Main loop ─────────────────────────────────────────────────────────────────

_running = True


def _handle_signal(sig, frame):
    """Handle SIGTERM/SIGINT to gracefully drain and shut down the worker."""
    global _running
    logger.info('Signal %s received — draining and shutting down…', sig)
    _running = False


signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)


def run():
    """Main loop: wait for LM Studio, then long-poll SQS for jobs."""
    logger.info('Coldbones worker starting. Queue: %s', QUEUE_URL)

    # Wait for LM Studio before entering the poll loop
    while _running:
        if check_lm_health():
            logger.info('LM Studio is healthy at %s', LM_STUDIO_URL)
            break
        logger.warning('LM Studio not ready at %s — retrying in 15 s', LM_STUDIO_URL)
        time.sleep(15)

    while _running:
        try:
            _poll_once()
        except Exception as exc:
            logger.exception('Unexpected error in poll loop: %s', exc)
            time.sleep(5)

    logger.info('Worker stopped.')


def _poll_once():
    """Receive one SQS message and process it, or return if none available."""
    resp = sqs.receive_message(
        QueueUrl=QUEUE_URL,
        MaxNumberOfMessages=MAX_MESSAGES,
        WaitTimeSeconds=WAIT_SECONDS,
        VisibilityTimeout=VISIBILITY_TIMEOUT,
        AttributeNames=['ApproximateReceiveCount'],
    )
    messages = resp.get('Messages', [])
    if not messages:
        return

    msg = messages[0]
    receipt_handle = msg['ReceiptHandle']
    receive_count  = int(msg.get('Attributes', {}).get('ApproximateReceiveCount', '1'))

    try:
        payload = json.loads(msg['Body'])
    except json.JSONDecodeError:
        logger.error('Unparseable SQS message body: %s', msg['Body'][:200])
        sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
        return

    job_id  = payload.get('jobId', 'unknown')
    s3_key  = payload.get('s3Key', '')
    lang    = payload.get('lang', 'en')
    filename = payload.get('filename', 'file')

    # Poison-message guard: after 3 delivery attempts, mark failed and drop.
    if receive_count > 3:
        logger.warning('job=%s exceeded max retries (%d) — marking FAILED', job_id, receive_count)
        _update_job(job_id, {'status': 'FAILED', 'completedAt': _now(),
                              'error': f'Exceeded max delivery attempts ({receive_count})'})
        sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)
        return

    logger.info('Processing job=%s s3_key=%s lang=%s (attempt %d)', job_id, s3_key, lang, receive_count)
    _update_job(job_id, {'status': 'PROCESSING', 'startedAt': _now()})

    try:
        result = _process(s3_key, lang, job_id, filename)
        _update_job(job_id, {
            'status':       'COMPLETED',
            'completedAt':  _now(),
            'result':       result,
            'resultS3Key':  result.get('resultS3Key', ''),
        })
        logger.info('job=%s COMPLETED in %d ms', job_id, result.get('processing_time_ms', 0))
        sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=receipt_handle)

    except Exception as exc:
        logger.exception('job=%s FAILED: %s', job_id, exc)
        _update_job(job_id, {
            'status':      'FAILED',
            'completedAt': _now(),
            'error':       str(exc)[:500],
        })
        # Don't delete — let SQS retry (or send to DLQ after MaxReceiveCount).
        # Re-hide for 60 s to avoid tight retry loop.
        try:
            sqs.change_message_visibility(
                QueueUrl=QUEUE_URL,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=60,
            )
        except Exception:
            pass


# ── Core processing ───────────────────────────────────────────────────────────

def _process(s3_key: str, lang: str, job_id: str, filename: str) -> dict:
    """Download file from S3, run local LM Studio inference, and return results."""
    # 1. Download from S3
    obj        = s3.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
    file_bytes = obj['Body'].read()

    # 2. Detect type and convert to image data URLs
    content_type = _detect_type(file_bytes, s3_key)
    if content_type == 'application/pdf':
        image_data_urls = _pdf_to_data_urls(file_bytes)
    elif content_type.startswith('image/'):
        url = _image_to_data_url(file_bytes)
        image_data_urls = [url] if url else []
    else:
        raise ValueError(f'Unsupported content type: {content_type}')

    if not image_data_urls:
        raise ValueError('Could not extract images from file')

    # 3. Build message content
    content: list[dict] = [
        {'type': 'image_url', 'image_url': {'url': u}} for u in image_data_urls
    ]
    analysis_text = (
        'Analyze this image thoroughly.'
        if len(image_data_urls) == 1
        else f'Analyze these {len(image_data_urls)} pages. Provide a holistic analysis.'
    )
    lang_instr = LANGUAGE_INSTRUCTIONS.get(lang, '')
    if lang_instr:
        analysis_text = f'{analysis_text}\n\n{lang_instr}'
    content.append({'type': 'text', 'text': analysis_text})

    # 4. Call local LM Studio
    client = get_lm_client()
    start  = time.time()
    response = client.chat.completions.create(
        model=MODEL_NAME,
        messages=[
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user',   'content': content},
        ],
        max_tokens=MAX_TOKENS,
        temperature=0.6,
    )
    elapsed_ms   = int((time.time() - start) * 1000)
    raw_text     = response.choices[0].message.content or ''
    finish_reason = response.choices[0].finish_reason or ''
    parsed       = _parse(raw_text)

    result = {
        'summary':                parsed.get('summary', ''),
        'key_observations':       parsed.get('key_observations', []),
        'content_classification': parsed.get('content_classification', ''),
        'extracted_text':         parsed.get('extracted_text', ''),
        'processing_time_ms':     elapsed_ms,
        'finish_reason':          finish_reason,
        'model':                  MODEL_NAME,
        'provider':               'LM Studio (desktop RTX 5090)',
        'mode':                   'offline',
        'filename':               filename,
    }

    # 5. Save result JSON to S3 next to the original upload
    result_key = re.sub(r'/[^/]+$', '/result.json', s3_key)
    try:
        s3.put_object(
            Bucket=UPLOAD_BUCKET,
            Key=result_key,
            Body=json.dumps(result, ensure_ascii=False).encode('utf-8'),
            ContentType='application/json',
        )
        result['resultS3Key'] = result_key
    except Exception as e:
        logger.warning('Could not save result to S3: %s', e)

    return result


# ── Helpers ───────────────────────────────────────────────────────────────────

def _detect_type(raw: bytes, s3_key: str) -> str:
    """Identify file type from magic bytes, with s3_key extension as fallback."""
    if raw.startswith(b'%PDF-'):                  return 'application/pdf'
    if raw.startswith(b'\xFF\xD8\xFF'):           return 'image/jpeg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):      return 'image/png'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': return 'image/webp'
    if raw.startswith(b'GIF87a') or raw.startswith(b'GIF89a'): return 'image/gif'
    if raw.startswith(b'BM'):                     return 'image/bmp'
    ext = s3_key.rsplit('.', 1)[-1].lower() if '.' in s3_key else ''
    return {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp',
        'tiff': 'image/tiff', 'tif': 'image/tiff', 'pdf': 'application/pdf',
    }.get(ext, 'application/octet-stream')


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    """Convert raw image bytes to a PNG base64 data URL."""
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


def _pdf_to_data_urls(pdf_bytes: bytes) -> list[str]:
    """Render PDF pages as PNG base64 data URLs using pypdfium2."""
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
        logger.error('PDF conversion error: %s', e)
        return []


def _parse(text: str) -> dict:
    """Parse a JSON response from the model, stripping markdown fences if present."""
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            'summary': text[:500], 'key_observations': [],
            'content_classification': 'unknown', 'extracted_text': 'No text detected.',
        }


def _update_job(job_id: str, fields: dict) -> None:
    """Update a DynamoDB job record with the given fields."""
    table       = dynamodb.Table(JOBS_TABLE)
    expr_parts  = []
    attr_names  = {}
    attr_values = {}
    for k, v in fields.items():
        safe, val_key = f'#f_{k}', f':v_{k}'
        expr_parts.append(f'{safe} = {val_key}')
        attr_names[safe]  = k
        attr_values[val_key] = v
    try:
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET ' + ', '.join(expr_parts),
            ExpressionAttributeNames=attr_names,
            ExpressionAttributeValues=attr_values,
        )
    except Exception as e:
        logger.error('DynamoDB update failed job=%s: %s', job_id, e)


def _now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


if __name__ == '__main__':
    run()
