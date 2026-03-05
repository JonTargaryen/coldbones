"""
Tests for lambdas/bedrock_client.py — Bedrock CMI (Custom Model Import) client.

Covers:
  - Model ARN resolution (SSM, env-var override, cache)
  - is_bedrock_available check
  - invoke_bedrock (Qwen2.5-VL chat template, image b64 extraction, response parsing)
"""
from __future__ import annotations

import json
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas"))


def _reload_module():
    """Reload bedrock_client to reset module-level cache."""
    import bedrock_client
    bedrock_client._cached_model_arn = None
    bedrock_client._cache_time = 0.0
    bedrock_client._BEDROCK_MODEL_ARN_OVERRIDE = ""
    return bedrock_client


class TestGetBedrockModelArn:
    def test_reads_from_ssm(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "arn:aws:bedrock:us-east-1:123:imported-model/abc"}
        }
        mod._ssm = mock_ssm
        arn = mod.get_bedrock_model_arn()
        assert arn == "arn:aws:bedrock:us-east-1:123:imported-model/abc"

    def test_env_override_skips_ssm(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:override"
        mock_ssm = MagicMock()
        mod._ssm = mock_ssm
        arn = mod.get_bedrock_model_arn()
        assert arn == "arn:override"
        mock_ssm.get_parameter.assert_not_called()

    def test_cache_returns_previous(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.return_value = {
            "Parameter": {"Value": "arn:cached"}
        }
        mod._ssm = mock_ssm
        arn1 = mod.get_bedrock_model_arn()
        arn2 = mod.get_bedrock_model_arn()
        assert arn1 == arn2
        assert mock_ssm.get_parameter.call_count == 1

    def test_ssm_failure_raises(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = Exception("not found")
        mod._ssm = mock_ssm
        with pytest.raises(RuntimeError, match="Bedrock model ARN not configured"):
            mod.get_bedrock_model_arn()


class TestIsBedrockAvailable:
    def test_available_when_arn_set(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:aws:bedrock:us-east-1:123:model/x"
        assert mod.is_bedrock_available() is True

    def test_unavailable_when_ssm_fails(self):
        mod = _reload_module()
        mock_ssm = MagicMock()
        mock_ssm.get_parameter.side_effect = Exception("not configured")
        mod._ssm = mock_ssm
        assert mod.is_bedrock_available() is False


class TestInvokeBedrock:
    def test_successful_invocation_choices_format(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test-model"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({
            "choices": [{"text": '{"summary": "test result"}'}]
        }).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_bedrock(
            image_data_urls=["data:image/png;base64,iVBOR"],
            system_prompt="Analyze",
            analysis_text="Describe this image",
            max_tokens=1024,
        )
        assert result["raw_text"] == '{"summary": "test result"}'
        assert result["provider"] == "Bedrock (Qwen2.5-VL)"
        assert result["model_arn"] == "arn:test-model"

    def test_outputs_format(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({
            "outputs": [{"text": "output text"}]
        }).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_bedrock([], "sys", "user")
        assert result["raw_text"] == "output text"

    def test_generation_format(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({
            "generation": "generated text"
        }).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_bedrock([], "sys", "user")
        assert result["raw_text"] == "generated text"

    def test_unknown_format_returns_json_dump(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({"custom": "response"}).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_bedrock([], "sys", "user")
        assert "custom" in result["raw_text"]

    def test_strips_im_end_token(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({
            "choices": [{"text": "result text<|im_end|>"}]
        }).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        result = mod.invoke_bedrock([], "sys", "user")
        assert "<|im_end|>" not in result["raw_text"]
        assert result["raw_text"] == "result text"

    def test_builds_correct_prompt_with_images(self):
        mod = _reload_module()
        mod._BEDROCK_MODEL_ARN_OVERRIDE = "arn:test"

        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps({"choices": [{"text": "ok"}]}).encode()

        mock_runtime = MagicMock()
        mock_runtime.invoke_model.return_value = {"body": mock_body}
        mod._bedrock_runtime = mock_runtime

        mod.invoke_bedrock(
            image_data_urls=[
                "data:image/png;base64,AAAA",
                "data:image/jpeg;base64,BBBB",
            ],
            system_prompt="System",
            analysis_text="Analyze",
        )

        call_body = json.loads(mock_runtime.invoke_model.call_args.kwargs["body"])
        assert "images" in call_body
        assert len(call_body["images"]) == 2
        assert "<|vision_start|>" in call_body["prompt"]
