"""
Lambda: ws-disconnect

Handles WebSocket $disconnect route.
Removes the connection ID from DynamoDB.
"""

import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
CONNECTIONS_TABLE = os.environ["CONNECTIONS_TABLE"]


def handler(event: dict, _context: Any) -> dict:
    connection_id = event["requestContext"]["connectionId"]
    table = dynamodb.Table(CONNECTIONS_TABLE)
    try:
        table.delete_item(Key={"connectionId": connection_id})
        print(f"INFO: WebSocket disconnected: {connection_id}")
    except ClientError as e:
        print(f"WARNING: Failed to delete connection {connection_id}: {e}")
    return {"statusCode": 200, "body": "Disconnected"}
