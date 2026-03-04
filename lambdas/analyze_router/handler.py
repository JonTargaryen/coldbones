"""
Lambda: analyze-router

This is the single entry-point for all analysis requests.  It decides HOW the
job will be processed and returns a 202 immediately so the browser isn't
blocked waiting for a long inference run.

Routing logic:
  ┌─────────────────────────────────────────────────────────────────────┐
  │ POST /api/analyze { mode: "fast" }                                   │
  │   is_desktop_alive() ──yes──→ _invoke_async()  → 202 + jobId        │
  │                    ──no───→ _enqueue(fallback=True) → 202 + jobId   │
  │                                                                       │
  │ POST /api/analyze { mode: "offline" }                                │
  │   always → _enqueue() → 202 + jobId                                  │
  └─────────────────────────────────────────────────────────────────────┘

Why always 202 (not 200)?
  API Gateway has a hard 29 s timeout.  LM Studio inference on a single GPU
  for a multi-page PDF can take 30–90 s, so a synchronous response would always
  time out.  Instead:
    1. This router writes PROCESSING to DynamoDB and fires the orchestrator
       Lambda asynchronously (InvocationType='Event' = fire-and-forget).
    2. It returns 202 + jobId to the browser immediately.
    3. The browser polls GET /api/status/{jobId} every few seconds.
  This pattern is sometimes called the "async polling" or "job ticket" pattern.

Offline / fallback queue path:
  If the desktop is unreachable (LM Studio not running, power off, network
  issue), jobs are written to SQS instead.  The desktop worker (worker/worker.py)
  long-polls SQS and processes the queue whenever it's online.  This means the
  system degrades gracefully rather than failing hard.

Event (API Gateway proxy):
  POST /api/analyze
  Body: { "s3Key": "uploads/…", "lang": "en", "mode": "fast|offline",
          "filename": "photo.jpg" }
"""
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

sys.path.insert(0, '/var/task')
from desktop_client import is_desktop_alive

lambda_client = boto3.client('lambda')
sqs_client    = boto3.client('sqs')
dynamodb      = boto3.resource('dynamodb')

ORCHESTRATOR_FUNCTION_ARN = os.environ.get('ORCHESTRATOR_FUNCTION_ARN', '')
ANALYZE_QUEUE_URL          = os.environ.get('ANALYZE_QUEUE_URL', '')
JOBS_TABLE                 = os.environ.get('JOBS_TABLE', '')

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
    mode     = body.get('mode', 'fast').strip().lower()
    filename = body.get('filename', 'file').strip()

    if not s3_key:
        return _error(400, 'Missing s3Key')

    job_id = str(uuid.uuid4())
    payload = {
        'jobId':    job_id,
        's3Key':    s3_key,
        'lang':     lang,
        'filename': filename,
        'mode':     mode,
    }

    if mode == 'fast':
        # Check desktop health before committing to the async path.
        # Falls back to offline queue if the desktop GPU is not reachable.
        if is_desktop_alive():
            return _invoke_async(payload, job_id)
        else:
            print(f'[analyze_router] Desktop offline — routing job={job_id} to offline queue')
            payload['mode'] = 'offline'
            return _enqueue(payload, fallback=True)

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
      (up to 10 min), which would exceed API Gateway's 29 s limit on *this*
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
                'ttl':       int(datetime.now(timezone.utc).timestamp()) + 86400,
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
                'ttl':       int(datetime.now(timezone.utc).timestamp()) + 86400,
            })
        except Exception as e:
            print(f'[analyze_router] DynamoDB write failed (non-fatal): {e}')

    try:
        sqs_client.send_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MessageBody=json.dumps(payload),
        )
        msg = (
            'Desktop GPU offline — job queued. Will process when desktop comes back online.'
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


def _error(status: int, msg: str) -> dict:
    return {
        'statusCode': status,
        'headers': _HEADERS,
        'body': json.dumps({'detail': msg}),
    }
