"""
Lambda: ws-connect

Handles WebSocket $connect route from API Gateway WebSocket API.
Stores the connection ID in DynamoDB, associated with a job ID if provided.

Query string parameter: ?jobId=<uuid>  (optional — if provided, subscribe to that job)

DynamoDB table: coldbones-ws-connections
  PK: connectionId
  GSI: jobId-index on jobId
  TTL: 12 hours (connections expire if client doesn't disconnect cleanly)
"""

import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")

CONNECTIONS_TABLE = os.environ["CONNECTIONS_TABLE"]
CONNECTION_TTL_HOURS = int(os.environ.get("CONNECTION_TTL_HOURS", 12))


def handler(event: dict, _context: Any) -> dict:
    connection_id = event["requestContext"]["connectionId"]
    query_params = event.get("queryStringParameters") or {}
    job_id = query_params.get("jobId", "")

    table = dynamodb.Table(CONNECTIONS_TABLE)
    ttl = int(datetime.now(timezone.utc).timestamp()) + CONNECTION_TTL_HOURS * 3600

    item: dict = {
        "connectionId": connection_id,
        "connectedAt": datetime.now(timezone.utc).isoformat(),
        "expiresAt": ttl,
    }
    if job_id:
        item["jobId"] = job_id

    try:
        table.put_item(Item=item)
        print(f"INFO: WebSocket connected: {connection_id} (jobId={job_id!r})")
        return {"statusCode": 200, "body": "Connected"}
    except ClientError as e:
        print(f"ERROR: Failed to store connection {connection_id}: {e}")
        return {"statusCode": 500, "body": "Connection storage failed"}
