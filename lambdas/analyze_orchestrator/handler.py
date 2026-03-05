"""
Lambda: analyze-orchestrator  (the inference workhorse)

This Lambda is NEVER called by API Gateway directly.  It is invoked
asynchronously by analyze_router with InvocationType='Event', which means:
  - It runs in the background after the router returns 202 to the browser.
  - It has up to 10 minutes (Lambda hard limit) to complete.
  - If it crashes, there is no automatic retry (fire-and-forget); the job
    status will stay PROCESSING until the frontend poll times out.  This is
    acceptable because the orchestrator writes its own FAILED status on error.

Tri-provider support:
  The orchestrator supports three inference backends:
    1. Bedrock On-Demand (default) — Converse API, pay-per-token, scale-to-zero
    2. Desktop (LM Studio via Tailscale Funnel) — the RTX 5090 GPU
    3. Bedrock CMI (legacy) — Custom Model Import, Qwen2.5-VL on AWS infra

  The provider is selected by the analyze_router via the event's 'provider'
  field:
    'ondemand' → bedrock_ondemand_client.py (Converse API, cloud-primary default)
    'desktop'  → desktop_client.py (LM Studio via Tailscale)
    'bedrock'  → bedrock_client.py (CMI, legacy path)

Full flow:
  1. Download the file from S3 using the s3Key written by the presign Lambda.
  2. Detect the true file type from magic bytes (not from the extension or the
     Content-Type header, which can be spoofed).
  3. Convert to one or more base64-encoded PNG data-URLs.
  4. Route inference to the selected provider (ondemand, desktop, or bedrock-cmi).
  5. Parse and validate the structured response (CoT, summary, description,
     insights, observations, OCR text).
  6. Write the full result JSON back to S3 next to the original upload.
  7. Update the DynamoDB job record to COMPLETED (or FAILED on any error),
     linking the upload S3 key with the result S3 key.

Desktop endpoint discovered at runtime from SSM (see desktop_client.py):
  /coldbones/desktop-url  → Tailscale Funnel base URL
  /coldbones/desktop-port → LM Studio port (443 when using Funnel)

Bedrock model ARN discovered from SSM (see bedrock_client.py):
  /coldbones/bedrock-model-arn → Bedrock imported model ARN

Event shape (sent by analyze_router):
  { "jobId": "<uuid>", "s3Key": "uploads/<uuid>/photo.jpg",
    "lang": "en", "filename": "photo.jpg", "mode": "fast",
    "provider": "ondemand|desktop|bedrock" }
"""

import base64
import io
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError
from PIL import Image

# Inference clients — resolved from SSM at runtime
sys.path.insert(0, '/var/task')
from desktop_client import get_openai_client
from bedrock_client import invoke_bedrock
from bedrock_ondemand_client import invoke_ondemand, invoke_ondemand_streaming
from logger import get_logger

log = get_logger('analyze_orchestrator')

s3_client  = boto3.client('s3')
dynamodb   = boto3.resource('dynamodb')

UPLOAD_BUCKET    = os.environ['UPLOAD_BUCKET']
JOBS_TABLE_NAME  = os.environ.get('JOBS_TABLE', '')
MAX_TOKENS       = int(os.environ.get('MAX_INFERENCE_TOKENS', 16384))
MAX_PDF_PAGES    = int(os.environ.get('MAX_PDF_PAGES', 20))

# ── Image compression settings ──────────────────────────────────────────────
# Qwen3 VL processes images in tile grids.  Sending images larger than ~1568px
# on the longest side wastes vision tokens without improving quality.  Resizing
# and JPEG-compressing all images before inference dramatically reduces token
# cost (often 4-10x) with negligible quality loss for analysis.
MAX_IMAGE_DIMENSION = int(os.environ.get('MAX_IMAGE_DIMENSION', 1568))
JPEG_QUALITY        = int(os.environ.get('JPEG_QUALITY', 85))
MAX_VIDEO_FRAMES    = int(os.environ.get('MAX_VIDEO_FRAMES', 20))

# Qwen3 VL on Bedrock rejects payloads above ~6 MB of image data with:
#   "Failed to buffer the request body: length limit exceeded"
# Target 5 MB to stay safely under the model's internal limit.
MAX_PAYLOAD_BYTES   = int(os.environ.get('MAX_PAYLOAD_BYTES', 5 * 1024 * 1024))

HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
}

# ── Chain-of-Thought System Prompt ──────────────────────────────────────────────
# Qwen3 VL supports native chain-of-thought reasoning.  The prompt instructs the
# model to think deeply, then produce a structured JSON response with:
#   - chain_of_thought: full internal reasoning (displayed in collapsible UI)
#   - summary: concise summary of the analysis
#   - description: detailed description of what's in the image
#   - insights: analytical observations and deeper interpretations
#   - observations: factual, specific things noticed in the image
#   - ocr_text: any readable text, accurately transcribed for copy-paste
#   - content_classification: what type of content this is

SYSTEM_PROMPT = """You are an expert visual analyst with deep knowledge across many domains. When given an image, you must perform a thorough, multi-layered analysis.

## Your Process

Think through what you see step by step. Consider composition, context, details, text, colors, objects, people, symbols, and any domain-specific elements.

## Response Format

Respond with a JSON object (no markdown fences, no extra text outside the JSON) matching this exact schema:

{
  "chain_of_thought": "Your complete internal reasoning process. Walk through everything you observe, consider, and deduce. Be thorough and detailed — this is your scratch pad. Use markdown formatting: headers, bullet points, bold, italic, code blocks as appropriate. This section can be long.",
  "summary": "A concise 2-4 sentence overview of the image and your key findings. This should be the TL;DR that someone can read quickly.",
  "description": "A detailed, rich description of what the image contains. Describe the scene, objects, people, layout, colors, composition, and context. Write in flowing prose, not bullet points. Use markdown for emphasis where helpful.",
  "insights": [
    "An analytical observation or deeper interpretation — not just what you see, but what it means or implies.",
    "Another insight — patterns, anomalies, relationships, context, or significance.",
    "Additional insights as warranted by the image content."
  ],
  "observations": [
    "A specific, factual observation about something visible in the image.",
    "Another concrete observation — details, measurements, quantities, positions.",
    "Further observations as needed."
  ],
  "ocr_text": "If there is readable text in the image, transcribe it accurately and completely, preserving formatting (line breaks, spacing, structure) as much as possible. If no text is present, write: No text detected.",
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, technical drawing, UI/wireframe, meme, social media post, video, or other (specify)."
}

## Guidelines

- **Chain of Thought**: Be genuinely thorough. Examine every region of the image. Note things others might miss.
- **Description**: Paint a vivid picture in words. Someone who can't see the image should be able to visualize it.
- **Insights**: Go beyond surface observations. What does this image tell us? What's interesting or notable?
- **OCR**: Transcribe ALL visible text, including small print, watermarks, timestamps, labels, buttons, captions. Preserve the original formatting and structure for easy copy-paste.
- **Be factual**: Don't speculate beyond what is clearly visible. Distinguish between observations and inferences.

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
    provider = event.get('provider', 'ondemand')  # 'ondemand', 'desktop', or 'bedrock'

    log.set_job_id(job_id)
    log.info('orchestrator_start', provider=provider, s3_key=s3_key, filename=filename, lang=lang)

    if not s3_key:
        return _error(400, 'Missing s3Key', job_id)

    start = time.time()

    # ── Download from S3 ────────────────────────────────────────────────────
    try:
        with log.timed('s3_download', bucket=UPLOAD_BUCKET, key=s3_key):
            obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
            file_bytes = obj['Body'].read()
            file_size = len(file_bytes)
        log.info('s3_download_complete', file_size_bytes=file_size)
    except ClientError as e:
        log.exception('s3_download_failed', exc=e)
        return _error(502, f'S3 download failed: {e}', job_id)

    content_type = _detect_magic_type(file_bytes, s3_key)
    if not content_type:
        log.error('unsupported_file_type', s3_key=s3_key)
        return _error(400, 'Unsupported or corrupt file content', job_id)

    log.info('file_type_detected', content_type=content_type)

    # ── Convert to image data URLs ──────────────────────────────────────────
    if content_type == 'application/pdf':
        image_data_urls = _pdf_to_data_urls(file_bytes, job_id)
    elif content_type.startswith('video/'):
        image_data_urls = _video_to_data_urls(file_bytes, job_id)
    else:
        url = _image_to_data_url(file_bytes)
        image_data_urls = [url] if url else []

    if not image_data_urls:
        log.error('image_conversion_failed', content_type=content_type)
        return _error(400, 'Could not extract image data from file', job_id)

    # ── Cap total payload size ──────────────────────────────────────────────
    # Bedrock Converse has a 25 MB request limit. If the combined images
    # exceed MAX_PAYLOAD_BYTES, progressively drop trailing pages/frames.
    image_data_urls = _cap_payload_size(image_data_urls)

    log.info('images_prepared', count=len(image_data_urls))

    # ── Build LM Studio request ─────────────────────────────────────────────
    content: list[dict] = [
        {'type': 'image_url', 'image_url': {'url': u}} for u in image_data_urls
    ]
    is_video = content_type.startswith('video/')
    is_pdf = content_type == 'application/pdf'
    if len(image_data_urls) == 1:
        analysis_text = 'Analyze this image thoroughly.'
    elif is_video:
        analysis_text = (
            f'These {len(image_data_urls)} frames were extracted from a video. '
            'Analyze the video content holistically — describe the scene, actions, '
            'changes across frames, and any text visible.'
        )
    elif is_pdf:
        analysis_text = (
            f'Analyze these {len(image_data_urls)} pages thoroughly. '
            'Provide a holistic analysis.'
        )
    else:
        analysis_text = f'Analyze these {len(image_data_urls)} images thoroughly.'
    lang_instr = LANGUAGE_INSTRUCTIONS.get(lang, '')
    if lang_instr:
        analysis_text = f'{analysis_text}\n\n{lang_instr}'
    content.append({'type': 'text', 'text': analysis_text})

    # ── Call inference provider ─────────────────────────────────────────────
    if provider == 'ondemand':
        try:
            # Stream tokens from Bedrock and periodically update DynamoDB
            # so the frontend can show live partial text while polling.
            _last_flush = [time.time()]
            _flush_interval = 2.0  # seconds between DynamoDB partial writes

            def _on_chunk(delta: str, accumulated: str) -> None:
                now = time.time()
                if now - _last_flush[0] >= _flush_interval:
                    _last_flush[0] = now
                    _write_partial_text(job_id, accumulated)

            with log.timed('inference', provider='ondemand') as ctx:
                ondemand_resp = invoke_ondemand_streaming(
                    image_data_urls=image_data_urls,
                    system_prompt=SYSTEM_PROMPT,
                    analysis_text=analysis_text,
                    on_chunk=_on_chunk,
                    max_tokens=MAX_TOKENS,
                    temperature=0.6,
                )
                raw_content   = ondemand_resp['raw_text']
                finish_reason = ondemand_resp['finish_reason']
                model_name    = ondemand_resp['model_id']
                provider_name = ondemand_resp['provider']
                usage_stats   = ondemand_resp.get('usage', {})
                ctx['model'] = model_name
                ctx['input_tokens'] = usage_stats.get('input_tokens', 0)
                ctx['output_tokens'] = usage_stats.get('output_tokens', 0)
                ctx['finish_reason'] = finish_reason
        except Exception as e:
            log.exception('inference_failed', exc=e, provider='ondemand')
            return _error(502, f'Bedrock On-Demand inference failed: {e}', job_id)
    elif provider == 'bedrock':
        try:
            with log.timed('inference', provider='bedrock-cmi') as ctx:
                bedrock_resp = invoke_bedrock(
                    image_data_urls=image_data_urls,
                    system_prompt=SYSTEM_PROMPT,
                    analysis_text=analysis_text,
                    max_tokens=MAX_TOKENS,
                    temperature=0.6,
                )
                raw_content   = bedrock_resp['raw_text']
                finish_reason = bedrock_resp['finish_reason']
                model_name    = bedrock_resp['model_arn']
                provider_name = bedrock_resp['provider']
                usage_stats   = {}
                ctx['model'] = model_name
                ctx['finish_reason'] = finish_reason
        except Exception as e:
            log.exception('inference_failed', exc=e, provider='bedrock-cmi')
            return _error(502, f'Bedrock CMI inference failed: {e}', job_id)
    else:
        try:
            client, model_name = get_openai_client(timeout=580.0)
            with log.timed('inference', provider='desktop', model=model_name) as ctx:
                response = client.chat.completions.create(
                    model=model_name,
                    messages=[
                        {'role': 'system', 'content': SYSTEM_PROMPT},
                        {'role': 'user',   'content': content},
                    ],
                    max_tokens=MAX_TOKENS,
                    temperature=0.6,
                )
                raw_content   = response.choices[0].message.content or ''
                finish_reason = response.choices[0].finish_reason or ''
                provider_name = 'RTX 5090'
                usage_stats   = {}
                ctx['finish_reason'] = finish_reason
        except Exception as e:
            log.exception('inference_failed', exc=e, provider='desktop')
            return _error(502, f'LM Studio inference failed: {e}', job_id)

    elapsed_ms = int((time.time() - start) * 1000)

    result = _parse_model_response(raw_content)
    log.info('response_parsed', has_chain_of_thought=bool(result.get('chain_of_thought')),
             has_ocr=bool(result.get('ocr_text')))

    # ── Build response body ─────────────────────────────────────────────────
    body = {
        'jobId':                   job_id,
        'chain_of_thought':        result.get('chain_of_thought', ''),
        'summary':                 result.get('summary', ''),
        'description':             result.get('description', ''),
        'insights':                result.get('insights', []),
        'observations':            result.get('observations', []),
        'ocr_text':                result.get('ocr_text', ''),
        'content_classification':  result.get('content_classification', ''),
        # Legacy fields for backward compatibility
        'key_observations':        result.get('observations', []),
        'extracted_text':          result.get('ocr_text', ''),
        'processing_time_ms':      elapsed_ms,
        'finish_reason':           finish_reason,
        'mode':                    'fast',
        'model':                   model_name,
        'provider':                provider_name,
        'filename':                filename,
        'usage':                   usage_stats if usage_stats else None,
    }

    # ── Persist result alongside the upload (S3) ────────────────────────────
    result_key = re.sub(r'/[^/]+$', '/result.json', s3_key)
    try:
        with log.timed('s3_result_save', key=result_key):
            s3_client.put_object(
                Bucket=UPLOAD_BUCKET,
                Key=result_key,
                Body=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                ContentType='application/json',
            )
        body['resultS3Key'] = result_key
    except Exception as e:
        log.warning('s3_result_save_failed', error=str(e))

    # ── Write COMPLETED to DynamoDB — links upload ↔ result ──────────────────
    if JOBS_TABLE_NAME and job_id != 'unknown':
        try:
            with log.timed('dynamodb_update'):
                dynamodb.Table(JOBS_TABLE_NAME).update_item(
                    Key={'jobId': job_id},
                    UpdateExpression=(
                        'SET #s = :s, completedAt = :ca, #r = :r, '
                        'resultS3Key = :rk, uploadS3Key = :uk, '
                        'contentType = :ct, fileSizeBytes = :fsb, '
                        'imageCount = :ic, processingTimeMs = :ptm, '
                        'modelId = :mid, providerName = :pn'
                    ),
                    ExpressionAttributeNames={'#s': 'status', '#r': 'result'},
                    ExpressionAttributeValues={
                        ':s': 'COMPLETED',
                        ':ca': datetime.now(timezone.utc).isoformat(),
                        ':r': body,
                        ':rk': result_key,
                        ':uk': s3_key,
                        ':ct': content_type,
                        ':fsb': file_size,
                        ':ic': len(image_data_urls),
                        ':ptm': elapsed_ms,
                        ':mid': model_name,
                        ':pn': provider_name,
                    },
                )
        except Exception as e:
            log.warning('dynamodb_update_failed', error=str(e))

    log.info('orchestrator_complete', elapsed_ms=elapsed_ms, provider=provider_name,
             model=model_name, finish_reason=finish_reason)

    return {'statusCode': 200, 'headers': HEADERS, 'body': json.dumps(body, ensure_ascii=False)}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _detect_magic_type(raw: bytes, s3_key: str) -> str:
    """Identify file type from magic bytes, with s3_key extension as fallback."""
    if len(raw) < 12:
        return ''
    if raw.startswith(b'%PDF-'):                   return 'application/pdf'
    if raw.startswith(b'\xFF\xD8\xFF'):            return 'image/jpeg'
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):      return 'image/png'
    if raw.startswith(b'GIF87a') or raw.startswith(b'GIF89a'): return 'image/gif'
    if raw.startswith(b'BM'):                      return 'image/bmp'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': return 'image/webp'
    if raw.startswith((b'II*\x00', b'MM\x00*')):  return 'image/tiff'
    # Video formats — check container magic bytes
    if len(raw) >= 12 and raw[4:8] == b'ftyp':     return 'video/mp4'   # MP4/MOV
    if raw.startswith(b'\x1a\x45\xdf\xa3'):        return 'video/webm'  # WebM/MKV (EBML)
    if raw[:4] == b'RIFF' and raw[8:12] == b'AVI ': return 'video/avi'
    ext = s3_key.rsplit('.', 1)[-1].lower() if '.' in s3_key else ''
    return {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'webp': 'image/webp', 'gif': 'image/gif', 'bmp': 'image/bmp',
        'tiff': 'image/tiff', 'tif': 'image/tiff', 'pdf': 'application/pdf',
        'mp4': 'video/mp4', 'mov': 'video/mp4', 'webm': 'video/webm',
        'avi': 'video/avi', 'mkv': 'video/webm',
    }.get(ext, '')


def _estimate_decoded_size(data_url: str) -> int:
    """Estimate the decoded byte size of a base64 data URL.

    The Converse API sends the raw bytes (not base64) over the wire, so
    the actual payload per image is ~75% of the base64 string length.
    """
    if ';base64,' in data_url:
        b64_part = data_url.split(';base64,', 1)[1]
        return len(b64_part) * 3 // 4
    return len(data_url)


def _cap_payload_size(data_urls: list[str]) -> list[str]:
    """Ensure total image payload fits within MAX_PAYLOAD_BYTES.

    Strategy (in order):
      1. Re-compress each image at progressively lower JPEG quality.
      2. If still too large, drop trailing pages/frames.
    """
    total = sum(_estimate_decoded_size(u) for u in data_urls)
    if total <= MAX_PAYLOAD_BYTES:
        return data_urls

    log.warning('payload_too_large', total_bytes=total,
                limit_bytes=MAX_PAYLOAD_BYTES, image_count=len(data_urls))

    # Step 1: Re-compress at lower quality + smaller dimensions
    reduced_dim = 1024
    reduced_quality = 60
    recompressed: list[str] = []
    for url in data_urls:
        if ';base64,' in url:
            header, b64 = url.split(';base64,', 1)
            try:
                img = Image.open(io.BytesIO(base64.b64decode(b64)))
                if img.mode != 'RGB':
                    img = img.convert('RGB')
                w, h = img.size
                if max(w, h) > reduced_dim:
                    scale = reduced_dim / max(w, h)
                    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format='JPEG', quality=reduced_quality, optimize=True)
                recompressed.append('data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode())
            except Exception:
                recompressed.append(url)  # keep original if re-compress fails
        else:
            recompressed.append(url)

    total = sum(_estimate_decoded_size(u) for u in recompressed)
    log.info('payload_recompressed', total_bytes=total, image_count=len(recompressed),
             dim=reduced_dim, quality=reduced_quality)

    if total <= MAX_PAYLOAD_BYTES:
        return recompressed

    # Step 2: Still too large — drop trailing pages
    capped = list(recompressed)
    while len(capped) > 1 and total > MAX_PAYLOAD_BYTES:
        removed = capped.pop()
        total -= _estimate_decoded_size(removed)

    log.info('payload_capped', kept=len(capped),
             dropped=len(data_urls) - len(capped), final_bytes=total)
    return capped


def _compress_image(pil_img: Image.Image) -> str | None:
    """Resize + JPEG-compress a PIL image and return a base64 data URL.

    Qwen3 VL tokenises images into tile grids.  Sending full-resolution PNGs
    wastes vision tokens (often 4-10x more) with negligible quality gain.
    Down-scaling to MAX_IMAGE_DIMENSION and encoding as JPEG at JPEG_QUALITY
    keeps the image visually identical for analysis while dramatically
    reducing both token count and network transfer size.
    """
    try:
        if pil_img.mode in ('RGBA', 'P', 'LA'):
            pil_img = pil_img.convert('RGB')
        elif pil_img.mode != 'RGB':
            pil_img = pil_img.convert('RGB')

        # Resize if either dimension exceeds MAX_IMAGE_DIMENSION
        w, h = pil_img.size
        if max(w, h) > MAX_IMAGE_DIMENSION:
            scale = MAX_IMAGE_DIMENSION / max(w, h)
            new_w, new_h = int(w * scale), int(h * scale)
            pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)
            log.info('image_resized', original=f'{w}x{h}', resized=f'{new_w}x{new_h}')

        buf = io.BytesIO()
        pil_img.save(buf, format='JPEG', quality=JPEG_QUALITY, optimize=True)
        return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        log.error('image_compress_error', error=str(e))
        return None


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    """Decode the image bytes with PIL, compress, and return as a JPEG data-URL."""
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        return _compress_image(img)
    except Exception as e:
        log.error('image_conversion_error', error=str(e))
        return None


def _pdf_to_data_urls(pdf_bytes: bytes, job_id: str) -> list[str]:
    """Render every PDF page as a compressed JPEG data-URL using pypdfium2."""
    try:
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument(pdf_bytes)
        result = []
        for i in range(min(len(pdf), MAX_PDF_PAGES)):
            page = pdf[i]
            bitmap = page.render(scale=150 / 72)
            pil_image = bitmap.to_pil()
            data_url = _compress_image(pil_image)
            if data_url:
                result.append(data_url)
        log.info('pdf_converted', pages=len(result), total_pages=len(pdf))
        return result
    except Exception as e:
        log.error('pdf_conversion_error', error=str(e))
        return []


def _video_to_data_urls(video_bytes: bytes, job_id: str) -> list[str]:
    """Extract evenly-spaced frames from a video, compress, and return as data URLs.

    Uses OpenCV (headless) to decode the video.  Because cv2.VideoCapture
    requires a file path (not a bytes buffer), we write to a temp file that is
    cleaned up immediately after extraction.
    """
    import tempfile
    try:
        import cv2
    except ImportError:
        log.error('opencv_not_installed')
        return []

    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
    try:
        os.write(tmp_fd, video_bytes)
        os.close(tmp_fd)

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            log.error('video_open_failed')
            return []

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        duration_s = total_frames / fps if fps > 0 else 0

        log.info('video_info', total_frames=total_frames, fps=round(fps, 2),
                 duration_s=round(duration_s, 1))

        # Pick evenly-spaced frame indices
        n_frames = min(total_frames, MAX_VIDEO_FRAMES)
        if n_frames <= 0:
            cap.release()
            return []
        frame_indices = [int(i * total_frames / n_frames) for i in range(n_frames)]

        results: list[str] = []
        for idx in frame_indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame = cap.read()
            if not ret:
                continue
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(frame_rgb)
            data_url = _compress_image(pil_img)
            if data_url:
                results.append(data_url)

        cap.release()
        log.info('video_frames_extracted', extracted=len(results),
                 requested=n_frames)
        return results
    except Exception as e:
        log.error('video_conversion_error', error=str(e))
        return []
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _parse_model_response(text: str) -> dict:
    """Extract the JSON object from the model's raw output.

    Handles:
      - Clean JSON output
      - JSON wrapped in markdown code fences
      - Qwen3 VL chain-of-thought output where thinking is outside the JSON
      - Malformed JSON (returns raw text as summary fallback)
    """
    text = text.strip()

    # Strip markdown code fences if present
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)

    # Try direct JSON parse first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    # Try to extract JSON object from mixed text (e.g. thinking + JSON)
    # Look for the outermost { ... } block
    brace_start = text.find('{')
    if brace_start >= 0:
        # Walk forward to find the matching closing brace
        depth = 0
        in_string = False
        escape_next = False
        for i in range(brace_start, len(text)):
            c = text[i]
            if escape_next:
                escape_next = False
                continue
            if c == '\\' and in_string:
                escape_next = True
                continue
            if c == '"' and not escape_next:
                in_string = not in_string
                continue
            if not in_string:
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        json_str = text[brace_start:i + 1]
                        try:
                            parsed = json.loads(json_str)
                            if isinstance(parsed, dict):
                                # Capture any text before the JSON as chain_of_thought
                                # if not already present
                                preamble = text[:brace_start].strip()
                                if preamble and 'chain_of_thought' not in parsed:
                                    parsed['chain_of_thought'] = preamble
                                return parsed
                        except json.JSONDecodeError:
                            break
                        break

    # Fallback: return raw text so the UI can display something
    log.warning('json_parse_fallback', raw_length=len(text))
    return {
        'chain_of_thought': '',
        'summary': text[:1000],
        'description': '',
        'insights': [],
        'observations': [],
        'ocr_text': 'No text detected.',
        'content_classification': 'unknown',
    }


def _write_partial_text(job_id: str, text: str) -> None:
    """Persist the current partial model output to DynamoDB.

    Called every ~2 s during streaming so the polling frontend can show
    live tokens.  Failures are swallowed — this is best-effort.
    """
    if not JOBS_TABLE_NAME or job_id == 'unknown':
        return
    try:
        dynamodb.Table(JOBS_TABLE_NAME).update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET partial_text = :pt, partial_len = :pl',
            ExpressionAttributeValues={
                ':pt': text,
                ':pl': len(text),
            },
        )
    except Exception as e:
        log.warning('partial_text_write_failed', error=str(e))


def _error(status: int, message: str, job_id: str = 'unknown') -> dict:
    log.error('orchestrator_error', status=status, message=message)
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
