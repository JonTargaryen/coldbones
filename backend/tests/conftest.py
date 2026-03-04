"""
Shared pytest fixtures and helpers for Coldbones backend tests.
"""
from __future__ import annotations

import io
import os
import sys
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image

# ─── ensure the backend root is importable ───────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ─── AWS mock environment (must be set before any boto3 import) ──────────────
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SECURITY_TOKEN", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")

# ─── lambda roots ────────────────────────────────────────────────────────────
LAMBDAS_ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "lambdas")


def add_lambda(name: str) -> None:
    """Prepend a lambda directory onto sys.path so its handler is importable."""
    path = os.path.join(LAMBDAS_ROOT, name)
    if path not in sys.path:
        sys.path.insert(0, path)


# ─── Tiny PNG factory ────────────────────────────────────────────────────────

def make_png_bytes(width: int = 4, height: int = 4, colour: str = "red") -> bytes:
    img = Image.new("RGB", (width, height), colour)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_jpeg_bytes() -> bytes:
    img = Image.new("RGB", (4, 4), "blue")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


# ─── Minimal fake OpenAI response ────────────────────────────────────────────

def fake_openai_response(content: str = "", reasoning: str = "") -> MagicMock:
    msg = MagicMock()
    msg.content = content
    msg.model_dump.return_value = {"content": content, "reasoning_content": reasoning}
    choice = MagicMock()
    choice.message = msg
    choice.finish_reason = "stop"
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def fake_models_response(model_id: str = "test-model") -> MagicMock:
    m = MagicMock()
    m.id = model_id
    models = MagicMock()
    models.data = [m]
    return models


# ─── Lambda mock context ─────────────────────────────────────────────────────

class FakeContext:
    function_name = "test-function"
    memory_limit_in_mb = 128
    invoked_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test"
    aws_request_id = "test-request-id"
    log_group_name = "/aws/lambda/test"
    log_stream_name = "test/stream"

    def get_remaining_time_in_millis(self) -> int:
        return 30000


FAKE_CONTEXT = FakeContext()
