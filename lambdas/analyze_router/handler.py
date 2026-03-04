"""
Lambda: analyze-router

Accepts POST /api/analyze requests and enqueues each job for async
processing by the batch-processor Lambda (SageMaker inference).

There is a single processing mode: the job is written to DynamoDB as
QUEUED, sent to SQS, and the caller receives a 202 with the jobId.
The frontend is notified of the completed result via WebSocket (ws_notify)
or by polling GET /api/status/{jobId}.

PDF inputs are handled inside batch_processor (converted to images there).

Event (API Gateway proxy event):
  POST /api/analyze
  Body: { "s3Key": "uploads/…", "lang": "en", "filename": "photo.jpg" }
"""

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

sqs_client = boto3.client('sqs')
dynamodb   = boto3.resource('dynamodb')

ANALYZE_QUEUE_URL = os.environ.get('ANALYZE_QUEUE_URL', '')
JOBS_TABLE        = os.environ.get('JOBS_TABLE', '')

_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
}


def handler(event: dict, _context: Any) -> dict:
    raw_body = event.get('body') or '{}'
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return _error(400, 'Invalid JSON body')

    s3_key   = body.get('s3Key', '').strip()
    lang     = body.get('lang', 'en').strip()
    filename = body.get('filename', 'file').strip()

    if not s3_key:
        return _error(400, 'Missing s3Key')
    if not ANALYZE_QUEUE_URL:
        return _error(500, 'ANALYZE_QUEUE_URL not configured')

    job_id = str(uuid.uuid4())
    now    = datetime.now(timezone.utc).isoformat()

    # Write job record to DynamoDB so status endpoint is immediately
    # queryable while the SQS message is in-flight to batch_processor.
    if JOBS_TABLE:
        try:
            table = dynamodb.Table(JOBS_TABLE)
            table.put_item(Item={
                'jobId':     job_id,
                'status':    'QUEUED',
                'createdAt': now,
                's3Key':     s3_key,
                'filename':  filename,
                'lang':      lang,
                'ttl':       int(datetime.now(timezone.utc).timestamp()) + 86400,
            })
        except Exception as exc:
            print(f'[analyze_router] DynamoDB write failed (non-fatal): {exc}')

    # Enqueue for async batch processing
    payload = {
        'jobId':    job_id,
        's3Key':    s3_key,
        'lang':     lang,
        'filename': filename,
    }
    try:
        sqs_client.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps(payload),
        )
    except ClientError as exc:
        return _error(502, f'SQS enqueue failed: {exc}')

    return {
        'statusCode': 202,
        'headers': _HEADERS,
        'body': json.dumps({
            'jobId':   job_id,
            'status':  'queued',
            'message': 'Job queued. Poll /api/status/{jobId} or subscribe via WebSocket.',
        }),
    }


def _error(status: int, msg: str) -> dict:
    return {
        'statusCode': status,
        'headers': _HEADERS,
        'body': json.dumps({'detail': msg}),
    }


def handler(event: dict, _context: Any) -> dict:
    # Parse body
    raw_body = event.get("body") or "{}"
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return _error(400, "Invalid JSON body")

    s3_key = body.get("s3Key", "").strip()
    lang = body.get("lang", "en").strip()
    mode = body.get("mode", "fast").strip().lower()
    filename = body.get("filename", "file").strip()

    if not s3_key:
        return _error(400, "Missing s3Key")

    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "s3Key": s3_key,
        "lang": lang,
        "filename": filename,
        "mode": mode,
    }

    if mode == "slow":
        return _enqueue(payload)
    else:
        return _invoke_sync(payload)


def _invoke_sync(payload: dict) -> dict:
    if not ORCHESTRATOR_FUNCTION_ARN:
        return _error(500, "ORCHESTRATOR_FUNCTION_ARN not configured")
    try:
        resp = lambda_client.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION_ARN,
            InvocationType="RequestResponse",
            Payload=json.dumps(payload).encode("utf-8"),
        )
        result_raw = resp["Payload"].read()
        result = json.loads(result_raw)
        return result
    except ClientError as e:
        return _error(502, f"Orchestrator invocation failed: {e}")


def _enqueue(payload: dict) -> dict:
    if not ANALYZE_QUEUE_URL:
        return _error(500, "ANALYZE_QUEUE_URL not configured")

    job_id = payload["jobId"]
    now = datetime.now(timezone.utc).isoformat()

    # Write initial QUEUED record so the status poller doesn't get 404s
    # while the SQS message is in-flight to batch_processor.
    if JOBS_TABLE:
        try:
            table = dynamodb.Table(JOBS_TABLE)
            table.put_item(Item={
                "jobId": job_id,
                "status": "QUEUED",
                "createdAt": now,
                "s3Key": payload.get("s3Key", ""),
                "filename": payload.get("filename", ""),
                "lang": payload.get("lang", "en"),
                "ttl": int(datetime.now(timezone.utc).timestamp()) + 86400,
            })
        except Exception as e:
            print(f"[analyze_router] DynamoDB write failed (non-fatal): {e}")

    try:
        sqs_client.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps(payload),
        )
        return {
            "statusCode": 202,
            "body": json.dumps({
                "jobId": job_id,
                "status": "queued",
                "message": "Job queued for processing. Poll /api/status/{jobId} for results.",
            }),
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
        }
    except ClientError as e:
        return _error(502, f"SQS enqueue failed: {e}")


def _error(status: int, msg: str) -> dict:
    return {
        "statusCode": status,
        "body": json.dumps({"detail": msg}),
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
    }
