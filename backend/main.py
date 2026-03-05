from __future__ import annotations

"""
ColdBones local development backend
FastAPI server that calls LM Studio (running on Seratonin via Tailscale) via the OpenAI-compatible API.

Usage:
  pip install -r requirements.txt
  uvicorn main:app --reload --port 8000

Environment variables (set in .env):
  LM_STUDIO_URL         https://seratonin.tail40ae2c.ts.net  (Tailscale Funnel URL)
  LM_STUDIO_API_KEY     lm-studio                           (LM Studio ignores value but requires non-empty)
  MODEL_NAME            qwen/qwen3.5-35b-a3b
  MAX_INFERENCE_TOKENS  8192
  MAX_PDF_PAGES         20
"""

import base64
import io
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI, APIConnectionError
from PIL import Image
from pydantic import BaseModel

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("coldbones")

LM_STUDIO_URL     = os.environ.get("LM_STUDIO_URL",     "http://localhost:1234")
LM_STUDIO_API_KEY = os.environ.get("LM_STUDIO_API_KEY", "lm-studio")
MODEL_NAME        = os.environ.get("MODEL_NAME",        "qwen/qwen3.5-35b-a3b")
MAX_TOKENS  = int(os.environ.get("MAX_INFERENCE_TOKENS", 8192))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))
MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB pre-compression
MAX_IMAGE_DIMENSION = int(os.environ.get('MAX_IMAGE_DIMENSION', 1568))
JPEG_QUALITY        = int(os.environ.get('JPEG_QUALITY', 85))
MAX_VIDEO_FRAMES    = int(os.environ.get('MAX_VIDEO_FRAMES', 20))

ACCEPTED_CONTENT_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp",
    "image/gif", "image/bmp", "image/tiff", "application/pdf",
    "video/mp4", "video/webm", "video/quicktime",
    "video/x-msvideo", "video/x-matroska",
}

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully and respond with a JSON object (no markdown fences) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible. Your output must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी). All JSON values must be in Hindi.",
    "es": "IMPORTANT: Respond entirely in Spanish (Español). All JSON values must be in Spanish.",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা). All JSON values must be in Bengali.",
}

lm_client: OpenAI | None = None
active_model: str = MODEL_NAME


@asynccontextmanager
async def lifespan(app: FastAPI):
    """App lifespan: probe LM Studio on startup, yield, then shut down."""
    global lm_client, active_model
    try:
        probe = OpenAI(
            base_url=f"{LM_STUDIO_URL.rstrip('/')}/v1",
            api_key=LM_STUDIO_API_KEY,
            timeout=10.0,
        )
        models = probe.models.list()
        if models.data:
            active_model = models.data[0].id
        lm_client = OpenAI(
            base_url=f"{LM_STUDIO_URL.rstrip('/')}/v1",
            api_key=LM_STUDIO_API_KEY,
            timeout=120.0,
        )
        logger.info(f"LM Studio ready at {LM_STUDIO_URL} — model: {active_model}")
    except Exception as e:
        logger.warning(f"Could not reach LM Studio on startup: {e}. Will retry on first request.")
    yield


app = FastAPI(title="ColdBones API (local dev)", version="4.0.0", lifespan=lifespan)

# ── Local dev upload store (in-memory) ────────────────────────────────────────
# Maps s3Key → raw bytes so the presign → upload → analyze flow works locally
# without real AWS credentials.
_local_store: dict[str, bytes] = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class PresignRequest(BaseModel):
    filename: str
    contentType: str = ""


@app.post("/api/presign")
async def presign(req: PresignRequest):
    """Local-dev shim for the presign Lambda.  Returns a localhost PUT URL and
    a synthetic s3Key that the /api/analyze endpoint resolves from _local_store."""
    token = str(uuid.uuid4())
    safe_name = req.filename.replace("/", "_")
    s3_key = f"local/{token}/{safe_name}"
    upload_url = f"/api/localupload/{token}/{safe_name}"
    job_id = str(uuid.uuid4())
    return {"uploadUrl": upload_url, "s3Key": s3_key, "jobId": job_id}


@app.put("/api/localupload/{token}/{filename:path}")
async def local_upload(token: str, filename: str, request: Request):
    """Receives the raw XHR PUT from the frontend and stores it in memory."""
    body = await request.body()
    s3_key = f"local/{token}/{filename}"
    _local_store[s3_key] = body
    return {"ok": True}


@app.get("/api/health")
async def health():
    """Return LM Studio connection status and active model info."""
    global lm_client, active_model
    model_loaded = False
    current_model = active_model

    try:
        probe = OpenAI(
            base_url=f"{LM_STUDIO_URL.rstrip('/')}/v1",
            api_key=LM_STUDIO_API_KEY,
            timeout=5.0,
        )
        models = probe.models.list()
        if models.data:
            current_model = models.data[0].id
            active_model = current_model
        model_loaded = True
    except Exception:
        model_loaded = False

    return {
        "status": "ok" if model_loaded else "degraded",
        "model": current_model,
        "provider": "LM Studio (Seratonin)",
        "lm_studio_url": LM_STUDIO_URL,
        "model_loaded": model_loaded,
    }


@app.post("/api/analyze")
async def analyze(request: Request):
    """Accepts two call styles:
    1. multipart/form-data  — file + lang + mode  (used by local drag-drop)
    2. application/json     — {s3Key, filename, lang, mode}  (used by AWS flow
       after uploading to S3 / localupload)
    """
    if lm_client is None:
        raise HTTPException(503, "LM Studio client not initialised — is LM Studio running on Seratonin?")

    ct = request.headers.get("content-type", "")

    if "application/json" in ct:
        body = await request.json()
        s3_key: str = body.get("s3Key", "")
        lang: str = body.get("lang", "en")
        mode: str = body.get("mode", "fast")
        if s3_key not in _local_store:
            raise HTTPException(404, f"No local upload found for s3Key: {s3_key!r}; upload the file first via POST /api/presign then PUT to uploadUrl")
        raw_bytes = _local_store.pop(s3_key)
        # Guess content type from filename suffix
        suffix = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else ""
        _ct_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                   "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
                   "tiff": "image/tiff", "tif": "image/tiff", "pdf": "application/pdf"}
        content_type = _ct_map.get(suffix, "image/jpeg")
    else:
        # Multipart form-data (original behaviour)
        form = await request.form()
        file_field = form.get("file")
        if file_field is None:
            raise HTTPException(400, "Missing 'file' field in multipart form")
        lang = str(form.get("lang") or "en")
        mode = str(form.get("mode") or "fast")
        content_type = (getattr(file_field, "content_type", "") or "").lower()
        if content_type not in ACCEPTED_CONTENT_TYPES:
            raise HTTPException(400, f"Unsupported file type: {content_type}")
        raw_bytes = await file_field.read()

    detected = _detect_type(raw_bytes, content_type)

    start = time.time()

    try:
        if detected == "application/pdf":
            image_data_urls = _pdf_to_data_urls(raw_bytes)
        elif detected.startswith("video/"):
            image_data_urls = _video_to_data_urls(raw_bytes)
        else:
            url = _image_to_data_url(raw_bytes)
            image_data_urls = [url] if url else []
    except Exception as e:
        raise HTTPException(422, f"File conversion error: {e}")

    if not image_data_urls:
        raise HTTPException(422, "Could not extract images from file")

    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": url}}
        for url in image_data_urls
    ]
    analysis_text = (
        "Analyze this image thoroughly."
        if len(image_data_urls) == 1
        else f"Analyze these {len(image_data_urls)} pages. Provide a holistic analysis."
    )
    lang_instr = LANGUAGE_INSTRUCTIONS.get(lang, "")
    if lang_instr:
        analysis_text = f"{analysis_text}\n\n{lang_instr}"
    content.append({"type": "text", "text": analysis_text})

    try:
        response = lm_client.chat.completions.create(
            model=active_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            max_tokens=MAX_TOKENS,
            temperature=0.6,
        )
        raw_text = response.choices[0].message.content or ""
    except APIConnectionError:
        raise HTTPException(
            502,
            f"Cannot reach LM Studio at {LM_STUDIO_URL}. "
            "Make sure LM Studio is running on Seratonin and accessible via Tailscale.",
        )
    except Exception as e:
        raise HTTPException(502, f"Inference failed: {e}")

    elapsed_ms = int((time.time() - start) * 1000)
    result = _parse(raw_text)

    reasoning = ""
    try:
        msg = response.choices[0].message
        d = msg.model_dump() if hasattr(msg, "model_dump") else msg.__dict__
        reasoning = d.get("reasoning_content", "") or ""
    except Exception:
        pass

    return {
        "summary": result.get("summary", ""),
        "key_observations": result.get("key_observations", []),
        "content_classification": result.get("content_classification", ""),
        "extracted_text": result.get("extracted_text", ""),
        "reasoning": reasoning,
        "reasoning_token_count": len(reasoning.split()) if reasoning else 0,
        "finish_reason": response.choices[0].finish_reason or "stop",
        "processing_time_ms": elapsed_ms,
        "mode": mode,
        "model": active_model,
        "provider": "LM Studio (Seratonin)",
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _detect_type(file_bytes: bytes, fallback: str) -> str:
    """Identify file type from magic bytes, with fallback content type."""
    if file_bytes[:5] == b"%PDF-":
        return "application/pdf"
    if file_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if file_bytes[:2] in (b"\xff\xd8", b"\xff\xe0", b"\xff\xe1"):
        return "image/jpeg"
    if file_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b"WEBP" in file_bytes[:12]:
        return "image/webp"
    # Video formats
    if len(file_bytes) >= 12 and file_bytes[4:8] == b"ftyp":
        return "video/mp4"
    if file_bytes[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm"
    if file_bytes[:4] == b"RIFF" and file_bytes[8:12] == b"AVI ":
        return "video/avi"
    return fallback


def _compress_image(pil_img: Image.Image) -> str | None:
    """Resize + JPEG-compress a PIL image and return a base64 data URL."""
    try:
        if pil_img.mode in ("RGBA", "P", "LA"):
            pil_img = pil_img.convert("RGB")
        elif pil_img.mode != "RGB":
            pil_img = pil_img.convert("RGB")

        w, h = pil_img.size
        if max(w, h) > MAX_IMAGE_DIMENSION:
            scale = MAX_IMAGE_DIMENSION / max(w, h)
            new_w, new_h = int(w * scale), int(h * scale)
            pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)

        buf = io.BytesIO()
        pil_img.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        logger.error(f"Image compress error: {e}")
        return None


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    """Convert raw image bytes to a compressed JPEG base64 data URL."""
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        return _compress_image(img)
    except Exception as e:
        logger.error(f"Image conversion error: {e}")
        return None


def _pdf_to_data_urls(pdf_bytes: bytes) -> list[str]:
    """Render PDF pages as compressed JPEG base64 data URLs."""
    try:
        import pdf2image
        pages = pdf2image.convert_from_bytes(pdf_bytes, dpi=150)
    except ImportError:
        raise RuntimeError("pdf2image not installed — run: pip install pdf2image")
    except Exception as e:
        raise RuntimeError(f"PDF conversion failed: {e}")

    result = []
    for page in pages[:MAX_PDF_PAGES]:
        url = _compress_image(page)
        if url:
            result.append(url)
    return result


def _video_to_data_urls(video_bytes: bytes) -> list[str]:
    """Extract evenly-spaced frames from a video, compress, return as data URLs."""
    import tempfile
    try:
        import cv2
    except ImportError:
        raise RuntimeError("opencv-python-headless not installed — run: pip install opencv-python-headless")

    tmp_fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
    try:
        os.write(tmp_fd, video_bytes)
        os.close(tmp_fd)

        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            raise RuntimeError("Could not open video file")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
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
        return results
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _parse(raw_text: str) -> dict:
    """Parse a JSON response from the model, stripping markdown fences if present."""
    text = raw_text.strip()
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
