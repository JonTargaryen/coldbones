"""
Lambda: schedule-manager

Handles scheduled EventBridge rules for overnight GPU (vLLM) management.

Actions (passed via event.action or event.detail.action):

  overnight-shutdown  — Scale GPU ASG to desired=0, max=0 (no new instances).
                        Triggered 04:00 UTC Mon–Fri (11 PM ET).

  morning-warmup      — Restore GPU ASG max=1 so SQS demand can trigger
                        scale-up on the next inference request.
                        Triggered 12:00 UTC Mon–Fri (7 AM ET).

  weekend-shutdown    — Scale GPU ASG to 0 for the full weekend.
                        Triggered Sat 03:00 UTC.

  monday-warmup       — Restore GPU ASG max=1 at start of week.
                        Triggered Mon 12:00 UTC.

ASG name resolved from: GPU_ASG_NAME env var (set by ApiStack) with
fallback to SSM /coldbones/gpu-asg-name.
"""

import os
from datetime import datetime, timezone
from typing import Any

import boto3

autoscaling = boto3.client("autoscaling")
cloudwatch  = boto3.client("cloudwatch")
ssm_client  = boto3.client("ssm")

# Env var set by ApiStack from gpu-stack output; fall back to SSM
_GPU_ASG_NAME_ENV   = os.environ.get("GPU_ASG_NAME", "")
_GPU_ASG_NAME_PARAM = os.environ.get("GPU_ASG_PARAM", "/coldbones/gpu-asg-name")


def _gpu_asg_name() -> str:
    if _GPU_ASG_NAME_ENV:
        return _GPU_ASG_NAME_ENV
    try:
        return ssm_client.get_parameter(Name=_GPU_ASG_NAME_PARAM)["Parameter"]["Value"]
    except Exception as e:
        raise RuntimeError(f"Cannot resolve GPU ASG name from SSM {_GPU_ASG_NAME_PARAM}: {e}") from e


def handler(event: dict, _context: Any) -> dict:
    action = (
        event.get("action")
        or (event.get("detail") or {}).get("action")
        or ""
    )

    print(f"INFO: schedule-manager action={action!r} at {datetime.now(timezone.utc).isoformat()}")

    dispatch = {
        "overnight-shutdown": _overnight_shutdown,
        "morning-warmup":     _morning_warmup,
        "weekend-shutdown":   _weekend_shutdown,
        "monday-warmup":      _monday_warmup,
    }

    fn = dispatch.get(action)
    if fn is None:
        print(f"WARNING: Unknown action: {action!r}")
        return {"status": "skipped", "action": action}

    return fn()


# ── Action handlers ──────────────────────────────────────────────────────────

def _overnight_shutdown() -> dict:
    """04:00 UTC weekdays — shut down GPU, no charges overnight."""
    asg = _gpu_asg_name()
    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=asg,
            MinSize=0,
            MaxSize=0,
            DesiredCapacity=0,
        )
        print(f"INFO: GPU ASG {asg} → 0/0/0 (overnight shutdown)")
        _emit("overnight-shutdown")
        return {"status": "ok", "action": "overnight-shutdown", "asg": asg}
    except Exception as e:
        print(f"ERROR: overnight-shutdown failed: {e}")
        return {"status": "error", "error": str(e)}


def _morning_warmup() -> dict:
    """12:00 UTC weekdays — re-allow GPU scale-up on next request."""
    asg = _gpu_asg_name()
    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=asg,
            MinSize=0,
            MaxSize=1,
            # Don't set DesiredCapacity — let SQS / analyze_router trigger it
        )
        print(f"INFO: GPU ASG {asg} → max=1 (morning warmup ready)")
        _emit("morning-warmup")
        return {"status": "ok", "action": "morning-warmup", "asg": asg}
    except Exception as e:
        print(f"ERROR: morning-warmup failed: {e}")
        return {"status": "error", "error": str(e)}


def _weekend_shutdown() -> dict:
    """Sat 03:00 UTC — shut down for the full weekend."""
    asg = _gpu_asg_name()
    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=asg,
            MinSize=0,
            MaxSize=0,
            DesiredCapacity=0,
        )
        print(f"INFO: GPU ASG {asg} → 0/0/0 (weekend shutdown)")
        _emit("weekend-shutdown")
        return {"status": "ok", "action": "weekend-shutdown", "asg": asg}
    except Exception as e:
        print(f"ERROR: weekend-shutdown failed: {e}")
        return {"status": "error", "error": str(e)}


def _monday_warmup() -> dict:
    """Mon 12:00 UTC — restore GPU availability for the week."""
    asg = _gpu_asg_name()
    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=asg,
            MinSize=0,
            MaxSize=1,
        )
        print(f"INFO: GPU ASG {asg} → max=1 (monday warmup ready)")
        _emit("monday-warmup")
        return {"status": "ok", "action": "monday-warmup", "asg": asg}
    except Exception as e:
        print(f"ERROR: monday-warmup failed: {e}")
        return {"status": "error", "error": str(e)}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _emit(action: str) -> None:
    try:
        cloudwatch.put_metric_data(
            Namespace="Coldbones/Scheduling",
            MetricData=[{
                "MetricName": "ScheduledAction",
                "Dimensions": [{"Name": "Action", "Value": action}],
                "Value": 1,
                "Unit": "Count",
            }],
        )
    except Exception as e:
        print(f"WARNING: CloudWatch metric emit failed: {e}")
