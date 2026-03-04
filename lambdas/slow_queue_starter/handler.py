"""
Lambda: slow-queue-starter

SQS consumer that starts one Step Functions execution per queued slow-mode job.
This keeps SQS as the ingestion buffer while Step Functions owns orchestration.

SQS message body (from analyze-router):
  { "jobId": "<uuid>", "s3Key": "uploads/...", "lang": "en", "filename": "foo.jpg" }
"""

import json
import os
import re
from typing import Any

import boto3
from botocore.exceptions import ClientError

sfn = boto3.client("stepfunctions")

STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]
UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
ANALYZE_QUEUE_URL = os.environ["ANALYZE_QUEUE_URL"]
SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]
SLOW_ASG_NAME = os.environ["SLOW_ASG_NAME"]
LIFECYCLE_FUNCTION_ARN = os.environ["LIFECYCLE_FUNCTION_ARN"]
BATCH_PROCESSOR_FUNCTION_ARN = os.environ["BATCH_PROCESSOR_FUNCTION_ARN"]


def handler(event: dict, _context: Any) -> dict:
    records = event.get("Records") or []
    failures: list[dict] = []

    for record in records:
        message_id = record.get("messageId", "")
        receipt_id = message_id or record.get("receiptHandle", "unknown")

        try:
            body = json.loads(record.get("body") or record.get("Body") or "{}")
            job_id = body["jobId"]
            s3_key = body["s3Key"]
            lang = body.get("lang", "en")
            filename = body.get("filename", "")

            execution_name = _build_execution_name(job_id, message_id)
            execution_input = {
                "jobId": job_id,
                "s3Key": s3_key,
                "lang": lang,
                "filename": filename,
                "bucket": UPLOAD_BUCKET,
                "queueUrl": ANALYZE_QUEUE_URL,
                "topicArn": SNS_TOPIC_ARN,
                "slowAsgName": SLOW_ASG_NAME,
                "lifecycleFunctionArn": LIFECYCLE_FUNCTION_ARN,
                "batchProcessorFunctionArn": BATCH_PROCESSOR_FUNCTION_ARN,
                "retryCount": 0,
                "healthRetries": 0,
            }

            sfn.start_execution(
                stateMachineArn=STATE_MACHINE_ARN,
                name=execution_name,
                input=json.dumps(execution_input),
            )

        except KeyError as e:
            print(f"ERROR: Missing required message field: {e}; messageId={message_id}")
            failures.append({"itemIdentifier": receipt_id})
        except sfn.exceptions.ExecutionAlreadyExists:
            # Idempotent handling for SQS retries with same messageId
            print(f"INFO: Execution already exists for messageId={message_id}; treating as success")
        except ClientError as e:
            print(f"ERROR: Failed to start Step Functions execution for messageId={message_id}: {e}")
            failures.append({"itemIdentifier": receipt_id})
        except Exception as e:
            print(f"ERROR: Unexpected failure for messageId={message_id}: {e}")
            failures.append({"itemIdentifier": receipt_id})

    # Enables partial-batch failure handling on SQS event source mapping.
    return {"batchItemFailures": failures}


def _build_execution_name(job_id: str, message_id: str) -> str:
    raw_name = f"{job_id}-{message_id}" if message_id else job_id
    safe = re.sub(r"[^A-Za-z0-9-_]", "-", raw_name)
    return safe[:80]
