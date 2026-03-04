"""
Lambda: lifecycle-manager

Handles ASG lifecycle hooks for the cloud GPU (vLLM) instance.

1. EC2_INSTANCE_LAUNCHING:
   - Waits for vLLM /health endpoint to return 200 (up to 20 min)
   - Writes the instance private IP to SSM /coldbones/gpu-ip
   - Completes lifecycle hook → CONTINUE

2. EC2_INSTANCE_TERMINATING:
   - Waits for in-flight inference to finish (checks active connection count)
   - Clears the SSM GPU IP parameter
   - Completes lifecycle hook → CONTINUE

Triggered by SNS (ASG lifecycle hook target).
"""

import json
import logging
import os
import time
from typing import Any

import boto3
import urllib.request

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

autoscaling = boto3.client('autoscaling')
ec2_client  = boto3.client('ec2')
ssm_client  = boto3.client('ssm')

GPU_PORT              = int(os.environ.get('GPU_PORT', 8000))
HEALTH_CHECK_PATH     = '/health'
HEALTH_TIMEOUT_S      = int(os.environ.get('HEALTH_TIMEOUT_S', 1200))   # 20 min
HEALTH_POLL_S         = int(os.environ.get('HEALTH_POLL_INTERVAL_S', 15))
DRAIN_TIMEOUT_S       = int(os.environ.get('DRAIN_TIMEOUT_S', 300))
GPU_IP_PARAM          = os.environ.get('GPU_IP_PARAM', '/coldbones/gpu-ip')
GPU_PORT_PARAM        = os.environ.get('GPU_PORT_PARAM', '/coldbones/gpu-port')


def handler(event: dict, _context: Any) -> dict:
    # SNS wraps the ASG lifecycle event in event.Records[].Sns.Message
    records = event.get('Records', [event])
    for rec in records:
        detail = rec
        if rec.get('EventSource') == 'aws:sns' or 'Sns' in rec:
            try:
                detail = json.loads(rec['Sns']['Message'])
            except Exception:
                detail = rec

        token      = detail.get('LifecycleActionToken', '')
        hook_name  = detail.get('LifecycleHookName', '')
        asg_name   = detail.get('AutoScalingGroupName', '')
        instance_id = detail.get('EC2InstanceId', '')
        transition  = detail.get('LifecycleTransition', '')

        logger.info('Lifecycle event: %s instance=%s asg=%s', transition, instance_id, asg_name)

        if 'LAUNCHING' in transition:
            _handle_launch(instance_id, asg_name, hook_name, token)
        elif 'TERMINATING' in transition:
            _handle_terminate(instance_id, asg_name, hook_name, token)
        else:
            logger.warning('Unknown lifecycle transition: %s', transition)

    return {'status': 'ok'}


def _handle_launch(instance_id: str, asg_name: str, hook: str, token: str) -> None:
    ip = _get_private_ip(instance_id)
    if not ip:
        logger.error('Could not get private IP for %s → ABANDON', instance_id)
        _complete(asg_name, hook, token, 'ABANDON')
        return

    health_url = f'http://{ip}:{GPU_PORT}{HEALTH_CHECK_PATH}'
    logger.info('Polling vLLM health: %s', health_url)

    deadline = time.time() + HEALTH_TIMEOUT_S
    healthy  = False
    while time.time() < deadline:
        if _health_ok(health_url):
            healthy = True
            break
        time.sleep(HEALTH_POLL_S)

    if not healthy:
        logger.error('vLLM did not become healthy within %d s → CONTINUE (backstop)', HEALTH_TIMEOUT_S)
        _complete(asg_name, hook, token, 'CONTINUE')
        return

    # Write IP to SSM so Lambdas can discover it
    try:
        ssm_client.put_parameter(
            Name=GPU_IP_PARAM,
            Value=ip,
            Type='String',
            Overwrite=True,
        )
        ssm_client.put_parameter(
            Name=GPU_PORT_PARAM,
            Value=str(GPU_PORT),
            Type='String',
            Overwrite=True,
        )
        logger.info('Updated SSM %s = %s', GPU_IP_PARAM, ip)
    except Exception as e:
        logger.error('SSM update failed: %s', e)

    _complete(asg_name, hook, token, 'CONTINUE')
    logger.info('Instance %s is ready and serving vLLM', instance_id)


def _handle_terminate(instance_id: str, asg_name: str, hook: str, token: str) -> None:
    ip = _get_private_ip(instance_id)
    if not ip:
        _complete(asg_name, hook, token, 'CONTINUE')
        return

    metrics_url = f'http://{ip}:{GPU_PORT}/metrics'
    health_url  = f'http://{ip}:{GPU_PORT}{HEALTH_CHECK_PATH}'
    deadline    = time.time() + DRAIN_TIMEOUT_S
    last_active = time.time()

    logger.info('Draining %s (timeout=%ds)', instance_id, DRAIN_TIMEOUT_S)

    while time.time() < deadline:
        if not _health_ok(health_url):
            logger.info('vLLM stopped responding — drain complete')
            break
        if not _has_active_requests(metrics_url):
            if time.time() - last_active > 15:
                logger.info('No active inference requests — drain complete')
                break
        else:
            last_active = time.time()
        time.sleep(5)

    # Clear the GPU IP from SSM
    try:
        ssm_client.put_parameter(
            Name=GPU_IP_PARAM,
            Value='not-yet-assigned',
            Type='String',
            Overwrite=True,
        )
    except Exception:
        pass

    _complete(asg_name, hook, token, 'CONTINUE')


def _health_ok(url: str) -> bool:
    try:
        req = urllib.request.urlopen(url, timeout=5)
        return req.status == 200
    except Exception:
        return False


def _has_active_requests(metrics_url: str) -> bool:
    """Parse vLLM Prometheus metrics for running request slots."""
    try:
        req = urllib.request.urlopen(metrics_url, timeout=5)
        body = req.read().decode('utf-8')
        for line in body.splitlines():
            if 'vllm:num_requests_running' in line and not line.startswith('#'):
                return float(line.split()[-1]) > 0
    except Exception:
        pass
    return False


def _get_private_ip(instance_id: str) -> str | None:
    try:
        resp = ec2_client.describe_instances(InstanceIds=[instance_id])
        res  = resp.get('Reservations', [])
        if res:
            inst = res[0].get('Instances', [])
            if inst:
                return inst[0].get('PrivateIpAddress')
    except Exception as e:
        logger.warning('describe_instances failed for %s: %s', instance_id, e)
    return None


def _complete(asg_name: str, hook: str, token: str, result: str) -> None:
    try:
        autoscaling.complete_lifecycle_action(
            AutoScalingGroupName=asg_name,
            LifecycleHookName=hook,
            LifecycleActionToken=token,
            LifecycleActionResult=result,
        )
        logger.info('Lifecycle completed: %s', result)
    except Exception as e:
        logger.error('complete_lifecycle_action failed: %s', e)


2. EC2_INSTANCE_TERMINATING hook:
   - Checks for in-flight inference requests
   - Waits up to 5 minutes for graceful drain
   - Completes the lifecycle action to allow termination

Triggered by EventBridge → Lambda when the ASG lifecycle event fires.

Event:
  Standard ASG lifecycle hook event from EventBridge (AWS EC2 Auto Scaling event)
"""

import json
import os
import time
from typing import Any

import boto3
import urllib.request
import urllib.error

autoscaling = boto3.client("autoscaling")
ec2 = boto3.client("ec2")

GPU_PORT = int(os.environ.get("GPU_PORT", 8000))
HEALTH_CHECK_PATH = os.environ.get("HEALTH_CHECK_PATH", "/health")
HEALTH_TIMEOUT_S = int(os.environ.get("HEALTH_TIMEOUT_S", 300))  # 5 minutes
HEALTH_POLL_INTERVAL_S = int(os.environ.get("HEALTH_POLL_INTERVAL_S", 10))
DRAIN_TIMEOUT_S = int(os.environ.get("DRAIN_TIMEOUT_S", 300))


def handler(event: dict, _context: Any) -> dict:
    detail = event.get("detail", event)  # EventBridge wraps in 'detail'

    lifecycle_action_token = detail.get("LifecycleActionToken", "")
    lifecycle_hook_name = detail.get("LifecycleHookName", "")
    asg_name = detail.get("AutoScalingGroupName", "")
    instance_id = detail.get("EC2InstanceId", "")
    lifecycle_transition = detail.get("LifecycleTransition", "")

    print(f"INFO: Lifecycle event: {lifecycle_transition} for instance {instance_id} in {asg_name}")

    if "LAUNCHING" in lifecycle_transition:
        return _handle_launch(
            instance_id, asg_name, lifecycle_hook_name, lifecycle_action_token
        )
    elif "TERMINATING" in lifecycle_transition:
        return _handle_termination(
            instance_id, asg_name, lifecycle_hook_name, lifecycle_action_token
        )
    else:
        print(f"WARNING: Unknown lifecycle transition: {lifecycle_transition}")
        return {"status": "unhandled"}


def _handle_launch(
    instance_id: str, asg_name: str, hook_name: str, token: str
) -> dict:
    """Wait for model server to be healthy, then complete the lifecycle hook."""
    ip = _get_instance_private_ip(instance_id)
    if not ip:
        print(f"ERROR: Could not get private IP for instance {instance_id}")
        _complete_lifecycle(asg_name, hook_name, token, "ABANDON")
        return {"status": "abandoned", "reason": "no_ip"}

    health_url = f"http://{ip}:{GPU_PORT}{HEALTH_CHECK_PATH}"
    print(f"INFO: Waiting for model server at {health_url}")

    deadline = time.time() + HEALTH_TIMEOUT_S
    while time.time() < deadline:
        if _health_check(health_url):
            print(f"INFO: Instance {instance_id} is healthy. Completing lifecycle hook.")
            _complete_lifecycle(asg_name, hook_name, token, "CONTINUE")
            return {"status": "healthy", "instanceId": instance_id}
        time.sleep(HEALTH_POLL_INTERVAL_S)

    print(f"ERROR: Instance {instance_id} did not become healthy within {HEALTH_TIMEOUT_S}s")
    _complete_lifecycle(asg_name, hook_name, token, "ABANDON")
    return {"status": "abandoned", "reason": "health_timeout"}


def _handle_termination(
    instance_id: str, asg_name: str, hook_name: str, token: str
) -> dict:
    """
    Allow in-flight requests to complete, then complete the lifecycle hook.
    We poll the model server's /health endpoint — if it start returning 503 or errors,
    it has finished and is shutting down.
    """
    ip = _get_instance_private_ip(instance_id)
    if not ip:
        _complete_lifecycle(asg_name, hook_name, token, "CONTINUE")
        return {"status": "drained", "reason": "no_ip"}

    drain_url = f"http://{ip}:{GPU_PORT}/metrics"  # llama.cpp exposes /metrics
    deadline = time.time() + DRAIN_TIMEOUT_S
    last_active = time.time()

    print(f"INFO: Draining instance {instance_id} (timeout {DRAIN_TIMEOUT_S}s)")

    while time.time() < deadline:
        # If /health returns 503 or fails, the server has stopped accepting new work
        healthy = _health_check(f"http://{ip}:{GPU_PORT}{HEALTH_CHECK_PATH}")
        if not healthy:
            print(f"INFO: Instance {instance_id} drain complete (server stopped responding)")
            break
        # Check if any requests are in-flight by looking at /metrics
        if not _has_active_requests(drain_url):
            if time.time() - last_active > 15:  # 15s with no activity → drain complete
                print(f"INFO: Instance {instance_id} has no active requests")
                break
        else:
            last_active = time.time()
        time.sleep(5)

    _complete_lifecycle(asg_name, hook_name, token, "CONTINUE")
    return {"status": "drained", "instanceId": instance_id}


def _health_check(url: str) -> bool:
    try:
        req = urllib.request.urlopen(url, timeout=5)
        return req.status == 200
    except Exception:
        return False


def _has_active_requests(metrics_url: str) -> bool:
    """
    Parse llama.cpp Prometheus metrics to check for active request slots.
    Returns True if there are requests being processed.
    """
    try:
        req = urllib.request.urlopen(metrics_url, timeout=5)
        body = req.read().decode("utf-8")
        for line in body.splitlines():
            if "requests_processing" in line and not line.startswith("#"):
                value_str = line.split()[-1]
                return float(value_str) > 0
    except Exception:
        pass
    return False


def _get_instance_private_ip(instance_id: str) -> str | None:
    try:
        resp = ec2.describe_instances(InstanceIds=[instance_id])
        reservations = resp.get("Reservations", [])
        if reservations:
            instances = reservations[0].get("Instances", [])
            if instances:
                return instances[0].get("PrivateIpAddress")
    except Exception as e:
        print(f"WARNING: Could not describe instance {instance_id}: {e}")
    return None


def _complete_lifecycle(
    asg_name: str, hook_name: str, token: str, result: str
) -> None:
    try:
        autoscaling.complete_lifecycle_action(
            AutoScalingGroupName=asg_name,
            LifecycleHookName=hook_name,
            LifecycleActionToken=token,
            LifecycleActionResult=result,
        )
        print(f"INFO: Lifecycle action completed: {result}")
    except Exception as e:
        print(f"ERROR: Failed to complete lifecycle action: {e}")
