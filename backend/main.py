"""
Coldbones Backend — FastAPI server that proxies vision analysis requests to LM Studio.

Endpoints:
  GET  /api/health   — Health check + LM Studio connectivity
  POST /api/analyze   — Upload a file and get AI vision analysis
"""

import base64
import io
import json
import os
import re
import time
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from PIL import Image

load_dotenv()

LM_STUDIO_URL = os.getenv("LM_STUDIO_URL", "http://localhost:1234/v1")
LM_STUDIO_MODEL = os.getenv("LM_STUDIO_MODEL", "")
MAX_FILE_SIZE = int(os.getenv("MAX_FILE_SIZE", 20 * 1024 * 1024))

app = FastAPI(title="Coldbones API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# LM Studio client (OpenAI-compatible)
client = OpenAI(base_url=LM_STUDIO_URL, api_key="lm-studio")

# Qwen3.5 is a thinking model — it produces reasoning in `reasoning_content`
# and the final answer in `content`. We give it generous max_tokens so it can
# think thoroughly and still produce a complete answer. The reasoning is returned
# to the frontend for transparency.
MAX_INFERENCE_TOKENS = int(os.getenv("MAX_INFERENCE_TOKENS", 16384))

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully. Think through what you see step by step, then respond with a JSON object (no markdown fences) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible. Your final output (after any thinking) must be ONLY the JSON object."""


ACCEPTED_IMAGE_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff"
}
ACCEPTED_PDF_TYPE = "application/pdf"

# Language instructions appended to the user message to steer model output language
LANGUAGE_INSTRUCTIONS = {
    "en": "",  # English is the default, no extra instruction needed
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी). All text in your JSON response — summary, observations, classification labels, and extracted text translation — must be written in Hindi.",
    "es": "IMPORTANT: Respond entirely in Spanish (Español). All text in your JSON response — summary, observations, classification labels, and extracted text translation — must be written in Spanish.",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা). All text in your JSON response — summary, observations, classification labels, and extracted text translation — must be written in Bengali.",
}


def image_to_base64_data_url(image_bytes: bytes, mime_type: str) -> str:
    """Convert raw image bytes to a base64 data URL."""
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    return f"data:{mime_type}/{mime_type.split('/')[-1]};base64,{b64}"


def convert_to_png_bytes(image_bytes: bytes) -> bytes:
    """Convert any image format to PNG bytes for consistent processing."""
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def pdf_to_images(pdf_bytes: bytes) -> list[bytes]:
    """Convert PDF pages to PNG images. Requires poppler-utils installed."""
    try:
        from pdf2image import convert_from_bytes

        images = convert_from_bytes(pdf_bytes, dpi=150, fmt="png")
        result = []
        for img in images:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            result.append(buf.getvalue())
        return result
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"PDF conversion failed. Ensure poppler-utils is installed. Error: {str(e)}",
        )


def parse_model_response(raw_text: str) -> dict:
    """Parse the model's JSON response, handling common quirks."""
    text = raw_text.strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # If JSON parsing fails, create a structured response from raw text
        return {
            "summary": text[:500] if len(text) > 500 else text,
            "key_observations": [],
            "content_classification": "unknown",
            "extracted_text": "No text detected.",
        }


def extract_observations_from_reasoning(reasoning: str) -> list[str]:
    """Pull useful observations from raw reasoning text when content is empty."""
    observations = []
    lines = reasoning.split("\n")
    for line in lines:
        line = line.strip()
        # Look for lines that start with bullets, numbers, or "I see/notice/observe"
        if (
            line
            and len(line) > 20
            and not line.startswith("Thinking")
            and not line.startswith("Let me")
            and (
                line.startswith(("- ", "* ", "• "))
                or re.match(r"^\d+[.)]", line)
                or any(kw in line.lower() for kw in ["i see", "i notice", "i observe", "there is", "the image", "this is", "this shows"])
            )
        ):
            # Clean up the line
            cleaned = re.sub(r"^[-*•\d.)]+\s*", "", line).strip()
            if cleaned and len(cleaned) > 10:
                observations.append(cleaned)
        if len(observations) >= 10:
            break
    return observations


def get_model_name() -> str:
    """Get the model name to use. If not configured, try to detect from LM Studio."""
    if LM_STUDIO_MODEL:
        return LM_STUDIO_MODEL
    try:
        models = client.models.list()
        if models.data:
            return models.data[0].id
    except Exception:
        pass
    return "default"


@app.get("/api/health")
async def health():
    """Health check — verifies LM Studio is reachable."""
    model_loaded = False
    model_name = ""
    try:
        models = client.models.list()
        model_loaded = len(models.data) > 0
        if model_loaded:
            model_name = models.data[0].id
    except Exception:
        pass

    return {
        "status": "ok",
        "model_loaded": model_loaded,
        "model_name": model_name,
        "lm_studio_url": LM_STUDIO_URL,
    }


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    mode: str = Form("fast"),
    lang: str = Form("en"),
):
    """
    Analyze an uploaded image or PDF using the vision model.

    - **file**: Image (JPEG, PNG, WebP, GIF, BMP, TIFF) or PDF
    - **mode**: "fast" (synchronous) or "slow" (queued — currently both are synchronous in local dev)
    - **lang**: Response language — "en", "hi", "es", or "bn"
    """
    # Validate file type
    content_type = file.content_type or ""
    if content_type not in ACCEPTED_IMAGE_TYPES and content_type != ACCEPTED_PDF_TYPE:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {content_type}. Accepted: JPEG, PNG, WebP, GIF, BMP, TIFF, PDF.",
        )

    # Read file
    file_bytes = await file.read()
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File exceeds {MAX_FILE_SIZE // (1024*1024)} MB limit.",
        )

    start_time = time.time()

    # Prepare image(s) for model
    image_data_urls: list[str] = []

    if content_type == ACCEPTED_PDF_TYPE:
        # Convert PDF pages to images
        page_images = pdf_to_images(file_bytes)
        for page_bytes in page_images[:20]:  # Limit to 20 pages
            data_url = f"data:image/png;base64,{base64.b64encode(page_bytes).decode('utf-8')}"
            image_data_urls.append(data_url)
    else:
        # Convert image to PNG for consistency
        try:
            png_bytes = convert_to_png_bytes(file_bytes)
        except Exception:
            png_bytes = file_bytes  # Fall back to original

        data_url = f"data:image/png;base64,{base64.b64encode(png_bytes).decode('utf-8')}"
        image_data_urls.append(data_url)

    # Build message content with image(s)
    content: list[dict] = []
    for url in image_data_urls:
        content.append({
            "type": "image_url",
            "image_url": {"url": url},
        })

    # Base analysis instruction
    analysis_text = (
        "Analyze this image thoroughly."
        if len(image_data_urls) == 1
        else f"Analyze these {len(image_data_urls)} pages from a document thoroughly."
    )

    # Append language instruction if non-English
    lang_instruction = LANGUAGE_INSTRUCTIONS.get(lang, "")
    if lang_instruction:
        analysis_text = f"{analysis_text}\n\n{lang_instruction}"

    content.append({
        "type": "text",
        "text": analysis_text,
    })

    # Call model — Qwen3.5 is a thinking model, so we give generous token budget
    # for both reasoning (thinking) and the final answer.
    model_name = get_model_name()
    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            max_tokens=MAX_INFERENCE_TOKENS,
            temperature=0.6,
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Model inference failed: {str(e)}. Is LM Studio running with a model loaded?",
        )

    elapsed_ms = int((time.time() - start_time) * 1000)

    # Extract thinking/reasoning and final content from the response.
    # Qwen3.5 thinking models put reasoning in `reasoning_content` and the
    # final answer in `content`. LM Studio surfaces this via the message object.
    message = response.choices[0].message
    raw_content = message.content or ""
    finish_reason = response.choices[0].finish_reason or ""

    # Extract reasoning_content — it's a non-standard field, so access via
    # the raw dict or attribute depending on the client version.
    reasoning = ""
    try:
        msg_dict = message.model_dump() if hasattr(message, "model_dump") else message.__dict__
        reasoning = msg_dict.get("reasoning_content", "") or ""
    except Exception:
        pass

    # If content is empty but we have reasoning, the model's thinking consumed
    # all tokens before it could produce a final answer. Try to extract useful
    # info from the reasoning itself.
    if not raw_content.strip() and reasoning:
        # The model was still thinking — create a best-effort response from reasoning
        result = {
            "summary": "The model's detailed reasoning is shown below. It finished thinking but did not produce a structured answer (max tokens may need to be increased).",
            "key_observations": extract_observations_from_reasoning(reasoning),
            "content_classification": "unknown (inference incomplete)",
            "extracted_text": "No text detected.",
        }
    else:
        result = parse_model_response(raw_content)

    return {
        "summary": result.get("summary", ""),
        "key_observations": result.get("key_observations", []),
        "content_classification": result.get("content_classification", ""),
        "extracted_text": result.get("extracted_text", ""),
        "reasoning": reasoning,
        "reasoning_token_count": len(reasoning.split()) if reasoning else 0,
        "processing_time_ms": elapsed_ms,
        "finish_reason": finish_reason,
        "mode": mode,
        "model": model_name,
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
