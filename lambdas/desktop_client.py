"""
Shared desktop GPU client for all Coldbones Lambda functions.

Resolves the desktop vLLM endpoint from SSM Parameter Store:
  /coldbones/desktop-url   → Tailscale Funnel base URL, e.g.
                             https://seratonin.tail40ae2c.ts.net
  /coldbones/desktop-port  → vLLM port (default 8000)

The desktop exposes vLLM via Tailscale Funnel — no open home-router ports,
TLS handled by Tailscale. Lambdas reach it over the public internet.
"""
import logging
import os
import time
from typing import Tuple

import boto3
import urllib.request
import urllib.error
from openai import OpenAI

logger = logging.getLogger(__name__)

_DESKTOP_URL_PARAM  = os.environ.get('DESKTOP_URL_PARAM',  '/coldbones/desktop-url')
_DESKTOP_PORT_PARAM = os.environ.get('DESKTOP_PORT_PARAM', '/coldbones/desktop-port')
_MODEL_NAME         = os.environ.get('MODEL_NAME',         'Qwen/Qwen3.5-35B-A3B-AWQ')
_HEALTH_TIMEOUT_S   = float(os.environ.get('DESKTOP_HEALTH_TIMEOUT_S', '4'))

_ssm = boto3.client('ssm')

# Module-level cache — re-read SSM at most every 60 s per Lambda container.
_cached_base_url: str | None = None
_cache_time: float = 0.0
_CACHE_TTL_S = 60.0


def get_desktop_base_url() -> str:
    """Return the Tailscale Funnel base URL for the desktop vLLM service."""
    global _cached_base_url, _cache_time
    if _cached_base_url and (time.time() - _cache_time) < _CACHE_TTL_S:
        return _cached_base_url

    try:
        url_val  = _ssm.get_parameter(Name=_DESKTOP_URL_PARAM)['Parameter']['Value']
        port_val = _ssm.get_parameter(Name=_DESKTOP_PORT_PARAM)['Parameter']['Value']
    except Exception as e:
        raise RuntimeError(
            f'Desktop SSM params not configured ({_DESKTOP_URL_PARAM}, '
            f'{_DESKTOP_PORT_PARAM}). Run the setup steps in worker/SETUP.md. '
            f'Error: {e}'
        )

    base = url_val.rstrip('/')
    if ':' not in base.split('://', 1)[-1]:
        base = f'{base}:{port_val}'

    _cached_base_url = base
    _cache_time = time.time()
    return base


def is_desktop_alive() -> bool:
    """
    Return True if the desktop vLLM /health endpoint responds within
    DESKTOP_HEALTH_TIMEOUT_S seconds. Fast-fail path — never raises.
    """
    try:
        base = get_desktop_base_url()
        req = urllib.request.Request(f'{base}/health', method='GET')
        with urllib.request.urlopen(req, timeout=_HEALTH_TIMEOUT_S) as resp:
            return resp.status == 200
    except Exception as exc:
        logger.info('Desktop health check failed (desktop may be offline): %s', exc)
        return False


def get_openai_client(timeout: float = 120.0) -> Tuple[OpenAI, str]:
    """
    Return (OpenAI-compatible client, model_name) pointed at the desktop vLLM.
    Raises RuntimeError if desktop SSM params are not set.
    """
    base = get_desktop_base_url()
    client = OpenAI(
        base_url=f'{base}/v1',
        api_key='coldbones',   # vLLM token-based auth — set api_key in vLLM args if desired
        timeout=timeout,
    )
    return client, _MODEL_NAME
