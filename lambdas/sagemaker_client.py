"""
Shared SageMaker inference client for all Coldbones Lambda functions.

Calls the SageMaker real-time endpoint that runs
Qwen/Qwen3.5-35B-A3B-AWQ via the DJL LMI / vLLM backend.

The endpoint uses an OpenAI-compatible request/response schema,
identical to the /v1/chat/completions format — so multimodal image_url
content items are passed through transparently.
"""
import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

SAGEMAKER_ENDPOINT = os.environ.get('SAGEMAKER_ENDPOINT', 'coldbones-qwen35')
MODEL_NAME         = os.environ.get('MODEL_NAME', 'Qwen/Qwen3.5-35B-A3B-AWQ')
MAX_TOKENS         = int(os.environ.get('MAX_INFERENCE_TOKENS', 8192))
AWS_REGION         = os.environ.get('AWS_REGION', 'us-east-1')

_runtime: Any = None


def _get_runtime() -> Any:
    global _runtime
    if _runtime is None:
        _runtime = boto3.client('sagemaker-runtime', region_name=AWS_REGION)
    return _runtime


def invoke_model(
    messages: list,
    max_tokens: int = MAX_TOKENS,
    temperature: float = 0.6,
) -> tuple[str, str]:
    """
    Call the SageMaker endpoint and return (content, finish_reason).

    Args:
        messages: OpenAI-format list[dict] with role/content.
                  Content items may include image_url entries for multimodal input.
        max_tokens: Maximum tokens to generate.
        temperature: Sampling temperature.

    Returns:
        (content, finish_reason) tuple.

    Raises:
        RuntimeError: If the endpoint call fails or returns an unexpected response.
    """
    payload = {
        'model': MODEL_NAME,
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'stream': False,
    }

    logger.info(
        'Invoking SageMaker endpoint=%s model=%s messages=%d',
        SAGEMAKER_ENDPOINT, MODEL_NAME, len(messages),
    )

    try:
        runtime = _get_runtime()
        resp = runtime.invoke_endpoint(
            EndpointName=SAGEMAKER_ENDPOINT,
            ContentType='application/json',
            Accept='application/json',
            Body=json.dumps(payload),
        )
    except ClientError as exc:
        raise RuntimeError(
            f'SageMaker endpoint call failed (endpoint={SAGEMAKER_ENDPOINT}): {exc}'
        ) from exc

    raw = resp['Body'].read()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f'SageMaker response is not valid JSON: {raw[:200]}'
        ) from exc

    if 'error' in result:
        raise RuntimeError(f'Model returned an error: {result["error"]}')

    choices = result.get('choices', [])
    if not choices:
        raise RuntimeError(f'No choices in SageMaker response: {result}')

    choice = choices[0]
    content: str = (choice.get('message') or {}).get('content') or ''
    finish_reason: str = choice.get('finish_reason') or 'stop'

    usage = result.get('usage', {})
    logger.info(
        'Inference complete: finish=%s prompt_tokens=%s completion_tokens=%s',
        finish_reason,
        usage.get('prompt_tokens', '?'),
        usage.get('completion_tokens', '?'),
    )

    return content, finish_reason
