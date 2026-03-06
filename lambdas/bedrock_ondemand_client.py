from __future__ import annotations
"""
bedrock_ondemand_client — Bedrock On-Demand inference for Coldbones Lambdas

Uses the Bedrock **Converse API** (not invoke_model) which provides a unified
interface across all foundation models — Claude, Nova, Llama, Qwen, Gemma,
Mistral, etc.  No model-specific prompt templates needed.

Architecture:
  Browser → API Gateway → Lambda → bedrock_ondemand_client → Bedrock Converse API

Billing:
  Pure pay-per-token.  No provisioned capacity, no 5-minute billing windows.
  $0 when idle — true scale-to-zero.

Model selection:
  Controlled by the BEDROCK_ONDEMAND_MODEL_ID environment variable.  Defaults
  to Qwen3 VL 235B A22B — a state-of-the-art vision-language MoE model
  (235B total parameters, 22B active) with native chain-of-thought reasoning.

  To switch models, just change the env-var (no code changes):
    - qwen.qwen3-vl-235b-a22b        Qwen3 VL 235B     (default, MoE reasoning)
    - us.amazon.nova-lite-v1:0        Nova Lite         ($0.06/$0.24)
    - us.amazon.nova-pro-v1:0         Nova Pro          ($0.80/$3.20)
    - us.amazon.nova-premier-v1:0     Nova Premier      ($2.00/$8.00)
    - us.anthropic.claude-haiku-4-5-20251001-v1:0   Claude Haiku 4.5 ($1/$5)
    - us.anthropic.claude-sonnet-4-6  Claude Sonnet 4.6 ($3/$15)
    - us.anthropic.claude-opus-4-6-v1 Claude Opus 4.6   ($5/$25)
    - us.meta.llama4-scout-17b-instruct-v1:0  Llama 4 Scout
    - google.gemma-3-27b-it           Gemma 3 27B
    - mistral.mistral-large-3-675b-instruct  Mistral Large 3

  Both ON_DEMAND model IDs and INFERENCE_PROFILE IDs work with the Converse
  API — just pass them as the modelId parameter.

Converse API notes:
    The Converse API abstracts model-specific prompt templates away — you send
    structured messages with role/content arrays and Bedrock handles tokenization.
    This is the recommended approach for new integrations.
"""
import base64
import json
import logging
import os
import time
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from logger import get_logger

logger = get_logger('bedrock_ondemand')

# Retry config for transient Bedrock errors
MAX_RETRIES = 3
RETRY_BASE_DELAY = 1.0  # seconds, doubled each retry
RETRYABLE_ERROR_CODES = {
    'ThrottlingException',
    'ServiceUnavailableException',
    'ModelTimeoutException',
    'InternalServerException',
}

# Default: Qwen3 VL 235B A22B — MoE vision-language model with native CoT reasoning
# Override via env-var to use any supported model (see docstring for options)
_MODEL_ID = os.environ.get(
    'BEDROCK_ONDEMAND_MODEL_ID',
    'qwen.qwen3-vl-235b-a22b',
)

_bedrock_runtime = boto3.client('bedrock-runtime')


def get_ondemand_model_id() -> str:
    """Return the configured on-demand model ID."""
    return _MODEL_ID


def is_ondemand_available() -> bool:
    """On-demand is always available — no imported model ARN to check.

    Bedrock foundation models have a 99.9% SLA.  If the model ID is set,
    we assume it's ready.  Actual errors (quotas, model deprecation) will
    surface at invoke time and be handled by the orchestrator's try/except.
    """
    return bool(_MODEL_ID)


def invoke_ondemand(
    image_data_urls: list[str],
    system_prompt: str,
    analysis_text: str,
    max_tokens: int = 8192,
    temperature: float = 0.6,
) -> dict:
    """Run multimodal inference via Bedrock On-Demand using the Converse API.

    The Converse API accepts a standard messages array with content blocks.
    Image data is passed as base64 bytes with a media type — Bedrock handles
    the model-specific formatting internally.

    Args:
        image_data_urls: List of data URLs (data:image/png;base64,<data>)
        system_prompt: System instruction text
        analysis_text: User analysis instruction text
        max_tokens: Maximum output tokens
        temperature: Sampling temperature

    Returns:
        Dict with raw_text, model_id, provider, finish_reason, and usage stats.
    """
    model_id = get_ondemand_model_id()

    # Build content blocks for the user message: images first, then text
    content_blocks: list[dict] = []

    for data_url in image_data_urls:
        # Parse data URL: data:image/png;base64,<base64data>
        if ';base64,' in data_url:
            header, b64_data = data_url.split(';base64,', 1)
            # Extract media type from "data:image/png"
            media_type = header.replace('data:', '') if header.startswith('data:') else 'image/png'

            content_blocks.append({
                'image': {
                    'format': _media_type_to_format(media_type),
                    'source': {
                        'bytes': base64.b64decode(b64_data),
                    },
                },
            })

    # Add the analysis instruction as text
    content_blocks.append({
        'text': analysis_text,
    })

    # Build the Converse API request
    messages = [
        {
            'role': 'user',
            'content': content_blocks,
        },
    ]

    converse_params: dict = {
        'modelId': model_id,
        'messages': messages,
        'system': [{'text': system_prompt}],
        'inferenceConfig': {
            'maxTokens': max_tokens,
            'temperature': temperature,
            'topP': 0.9,
        },
    }

    logger.info('bedrock_converse_request', model=model_id, image_count=len(image_data_urls))

    # Retry loop for transient Bedrock errors
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = _bedrock_runtime.converse(**converse_params)
            break
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            if error_code in RETRYABLE_ERROR_CODES and attempt < MAX_RETRIES:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.warning('bedrock_retry', attempt=attempt, error_code=error_code,
                               delay_s=delay, error=str(e))
                time.sleep(delay)
                last_error = e
                continue
            logger.error('bedrock_converse_failed', attempt=attempt, error_code=error_code,
                         error=str(e))
            raise
        except Exception as e:
            logger.error('bedrock_converse_unexpected_error', attempt=attempt, error=str(e))
            raise
    else:
        raise last_error  # type: ignore[misc]

    # Extract response
    output = response.get('output', {})
    message = output.get('message', {})
    content = message.get('content', [])

    # The response content is a list of blocks — extract all text blocks
    raw_text = '\n'.join(
        block['text'] for block in content if 'text' in block
    ).strip()

    # Usage stats (for cost tracking)
    usage = response.get('usage', {})
    stop_reason = response.get('stopReason', 'end_turn')

    return {
        'raw_text': raw_text,
        'model_id': model_id,
        'provider': f'Bedrock On-Demand ({model_id})',
        'finish_reason': stop_reason,
        'usage': {
            'input_tokens': usage.get('inputTokens', 0),
            'output_tokens': usage.get('outputTokens', 0),
        },
    }


def _media_type_to_format(media_type: str) -> str:
    """Convert MIME type to Bedrock image format string.

    Bedrock Converse API expects format as one of:
    'png', 'jpeg', 'gif', 'webp'
    """
    mapping = {
        'image/png': 'png',
        'image/jpeg': 'jpeg',
        'image/jpg': 'jpeg',
        'image/gif': 'gif',
        'image/webp': 'webp',
    }
    return mapping.get(media_type, 'png')


def invoke_ondemand_streaming(
    image_data_urls: list[str],
    system_prompt: str,
    analysis_text: str,
    on_chunk: 'Callable[[str, str], None]',
    max_tokens: int = 8192,
    temperature: float = 0.6,
) -> dict:
    """Stream multimodal inference via Bedrock Converse Stream API.

    Yields tokens to the on_chunk callback as they arrive.  The callback
    receives (delta_text, accumulated_text) so callers can periodically
    persist partial results.

    Returns the same dict shape as invoke_ondemand() once the stream
    completes.
    """
    from typing import Callable  # noqa: F811

    model_id = get_ondemand_model_id()

    # Build content blocks — same as non-streaming
    content_blocks: list[dict] = []
    for data_url in image_data_urls:
        if ';base64,' in data_url:
            header, b64_data = data_url.split(';base64,', 1)
            media_type = header.replace('data:', '') if header.startswith('data:') else 'image/png'
            content_blocks.append({
                'image': {
                    'format': _media_type_to_format(media_type),
                    'source': {'bytes': base64.b64decode(b64_data)},
                },
            })
    content_blocks.append({'text': analysis_text})

    converse_params: dict = {
        'modelId': model_id,
        'messages': [{'role': 'user', 'content': content_blocks}],
        'system': [{'text': system_prompt}],
        'inferenceConfig': {
            'maxTokens': max_tokens,
            'temperature': temperature,
            'topP': 0.9,
        },
    }

    logger.info('bedrock_converse_stream_request', model=model_id, image_count=len(image_data_urls))

    last_error: Exception | None = None
    response = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = _bedrock_runtime.converse_stream(**converse_params)
            break
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', '')
            if error_code in RETRYABLE_ERROR_CODES and attempt < MAX_RETRIES:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.warning('bedrock_stream_retry', attempt=attempt, error_code=error_code,
                               delay_s=delay)
                time.sleep(delay)
                last_error = e
                continue
            raise
        except Exception:
            raise
    else:
        raise last_error  # type: ignore[misc]

    # Consume the stream
    accumulated = []
    usage = {}
    stop_reason = 'end_turn'

    stream = response.get('stream', [])
    for event in stream:
        if 'contentBlockDelta' in event:
            delta = event['contentBlockDelta'].get('delta', {})
            text = delta.get('text', '')
            if text:
                accumulated.append(text)
                on_chunk(text, ''.join(accumulated))
        elif 'metadata' in event:
            meta = event['metadata']
            usage = meta.get('usage', {})
        elif 'messageStop' in event:
            stop_reason = event['messageStop'].get('stopReason', 'end_turn')

    raw_text = ''.join(accumulated).strip()

    return {
        'raw_text': raw_text,
        'model_id': model_id,
        'provider': f'Bedrock On-Demand ({model_id})',
        'finish_reason': stop_reason,
        'usage': {
            'input_tokens': usage.get('inputTokens', 0),
            'output_tokens': usage.get('outputTokens', 0),
        },
    }
