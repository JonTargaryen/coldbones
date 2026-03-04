"""
Lambda: schedule-manager

Handles scheduled EventBridge rules for overnight GPU management:

- overnight-shutdown (11 PM daily):
    Sets slow-mode ASG max=0, desired=0 to prevent overnight GPU charges.
    Optionally sets fast-mode ASG desired=0, min=0 on weekends.

- morning-warmup (7 AM daily):
    Restores slow-mode ASG max=1 to allow SQS-triggered scaling.
    Optionally restores fast-mode ASG on Monday.

- weekend-fast-shutdown (Friday 11 PM, optional):
    Sets fast-mode ASG min=0, desired=0 to save ~28% monthly.

- weekend-fast-warmup (Monday 7 AM, optional):
    Restores fast-mode ASG min=1, desired=1.

EventBridge event:
  { "action": "overnight-shutdown" | "morning-warmup" |
               "weekend-fast-shutdown" | "weekend-fast-warmup" }
"""

import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3

autoscaling = boto3.client("autoscaling")
cloudwatch = boto3.client("cloudwatch")

SLOW_ASG_NAME = os.environ["SLOW_ASG_NAME"]
FAST_ASG_NAME = os.environ.get("FAST_ASG_NAME", "")
ENABLE_WEEKEND_FAST_SHUTDOWN = os.environ.get("ENABLE_WEEKEND_FAST_SHUTDOWN", "false").lower() == "true"


def handler(event: dict, _context: Any) -> dict:
    action = event.get("action", "") or (event.get("detail", {}) or {}).get("action", "")

    print(f"INFO: schedule-manager action={action!r} at {datetime.now(timezone.utc).isoformat()}")

    if action == "overnight-shutdown":
        return _overnight_shutdown()
    elif action == "morning-warmup":
        return _morning_warmup()
    elif action == "weekend-fast-shutdown" and ENABLE_WEEKEND_FAST_SHUTDOWN:
        return _weekend_fast_shutdown()
    elif action == "weekend-fast-warmup" and ENABLE_WEEKEND_FAST_SHUTDOWN:
        return _weekend_fast_warmup()
    else:
        print(f"WARNING: Unknown or disabled action: {action!r}")
        return {"status": "skipped", "action": action}


def _overnight_shutdown() -> dict:
    """11 PM daily — scale slow ASG to 0, optionally fast ASG on weekends."""
    results = {}

    # Slow ASG: scale to zero for overnight
    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=SLOW_ASG_NAME,
            MinSize=0,
            MaxSize=0,
            DesiredCapacity=0,
        )
        print(f"INFO: Slow ASG {SLOW_ASG_NAME} scaled to 0/0/0 (overnight shutdown)")
        results["slow_asg"] = "scaled_to_zero"
    except Exception as e:
        print(f"ERROR: Failed to scale slow ASG: {e}")
        results["slow_asg"] = f"error: {e}"

    _emit_metric("ScheduledAction", "overnight-shutdown")
    return {"status": "ok", "action": "overnight-shutdown", "results": results}


def _morning_warmup() -> dict:
    """7 AM daily — restore slow ASG max=1 to allow SQS-triggered scaling."""
    results = {}

    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=SLOW_ASG_NAME,
            MinSize=0,
            MaxSize=1,
            # Do NOT set DesiredCapacity — let CloudWatch alarm drive it
        )
        print(f"INFO: Slow ASG {SLOW_ASG_NAME} max restored to 1 (morning warmup)")
        results["slow_asg"] = "max_restored"
    except Exception as e:
        print(f"ERROR: Failed to restore slow ASG: {e}")
        results["slow_asg"] = f"error: {e}"

    _emit_metric("ScheduledAction", "morning-warmup")
    return {"status": "ok", "action": "morning-warmup", "results": results}


def _weekend_fast_shutdown() -> dict:
    """Friday 11 PM — scale fast-mode ASG to 0 for the weekend."""
    if not FAST_ASG_NAME:
        return {"status": "skipped", "reason": "FAST_ASG_NAME not configured"}

    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=FAST_ASG_NAME,
            MinSize=0,
            MaxSize=0,
            DesiredCapacity=0,
        )
        print(f"INFO: Fast ASG {FAST_ASG_NAME} scaled to 0 for weekend")
        _emit_metric("ScheduledAction", "weekend-fast-shutdown")
        return {"status": "ok", "action": "weekend-fast-shutdown"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _weekend_fast_warmup() -> dict:
    """Monday 7 AM — restore fast-mode ASG min=1, desired=1."""
    if not FAST_ASG_NAME:
        return {"status": "skipped", "reason": "FAST_ASG_NAME not configured"}

    try:
        autoscaling.update_auto_scaling_group(
            AutoScalingGroupName=FAST_ASG_NAME,
            MinSize=1,
            MaxSize=1,
            DesiredCapacity=1,
        )
        print(f"INFO: Fast ASG {FAST_ASG_NAME} restored to 1/1/1 for the week")
        _emit_metric("ScheduledAction", "weekend-fast-warmup")
        return {"status": "ok", "action": "weekend-fast-warmup"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def _emit_metric(metric_name: str, action: str) -> None:
    try:
        cloudwatch.put_metric_data(
            Namespace="Coldbones/Scheduling",
            MetricData=[{
                "MetricName": metric_name,
                "Dimensions": [{"Name": "Action", "Value": action}],
                "Value": 1,
                "Unit": "Count",
            }],
        )
    except Exception as e:
        print(f"WARNING: CloudWatch metric emit failed: {e}")
