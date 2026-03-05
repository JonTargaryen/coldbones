"""
Tests for lambdas/logger.py — structured JSON logger with timing.

Covers:
  - Logger creation and configuration
  - Structured log output (JSON format)
  - All log levels (info, warning, error, debug, exception)
  - Job ID correlation
  - Extra fields
  - Timed context manager (success + failure paths)
"""
from __future__ import annotations

import json
import logging
import os
import sys
from unittest.mock import patch

import pytest

# Ensure lambdas root is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "lambdas"))

from logger import get_logger, StructuredLogger


class TestGetLogger:
    def test_returns_structured_logger(self):
        log = get_logger("test_module")
        assert isinstance(log, StructuredLogger)

    def test_custom_level(self):
        log = get_logger("test_debug", level=logging.DEBUG)
        assert log._logger.level == logging.DEBUG

    def test_default_level_is_info(self):
        log = get_logger("test_info")
        assert log._logger.level == logging.INFO


class TestStructuredLoggerInit:
    def test_default_service_name(self):
        log = StructuredLogger("test")
        assert log._service == "coldbones"

    def test_custom_service_from_env(self):
        with patch.dict(os.environ, {"POWERTOOLS_SERVICE_NAME": "my-service"}):
            log = StructuredLogger("test")
        assert log._service == "my-service"

    def test_default_job_id_is_unknown(self):
        log = StructuredLogger("test")
        assert log._job_id == "unknown"


class TestSetJobId:
    def test_sets_job_id(self):
        log = StructuredLogger("test")
        log.set_job_id("abc-123")
        assert log._job_id == "abc-123"


class TestSetExtra:
    def test_adds_extra_fields(self):
        log = StructuredLogger("test")
        log.set_extra(provider="ondemand", region="us-east-1")
        assert log._extra["provider"] == "ondemand"
        assert log._extra["region"] == "us-east-1"


class TestEmit:
    def test_info_emits_json(self, capfd):
        log = get_logger("test_emit")
        log.set_job_id("job-001")
        log.info("test_event", key="value")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["event"] == "test_event"
        assert record["level"] == "INFO"
        assert record["job_id"] == "job-001"
        assert record["key"] == "value"
        assert "timestamp" in record

    def test_warning_emits(self, capfd):
        log = get_logger("test_warn")
        log.warning("warn_event")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["level"] == "WARNING"

    def test_error_emits(self, capfd):
        log = get_logger("test_err")
        log.error("err_event")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["level"] == "ERROR"

    def test_debug_emits(self, capfd):
        log = get_logger("test_dbg", level=logging.DEBUG)
        log.debug("dbg_event")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["level"] == "DEBUG"

    def test_none_values_excluded(self, capfd):
        log = get_logger("test_none")
        log.info("evt", foo=None, bar="baz")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert "foo" not in record
        assert record["bar"] == "baz"

    def test_extra_fields_appear(self, capfd):
        log = get_logger("test_extra")
        log.set_extra(provider="desktop")
        log.info("evt")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["provider"] == "desktop"


class TestException:
    def test_exception_includes_traceback(self, capfd):
        log = get_logger("test_exc")
        try:
            raise ValueError("boom")
        except ValueError as e:
            log.exception("fail", exc=e, extra_info="ctx")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["level"] == "ERROR"
        assert "boom" in record["error"]
        assert record["extra_info"] == "ctx"

    def test_exception_without_exc(self, capfd):
        log = get_logger("test_exc_none")
        log.exception("fail_no_exc")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["level"] == "ERROR"


class TestTimed:
    def test_timed_logs_elapsed(self, capfd):
        log = get_logger("test_timed")
        with log.timed("operation", key="val"):
            pass
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["event"] == "operation"
        assert "elapsed_ms" in record
        assert record["elapsed_ms"] >= 0
        assert record["key"] == "val"

    def test_timed_context_dict(self, capfd):
        log = get_logger("test_timed_ctx")
        with log.timed("op") as ctx:
            ctx["tokens"] = 512
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["tokens"] == 512

    def test_timed_on_exception(self, capfd):
        log = get_logger("test_timed_fail")
        with pytest.raises(RuntimeError):
            with log.timed("failing_op"):
                raise RuntimeError("oops")
        out = capfd.readouterr().out
        record = json.loads(out.strip())
        assert record["event"] == "failing_op_failed"
        assert "elapsed_ms" in record
        assert "oops" in record.get("error", "")
