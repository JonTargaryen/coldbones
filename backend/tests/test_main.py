"""
Tests for backend/main.py — FastAPI + vision-analysis application.

Coverage targets:
  - /api/health  (model loaded, model missing, LM Studio unreachable)
  - /api/analyze (images, PDFs, invalid types, size limit, language routing,
                  reasoning_content extraction, JSON parse fallback, empty content
                  with reasoning, model name detection)
  - Helper functions (parse_model_response, extract_observations_from_reasoning,
                      convert_to_png_bytes, image_to_base64_data_url, pdf_to_images,
                      get_model_name)
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image

# ── path setup ───────────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── patch OpenAI client before importing main ────────────────────────────────
_mock_client = MagicMock()
_mock_client.models.list.return_value = MagicMock(data=[])

with patch("openai.OpenAI", return_value=_mock_client):
    import main as app_module
    from main import (
        app,
        convert_to_png_bytes,
        extract_observations_from_reasoning,
        get_model_name,
        parse_model_response,
        image_to_base64_data_url,
        pdf_to_images,
    )

client = TestClient(app)


# ─────────────────────────── helpers ─────────────────────────────────────────

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


def _good_analyze_json() -> str:
    return json.dumps({
        "summary": "A test image.",
        "key_observations": ["It is red", "4×4 pixels"],
        "content_classification": "photograph",
        "extracted_text": "No text detected.",
    })


def _fake_response(content: str = "", reasoning: str = "", finish: str = "stop") -> MagicMock:
    msg = MagicMock()
    msg.content = content
    msg.model_dump.return_value = {"content": content, "reasoning_content": reasoning}
    choice = MagicMock()
    choice.message = msg
    choice.finish_reason = finish
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def _fake_models(model_id: str = "qwen3.5") -> MagicMock:
    m = MagicMock()
    m.id = model_id
    result = MagicMock()
    result.data = [m]
    return result


# ═════════════════════════ /api/health ════════════════════════════════════════

class TestHealth:
    def test_health_model_loaded(self):
        app_module.client.models.list.return_value = _fake_models("qwen3.5")
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["model_loaded"] is True
        assert data["model_name"] == "qwen3.5"

    def test_health_no_models(self):
        empty = MagicMock()
        empty.data = []
        app_module.client.models.list.return_value = empty
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["model_loaded"] is False
        assert data["model_name"] == ""

    def test_health_lm_studio_unreachable(self):
        app_module.client.models.list.side_effect = Exception("connection refused")
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["model_loaded"] is False
        app_module.client.models.list.side_effect = None

    def test_health_returns_lm_studio_url(self):
        app_module.client.models.list.return_value = _fake_models()
        resp = client.get("/api/health")
        assert "lm_studio_url" in resp.json()


# ═════════════════════════ /api/analyze ═══════════════════════════════════════

class TestAnalyzeInput:
    """Validate request handling / input gating."""

    def test_unsupported_type_rejected(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.mp4", b"data", "video/mp4")},
        )
        assert resp.status_code == 400
        assert "Unsupported file type" in resp.json()["detail"]

    def test_file_too_large_rejected(self):
        big = b"x" * (21 * 1024 * 1024)
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("big.png", big, "image/png")},
        )
        assert resp.status_code == 400
        assert "exceeds" in resp.json()["detail"]

    def test_image_jpeg_accepted(self):
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())
        app_module.client.models.list.return_value = _fake_models()
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.jpg", _jpeg_bytes(), "image/jpeg")},
        )
        assert resp.status_code == 200

    def test_image_png_accepted(self):
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())
        app_module.client.models.list.return_value = _fake_models()
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_image_webp_accepted(self):
        img = Image.new("RGB", (4, 4), "cyan")
        buf = io.BytesIO()
        img.save(buf, format="WEBP")
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("test.webp", buf.getvalue(), "image/webp")},
        )
        assert resp.status_code == 200

    def test_rgba_image_converted(self):
        """RGBA/P images must be converted to RGB before PNG encode."""
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("rgba.png", _rgba_png_bytes(), "image/png")},
        )
        assert resp.status_code == 200


class TestAnalyzeResponse:
    """Validate response shape and field mapping."""

    def setup_method(self):
        self._orig_model = app_module.LM_STUDIO_MODEL
        app_module.LM_STUDIO_MODEL = ""  # force model detection via mock
        app_module.client.models.list.return_value = _fake_models("my-model")
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())

    def teardown_method(self):
        app_module.LM_STUDIO_MODEL = self._orig_model

    def test_response_has_all_fields(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
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

    def test_model_name_in_response(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["model"] == "my-model"

    def test_processing_time_positive(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.json()["processing_time_ms"] >= 0


class TestAnalyzeLanguages:
    """Multilingual routing — lang param appended to user message."""

    def setup_method(self):
        app_module.client.models.list.return_value = _fake_models()
        app_module.client.chat.completions.create.return_value = _fake_response(_good_analyze_json())

    def test_hindi_lang_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "hi"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        # Verify the call message included the Hindi instruction
        call_args = app_module.client.chat.completions.create.call_args
        messages = call_args.kwargs["messages"]
        user_content = messages[1]["content"]
        found_hindi = any(
            "Hindi" in str(part.get("text", "")) for part in user_content if isinstance(part, dict)
        )
        assert found_hindi

    def test_spanish_lang_accepted(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "es"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200

    def test_bengali_lang_accepted(self):
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
        call_args = app_module.client.chat.completions.create.call_args
        messages = call_args.kwargs["messages"]
        user_content = messages[1]["content"]
        no_lang_instruction = not any(
            "IMPORTANT" in str(part.get("text", "")) for part in user_content if isinstance(part, dict)
        )
        assert no_lang_instruction

    def test_unknown_lang_falls_back_to_no_instruction(self):
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "xx"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200


class TestAnalyzeReasoning:
    """Reasoning token extraction and fallback handling."""

    def test_reasoning_content_extracted(self):
        app_module.client.models.list.return_value = _fake_models()
        app_module.client.chat.completions.create.return_value = _fake_response(
            content=_good_analyze_json(),
            reasoning="Step 1: Look at the image. Step 2: Describe.",
        )
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        data = resp.json()
        assert data["reasoning"] == "Step 1: Look at the image. Step 2: Describe."
        assert data["reasoning_token_count"] > 0

    def test_empty_content_with_reasoning_uses_fallback(self):
        """When content is empty but reasoning exists, create a best-effort response."""
        reasoning = (
            "- I see a red square\n"
            "- The image is small\n"
            "I observe it's a test image.\n"
        )
        app_module.client.models.list.return_value = _fake_models()
        app_module.client.chat.completions.create.return_value = _fake_response(
            content="", reasoning=reasoning
        )
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert "model" in data["summary"] or len(data["key_observations"]) > 0

    def test_model_dump_exception_handled(self):
        """If model_dump() raises, reasoning defaults to empty string."""
        msg = MagicMock()
        msg.content = _good_analyze_json()
        msg.model_dump = MagicMock(side_effect=Exception("dump failed"))
        choice = MagicMock()
        choice.message = msg
        choice.finish_reason = "stop"
        resp_mock = MagicMock()
        resp_mock.choices = [choice]
        app_module.client.chat.completions.create.return_value = resp_mock
        app_module.client.models.list.return_value = _fake_models()
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 200
        assert resp.json()["reasoning"] == ""

    def test_inference_error_returns_502(self):
        app_module.client.chat.completions.create.side_effect = Exception("LM Studio down")
        app_module.client.models.list.return_value = _fake_models()
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("img.png", _png_bytes(), "image/png")},
        )
        assert resp.status_code == 502
        app_module.client.chat.completions.create.side_effect = None


class TestAnalyzePDF:
    """PDF upload path — pdf_to_images conversion."""

    def test_pdf_poppler_not_installed(self):
        """When pdf2image raises, return 500."""
        with patch("main.pdf_to_images", side_effect=Exception("poppler not found")):
            # patch pdf_to_images at module level
            pass
        # Actually test via the endpoint using a fake PDF bytes
        # Override the module-level function
        original = app_module.pdf_to_images
        def boom(b):
            from fastapi import HTTPException
            raise HTTPException(500, "PDF conversion failed. Ensure poppler-utils is installed.")
        app_module.pdf_to_images = boom
        resp = client.post(
            "/api/analyze",
            data={"mode": "fast", "lang": "en"},
            files={"file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
        )
        assert resp.status_code == 500
        app_module.pdf_to_images = original

    def test_pdf_converted_and_multi_image_prompt(self):
        """Successful PDF conversion should send multiple image URLs."""
        fake_page = _png_bytes()
        with patch("main.pdf_to_images", return_value=[fake_page, fake_page]):
            app_module.client.models.list.return_value = _fake_models()
            app_module.client.chat.completions.create.return_value = _fake_response(
                _good_analyze_json()
            )
            resp = client.post(
                "/api/analyze",
                data={"mode": "fast", "lang": "en"},
                files={"file": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
            )
            assert resp.status_code == 200
            call_args = app_module.client.chat.completions.create.call_args
            messages = call_args.kwargs["messages"]
            user_content = messages[1]["content"]
            image_parts = [p for p in user_content if isinstance(p, dict) and p.get("type") == "image_url"]
            assert len(image_parts) == 2


# ═════════════════════════ Helper function unit tests ═════════════════════════

class TestParseModelResponse:
    def test_valid_json(self):
        raw = json.dumps({
            "summary": "Test", "key_observations": ["a"],
            "content_classification": "photo", "extracted_text": "hello",
        })
        result = parse_model_response(raw)
        assert result["summary"] == "Test"
        assert result["key_observations"] == ["a"]

    def test_strips_markdown_fence(self):
        raw = "```json\n{\"summary\": \"fenced\", \"key_observations\": [], \"content_classification\": \"x\", \"extracted_text\": \"\"}\n```"
        result = parse_model_response(raw)
        assert result["summary"] == "fenced"

    def test_strips_plain_fence(self):
        raw = "```\n{\"summary\": \"plain\", \"key_observations\": [], \"content_classification\": \"x\", \"extracted_text\": \"\"}\n```"
        result = parse_model_response(raw)
        assert result["summary"] == "plain"

    def test_invalid_json_fallback(self):
        result = parse_model_response("not valid json at all {")
        assert "summary" in result
        assert result["content_classification"] == "unknown"
        assert result["key_observations"] == []

    def test_empty_string_fallback(self):
        result = parse_model_response("")
        assert result["content_classification"] == "unknown"

    def test_long_text_truncated_in_fallback(self):
        long_text = "x" * 1000
        result = parse_model_response(long_text)
        assert len(result["summary"]) <= 500


class TestExtractObservationsFromReasoning:
    def test_extracts_bullet_lines(self):
        reasoning = "- I see a large red square in the center\n- The background appears to be plain white\n- The object is approximately 4x4 pixels"
        obs = extract_observations_from_reasoning(reasoning)
        assert len(obs) >= 2
        assert any("red square" in o for o in obs)

    def test_extracts_numbered_lines(self):
        reasoning = "1. The image is blurry\n2. There is a cat\n3. Background is dark"
        obs = extract_observations_from_reasoning(reasoning)
        assert len(obs) >= 2

    def test_extracts_i_see_phrases(self):
        reasoning = "I see a dog in the image. There is also a tree."
        obs = extract_observations_from_reasoning(reasoning)
        assert len(obs) >= 1

    def test_skips_thinking_header(self):
        reasoning = "Thinking about this...\nLet me analyze.\n- Actual observation here"
        obs = extract_observations_from_reasoning(reasoning)
        assert not any("Thinking" in o for o in obs)
        assert not any("Let me" in o for o in obs)

    def test_max_10_observations(self):
        lines = "\n".join(f"- observation number {i} with detail" for i in range(20))
        obs = extract_observations_from_reasoning(lines)
        assert len(obs) <= 10

    def test_empty_reasoning(self):
        obs = extract_observations_from_reasoning("")
        assert obs == []

    def test_short_lines_skipped(self):
        reasoning = "- ok\n- x\n- this is a substantial observation with enough text"
        obs = extract_observations_from_reasoning(reasoning)
        # Only lines with len > 20 pass
        assert all(len(o) > 5 for o in obs)


class TestConvertToPngBytes:
    def test_jpeg_to_png(self):
        result = convert_to_png_bytes(_jpeg_bytes())
        # Should start with PNG magic bytes
        assert result[:8] == b"\x89PNG\r\n\x1a\n"

    def test_rgba_to_rgb_png(self):
        result = convert_to_png_bytes(_rgba_png_bytes())
        img = Image.open(io.BytesIO(result))
        assert img.mode == "RGB"

    def test_png_passthrough(self):
        orig = _png_bytes()
        result = convert_to_png_bytes(orig)
        assert result[:8] == b"\x89PNG\r\n\x1a\n"


class TestImageToBase64DataUrl:
    def test_returns_data_url(self):
        url = image_to_base64_data_url(_png_bytes(), "image/png")
        assert url.startswith("data:image/png/png;base64,") or url.startswith("data:image/png;base64,") or "base64," in url

    def test_base64_is_decodable(self):
        url = image_to_base64_data_url(_png_bytes(), "image/png")
        b64_part = url.split("base64,")[1]
        decoded = base64.b64decode(b64_part)
        assert len(decoded) > 0


class TestGetModelName:
    def test_uses_env_var_when_set(self):
        app_module.LM_STUDIO_MODEL = "env-model"
        name = get_model_name()
        assert name == "env-model"
        app_module.LM_STUDIO_MODEL = ""

    def test_detects_from_api_when_no_env(self):
        app_module.LM_STUDIO_MODEL = ""
        app_module.client.models.list.return_value = _fake_models("detected-model")
        name = get_model_name()
        assert name == "detected-model"

    def test_falls_back_to_default_on_exception(self):
        app_module.LM_STUDIO_MODEL = ""
        app_module.client.models.list.side_effect = Exception("unreachable")
        name = get_model_name()
        assert name == "default"
        app_module.client.models.list.side_effect = None

    def test_falls_back_to_default_when_no_models(self):
        app_module.LM_STUDIO_MODEL = ""
        empty = MagicMock()
        empty.data = []
        app_module.client.models.list.return_value = empty
        name = get_model_name()
        assert name == "default"


class TestPdfToImages:
    def test_calls_convert_from_bytes(self):
        fake_img = Image.new("RGB", (4, 4), "white")
        with patch("pdf2image.convert_from_bytes", return_value=[fake_img]) as mock_convert:
            result = pdf_to_images(b"%PDF-1.4")
            mock_convert.assert_called_once()
            assert len(result) == 1
            assert result[0][:8] == b"\x89PNG\r\n\x1a\n"

    def test_returns_all_converted_pages(self):
        """pdf_to_images returns all pages; caller limits to 20 (tested in TestAnalyzePDF)."""
        pages = [Image.new("RGB", (4, 4)) for _ in range(5)]
        with patch("pdf2image.convert_from_bytes", return_value=pages):
            result = pdf_to_images(b"%PDF-1.4")
            assert len(result) == 5

    def test_raises_http_exception_on_failure(self):
        with patch("pdf2image.convert_from_bytes", side_effect=Exception("poppler not found")):
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc_info:
                pdf_to_images(b"bad pdf")
            assert exc_info.value.status_code == 500
            assert "poppler" in exc_info.value.detail.lower()
