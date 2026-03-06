"""
Lambda: analyze-router

This is the single entry-point for all analysis requests.  It decides HOW the
job will be processed and returns a 202 immediately so the browser isn't
blocked waiting for a long inference run.

Routing logic (cloud-primary -- optimised for low traffic + scale-to-zero):

  provider="auto" (default):
    Cloud-primary.  Routes straight to Bedrock On-Demand (Converse API).
    Pay-per-token, zero cold start, true scale-to-zero.

  provider="local":
    Desktop only.  is_desktop_alive() -> desktop, else SQS queue.

  provider="cloud":
    Bedrock On-Demand (same as auto).

  mode="offline":
    Always enqueue to SQS.

Provider modes:
  - 'auto'  (default): Cloud-primary -- Bedrock On-Demand (pay-per-token)
  - 'local': Desktop only, SQS queue if offline
  - 'cloud': Bedrock On-Demand (same as auto)

Event (API Gateway proxy):
  POST /api/analyze
  Body: { "s3Key": "uploads/...", "lang": "en", "mode": "fast|offline",
                    "provider": "auto|local|cloud", "filename": "photo.jpg" }
"""
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import boto3
from botocore.exceptions import ClientError

sys.path.insert(0, '/var/task')
from desktop_client import is_desktop_alive

lambda_client = boto3.client('lambda')
sqs_client    = boto3.client('sqs')
s3_client     = boto3.client('s3')
dynamodb      = boto3.resource('dynamodb')

ORCHESTRATOR_FUNCTION_ARN = os.environ.get('ORCHESTRATOR_FUNCTION_ARN', '')
ANALYZE_QUEUE_URL          = os.environ.get('ANALYZE_QUEUE_URL', '')
JOBS_TABLE                 = os.environ.get('JOBS_TABLE', '')
UPLOAD_BUCKET              = os.environ.get('UPLOAD_BUCKET', '')
MAX_UPLOAD_BYTES           = int(os.environ.get('MAX_UPLOAD_BYTES', 20 * 1024 * 1024))

_HEADERS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
}


def handler(event: dict, _context: Any) -> dict:
    """Lambda entry point: route analysis requests to the appropriate provider."""
    raw_body = event.get('body') or '{}'
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError:
        return _error(400, 'Invalid JSON body')

    s3_key   = body.get('s3Key', '').strip()
    lang     = body.get('lang', 'en').strip()
    mode     = body.get('mode', 'fast').strip().lower()
    provider = body.get('provider', 'auto').strip().lower()  # auto | local | cloud
    filename = body.get('filename', 'file').strip()

    if not s3_key:
        return _error(400, 'Missing s3Key')

    # Server-side size enforcement (defense-in-depth): reject oversized
    # uploads even if a client bypasses frontend validation.
    size_error = _validate_upload_size(s3_key)
    if size_error:
        return size_error

    job_id = str(uuid.uuid4())
    payload = {
        'jobId':    job_id,
        's3Key':    s3_key,
        'lang':     lang,
        'filename': filename,
        'mode':     mode,
        'provider': 'ondemand',  # default; overridden below
    }

    if mode == 'fast':
        if provider == 'cloud':
            # Bedrock On-Demand (Converse API, pay-per-token)
            payload['provider'] = 'ondemand'
            return _invoke_async(payload, job_id)

        if provider == 'local':
            # User explicitly requested local desktop
            if is_desktop_alive():
                payload['provider'] = 'desktop'
                return _invoke_async(payload, job_id)
            else:
                print(f'[analyze_router] Desktop offline -- routing job={job_id} to offline queue')
                payload['mode'] = 'offline'
                return _enqueue(payload, fallback=True)

        # provider == 'auto' (default): cloud-primary -- Bedrock On-Demand
        # Pay-per-token, zero cold start, true scale-to-zero.
        payload['provider'] = 'ondemand'
        print(f'[analyze_router] Cloud-primary: routing job={job_id} to Bedrock On-Demand')
        return _invoke_async(payload, job_id)

    # mode == 'offline' (or anything else)
    return _enqueue(payload)


def _invoke_async(payload: dict, job_id: str) -> dict:
    """Fire the orchestrator Lambda asynchronously (fire-and-forget) and
    return HTTP 202 + jobId so the browser can start polling.

    Sequence:
      1. Pre-write PROCESSING to DynamoDB.  This ensures that if the browser
         polls before the orchestrator has had time to write its own status
         update, it still gets a sensible response instead of 404.
      2. Call Lambda:Invoke with InvocationType='Event'.  This returns
         immediately (HTTP 202 from the Lambda control plane) without waiting
         for the function to finish.  The orchestrator runs in the background.
      3. Return our own 202 to the browser with the jobId it should poll.

    Why InvocationType='Event' and not 'RequestResponse'?
      'RequestResponse' would block this Lambda until the orchestrator finishes
      (up to 10 min), which would exceed API Gateway\'s 29 s limit on *this*
      function.  'Event' decouples the two Lambdas entirely.
    """
    if not ORCHESTRATOR_FUNCTION_ARN:
        return _error(500, 'ORCHESTRATOR_FUNCTION_ARN not configured')

    now = datetime.now(timezone.utc).isoformat()

    if JOBS_TABLE:
        try:
            dynamodb.Table(JOBS_TABLE).put_item(Item={
                'jobId':     job_id,
                'status':    'PROCESSING',
                'createdAt': now,
                'startedAt': now,
                's3Key':     payload.get('s3Key', ''),
                'filename':  payload.get('filename', ''),
                'lang':      payload.get('lang', 'en'),
                'mode':      'fast',
                'ttl':       int(datetime.now(timezone.utc).timestamp()) + 2592000,  # 30 days
            })
        except Exception as e:
            print(f'[analyze_router] DynamoDB write failed (non-fatal): {e}')

    try:
        lambda_client.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION_ARN,
            InvocationType='Event',
            Payload=json.dumps(payload).encode(),
        )
    except ClientError as e:
        return _error(502, f'Orchestrator invocation failed: {e}')

    return {
        'statusCode': 202,
        'headers': _HEADERS,
        'body': json.dumps({
            'jobId':   job_id,
            'status':  'processing',
            'mode':    'fast',
            'message': 'Analysis started. Poll /api/status/{jobId} for results.',
        }),
    }


def _enqueue(payload: dict, fallback: bool = False) -> dict:
    """Send the job payload to the SQS offline queue and return HTTP 202."""
    if not ANALYZE_QUEUE_URL:
        return _error(500, 'ANALYZE_QUEUE_URL not configured')

    job_id = payload['jobId']
    now    = datetime.now(timezone.utc).isoformat()

    if JOBS_TABLE:
        try:
            dynamodb.Table(JOBS_TABLE).put_item(Item={
                'jobId':     job_id,
                'status':    'QUEUED',
                'createdAt': now,
                's3Key':     payload.get('s3Key', ''),
                'filename':  payload.get('filename', ''),
                'lang':      payload.get('lang', 'en'),
                'mode':      payload.get('mode', 'offline'),
                'ttl':       int(datetime.now(timezone.utc).timestamp()) + 2592000,  # 30 days
            })
        except Exception as e:
            print(f'[analyze_router] DynamoDB write failed (non-fatal): {e}')

    try:
        sqs_client.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps(payload),
        )
        msg = (
            'Desktop GPU offline -- job queued. Will process when desktop comes back online.'
            if fallback
            else 'Job queued for processing. Poll /api/status/{jobId} for results.'
        )
        return {
            'statusCode': 202,
            'headers': _HEADERS,
            'body': json.dumps({
                'jobId':   job_id,
                'status':  'queued',
                'mode':    payload.get('mode', 'offline'),
                'message': msg,
            }),
        }
    except ClientError as e:
        return _error(502, f'SQS enqueue failed: {e}')


def _validate_upload_size(s3_key: str) -> Optional[dict]:
    """Validate S3 object size against MAX_UPLOAD_BYTES.

    Returns an HTTP error dict when validation fails, else None.
    """
    if not UPLOAD_BUCKET:
        # Misconfigured environment: skip size check rather than blocking
        # all traffic. The orchestrator still performs a defensive check.
        return None

    try:
        head = s3_client.head_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
    except ClientError as e:
        code = e.response.get('Error', {}).get('Code', '')
        if code in {'404', 'NoSuchKey', 'NotFound'}:
            return _error(404, f'Upload not found for s3Key: {s3_key}')
        return _error(502, f'Could not validate upload size: {e}')

    size_bytes = int(head.get('ContentLength', 0))
    if size_bytes > MAX_UPLOAD_BYTES:
        size_mb = size_bytes / (1024 * 1024)
        limit_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        return _error(413, f'File exceeds {limit_mb:.0f} MB limit ({size_mb:.1f} MB).')

    return None


def _error(status: int, msg: str) -> dict:
    """Build a JSON error response with the given HTTP status."""
    return {
        'statusCode': status,
        'headers': _HEADERS,
        'body': json.dumps({'detail': msg}),
    }
