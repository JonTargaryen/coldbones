"""
Tests for lambdas/bedrock_ondemand_client.py — Bedrock Converse API client.

Covers:
  - Model ID retrieval
  - is_ondemand_available
  - Media type to format conversion
  - invoke_ondemand (non-streaming Converse API)
  - invoke_ondemand_streaming (Converse Stream API)
  - Retry logic for transient errors
"""
from __future__ import annotations

import base64
import os
import sys
import time
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas"))

from botocore.exceptions import ClientError


def _reload_module():
    """Reload bedrock_ondemand_client to reset state."""
    import bedrock_ondemand_client as mod
    return mod


def _make_client_error(code: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": f"{code} error"}},
        "converse",
    )


# Small PNG as base64 for test data URLs
_TINY_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20).decode()
_DATA_URL = f"data:image/png;base64,{_TINY_B64}"


class TestGetOndemandModelId:
    def test_returns_default_model(self):
        mod = _reload_module()
        model_id = mod.get_ondemand_model_id()
        assert "qwen" in model_id.lower() or model_id  # has a value

    def test_respects_env_override(self):
        with patch.dict(os.environ, {"BEDROCK_ONDEMAND_MODEL_ID": "us.amazon.nova-lite-v1:0"}):
            import importlib
            import bedrock_ondemand_client as mod
            importlib.reload(mod)
            assert mod.get_ondemand_model_id() == "us.amazon.nova-lite-v1:0"


class TestIsOndemandAvailable:
    def test_available_when_model_id_set(self):
        mod = _reload_module()
        assert mod.is_ondemand_available() is True


class TestMediaTypeToFormat:
    def test_png(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/png") == "png"

    def test_jpeg(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/jpeg") == "jpeg"

    def test_jpg(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/jpg") == "jpeg"

    def test_gif(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/gif") == "gif"

    def test_webp(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/webp") == "webp"

    def test_unknown_defaults_to_png(self):
        mod = _reload_module()
        assert mod._media_type_to_format("image/bmp") == "png"


class TestInvokeOndemand:
    def test_successful_invocation(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.return_value = {
            "output": {
                "message": {
                    "content": [{"text": '{"summary": "test analysis"}'}]
                }
            },
            "usage": {"inputTokens": 100, "outputTokens": 50},
            "stopReason": "end_turn",
        }
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_ondemand(
            image_data_urls=[_DATA_URL],
            system_prompt="Analyze",
            analysis_text="Describe this",
        )

        assert result["raw_text"] == '{"summary": "test analysis"}'
        assert result["finish_reason"] == "end_turn"
        assert result["usage"]["input_tokens"] == 100
        assert result["usage"]["output_tokens"] == 50
        assert "Bedrock On-Demand" in result["provider"]

    def test_retries_on_throttling(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.side_effect = [
            _make_client_error("ThrottlingException"),
            {
                "output": {"message": {"content": [{"text": "ok"}]}},
                "usage": {},
                "stopReason": "end_turn",
            },
        ]
        mod._bedrock_runtime = mock_runtime

        with patch("bedrock_ondemand_client.time.sleep"):
            result = mod.invoke_ondemand([_DATA_URL], "sys", "user")

        assert result["raw_text"] == "ok"
        assert mock_runtime.converse.call_count == 2

    def test_raises_after_max_retries(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.side_effect = _make_client_error("ThrottlingException")
        mod._bedrock_runtime = mock_runtime

        with patch("bedrock_ondemand_client.time.sleep"):
            with pytest.raises(ClientError):
                mod.invoke_ondemand([_DATA_URL], "sys", "user")

    def test_non_retryable_error_raises_immediately(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.side_effect = _make_client_error("ValidationException")
        mod._bedrock_runtime = mock_runtime

        with pytest.raises(ClientError):
            mod.invoke_ondemand([_DATA_URL], "sys", "user")
        assert mock_runtime.converse.call_count == 1

    def test_non_client_error_raises_immediately(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.side_effect = RuntimeError("unexpected")
        mod._bedrock_runtime = mock_runtime

        with pytest.raises(RuntimeError):
            mod.invoke_ondemand([_DATA_URL], "sys", "user")

    def test_multiple_images(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse.return_value = {
            "output": {"message": {"content": [{"text": "multi result"}]}},
            "usage": {},
            "stopReason": "end_turn",
        }
        mod._bedrock_runtime = mock_runtime

        mod.invoke_ondemand(
            image_data_urls=[_DATA_URL, _DATA_URL],
            system_prompt="sys",
            analysis_text="analyze",
        )

        call_args = mock_runtime.converse.call_args
        messages = call_args.kwargs["messages"]
        image_blocks = [b for b in messages[0]["content"] if "image" in b]
        assert len(image_blocks) == 2


class TestInvokeOndemandStreaming:
    def test_streams_tokens(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        stream_events = [
            {"contentBlockDelta": {"delta": {"text": "Hello"}}},
            {"contentBlockDelta": {"delta": {"text": " world"}}},
            {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5}}},
        ]
        mock_runtime.converse_stream.return_value = {"stream": stream_events}
        mod._bedrock_runtime = mock_runtime

        chunks = []
        def on_chunk(delta, accumulated):
            chunks.append((delta, accumulated))

        result = mod.invoke_ondemand_streaming(
            image_data_urls=[_DATA_URL],
            system_prompt="sys",
            analysis_text="analyze",
            on_chunk=on_chunk,
        )

        assert result["raw_text"] == "Hello world"
        assert result["finish_reason"] == "end_turn"
        assert len(chunks) == 2
        assert chunks[0] == ("Hello", "Hello")
        assert chunks[1] == (" world", "Hello world")

    def test_stream_retry_on_throttling(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        mock_runtime.converse_stream.side_effect = [
            _make_client_error("ThrottlingException"),
            {"stream": [
                {"contentBlockDelta": {"delta": {"text": "ok"}}},
                {"messageStop": {"stopReason": "end_turn"}},
            ]},
        ]
        mod._bedrock_runtime = mock_runtime

        with patch("bedrock_ondemand_client.time.sleep"):
            result = mod.invoke_ondemand_streaming(
                [_DATA_URL], "sys", "analyze", on_chunk=lambda d, a: None,
            )

        assert result["raw_text"] == "ok"

    def test_stream_empty_deltas_ignored(self):
        mod = _reload_module()
        mock_runtime = MagicMock()
        stream_events = [
            {"contentBlockDelta": {"delta": {"text": ""}}},
            {"contentBlockDelta": {"delta": {"text": "content"}}},
            {"contentBlockDelta": {"delta": {}}},
            {"messageStop": {"stopReason": "end_turn"}},
        ]
        mock_runtime.converse_stream.return_value = {"stream": stream_events}
        mod._bedrock_runtime = mock_runtime

        chunks = []
        result = mod.invoke_ondemand_streaming(
            [_DATA_URL], "sys", "analyze",
            on_chunk=lambda d, a: chunks.append(d),
        )

        assert result["raw_text"] == "content"
        assert chunks == ["content"]
