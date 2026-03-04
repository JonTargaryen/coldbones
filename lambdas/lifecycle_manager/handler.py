"""
Lambda: lifecycle-manager

Handles ASG lifecycle hooks for GPU instances:

1. EC2_INSTANCE_LAUNCHING hook:
   - Waits for the model server's /health endpoint to return 200
   - Completes the lifecycle action (CONTINUE) once healthy
   - Abandons if health check doesn't pass within 5 minutes

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
sqs = boto3.client("sqs")

GPU_PORT = int(os.environ.get("GPU_PORT", 8000))
HEALTH_CHECK_PATH = os.environ.get("HEALTH_CHECK_PATH", "/health")
HEALTH_TIMEOUT_S = int(os.environ.get("HEALTH_TIMEOUT_S", 300))  # 5 minutes
HEALTH_POLL_INTERVAL_S = int(os.environ.get("HEALTH_POLL_INTERVAL_S", 10))
DRAIN_TIMEOUT_S = int(os.environ.get("DRAIN_TIMEOUT_S", 300))


def handler(event: dict, _context: Any) -> dict:
    action = event.get("action", "")
    if action:
        return _handle_orchestration_action(event)

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


def _handle_orchestration_action(event: dict) -> dict:
    action = str(event.get("action", "")).upper()

    if action == "DESCRIBE_ASG":
        asg_name = event.get("asgName", "")
        desc = _describe_asg(asg_name)
        return {
            "action": action,
            "asgName": asg_name,
            "desiredCapacity": desc.get("desiredCapacity", 0),
            "instanceIds": desc.get("instanceIds", []),
        }

    if action == "SCALE_UP":
        asg_name = event.get("asgName", "")
        desired_capacity = int(event.get("desiredCapacity", 1))
        _ensure_asg_max(asg_name, desired_capacity)
        autoscaling.set_desired_capacity(
            AutoScalingGroupName=asg_name,
            DesiredCapacity=desired_capacity,
            HonorCooldown=False,
        )
        return {
            "action": action,
            "asgName": asg_name,
            "desiredCapacity": desired_capacity,
            "status": "scaled",
        }

    if action == "HEALTH_CHECK":
        asg_name = event.get("asgName", "")
        healthy = _is_any_instance_healthy(asg_name)
        return {"action": action, "asgName": asg_name, "healthy": healthy}

    if action == "CHECK_QUEUE_AND_SCALE":
        asg_name = event.get("asgName", "")
        queue_url = event.get("queueUrl", "")
        queue_depth = _queue_depth(queue_url) if queue_url else 0

        if queue_depth <= 0:
            autoscaling.set_desired_capacity(
                AutoScalingGroupName=asg_name,
                DesiredCapacity=0,
                HonorCooldown=False,
            )
            status = "scaled_down"
        else:
            status = "kept_warm"

        return {
            "action": action,
            "asgName": asg_name,
            "queueDepth": queue_depth,
            "status": status,
        }

    if action == "HANDLE_INTERRUPTION":
        return {
            "action": action,
            "jobId": event.get("jobId", ""),
            "status": "acknowledged",
        }

    raise ValueError(f"Unsupported action: {action}")


def _describe_asg(asg_name: str) -> dict:
    response = autoscaling.describe_auto_scaling_groups(
        AutoScalingGroupNames=[asg_name],
    )
    groups = response.get("AutoScalingGroups", [])
    if not groups:
        return {"desiredCapacity": 0, "instanceIds": []}

    group = groups[0]
    return {
        "desiredCapacity": int(group.get("DesiredCapacity", 0)),
        "maxSize": int(group.get("MaxSize", 0)),
        "instanceIds": [
            instance.get("InstanceId")
            for instance in group.get("Instances", [])
            if instance.get("InstanceId")
        ],
    }


def _ensure_asg_max(asg_name: str, desired_capacity: int) -> None:
    asg = _describe_asg(asg_name)
    max_size = int(asg.get("maxSize", 0))
    if desired_capacity > max_size:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=asg_name,
            MaxSize=desired_capacity,
        )


def _is_any_instance_healthy(asg_name: str) -> bool:
    asg = _describe_asg(asg_name)
    instance_ids: list[str] = asg.get("instanceIds", [])
    if not instance_ids:
        return False

    response = ec2.describe_instances(InstanceIds=instance_ids)
    reservations = response.get("Reservations", [])
    for reservation in reservations:
        for instance in reservation.get("Instances", []):
            ip = instance.get("PrivateIpAddress")
            state = (instance.get("State") or {}).get("Name")
            if not ip or state != "running":
                continue
            health_url = f"http://{ip}:{GPU_PORT}{HEALTH_CHECK_PATH}"
            if _health_check(health_url):
                return True
    return False


def _queue_depth(queue_url: str) -> int:
    response = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    )
    attrs = response.get("Attributes", {})
    visible = int(attrs.get("ApproximateNumberOfMessages", 0))
    in_flight = int(attrs.get("ApproximateNumberOfMessagesNotVisible", 0))
    return visible + in_flight


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
