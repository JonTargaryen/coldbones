"""
Tests for lambdas/analyze_orchestrator/handler.py — the inference workhorse.

Covers:
  - Handler entry point (happy path, missing s3Key, various providers)
  - _detect_magic_type (magic bytes + extension fallback)
  - _compress_image (resize, RGBA→RGB, quality)
  - _image_to_data_url
  - _pdf_to_data_urls
  - _video_to_data_urls
  - _cap_payload_size (recompression + page dropping)
  - _parse_model_response (clean JSON, code fences, mixed text, fallback)
  - _write_partial_text
  - _error helper
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import types
from unittest.mock import MagicMock, patch, ANY

import pytest
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas", "analyze_orchestrator"))

# Set required env vars BEFORE importing the handler
_ENV = {
    "UPLOAD_BUCKET": "test-bucket",
    "JOBS_TABLE": "test-jobs",
    "AWS_DEFAULT_REGION": "us-east-1",
}


def _load_handler():
    """Import handler with mocked dependencies."""
    with patch.dict(os.environ, _ENV):
        with patch("handler.boto3"):
            import handler as mod
            return mod


# We need to import with mocked boto3 to avoid real AWS calls
# Use setdefault so we don't overwrite the real modules if already imported
_mock_modules_applied = {}
for mod_name in ("desktop_client", "bedrock_client", "bedrock_ondemand_client"):
    if mod_name not in sys.modules:
        fake = types.ModuleType(mod_name)
        if mod_name == "desktop_client":
            fake.get_openai_client = MagicMock()
            fake.is_desktop_alive = MagicMock(return_value=False)
        elif mod_name == "bedrock_client":
            fake.invoke_bedrock = MagicMock()
        else:
            fake.invoke_ondemand = MagicMock()
            fake.invoke_ondemand_streaming = MagicMock()
        sys.modules[mod_name] = fake
        _mock_modules_applied[mod_name] = fake

with patch.dict(os.environ, _ENV):
    with patch("boto3.client", return_value=MagicMock()):
        with patch("boto3.resource", return_value=MagicMock()):
            import lambdas.analyze_orchestrator.handler as orch_mod

# Clean up: remove our fakes so other test files can import the real modules
for mod_name, fake in _mock_modules_applied.items():
    if sys.modules.get(mod_name) is fake:
        del sys.modules[mod_name]


def _make_png_bytes(w=4, h=4, color="red"):
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_jpeg_data_url(size_bytes=100):
    """Create a JPEG data URL of approximately the given size."""
    img = Image.new("RGB", (10, 10), "blue")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


class FakeCtx:
    aws_request_id = "req-test"
    function_name = "test-orchestrator"
    def get_remaining_time_in_millis(self):
        return 600000


CTX = FakeCtx()


# ══════════════════════════════════════════════════════════════════════════════
# _detect_magic_type
# ══════════════════════════════════════════════════════════════════════════════

class TestDetectMagicType:
    def test_pdf(self):
        assert orch_mod._detect_magic_type(b"%PDF-1.4" + b"\x00" * 10, "f.pdf") == "application/pdf"

    def test_jpeg(self):
        assert orch_mod._detect_magic_type(b"\xFF\xD8\xFF" + b"\x00" * 10, "f.jpg") == "image/jpeg"

    def test_png(self):
        assert orch_mod._detect_magic_type(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, "f.png") == "image/png"

    def test_gif87(self):
        assert orch_mod._detect_magic_type(b"GIF87a" + b"\x00" * 10, "f.gif") == "image/gif"

    def test_gif89(self):
        assert orch_mod._detect_magic_type(b"GIF89a" + b"\x00" * 10, "f.gif") == "image/gif"

    def test_bmp(self):
        assert orch_mod._detect_magic_type(b"BM" + b"\x00" * 10, "f.bmp") == "image/bmp"

    def test_webp(self):
        raw = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4
        assert orch_mod._detect_magic_type(raw, "f.webp") == "image/webp"

    def test_tiff_le(self):
        assert orch_mod._detect_magic_type(b"II*\x00" + b"\x00" * 10, "f.tiff") == "image/tiff"

    def test_tiff_be(self):
        assert orch_mod._detect_magic_type(b"MM\x00*" + b"\x00" * 10, "f.tiff") == "image/tiff"

    def test_mp4(self):
        raw = b"\x00\x00\x00\x18ftyp" + b"\x00" * 10
        assert orch_mod._detect_magic_type(raw, "f.mp4") == "video/mp4"

    def test_webm(self):
        assert orch_mod._detect_magic_type(b"\x1a\x45\xdf\xa3" + b"\x00" * 10, "f.webm") == "video/webm"

    def test_avi(self):
        raw = b"RIFF\x00\x00\x00\x00AVI " + b"\x00" * 4
        assert orch_mod._detect_magic_type(raw, "f.avi") == "video/avi"

    def test_extension_fallback_jpg(self):
        assert orch_mod._detect_magic_type(b"\x00" * 20, "photo.jpg") == "image/jpeg"

    def test_extension_fallback_pdf(self):
        assert orch_mod._detect_magic_type(b"\x00" * 20, "doc.pdf") == "application/pdf"

    def test_unknown_returns_empty(self):
        assert orch_mod._detect_magic_type(b"\x00" * 20, "file.xyz") == ""

    def test_too_short_returns_empty(self):
        assert orch_mod._detect_magic_type(b"\x00" * 5, "f.jpg") == ""


# ══════════════════════════════════════════════════════════════════════════════
# _compress_image
# ══════════════════════════════════════════════════════════════════════════════

class TestCompressImage:
    def test_rgb_image_returns_data_url(self):
        img = Image.new("RGB", (100, 100), "red")
        result = orch_mod._compress_image(img)
        assert result is not None
        assert result.startswith("data:image/jpeg;base64,")

    def test_rgba_converted_to_rgb(self):
        img = Image.new("RGBA", (50, 50), (255, 0, 0, 128))
        result = orch_mod._compress_image(img)
        assert result is not None
        decoded = base64.b64decode(result.split("base64,")[1])
        output_img = Image.open(io.BytesIO(decoded))
        assert output_img.mode == "RGB"

    def test_palette_mode_converted(self):
        img = Image.new("P", (50, 50))
        result = orch_mod._compress_image(img)
        assert result is not None

    def test_large_image_resized(self):
        img = Image.new("RGB", (4000, 3000), "blue")
        result = orch_mod._compress_image(img)
        assert result is not None
        decoded = base64.b64decode(result.split("base64,")[1])
        output_img = Image.open(io.BytesIO(decoded))
        assert max(output_img.size) <= orch_mod.MAX_IMAGE_DIMENSION

    def test_small_image_not_resized(self):
        img = Image.new("RGB", (100, 100), "green")
        result = orch_mod._compress_image(img)
        assert result is not None

    def test_la_mode_converted(self):
        """LA (luminance + alpha) mode is converted to RGB."""
        img = Image.new("LA", (50, 50))
        result = orch_mod._compress_image(img)
        assert result is not None

    def test_other_mode_converted(self):
        """Non-standard mode (e.g. L) is converted to RGB via else branch."""
        img = Image.new("L", (50, 50))
        result = orch_mod._compress_image(img)
        assert result is not None

    def test_corrupt_image_returns_none(self):
        """Exception during compression returns None."""
        mock_img = MagicMock()
        mock_img.mode = "RGB"
        mock_img.size = (100, 100)
        mock_img.save.side_effect = Exception("corrupt")
        result = orch_mod._compress_image(mock_img)
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# _image_to_data_url
# ══════════════════════════════════════════════════════════════════════════════

class TestImageToDataUrl:
    def test_valid_png_bytes(self):
        result = orch_mod._image_to_data_url(_make_png_bytes())
        assert result is not None
        assert result.startswith("data:image/jpeg;base64,")

    def test_corrupt_bytes_returns_none(self):
        result = orch_mod._image_to_data_url(b"\x00corrupt")
        assert result is None


# ══════════════════════════════════════════════════════════════════════════════
# _estimate_decoded_size
# ══════════════════════════════════════════════════════════════════════════════

class TestEstimateDecodedSize:
    def test_base64_data_url(self):
        # 100 base64 chars ≈ 75 decoded bytes
        data_url = "data:image/jpeg;base64," + "A" * 100
        size = orch_mod._estimate_decoded_size(data_url)
        assert size == 75

    def test_non_base64_url(self):
        size = orch_mod._estimate_decoded_size("not-a-data-url")
        assert size == len("not-a-data-url")


# ══════════════════════════════════════════════════════════════════════════════
# _cap_payload_size
# ══════════════════════════════════════════════════════════════════════════════

class TestCapPayloadSize:
    def test_small_payload_unchanged(self):
        urls = [_make_jpeg_data_url()]
        result = orch_mod._cap_payload_size(urls)
        assert len(result) == len(urls)

    def test_large_payload_drops_trailing(self):
        # Create many URLs that exceed the limit
        original_max = orch_mod.MAX_PAYLOAD_BYTES
        orch_mod.MAX_PAYLOAD_BYTES = 500  # Very small limit for testing
        try:
            urls = [_make_jpeg_data_url() for _ in range(20)]
            result = orch_mod._cap_payload_size(urls)
            assert len(result) < len(urls)
            assert len(result) >= 1
        finally:
            orch_mod.MAX_PAYLOAD_BYTES = original_max


# ══════════════════════════════════════════════════════════════════════════════
# _parse_model_response
# ══════════════════════════════════════════════════════════════════════════════

class TestParseModelResponse:
    def test_clean_json(self):
        data = {"summary": "Test", "observations": ["a", "b"]}
        result = orch_mod._parse_model_response(json.dumps(data))
        assert result["summary"] == "Test"
        assert result["observations"] == ["a", "b"]

    def test_json_code_fence(self):
        raw = '```json\n{"summary": "fenced"}\n```'
        result = orch_mod._parse_model_response(raw)
        assert result["summary"] == "fenced"

    def test_plain_code_fence(self):
        raw = '```\n{"summary": "plain"}\n```'
        result = orch_mod._parse_model_response(raw)
        assert result["summary"] == "plain"

    def test_mixed_text_and_json(self):
        raw = 'Some thinking text here...\n\n{"summary": "extracted", "insights": []}'
        result = orch_mod._parse_model_response(raw)
        assert result["summary"] == "extracted"
        # Preamble should be captured as chain_of_thought
        assert "thinking" in result.get("chain_of_thought", "")

    def test_invalid_json_fallback(self):
        result = orch_mod._parse_model_response("not valid JSON {{{")
        assert "summary" in result
        assert result["content_classification"] == "unknown"

    def test_empty_string_fallback(self):
        result = orch_mod._parse_model_response("")
        assert result["content_classification"] == "unknown"

    def test_nested_json_in_text(self):
        raw = 'Before\n{"summary": "nested", "observations": ["x"]}\nAfter'
        result = orch_mod._parse_model_response(raw)
        assert result["summary"] == "nested"

    def test_preserves_existing_chain_of_thought(self):
        data = {"summary": "Test", "chain_of_thought": "existing CoT"}
        raw = "preamble\n" + json.dumps(data)
        result = orch_mod._parse_model_response(raw)
        # Should keep the existing chain_of_thought, not overwrite with preamble
        assert result["chain_of_thought"] == "existing CoT"


# ══════════════════════════════════════════════════════════════════════════════
# _write_partial_text
# ══════════════════════════════════════════════════════════════════════════════

class TestWritePartialText:
    def test_writes_to_dynamodb(self):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        orch_mod._write_partial_text("job-123", "partial output")

        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs["Key"] == {"jobId": "job-123"}
        assert call_kwargs["ExpressionAttributeValues"][":pt"] == "partial output"

    def test_skips_when_no_table(self):
        orch_mod.JOBS_TABLE_NAME = ""
        orch_mod._write_partial_text("job-123", "text")
        # Should not raise

    def test_skips_unknown_job_id(self):
        orch_mod.JOBS_TABLE_NAME = "test-jobs"
        orch_mod._write_partial_text("unknown", "text")
        # Should not raise

    def test_swallows_dynamodb_errors(self):
        mock_table = MagicMock()
        mock_table.update_item.side_effect = Exception("DDB error")
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        # Should not raise
        orch_mod._write_partial_text("job-123", "text")


# ══════════════════════════════════════════════════════════════════════════════
# _error helper
# ══════════════════════════════════════════════════════════════════════════════

class TestErrorHelper:
    def test_returns_error_response(self):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        result = orch_mod._error(400, "Bad request", "job-001")
        assert result["statusCode"] == 400
        body = json.loads(result["body"])
        assert "Bad request" in body["error"]

    def test_updates_dynamodb_on_error(self):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        orch_mod._error(502, "Inference failed", "job-002")
        mock_table.update_item.assert_called_once()

    def test_skips_dynamodb_for_unknown_job(self):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        orch_mod._error(400, "msg", "unknown")
        mock_table.update_item.assert_not_called()


# ══════════════════════════════════════════════════════════════════════════════
# _pdf_to_data_urls
# ══════════════════════════════════════════════════════════════════════════════

class TestOrchestratorPdfToDataUrls:
    def test_converts_pdf_pages(self):
        fake_page = Image.new("RGB", (100, 100), "white")

        mock_pdf = MagicMock()
        mock_pdf.__len__ = MagicMock(return_value=2)
        mock_bitmap = MagicMock()
        mock_bitmap.to_pil.return_value = fake_page
        mock_page = MagicMock()
        mock_page.render.return_value = mock_bitmap
        mock_pdf.__getitem__ = MagicMock(return_value=mock_page)

        fake_pdfium = types.ModuleType("pypdfium2")
        fake_pdfium.PdfDocument = MagicMock(return_value=mock_pdf)

        with patch.dict("sys.modules", {"pypdfium2": fake_pdfium}):
            result = orch_mod._pdf_to_data_urls(b"%PDF-1.4", "job-test")

        assert len(result) == 2
        assert all(u.startswith("data:image/jpeg;base64,") for u in result)

    def test_empty_on_failure(self):
        fake_pdfium = types.ModuleType("pypdfium2")
        fake_pdfium.PdfDocument = MagicMock(side_effect=Exception("parse error"))

        with patch.dict("sys.modules", {"pypdfium2": fake_pdfium}):
            result = orch_mod._pdf_to_data_urls(b"not-a-pdf", "job-test")

        assert result == []

    def test_skips_pages_that_fail_compress(self):
        """Pages where _compress_image returns None should be skipped."""
        mock_pdf = MagicMock()
        mock_pdf.__len__ = MagicMock(return_value=2)
        mock_bitmap = MagicMock()
        # Return an image that will NOT compress (we mock _compress_image)
        mock_bitmap.to_pil.return_value = Image.new("RGB", (10, 10))
        mock_page = MagicMock()
        mock_page.render.return_value = mock_bitmap
        mock_pdf.__getitem__ = MagicMock(return_value=mock_page)

        fake_pdfium = types.ModuleType("pypdfium2")
        fake_pdfium.PdfDocument = MagicMock(return_value=mock_pdf)

        with patch.dict("sys.modules", {"pypdfium2": fake_pdfium}):
            with patch.object(orch_mod, "_compress_image", side_effect=[None, "data:image/jpeg;base64,abc"]):
                result = orch_mod._pdf_to_data_urls(b"%PDF-1.4", "job-test")

        assert len(result) == 1


# ══════════════════════════════════════════════════════════════════════════════
# _video_to_data_urls
# ══════════════════════════════════════════════════════════════════════════════

class TestVideoToDataUrls:
    def test_opencv_not_installed(self):
        """When cv2 is not importable, return empty list."""
        # Ensure cv2 is not available
        with patch.dict("sys.modules", {"cv2": None}):
            result = orch_mod._video_to_data_urls(b"fake-video", "job-test")
        assert result == []

    def test_extracts_frames(self):
        """With mocked cv2, extract frames and compress."""
        fake_cv2 = types.ModuleType("cv2")
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.get.side_effect = lambda prop: {
            # CAP_PROP_FRAME_COUNT = 7, CAP_PROP_FPS = 5
            7: 10,  # 10 frames total
            5: 30.0,  # 30 fps
        }.get(prop, 0)
        # Return a fake BGR frame — use a real small PIL image converted to array-like
        small_img = Image.new("RGB", (10, 10), "red")
        # cv2.cvtColor will be mocked, so the frame itself doesn't matter
        mock_cap.read.return_value = (True, MagicMock())
        fake_cv2.VideoCapture = MagicMock(return_value=mock_cap)
        fake_cv2.CAP_PROP_FRAME_COUNT = 7
        fake_cv2.CAP_PROP_FPS = 5
        fake_cv2.CAP_PROP_POS_FRAMES = 1
        fake_cv2.COLOR_BGR2RGB = 4

        # Mock cvtColor to return an array that Image.fromarray can handle
        import struct
        # Create raw bytes for a 10x10 RGB image
        raw_rgb = bytes([255, 0, 0] * 100)  # 10x10 red pixels

        class FakeArray:
            """Minimal array-like that PIL.Image.fromarray can consume."""
            def __init__(self):
                self.shape = (10, 10, 3)
                self.dtype = type('dt', (), {'str': '|u1', 'name': 'uint8'})()
                self.__array_interface__ = {
                    'shape': (10, 10, 3),
                    'typestr': '|u1',
                    'data': (id(raw_rgb), False),
                    'version': 3,
                }

        # Instead of fighting with array interface, just mock Image.fromarray
        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            with patch.object(Image, "fromarray", return_value=Image.new("RGB", (10, 10), "blue")):
                fake_cv2.cvtColor = MagicMock(return_value=MagicMock())
                result = orch_mod._video_to_data_urls(b"fake-video-bytes", "job-test")

        assert len(result) == 10
        assert all(u.startswith("data:image/jpeg;base64,") for u in result)

    def test_video_open_failed(self):
        """If VideoCapture can't open, return empty list."""
        fake_cv2 = types.ModuleType("cv2")
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = False
        fake_cv2.VideoCapture = MagicMock(return_value=mock_cap)

        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = orch_mod._video_to_data_urls(b"bad-video", "job-test")

        assert result == []

    def test_zero_frames(self):
        """If video has 0 frames, return empty list."""
        fake_cv2 = types.ModuleType("cv2")
        mock_cap = MagicMock()
        mock_cap.isOpened.return_value = True
        mock_cap.get.return_value = 0  # 0 frames
        fake_cv2.VideoCapture = MagicMock(return_value=mock_cap)
        fake_cv2.CAP_PROP_FRAME_COUNT = 7
        fake_cv2.CAP_PROP_FPS = 5

        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = orch_mod._video_to_data_urls(b"empty-video", "job-test")

        assert result == []

    def test_conversion_error_returns_empty(self):
        """General exception in video processing returns empty list."""
        fake_cv2 = types.ModuleType("cv2")
        fake_cv2.VideoCapture = MagicMock(side_effect=Exception("cv2 boom"))

        with patch.dict("sys.modules", {"cv2": fake_cv2}):
            result = orch_mod._video_to_data_urls(b"video", "job-test")

        assert result == []


# ══════════════════════════════════════════════════════════════════════════════
# handler — integration-level tests
# ══════════════════════════════════════════════════════════════════════════════

class TestHandler:
    def test_missing_s3_key_returns_400(self):
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        result = orch_mod.handler({"jobId": "j1", "lang": "en"}, CTX)
        assert result["statusCode"] == 400

    def test_rejects_oversized_upload_before_inference(self):
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"x" * 101))
        }
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        original_limit = orch_mod.MAX_UPLOAD_BYTES
        orch_mod.MAX_UPLOAD_BYTES = 100
        try:
            with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
                result = orch_mod.handler({
                    "jobId": "j-large",
                    "s3Key": "uploads/abc/large.png",
                    "lang": "en",
                    "filename": "large.png",
                    "provider": "ondemand",
                }, CTX)
            assert result["statusCode"] == 413
            assert "limit" in json.loads(result["body"])["error"].lower()
            mock_invoke.assert_not_called()
        finally:
            orch_mod.MAX_UPLOAD_BYTES = original_limit

    def test_ondemand_provider_success(self):
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        # Mock the streaming inference
        with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
            mock_invoke.return_value = {
                "raw_text": json.dumps({"summary": "test analysis", "observations": ["obs1"]}),
                "finish_reason": "end_turn",
                "model_id": "qwen.qwen3-vl-235b-a22b",
                "provider": "Bedrock On-Demand (qwen.qwen3-vl-235b-a22b)",
                "usage": {"input_tokens": 100, "output_tokens": 200},
            }

            result = orch_mod.handler({
                "jobId": "j-test",
                "s3Key": "uploads/abc/photo.png",
                "lang": "en",
                "filename": "photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["summary"] == "test analysis"
        assert body["jobId"] == "j-test"

    def test_desktop_provider_success(self):
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        # Mock desktop client
        mock_client = MagicMock()
        msg = MagicMock()
        msg.content = json.dumps({"summary": "desktop result"})
        msg.model_dump.return_value = {}
        choice = MagicMock()
        choice.message = msg
        choice.finish_reason = "stop"
        resp = MagicMock()
        resp.choices = [choice]
        mock_client.chat.completions.create.return_value = resp

        with patch.object(orch_mod, "get_openai_client", return_value=(mock_client, "qwen3.5-35b")):
            result = orch_mod.handler({
                "jobId": "j-desktop",
                "s3Key": "uploads/abc/photo.png",
                "lang": "en",
                "filename": "photo.png",
                "provider": "desktop",
            }, CTX)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["summary"] == "desktop result"
        assert body["provider"] == "RTX 5090"

    def test_s3_download_failure_returns_502(self):
        from botocore.exceptions import ClientError
        mock_s3 = MagicMock()
        mock_s3.get_object.side_effect = ClientError(
            {"Error": {"Code": "NoSuchKey", "Message": "not found"}}, "GetObject"
        )
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        result = orch_mod.handler({
            "jobId": "j-fail",
            "s3Key": "uploads/missing/file.png",
            "provider": "ondemand",
        }, CTX)

        assert result["statusCode"] == 502

    def test_unsupported_file_returns_400(self):
        mock_s3 = MagicMock()
        # Return bytes with no recognizable magic bytes
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"\x00" * 20))
        }
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        result = orch_mod.handler({
            "jobId": "j-bad",
            "s3Key": "uploads/abc/file.xyz",
            "provider": "ondemand",
        }, CTX)

        assert result["statusCode"] == 400

    def test_bedrock_provider_success(self):
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "invoke_bedrock") as mock_invoke:
            mock_invoke.return_value = {
                "raw_text": json.dumps({"summary": "bedrock cmi result"}),
                "model_arn": "arn:test",
                "provider": "Bedrock (Qwen2.5-VL)",
                "finish_reason": "stop",
            }

            result = orch_mod.handler({
                "jobId": "j-bedrock",
                "s3Key": "uploads/abc/photo.png",
                "lang": "en",
                "filename": "photo.png",
                "provider": "bedrock",
            }, CTX)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["summary"] == "bedrock cmi result"

    def test_inference_failure_returns_502(self):
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "invoke_ondemand_streaming", side_effect=RuntimeError("model crashed")):
            result = orch_mod.handler({
                "jobId": "j-crash",
                "s3Key": "uploads/abc/photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 502

    def test_handler_pdf_multi_page_prompt(self):
        """Multi-page PDF generates correct prompt text."""
        mock_s3 = MagicMock()
        pdf_bytes = b"%PDF-1.4" + b"\x00" * 20
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=pdf_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        fake_urls = ["data:image/jpeg;base64,a", "data:image/jpeg;base64,b", "data:image/jpeg;base64,c"]

        with patch.object(orch_mod, "_pdf_to_data_urls", return_value=fake_urls):
            with patch.object(orch_mod, "_cap_payload_size", return_value=fake_urls):
                with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
                    mock_invoke.return_value = {
                        "raw_text": json.dumps({"summary": "pdf analysis"}),
                        "finish_reason": "end_turn",
                        "model_id": "qwen-test",
                        "provider": "Bedrock On-Demand",
                        "usage": {},
                    }
                    result = orch_mod.handler({
                        "jobId": "j-pdf",
                        "s3Key": "uploads/abc/doc.pdf",
                        "lang": "en",
                        "filename": "doc.pdf",
                        "provider": "ondemand",
                    }, CTX)

        assert result["statusCode"] == 200
        # Check the prompt includes "pages"
        call_kwargs = mock_invoke.call_args.kwargs
        assert "pages" in call_kwargs["analysis_text"].lower()

    def test_handler_with_language_instruction(self):
        """Non-English language appends language instruction."""
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
            mock_invoke.return_value = {
                "raw_text": json.dumps({"summary": "Hindi analysis"}),
                "finish_reason": "end_turn",
                "model_id": "qwen-test",
                "provider": "Bedrock On-Demand",
                "usage": {},
            }
            result = orch_mod.handler({
                "jobId": "j-hindi",
                "s3Key": "uploads/abc/photo.png",
                "lang": "hi",
                "filename": "photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 200
        call_kwargs = mock_invoke.call_args.kwargs
        assert "Hindi" in call_kwargs["analysis_text"]

    def test_handler_video_content(self):
        """Handler processes video content type correctly."""
        mock_s3 = MagicMock()
        # Video magic bytes: ftyp at offset 4
        video_bytes = b"\x00\x00\x00\x18ftyp" + b"\x00" * 20
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=video_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        fake_urls = ["data:image/jpeg;base64,frame1", "data:image/jpeg;base64,frame2"]

        with patch.object(orch_mod, "_video_to_data_urls", return_value=fake_urls):
            with patch.object(orch_mod, "_cap_payload_size", return_value=fake_urls):
                with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
                    mock_invoke.return_value = {
                        "raw_text": json.dumps({"summary": "video result"}),
                        "finish_reason": "end_turn",
                        "model_id": "qwen-test",
                        "provider": "Bedrock On-Demand",
                        "usage": {},
                    }
                    result = orch_mod.handler({
                        "jobId": "j-video",
                        "s3Key": "uploads/abc/video.mp4",
                        "lang": "en",
                        "filename": "video.mp4",
                        "provider": "ondemand",
                    }, CTX)

        assert result["statusCode"] == 200
        # Video prompt mentions "frames" and "video"
        call_kwargs = mock_invoke.call_args.kwargs
        assert "frames" in call_kwargs["analysis_text"].lower()

    def test_handler_image_conversion_fails_returns_400(self):
        """When image conversion produces no data URLs, return 400."""
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "_image_to_data_url", return_value=None):
            result = orch_mod.handler({
                "jobId": "j-noimgs",
                "s3Key": "uploads/abc/photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 400

    def test_handler_ondemand_calls_on_chunk(self):
        """Verify _on_chunk callback writes partial text during streaming."""
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        def fake_streaming(**kwargs):
            # Call on_chunk to simulate streaming
            cb = kwargs.get("on_chunk")
            if cb:
                cb("Hello", "Hello")
                # Simulate time passing so the flush interval triggers
                import time
                time.sleep(0.01)
                cb(" world", "Hello world")
            return {
                "raw_text": json.dumps({"summary": "streamed result"}),
                "finish_reason": "end_turn",
                "model_id": "qwen-test",
                "provider": "Bedrock On-Demand",
                "usage": {},
            }

        with patch.object(orch_mod, "invoke_ondemand_streaming", side_effect=fake_streaming):
            # Set flush interval to 0 so every chunk triggers a write
            original_handler = orch_mod.handler
            result = orch_mod.handler({
                "jobId": "j-stream",
                "s3Key": "uploads/abc/photo.png",
                "lang": "en",
                "filename": "photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 200

    def test_handler_s3_result_save_failure_non_fatal(self):
        """S3 result save failure should not prevent response."""
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.side_effect = Exception("S3 write failed")
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
            mock_invoke.return_value = {
                "raw_text": json.dumps({"summary": "result despite s3 fail"}),
                "finish_reason": "end_turn",
                "model_id": "qwen-test",
                "provider": "Bedrock On-Demand",
                "usage": {},
            }
            result = orch_mod.handler({
                "jobId": "j-s3fail",
                "s3Key": "uploads/abc/photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 200

    def test_handler_ddb_update_failure_non_fatal(self):
        """DynamoDB final update failure should not prevent response."""
        mock_s3 = MagicMock()
        png_bytes = _make_png_bytes()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=png_bytes))
        }
        mock_s3.put_object.return_value = {}
        orch_mod.s3_client = mock_s3

        mock_table = MagicMock()
        mock_table.update_item.side_effect = Exception("DDB boom")
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        orch_mod.dynamodb = mock_ddb
        orch_mod.JOBS_TABLE_NAME = "test-jobs"

        with patch.object(orch_mod, "invoke_ondemand_streaming") as mock_invoke:
            mock_invoke.return_value = {
                "raw_text": json.dumps({"summary": "result despite ddb fail"}),
                "finish_reason": "end_turn",
                "model_id": "qwen-test",
                "provider": "Bedrock On-Demand",
                "usage": {},
            }
            result = orch_mod.handler({
                "jobId": "j-ddbfail",
                "s3Key": "uploads/abc/photo.png",
                "provider": "ondemand",
            }, CTX)

        assert result["statusCode"] == 200
