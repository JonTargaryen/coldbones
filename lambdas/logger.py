"""
Centralized structured logging for ColdBones Lambdas.

Provides a `get_logger` factory that creates loggers with consistent
structured JSON output, correlation IDs (jobId), and timing helpers.

Usage:
    from logger import get_logger

    log = get_logger('analyze_orchestrator')
    log.set_job_id('abc-123')
    log.info('Starting inference', provider='ondemand', model='qwen3-vl')
    log.error('Inference failed', error=str(e), elapsed_ms=450)

    with log.timed('s3_download'):
        obj = s3.get_object(...)
    # automatically logs: { "event": "s3_download", "elapsed_ms": 123 }

All log lines are JSON for easy CloudWatch Logs Insights queries:

    fields @timestamp, event, job_id, elapsed_ms
    | filter service = 'coldbones' and level = 'ERROR'
    | sort @timestamp desc
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Generator


class StructuredLogger:
    """Structured JSON logger with correlation ID and timing support."""

    def __init__(self, name: str, level: int = logging.INFO) -> None:
        self._name = name
        self._service = os.environ.get('POWERTOOLS_SERVICE_NAME', 'coldbones')
        self._job_id: str = 'unknown'
        self._extra: dict[str, Any] = {}

        # Use a standard Python logger as the backend
        self._logger = logging.getLogger(f'coldbones.{name}')
        self._logger.setLevel(level)

        # Avoid duplicate handlers on Lambda warm starts
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(logging.Formatter('%(message)s'))
            self._logger.addHandler(handler)
            self._logger.propagate = False

    def set_job_id(self, job_id: str) -> None:
        """Set the correlation ID for all subsequent log entries."""
        self._job_id = job_id

    def set_extra(self, **kwargs: Any) -> None:
        """Set persistent extra fields that appear on every log line."""
        self._extra.update(kwargs)

    def _emit(self, level: str, event: str, **kwargs: Any) -> None:
        """Emit a structured JSON log line."""
        record = {
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'level': level,
            'service': self._service,
            'function': self._name,
            'job_id': self._job_id,
            'event': event,
            **self._extra,
            **kwargs,
        }
        # Remove None values for cleaner output
        record = {k: v for k, v in record.items() if v is not None}
        line = json.dumps(record, default=str, ensure_ascii=False)

        if level == 'ERROR':
            self._logger.error(line)
        elif level == 'WARNING':
            self._logger.warning(line)
        elif level == 'DEBUG':
            self._logger.debug(line)
        else:
            self._logger.info(line)

    def info(self, event: str, **kwargs: Any) -> None:
        self._emit('INFO', event, **kwargs)

    def warning(self, event: str, **kwargs: Any) -> None:
        self._emit('WARNING', event, **kwargs)

    def error(self, event: str, **kwargs: Any) -> None:
        self._emit('ERROR', event, **kwargs)

    def debug(self, event: str, **kwargs: Any) -> None:
        self._emit('DEBUG', event, **kwargs)

    def exception(self, event: str, exc: Exception | None = None, **kwargs: Any) -> None:
        """Log an error with full traceback."""
        tb = traceback.format_exc() if exc else None
        self._emit('ERROR', event, error=str(exc) if exc else None, traceback=tb, **kwargs)

    @contextmanager
    def timed(self, event: str, **kwargs: Any) -> Generator[dict[str, Any], None, None]:
        """Context manager that logs elapsed time on exit.

        Usage:
            with log.timed('inference', provider='ondemand') as ctx:
                result = invoke_ondemand(...)
                ctx['tokens'] = result['usage']['output_tokens']
            # logs: { "event": "inference", "elapsed_ms": 2345, "tokens": 512 }
        """
        ctx: dict[str, Any] = {}
        start = time.monotonic()
        try:
            yield ctx
        except Exception as e:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            self.exception(f'{event}_failed', exc=e, elapsed_ms=elapsed_ms, **kwargs, **ctx)
            raise
        else:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            self.info(event, elapsed_ms=elapsed_ms, **kwargs, **ctx)


def get_logger(name: str, level: int = logging.INFO) -> StructuredLogger:
    """Factory: create a StructuredLogger for the given Lambda/module name."""
    return StructuredLogger(name, level)
