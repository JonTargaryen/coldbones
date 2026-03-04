"""
Shared GPU client helper for all Coldbones Lambda functions.

Resolves the vLLM endpoint from SSM Parameter Store:
  /coldbones/gpu-ip   → private EC2 IP
  /coldbones/gpu-port → vLLM HTTP port (default 8000)

Returns an OpenAI-compatible client and the resolved GPU base URL.
"""
import logging
import os
import time
from typing import Tuple

import boto3
from openai import OpenAI

logger = logging.getLogger(__name__)

_GPU_IP_PARAM   = os.environ.get('GPU_IP_PARAM',   '/coldbones/gpu-ip')
_GPU_PORT_PARAM = os.environ.get('GPU_PORT_PARAM',  '/coldbones/gpu-port')
_MODEL_NAME     = os.environ.get('MODEL_NAME',      'Qwen/Qwen3.5-35B-A3B-AWQ')
_GPU_ASG_NAME   = os.environ.get('GPU_ASG_NAME',    '')
_GPU_ASG_PARAM  = os.environ.get('GPU_ASG_PARAM',   '/coldbones/gpu-asg-name')

_ssm = boto3.client('ssm')
_asg = boto3.client('autoscaling')

# Module-level cache so cold-starts don't redundantly hit SSM on every request.
_cached_url: str | None = None
_cached_client: OpenAI | None = None
_cache_time: float = 0.0
_CACHE_TTL_S = 60.0  # re-read SSM at most every 60 s


def get_gpu_url() -> str:
    """Return the current vLLM base URL (http://<private-ip>:<port>)."""
    global _cached_url, _cache_time
    if _cached_url and (time.time() - _cache_time) < _CACHE_TTL_S:
        return _cached_url

    try:
        ip_param = _ssm.get_parameter(Name=_GPU_IP_PARAM)['Parameter']['Value']
        port_param = _ssm.get_parameter(Name=_GPU_PORT_PARAM)['Parameter']['Value']
    except Exception as e:
        raise RuntimeError(
            f'GPU not reachable: SSM params {_GPU_IP_PARAM}/{_GPU_PORT_PARAM} not set. '
            f'Is the GPU instance running? Error: {e}'
        )

    if ip_param in ('not-yet-assigned', '', 'None'):
        raise RuntimeError(
            'GPU not yet assigned (SSM GPU_IP_PARAM = "not-yet-assigned"). '
            'The GPU instance has not started or is still booting. '
            'Wait for lifecycle hook to complete, or start the GPU via POST /api/gpu/start.'
        )

    url = f'http://{ip_param}:{port_param}'
    _cached_url = url
    _cache_time = time.time()
    return url


def get_openai_client(timeout: float = 60.0) -> Tuple[OpenAI, str]:
    """Return (OpenAI client, model_name) for the running vLLM instance."""
    global _cached_client
    url = get_gpu_url()
    client = OpenAI(
        base_url=f'{url}/v1',
        api_key='coldbones',   # vLLM does not enforce auth by default
        timeout=timeout,
    )
    return client, _MODEL_NAME


def ensure_gpu_running(wait_seconds: int = 0) -> None:
    """
    Scale the GPU ASG to desired=1 if it is currently at 0.
    Optionally waits up to `wait_seconds` for the GPU IP SSM param to
    show a real IP (useful for fast-mode pre-warm).
    """
    asg_name = _GPU_ASG_NAME
    if not asg_name:
        # Fall back to SSM value
        try:
            asg_name = _ssm.get_parameter(Name=_GPU_ASG_PARAM)['Parameter']['Value']
        except Exception:
            logger.warning('ensure_gpu_running: could not read GPU_ASG_PARAM')
            return

    try:
        resp = _asg.describe_auto_scaling_groups(AutoScalingGroupNames=[asg_name])
        groups = resp.get('AutoScalingGroups', [])
        if not groups:
            logger.warning('ensure_gpu_running: ASG %s not found', asg_name)
            return
        desired = groups[0].get('DesiredCapacity', 0)
        if desired == 0:
            logger.info('ensure_gpu_running: scaling ASG %s to 1', asg_name)
            _asg.update_auto_scaling_group(
                AutoScalingGroupName=asg_name,
                MinSize=0,
                MaxSize=1,
                DesiredCapacity=1,
            )
    except Exception as e:
        logger.warning('ensure_gpu_running: could not scale ASG: %s', e)
        return

    if wait_seconds <= 0:
        return

    # Wait for IP to appear in SSM (polled every 15 s)
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        try:
            ip = _ssm.get_parameter(Name=_GPU_IP_PARAM)['Parameter']['Value']
            if ip not in ('not-yet-assigned', '', 'None'):
                logger.info('ensure_gpu_running: GPU IP ready: %s', ip)
                # Invalidate URL cache
                global _cached_url, _cache_time
                _cached_url = None
                _cache_time = 0.0
                return
        except Exception:
            pass
        logger.info('ensure_gpu_running: waiting for GPU IP…')
        time.sleep(15)

    logger.warning('ensure_gpu_running: timed out waiting for GPU IP after %d s', wait_seconds)


def emit_inference_metric(asg_name: str = '') -> None:
    """Emit a custom CloudWatch metric so the idle-shutdown alarm resets."""
    try:
        cw = boto3.client('cloudwatch')
        name = asg_name or _GPU_ASG_NAME
        cw.put_metric_data(
            Namespace='Coldbones/GPU',
            MetricData=[{
                'MetricName': 'InferenceRequests',
                'Dimensions': [{'Name': 'ASG', 'Value': name}],
                'Value': 1,
                'Unit': 'Count',
            }],
        )
    except Exception as e:
        logger.warning('emit_inference_metric failed: %s', e)
