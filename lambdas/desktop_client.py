from __future__ import annotations
"""
desktop_client  — shared module for Coldbones Lambda functions

Architecture:
  Browser → API Gateway → Lambda → desktop_client → LM Studio (via Tailscale Funnel)

Why Tailscale Funnel instead of a VPC/EC2 endpoint?
  - The model runs on a home RTX 5090, not in AWS.  Opening a home router port
    creates a static attack surface; Tailscale Funnel gives a stable HTTPS URL
    with mutual TLS and lets the desktop IP change freely (DHCP, reboots).
  - Lambdas have outbound internet access by default (no VPC needed), so they
    can reach the public Funnel URL directly.

Endpoint discovery via SSM Parameter Store:
  /coldbones/desktop-url  → full Tailscale Funnel base URL
                            (e.g. https://seratonin.tail40ae2c.ts.net)
  /coldbones/desktop-port → LM Studio port, written to SSM during setup
                            (443 when using Funnel, 1234 for direct LAN use)

  Storing the URL in SSM (not as a Lambda env-var) means you can update the
  Funnel URL or swap the model without redeploying the Lambda code — just
  update the parameter and warm containers will re-read it within 60 s.

Module-level URL cache:
  Each Lambda execution environment ("container") is reused across warm
  invocations.  Reading SSM on every request would add ~10 ms of latency and
  cost extra.  We cache the resolved URL for _CACHE_TTL_S seconds per container.
  The worst-case staleness is one TTL window — acceptable for a home desktop.
"""
import logging
import os
import time
from typing import Optional, Tuple

import boto3
import urllib.request
import urllib.error
from openai import OpenAI

logger = logging.getLogger(__name__)

# Allow SSM parameter paths to be overridden via env-vars so tests can inject
# fake paths without touching real SSM.
_DESKTOP_URL_PARAM    = os.environ.get('DESKTOP_URL_PARAM',    '/coldbones/desktop-url')
_DESKTOP_PORT_PARAM   = os.environ.get('DESKTOP_PORT_PARAM',   '/coldbones/desktop-port')
_DESKTOP_APIKEY_PARAM = os.environ.get('DESKTOP_APIKEY_PARAM', '/coldbones/desktop-apikey')
# Model name is also overridable — useful if you want to swap models without
# redeploying (update SSM and bounce the container by changing env-var).
_MODEL_NAME           = os.environ.get('MODEL_NAME',           'qwen/qwen3.5-35b-a3b')
# Short timeout for the health-check ping — we want a fast decision on whether
# the desktop is reachable, not a long wait.  The actual inference call uses
# a much longer timeout (580 s in the orchestrator).
_HEALTH_TIMEOUT_S     = float(os.environ.get('DESKTOP_HEALTH_TIMEOUT_S', '4'))

_ssm = boto3.client('ssm')

# Module-level cache — re-read SSM at most every _CACHE_TTL_S per Lambda
# container.  Lambda containers are reused across warm invocations so this cuts
# SSM API calls to roughly 1 per minute per container instead of 1 per request.
_cached_base_url: Optional[str] = None
_cached_api_key: Optional[str] = None
_cache_time: float = 0.0
_CACHE_TTL_S = 60.0


def _refresh_cache() -> tuple[str, str]:
    """Read all three desktop SSM params in one pass and update module cache.

    Returns (base_url, api_key).  Raises RuntimeError if any param is missing.
    """
    global _cached_base_url, _cached_api_key, _cache_time
    try:
        url_val  = _ssm.get_parameter(Name=_DESKTOP_URL_PARAM)['Parameter']['Value']
        port_val = _ssm.get_parameter(Name=_DESKTOP_PORT_PARAM)['Parameter']['Value']
        key_val  = _ssm.get_parameter(
            Name=_DESKTOP_APIKEY_PARAM, WithDecryption=True
        )['Parameter']['Value']
    except Exception as e:
        raise RuntimeError(
            f'Desktop SSM params not configured. Run the setup steps in '
            f'worker/SETUP.md. Error: {e}'
        )

    base = url_val.rstrip('/')
    if ':' not in base.split('://', 1)[-1]:
        base = f'{base}:{port_val}'

    _cached_base_url = base
    _cached_api_key  = key_val
    _cache_time      = time.time()
    return base, key_val


def get_desktop_base_url() -> str:
    """Return the Tailscale Funnel base URL for the desktop LM Studio service."""
    global _cached_base_url
    if _cached_base_url and (time.time() - _cache_time) < _CACHE_TTL_S:
        return _cached_base_url
    return _refresh_cache()[0]


def get_desktop_api_key() -> str:
    """Return the LM Studio API key (Bearer token) from SSM."""
    global _cached_api_key
    if _cached_api_key and (time.time() - _cache_time) < _CACHE_TTL_S:
        return _cached_api_key
    return _refresh_cache()[1]


def is_desktop_alive() -> bool:
    """Probe LM Studio's /v1/models endpoint with a short timeout.

    Used by analyze_router to decide whether to attempt synchronous inference
    or fall back to the SQS offline queue.  This must never raise — the router
    treats any exception as "desktop offline".

    We hit /v1/models (not /) because LM Studio always serves it and it returns
    a small JSON payload, making it a reliable liveness check.
    """
    try:
        base    = get_desktop_base_url()
        api_key = get_desktop_api_key()
        req = urllib.request.Request(f'{base}/v1/models', method='GET')
        req.add_header('Authorization', f'Bearer {api_key}')
        with urllib.request.urlopen(req, timeout=_HEALTH_TIMEOUT_S) as resp:
            return resp.status == 200
    except Exception as exc:
        logger.info('Desktop health check failed (LM Studio may be offline): %s', exc)
        return False


def get_openai_client(timeout: float = 120.0) -> Tuple[OpenAI, str]:
    """Return (OpenAI-compatible client pointed at LM Studio, model_name).

    LM Studio exposes an OpenAI-compatible REST API on /v1, so we can reuse
    the official openai SDK without any custom HTTP code.

    The timeout is set generously (580 s in the orchestrator) because large
    multimodal models on a single GPU can take 30–90 s per page of a dense PDF.
    Lambda has a hard ceiling of 10 min, so 580 s leaves a 20 s buffer.
    """
    base    = get_desktop_base_url()
    api_key = get_desktop_api_key()
    client  = OpenAI(
        base_url=f'{base}/v1',
        api_key=api_key,
        timeout=timeout,
    )
    return client, _MODEL_NAME
