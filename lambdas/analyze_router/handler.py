"""
Lambda: analyze-router

Routes POST /api/analyze:
  fast    → checks desktop health; if alive, synchronously invokes
             analyze-orchestrator (which calls desktop vLLM directly).
             Falls back to offline queue if desktop is down.
  offline → writes QUEUED to DynamoDB + enqueues to SQS.
             Desktop worker processes the job when it comes back online.

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
        # Check desktop health before committing to sync path.
        # Falls back to offline queue if the desktop GPU is not reachable.
        if is_desktop_alive():
            return _invoke_sync(payload)
        else:
            print(f'[analyze_router] Desktop offline — routing job={job_id} to offline queue')
            payload['mode'] = 'offline'
            return _enqueue(payload, fallback=True)

    # mode == 'offline' (or anything else)
    return _enqueue(payload)


def _invoke_sync(payload: dict) -> dict:
    if not ORCHESTRATOR_FUNCTION_ARN:
        return _error(500, 'ORCHESTRATOR_FUNCTION_ARN not configured')
    try:
        resp = lambda_client.invoke(
            FunctionName=ORCHESTRATOR_FUNCTION_ARN,
            InvocationType='RequestResponse',
            Payload=json.dumps(payload).encode(),
        )
        result_raw = resp['Payload'].read()
        return json.loads(result_raw)
    except ClientError as e:
        return _error(502, f'Orchestrator invocation failed: {e}')


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
