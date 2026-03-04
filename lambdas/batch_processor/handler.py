"""
Lambda: batch-processor

Slow-mode SQS consumer. Called by Step Functions or directly triggered by SQS.
Processes a batch of analysis jobs by:
  1. Pulling SQS messages (up to 10 at a time)
  2. For each job: download from S3, run inference on Spot GPU, write result to S3 + DynamoDB
  3. Publish completion notification to SNS for WebSocket push

Environment variables:
  UPLOAD_BUCKET       — S3 bucket for uploads + results
  GPU_ENDPOINT        — Internal URL of the GPU model server (e.g., http://10.0.1.12:8000/v1)
  GPU_API_KEY         — API key for the model server (default: llama.cpp)
  JOBS_TABLE          — DynamoDB table name
  ANALYZE_QUEUE_URL   — SQS queue URL
  SNS_TOPIC_ARN       — SNS topic for job completion notifications
  MODEL_NAME          — Model identifier (optional, auto-detected if empty)
  MAX_INFERENCE_TOKENS— Max tokens for model response (default: 16384)
  MAX_PDF_PAGES       — Max PDF pages to process (default: 20)
"""

import base64
import io
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError
from openai import OpenAI
from PIL import Image

s3_client = boto3.client("s3")
sqs_client = boto3.client("sqs")
dynamodb = boto3.resource("dynamodb")
sns_client = boto3.client("sns")

UPLOAD_BUCKET = os.environ["UPLOAD_BUCKET"]
GPU_ENDPOINT = os.environ.get("GPU_ENDPOINT", "http://localhost:1234/v1")
GPU_API_KEY = os.environ.get("GPU_API_KEY", "llama.cpp")
JOBS_TABLE = os.environ["JOBS_TABLE"]
ANALYZE_QUEUE_URL = os.environ["ANALYZE_QUEUE_URL"]
SNS_TOPIC_ARN = os.environ.get("SNS_TOPIC_ARN", "")
MAX_TOKENS = int(os.environ.get("MAX_INFERENCE_TOKENS", 16384))
MODEL_NAME = os.environ.get("MODEL_NAME", "")
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 20))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 10))

client = OpenAI(base_url=GPU_ENDPOINT, api_key=GPU_API_KEY, timeout=300.0)
table = dynamodb.Table(JOBS_TABLE)

SYSTEM_PROMPT = """You are a precise visual analyst. Examine the provided image carefully. Think through what you see step by step, then respond with a JSON object (no markdown fences) matching this exact schema:

{
  "summary": "A concise 2-3 sentence description of what this image contains.",
  "key_observations": ["observation 1", "observation 2", "..."],
  "content_classification": "One of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).",
  "extracted_text": "If there is readable text in the image, transcribe it accurately. If no text, write: No text detected."
}

Be factual and specific. Do not speculate beyond what is clearly visible. Your final output after any thinking must be ONLY the JSON object."""

LANGUAGE_INSTRUCTIONS = {
    "en": "",
    "hi": "IMPORTANT: Respond entirely in Hindi (हिन्दी).",
    "es": "IMPORTANT: Respond entirely in Spanish (Español).",
    "bn": "IMPORTANT: Respond entirely in Bengali (বাংলা).",
}


def handler(event: dict, _context: Any) -> dict:
    """
    Handles two invocation patterns:
    1. Direct SQS trigger (from EventBridge pipe or Lambda event source mapping)
    2. Step Functions task (explicit batch processing)
    """
    records = event.get("Records") or []

    if records:
        # Direct SQS trigger — process the records we received
        processed, failed = _process_records(records)
    else:
        # Step Functions / manual batch — pull from queue ourselves
        processed, failed = _pull_and_process()

    return {
        "processedCount": processed,
        "failedCount": failed,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def _pull_and_process() -> tuple[int, int]:
    """Pull up to BATCH_SIZE messages from SQS and process them."""
    processed = 0
    failed = 0

    try:
        response = sqs_client.receive_message(
            QueueUrl=ANALYZE_QUEUE_URL,
            MaxNumberOfMessages=BATCH_SIZE,
            WaitTimeSeconds=5,
            VisibilityTimeout=600,
        )
    except ClientError as e:
        print(f"ERROR: Failed to receive SQS messages: {e}")
        return 0, 0

    messages = response.get("Messages") or []
    for msg in messages:
        ok = _process_single_message(msg)
        if ok:
            processed += 1
            _delete_message(msg["ReceiptHandle"])
        else:
            failed += 1
            # Leave message in queue for retry (visibility timeout will expire)

    return processed, failed


def _process_records(records: list[dict]) -> tuple[int, int]:
    """Process SQS records delivered directly by Lambda event source mapping."""
    processed = 0
    failed = 0
    for record in records:
        ok = _process_single_message(record)
        if ok:
            processed += 1
        else:
            failed += 1
    return processed, failed


def _process_single_message(msg: dict) -> bool:
    """Process one SQS message. Returns True on success."""
    try:
        body = json.loads(msg.get("Body") or msg.get("body") or "{}")
    except Exception:
        print(f"ERROR: Could not parse message body: {msg}")
        return False

    job_id = body.get("jobId", str(uuid.uuid4()))
    s3_key = body.get("s3Key", "")
    lang = body.get("lang", "en")

    if not s3_key:
        print(f"ERROR: Missing s3Key in job {job_id}")
        return False

    print(f"INFO: Processing job {job_id} (s3Key={s3_key}, lang={lang})")

    # Mark as processing
    _update_job_status(job_id, "processing")

    start = time.time()
    try:
        # Download file
        file_bytes, content_type = _download_file(s3_key)

        # Convert to images
        image_data_urls = _prepare_images(file_bytes, content_type, s3_key, job_id)
        if not image_data_urls:
            raise ValueError("No images extracted from file")

        # Run inference
        result = _run_inference(image_data_urls, lang)
        elapsed_ms = int((time.time() - start) * 1000)

        # Write result to S3
        result_key = f"results/{job_id}/analysis.json"
        full_result = {**result, "jobId": job_id, "processing_time_ms": elapsed_ms, "mode": "slow"}
        s3_client.put_object(
            Bucket=UPLOAD_BUCKET,
            Key=result_key,
            Body=json.dumps(full_result),
            ContentType="application/json",
        )

        # Update DynamoDB with result
        _update_job_complete(job_id, full_result)

        # Notify via SNS
        if SNS_TOPIC_ARN:
            _notify_complete(job_id, full_result)

        print(f"INFO: Job {job_id} completed in {elapsed_ms}ms")
        return True

    except Exception as e:
        print(f"ERROR: Job {job_id} failed: {e}")
        _update_job_status(job_id, "failed", error=str(e))
        return False


def _download_file(s3_key: str) -> tuple[bytes, str]:
    obj = s3_client.get_object(Bucket=UPLOAD_BUCKET, Key=s3_key)
    content_type = obj.get("ContentType", "") or _guess_type(s3_key)
    return obj["Body"].read(), content_type


def _prepare_images(raw_bytes: bytes, content_type: str, s3_key: str, job_id: str) -> list[str]:
    if content_type == "application/pdf" or s3_key.lower().endswith(".pdf"):
        return _pdf_to_data_urls(raw_bytes, job_id)
    data_url = _image_to_data_url(raw_bytes)
    return [data_url] if data_url else []


def _run_inference(image_data_urls: list[str], lang: str) -> dict:
    content: list[dict] = [
        {"type": "image_url", "image_url": {"url": url}}
        for url in image_data_urls
    ]
    analysis_text = (
        "Analyze this image thoroughly."
        if len(image_data_urls) == 1
        else f"Analyze these {len(image_data_urls)} pages thoroughly. Provide a holistic analysis."
    )
    lang_instruction = LANGUAGE_INSTRUCTIONS.get(lang, "")
    if lang_instruction:
        analysis_text += f"\n\n{lang_instruction}"
    content.append({"type": "text", "text": analysis_text})

    model_name = MODEL_NAME or _detect_model()
    response = client.chat.completions.create(
        model=model_name,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        max_tokens=MAX_TOKENS,
        temperature=0.6,
    )

    message = response.choices[0].message
    raw_content = message.content or ""
    finish_reason = response.choices[0].finish_reason or ""

    reasoning = ""
    try:
        msg_dict = message.model_dump() if hasattr(message, "model_dump") else message.__dict__
        reasoning = msg_dict.get("reasoning_content", "") or ""
    except Exception:
        pass

    parsed = _parse_model_response(raw_content)
    return {
        **parsed,
        "reasoning": reasoning,
        "reasoning_token_count": len(reasoning.split()) if reasoning else 0,
        "finish_reason": finish_reason,
        "model": model_name,
    }


def _update_job_status(job_id: str, status: str, error: str | None = None) -> None:
    update_expr = "SET #s = :s, updatedAt = :u"
    expr_names = {"#s": "status"}
    expr_values: dict = {":s": status, ":u": datetime.now(timezone.utc).isoformat()}
    if error:
        update_expr += ", errorMessage = :e"
        expr_values[":e"] = error[:2000]
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression=update_expr,
            ExpressionAttributeNames=expr_names,
            ExpressionAttributeValues=expr_values,
        )
    except ClientError as e:
        print(f"WARNING: Could not update DynamoDB for job {job_id}: {e}")


def _update_job_complete(job_id: str, result: dict) -> None:
    result_str = json.dumps(result)
    try:
        table.update_item(
            Key={"jobId": job_id},
            UpdateExpression="SET #s = :s, updatedAt = :u, #r = :r",
            ExpressionAttributeNames={"#s": "status", "#r": "result"},
            ExpressionAttributeValues={
                ":s": "complete",
                ":u": datetime.now(timezone.utc).isoformat(),
                ":r": result_str,
            },
        )
    except ClientError as e:
        print(f"WARNING: Could not update DynamoDB for job {job_id}: {e}")


def _notify_complete(job_id: str, result: dict) -> None:
    try:
        sns_client.publish(
            TopicArn=SNS_TOPIC_ARN,
            Message=json.dumps({"jobId": job_id, "status": "complete", "result": result}),
            MessageAttributes={
                "jobId": {"DataType": "String", "StringValue": job_id},
                "eventType": {"DataType": "String", "StringValue": "job_complete"},
            },
        )
    except Exception as e:
        print(f"WARNING: SNS publish failed for job {job_id}: {e}")


def _delete_message(receipt_handle: str) -> None:
    try:
        sqs_client.delete_message(QueueUrl=ANALYZE_QUEUE_URL, ReceiptHandle=receipt_handle)
    except Exception as e:
        print(f"WARNING: Could not delete SQS message: {e}")


def _guess_type(key: str) -> str:
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
        "tiff": "image/tiff", "tif": "image/tiff", "pdf": "application/pdf",
    }.get(ext, "application/octet-stream")


def _image_to_data_url(raw_bytes: bytes) -> str | None:
    try:
        img = Image.open(io.BytesIO(raw_bytes))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
        return f"data:image/png;base64,{b64}"
    except Exception as e:
        print(f"Image conversion error: {e}")
        return None


def _pdf_to_data_urls(pdf_bytes: bytes, job_id: str) -> list[str]:
    try:
        from pdf2image import convert_from_bytes
        images = convert_from_bytes(pdf_bytes, dpi=150, fmt="png")
        result = []
        for img in images[:MAX_PDF_PAGES]:
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
            result.append(f"data:image/png;base64,{b64}")
        return result
    except Exception as e:
        print(f"PDF conversion error for job {job_id}: {e}")
        return []


def _detect_model() -> str:
    try:
        models = client.models.list()
        if models.data:
            return models.data[0].id
    except Exception:
        pass
    return "default"


def _parse_model_response(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "summary": text[:500],
            "key_observations": [],
            "content_classification": "unknown",
            "extracted_text": "No text detected.",
        }
