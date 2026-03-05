from __future__ import annotations
"""
bedrock_client — Bedrock Custom Model Import inference for Coldbones Lambdas

Provides the same interface as desktop_client but routes inference through
Amazon Bedrock instead of the desktop LM Studio API.

Architecture:
  Browser → API Gateway → Lambda → bedrock_client → Bedrock Runtime API

The imported Qwen2.5-VL model ARN is stored in SSM Parameter Store at
  /coldbones/bedrock-model-arn

Bedrock CMI uses the invoke_model API, NOT the Converse/ConverseStream API,
because imported models require the raw prompt format with a processor-applied
chat template — not the simplified Converse message array.

Module-level ARN cache:
  Same design as desktop_client — the model ARN is cached per Lambda
  container for _CACHE_TTL_S seconds to reduce SSM calls.
"""
import base64
import json
import logging
import os
import time
from typing import Optional, Tuple

import boto3

logger = logging.getLogger(__name__)

_BEDROCK_MODEL_ARN_PARAM = os.environ.get('BEDROCK_MODEL_ARN_PARAM', '/coldbones/bedrock-model-arn')
_BEDROCK_MODEL_ARN_OVERRIDE = os.environ.get('BEDROCK_MODEL_ARN', '')  # Direct override (skip SSM)

_ssm = boto3.client('ssm')
_bedrock_runtime = boto3.client('bedrock-runtime')

# Cache
_cached_model_arn: Optional[str] = None
_cache_time: float = 0.0
_CACHE_TTL_S = 60.0


def get_bedrock_model_arn() -> str:
    """Return the Bedrock imported model ARN.

    Priority:
      1. BEDROCK_MODEL_ARN env-var (direct override, no SSM call)
      2. SSM parameter at /coldbones/bedrock-model-arn
    """
    global _cached_model_arn, _cache_time

    # Direct override — skip SSM entirely
    if _BEDROCK_MODEL_ARN_OVERRIDE:
        return _BEDROCK_MODEL_ARN_OVERRIDE

    if _cached_model_arn and (time.time() - _cache_time) < _CACHE_TTL_S:
        return _cached_model_arn

    try:
        val = _ssm.get_parameter(Name=_BEDROCK_MODEL_ARN_PARAM)['Parameter']['Value']
    except Exception as e:
        raise RuntimeError(
            f'Bedrock model ARN not configured in SSM ({_BEDROCK_MODEL_ARN_PARAM}). '
            f'Run scripts/setup-bedrock-model.sh first. Error: {e}'
        )

    _cached_model_arn = val
    _cache_time = time.time()
    return val


def is_bedrock_available() -> bool:
    """Check whether Bedrock CMI is configured and reachable.

    Unlike desktop health checks (which ping LM Studio), this just verifies
    that the model ARN is configured.  Bedrock itself has 99.9% SLA so we
    don't need to probe it — if the ARN exists, we assume Bedrock is ready.
    """
    try:
        arn = get_bedrock_model_arn()
        return bool(arn)
    except Exception:
        return False


def invoke_bedrock(
    image_data_urls: list[str],
    system_prompt: str,
    analysis_text: str,
    max_tokens: int = 8192,
    temperature: float = 0.6,
) -> dict:
    """Run multimodal inference via Bedrock CMI using the Qwen2.5-VL model.

    Bedrock CMI for Qwen2.5-VL uses the invoke_model API with a raw prompt.
    The model expects the Qwen VL chat template format.

    Returns a dict with the model's raw text response and metadata.
    """
    model_arn = get_bedrock_model_arn()

    # Build the Qwen2.5-VL chat template prompt
    # Format: <|im_start|>system\n{system}\n<|im_end|>\n<|im_start|>user\n{content}<|im_end|>\n<|im_start|>assistant\n
    #
    # For multimodal, images are passed as base64 in the 'images' field of the
    # request body, and referenced in the prompt with <|vision_start|><|image_pad|><|vision_end|>

    # Extract base64 data from data URLs
    images_b64 = []
    for data_url in image_data_urls:
        # data:image/png;base64,<base64data>
        if ';base64,' in data_url:
            images_b64.append(data_url.split(';base64,', 1)[1])

    # Build prompt with image placeholders
    image_tokens = ''.join(
        '<|vision_start|><|image_pad|><|vision_end|>'
        for _ in images_b64
    )

    prompt = (
        f'<|im_start|>system\n{system_prompt}<|im_end|>\n'
        f'<|im_start|>user\n{image_tokens}{analysis_text}<|im_end|>\n'
        f'<|im_start|>assistant\n'
    )

    request_body = {
        'prompt': prompt,
        'temperature': temperature,
        'max_gen_len': max_tokens,
        'top_p': 0.9,
    }

    # Include images if present
    if images_b64:
        request_body['images'] = images_b64

    response = _bedrock_runtime.invoke_model(
        modelId=model_arn,
        body=json.dumps(request_body),
        accept='application/json',
        contentType='application/json',
    )

    response_body = json.loads(response['body'].read().decode('utf-8'))

    # Extract the generated text from the response
    # Bedrock CMI for Qwen returns different response formats:
    if 'choices' in response_body:
        raw_text = response_body['choices'][0].get('text', '')
    elif 'outputs' in response_body:
        raw_text = response_body['outputs'][0].get('text', '')
    elif 'generation' in response_body:
        raw_text = response_body['generation']
    else:
        raw_text = json.dumps(response_body)

    # Clean up: strip the assistant end token if present
    raw_text = raw_text.replace('<|im_end|>', '').strip()

    return {
        'raw_text': raw_text,
        'model_arn': model_arn,
        'provider': 'Bedrock (Qwen2.5-VL)',
        'finish_reason': 'stop',
    }
