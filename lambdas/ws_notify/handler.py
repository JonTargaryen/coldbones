"""
Lambda: ws-notify

Triggered by SNS when a slow-mode job completes.
Looks up all WebSocket connections subscribed to the job's ID,
then pushes the result via API Gateway's postToConnection API.

SNS message format:
  { "jobId": "<uuid>", "status": "complete"|"failed", "result": {...} }

Required environment variables:
  CONNECTIONS_TABLE     — DynamoDB table storing connectionId → jobId mappings
  WS_GATEWAY_URL        — API Gateway WebSocket management API URL
                          e.g. https://<api-id>.execute-api.<region>.amazonaws.com/<stage>
"""

import json
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

CONNECTIONS_TABLE = os.environ["CONNECTIONS_TABLE"]
WS_GATEWAY_URL = os.environ["WS_GATEWAY_URL"]

# Strip trailing slash from WS_GATEWAY_URL
_ws_url = WS_GATEWAY_URL.rstrip("/")
apigw = boto3.client("apigatewaymanagementapi", endpoint_url=_ws_url)


def handler(event: dict, _context: Any) -> dict:
    """Process SNS records and push results to subscribed WebSocket connections."""
    records = event.get("Records") or []
    for record in records:
        if record.get("EventSource") == "aws:sns" or record.get("EventSubscriptionArn"):
            _process_sns_record(record)
    return {"status": "ok"}


def _process_sns_record(record: dict) -> None:
    try:
        sns_body = record.get("Sns", {})
        message_str = sns_body.get("Message", "{}")
        payload: dict = json.loads(message_str)
    except Exception as e:
        print(f"ERROR: Could not parse SNS message: {e}")
        return

    job_id = payload.get("jobId", "")
    if not job_id:
        print("WARNING: SNS message missing jobId")
        return

    print(f"INFO: Notifying WebSocket clients for job {job_id}")

    ws_message = json.dumps({
        "type": "job_complete",
        "jobId": job_id,
        "status": payload.get("status"),
        "result": payload.get("result"),
    })

    # Find all connections subscribed to this jobId
    table = dynamodb.Table(CONNECTIONS_TABLE)
    try:
        resp = table.scan(
            FilterExpression=Attr("jobId").eq(job_id),
            ProjectionExpression="connectionId",
        )
        connections = [item["connectionId"] for item in resp.get("Items", [])]
    except ClientError as e:
        print(f"ERROR: DynamoDB scan failed for job {job_id}: {e}")
        return

    stale_connections: list[str] = []
    for conn_id in connections:
        try:
            apigw.post_to_connection(
                ConnectionId=conn_id,
                Data=ws_message.encode("utf-8"),
            )
            print(f"INFO: Pushed result to connection {conn_id}")
        except apigw.exceptions.GoneException:
            # Client disconnected — clean up the stale entry
            stale_connections.append(conn_id)
        except ClientError as e:
            print(f"WARNING: Could not push to connection {conn_id}: {e}")

    # Clean up stale connections
    if stale_connections:
        for conn_id in stale_connections:
            try:
                table.delete_item(Key={"connectionId": conn_id})
            except Exception:
                pass
        print(f"INFO: Cleaned up {len(stale_connections)} stale connection(s)")

    print(f"INFO: Notified {len(connections) - len(stale_connections)} active connection(s) for job {job_id}")
