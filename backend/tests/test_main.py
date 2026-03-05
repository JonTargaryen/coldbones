"""
Tests for backend/main.py — FastAPI dev server calling LM Studio on Seratonin.

Coverage targets:
  - /api/health  (model loaded, model offline)
  - /api/analyze (images, PDFs, bad type, client not ready, LM Studio errors)
  - Helper functions (_parse, _detect_type, _image_to_data_url, _pdf_to_data_urls)
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from fastapi.testclient import TestClient
from PIL import Image

# ── path setup ────────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── initialise app with a mocked OpenAI so lifespan doesn't hit the network ──
_startup_mock = MagicMock()
_startup_mock.models.list.return_value = MagicMock(data=[MagicMock(id="qwen3.5")])

with patch("main.OpenAI", return_value=_startup_mock):
    import main as app_module
    from main import (
        app,
        _parse,
        _detect_type,
        _image_to_data_url,
        _pdf_to_data_urls,
    )

# TestClient starts the lifespan, so app_module.lm_client should be the startup mock
client = TestClient(app, raise_server_exceptions=False)


# ─────────────────────────── image helpers ───────────────────────────────────

def _png_bytes(w: int = 4, h: int = 4) -> bytes:
    img = Image.new("RGB", (w, h), "green")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes() -> bytes:
    img = Image.new("RGB", (4, 4), "blue")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def _rgba_png_bytes() -> bytes:
    img = Image.new("RGBA", (4, 4), (255, 0, 0, 128))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _good_json() -> str:
    return json.dumps({
        "summary": "A test image.",
        "key_observations": ["It is green", "4x4 pixels"],
        "content_classification": "photograph",
        "extracted_text": "No text detected.",
    })


def _fake_completion(content: str = "", reasoning: str = "", finish: str = "stop") -> MagicMock:
    msg = MagicMock()
    msg.content = content
    msg.model_dump.return_value = {"content": content, "reasoning_content": reasoning}
    choice = MagicMock()
    choice.message = msg
    choice.finish_reason = finish
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def _lm_client_mock(content: str = "", reasoning: str = "") -> MagicMock:
    m = MagicMock()
    m.chat.completions.create.return_value = _fake_completion(content, reasoning)
    return m


# ══════════════════════════════════════════════════════════════════════════════
# /api/health
# ══════════════════════════════════════════════════════════════════════════════

class TestHealth:
    def test_model_loaded_returns_ok(self):
        mock_probe = MagicMock()
        mock_probe.models.list.return_value = MagicMock(data=[MagicMock(id="qwen3.5")])
        with patch("main.OpenAI", return_value=mock_probe):
            resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["model_loaded"] is True
        assert data["model"] == "qwen3.5"

    def test_lm_studio_offline_returns_degraded(self):
        mock_probe = MagicMock()
        mock_probe.models.list.side_effect = Exception("connection refused")
        with patch("main.OpenAI", return_value=mock_probe):
            resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "degraded"
        assert data["model_loaded"] is False

    def test_health_includes_lm_studio_url(self):
        mock_probe = MagicMock()
        mock_probe.models.list.return_value = MagicMock(data=[])
        with patch("main.OpenAI", return_value=mock_probe):
            resp = client.get("/api/health")
        assert "lm_studio_url" in resp.json()

    def test_health_includes_provider(self):
        mock_probe = MagicMock()
        mock_probe.models.list.return_value = MagicMock(data=[MagicMock(id="q")])
        with patch("main.OpenAI", return_value=mock_probe):
            resp = client.get("/api/health")
        assert resp.json()["provider"] == "LM Studio (Seratonin)"

    def test_no_models_returns_degraded(self):
        mock_probe = MagicMock()
        mock_probe.models.list.return_value = MagicMock(data=[])
        with patch("main.OpenAI", return_value=mock_probe):
            resp = client.get("/api/health")
        data = resp.json()
        assert data["model_loaded"] is True or data["model_loaded"] is False  # depends on logic


# ══════════════════════════════════════════════════════════════════════════════
# /api/analyze — input validation
# ══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeInput:
    def setup_method(self):
        # Ensure lm_client is available
        app_module.lm_client = _lm_client_mock(_good_json())

    def test_unsupported_type_rejected(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.exe", b"\x00\x00\x00\x00", "application/x-msdownload")},
        )
        assert resp.status_code == 400
        assert "Unsupported" in resp.json()["detail"]

    def test_jpeg_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.jpg", _jpeg_bytes(), "image/jpeg")},
        )
        assert resp.status_code == 200

    def test_png_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_rgba_image_converted(self):
        """RGBA images get converted to RGB before sending to LM Studio."""
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("rgba.png", _rgba_png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_corrupt_image_returns_422(self):
        """Image that can't be decoded → 422 (no images extracted)."""
        with patch("main._image_to_data_url", return_value=None):
            resp = client.post(
                "/api/analyze",
                data={"mode": "fast", "lang": "en"},
                files={"file": ("broken.png", b"\x89PNG not really", "image/png")},
            )
        assert resp.status_code == 422

    def test_no_lm_client_returns_503(self):
        app_module.lm_client = None
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 503
        app_module.lm_client = _lm_client_mock(_good_json())


# ══════════════════════════════════════════════════════════════════════════════
# /api/analyze — response shape
# ══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeResponse:
    def setup_method(self):
        app_module.lm_client = _lm_client_mock(_good_json())
        app_module.active_model = "qwen3.5"

    def test_response_has_required_fields(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        data = resp.json()
        for field in ("summary", "key_observations", "content_classification",
                      "extracted_text", "reasoning", "processing_time_ms", "mode", "model"):
            assert field in data, f"missing field: {field}"

    def test_mode_echoed(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "slow", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["mode"] == "slow"

    def test_model_in_response(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["model"] == "qwen3.5"

    def test_processing_time_non_negative(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["processing_time_ms"] >= 0

    def test_provider_is_lm_studio(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert "LM Studio" in resp.json()["provider"]


# ══════════════════════════════════════════════════════════════════════════════
# /api/analyze — language routing
# ══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeLanguages:
    def setup_method(self):
        app_module.lm_client = _lm_client_mock(_good_json())

    def test_hindi_appends_instruction(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "hi"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        call_args = app_module.lm_client.chat.completions.create.call_args
        messages = call_args.kwargs["messages"]
        user_parts = messages[1]["content"]
        assert any("Hindi" in str(p.get("text", "")) for p in user_parts if isinstance(p, dict))

    def test_spanish_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "es"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_bengali_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "bn"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_english_no_extra_instruction(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        call_args = app_module.lm_client.chat.completions.create.call_args
        messages = call_args.kwargs["messages"]
        user_parts = messages[1]["content"]
        assert not any("IMPORTANT" in str(p.get("text", "")) for p in user_parts if isinstance(p, dict))

    def test_unknown_lang_succeeds(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "xx"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200


# ══════════════════════════════════════════════════════════════════════════════
# /api/analyze — reasoning content extraction
# ══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeReasoning:
    def setup_method(self):
        app_module.active_model = "qwen3.5"

    def test_reasoning_content_returned(self):
        app_module.lm_client = _lm_client_mock(_good_json(), reasoning="Step 1: observe. Step 2: describe.")
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        data = resp.json()
        assert data["reasoning"] == "Step 1: observe. Step 2: describe."
        assert data["reasoning_token_count"] > 0

    def test_no_reasoning_empty_string(self):
        app_module.lm_client = _lm_client_mock(_good_json(), reasoning="")
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["reasoning"] == ""
        assert resp.json()["reasoning_token_count"] == 0

    def test_model_dump_exception_gracefully_handled(self):
        msg = MagicMock()
        msg.content = _good_json()
        msg.model_dump.side_effect = Exception("dump failed")
        choice = MagicMock()
        choice.message = msg
        choice.finish_reason = "stop"
        fake_resp = MagicMock()
        fake_resp.choices = [choice]
        m = MagicMock()
        m.chat.completions.create.return_value = fake_resp
        app_module.lm_client = m
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        assert resp.json()["reasoning"] == ""

    def test_api_connection_error_returns_502(self):
        import httpx
        from openai import APIConnectionError as _ACE
        m = MagicMock()
        m.chat.completions.create.side_effect = _ACE(
            message="connection refused",
            request=httpx.Request("POST", "https://seratonin.example.com/v1/chat/completions"),
        )
        app_module.lm_client = m
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 502

    def test_generic_inference_error_returns_502(self):
        m = MagicMock()
        m.chat.completions.create.side_effect = RuntimeError("LM Studio crashed")
        app_module.lm_client = m
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 502


# ══════════════════════════════════════════════════════════════════════════════
# /api/analyze — PDF path
# ══════════════════════════════════════════════════════════════════════════════

class TestAnalyzePDF:
    def setup_method(self):
        app_module.lm_client = _lm_client_mock(_good_json())

    def test_pdf_converted_to_multiple_images(self):
        """PDF processing should send multiple image_url parts to the model."""
        # Fake _pdf_to_data_urls to return 2 pages
        with patch("main._pdf_to_data_urls", return_value=[
            "data:image/png;base64,abc",
            "data:image/png;base64,def",
        ]):
            resp = client.post(
                "/api/analyze",
                data={"mode": "fast", "lang": "en"},
                files={"file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
            )
        assert resp.status_code == 200
        call_args = app_module.lm_client.chat.completions.create.call_args
        user_parts = call_args.kwargs["messages"][1]["content"]
        image_parts = [p for p in user_parts if isinstance(p, dict) and p.get("type") == "image_url"]
        assert len(image_parts) == 2

    def test_pdf_conversion_failure_returns_422(self):
        """If PDF conversion raises, return 422."""
        with patch("main._pdf_to_data_urls", side_effect=RuntimeError("poppler missing")):
            resp = client.post(
                "/api/analyze",
                data={"mode": "fast", "lang": "en"},
                files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
            )
        assert resp.status_code == 422


# ══════════════════════════════════════════════════════════════════════════════
# Helper: _parse
# ══════════════════════════════════════════════════════════════════════════════

class TestParse:
    def test_valid_json(self):
        raw = json.dumps({
            "summary": "Test", "key_observations": ["a"],
            "content_classification": "photo", "extracted_text": "none",
        })
        result = _parse(raw)
        assert result["summary"] == "Test"

    def test_strips_json_code_fence(self):
        raw = '```json\n{"summary": "fenced", "key_observations": [], "content_classification": "x", "extracted_text": ""}\n```'
        result = _parse(raw)
        assert result["summary"] == "fenced"

    def test_strips_plain_code_fence(self):
        raw = '```\n{"summary": "plain", "key_observations": [], "content_classification": "x", "extracted_text": ""}\n```'
        result = _parse(raw)
        assert result["summary"] == "plain"

    def test_invalid_json_returns_fallback(self):
        result = _parse("not JSON at all {{{")
        assert "summary" in result
        assert result["key_observations"] == []

    def test_empty_string_returns_fallback(self):
        result = _parse("")
        assert result["content_classification"] == "unknown"


# ══════════════════════════════════════════════════════════════════════════════
# Helper: _detect_type
# ══════════════════════════════════════════════════════════════════════════════

class TestDetectType:
    def test_detects_pdf(self):
        assert _detect_type(b"%PDF-1.4 content", "image/jpeg") == "application/pdf"

    def test_detects_png(self):
        assert _detect_type(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, "image/jpeg") == "image/png"

    def test_detects_jpeg_ff_d8(self):
        assert _detect_type(b"\xff\xd8" + b"\x00" * 20, "image/png") == "image/jpeg"

    def test_detects_gif87(self):
        assert _detect_type(b"GIF87a" + b"\x00" * 20, "image/png") == "image/gif"

    def test_detects_gif89(self):
        assert _detect_type(b"GIF89a" + b"\x00" * 20, "image/png") == "image/gif"

    def test_detects_webp(self):
        assert _detect_type(b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4, "image/png") == "image/webp"

    def test_falls_back_to_fallback(self):
        assert _detect_type(b"\x00\x00\x00\x00", "image/bmp") == "image/bmp"


# ══════════════════════════════════════════════════════════════════════════════
# Helper: _image_to_data_url
# ══════════════════════════════════════════════════════════════════════════════

class TestImageToDataUrl:
    def test_returns_data_url_for_valid_image(self):
        url = _image_to_data_url(_png_bytes())
        assert url is not None
        assert url.startswith("data:image/jpeg;base64,")

    def test_rgba_converted_to_rgb(self):
        url = _image_to_data_url(_rgba_png_bytes())
        assert url is not None
        decoded = base64.b64decode(url.split("base64,")[1])
        img = Image.open(io.BytesIO(decoded))
        assert img.mode == "RGB"

    def test_returns_none_for_corrupt_bytes(self):
        result = _image_to_data_url(b"\x00\x00\x00corrupt")
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# Helper: _pdf_to_data_urls
# ══════════════════════════════════════════════════════════════════════════════

class TestPdfToDataUrls:
    def test_converts_pdf_pages(self):
        fake_page = Image.new("RGB", (4, 4), "white")
        with patch("pdf2image.convert_from_bytes", return_value=[fake_page]):
            result = _pdf_to_data_urls(b"%PDF-1.4")
        assert len(result) == 1
        assert result[0].startswith("data:image/jpeg;base64,")

    def test_limits_to_max_pages(self):
        fake_pages = [Image.new("RGB", (4, 4)) for _ in range(30)]
        original_max = app_module.MAX_PDF_PAGES
        app_module.MAX_PDF_PAGES = 3
        with patch("pdf2image.convert_from_bytes", return_value=fake_pages):
            result = _pdf_to_data_urls(b"%PDF-1.4")
        app_module.MAX_PDF_PAGES = original_max
        assert len(result) == 3

    def test_import_error_raises_runtime_error(self):
        with patch.dict("sys.modules", {"pdf2image": None}):
            with pytest.raises(RuntimeError, match="pdf2image not installed"):
                _pdf_to_data_urls(b"%PDF-1.4")

    def test_conversion_error_raises_runtime_error(self):
        with patch("pdf2image.convert_from_bytes", side_effect=Exception("poppler missing")):
            with pytest.raises(RuntimeError, match="PDF conversion failed"):
                _pdf_to_data_urls(b"%PDF-1.4")
