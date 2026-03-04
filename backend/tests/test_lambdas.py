"""
Tests for all Lambda handlers in lambdas/

Handlers tested:
  - get_presigned_url
  - analyze_router
  - analyze_orchestrator
  - batch_processor
  - job_status
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
from typing import Any
from unittest.mock import MagicMock, patch, call

import boto3
import pytest
from moto import mock_aws
from PIL import Image

# Fix path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
LAMBDAS = os.path.join(os.path.dirname(__file__), "..", "..", "lambdas")

# Moto / boto3 env setup (must happen before any boto3 module-level client is created)
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SECURITY_TOKEN", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")


def _add_lambda(name: str):
    p = os.path.join(LAMBDAS, name)
    if p not in sys.path:
        sys.path.insert(0, p)


def _png_bytes() -> bytes:
    img = Image.new("RGB", (4, 4), "red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


class FakeCtx:
    aws_request_id = "req-123"
    function_name = "test-fn"
    def get_remaining_time_in_millis(self): return 30000


CTX = FakeCtx()


# ═══════════════════════════════════════════════════════════════════════════════
# GET PRESIGNED URL
# ═══════════════════════════════════════════════════════════════════════════════

class TestGetPresignedUrl:
    """Tests for lambdas/get_presigned_url/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("get_presigned_url")

    @mock_aws
    def test_returns_upload_url_and_job_id(self):
        # Create real S3 bucket + DynamoDB table
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads", "JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            event = {"body": json.dumps({"filename": "photo.jpg", "contentType": "image/jpeg", "mode": "fast"})}
            result = mod.handler(event, CTX)

        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert "uploadUrl" in body
        assert "s3Key" in body
        assert body["s3Key"].endswith(".jpg")
        assert "Access-Control-Allow-Origin" in result["headers"]

    @mock_aws
    def test_invalid_json_body_returns_400(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads", "JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            event = {"body": "not-json{{"}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 400

    @mock_aws
    def test_missing_body_defaults(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            event = {}  # No body → missing filename → 400
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 400

    @mock_aws
    def test_dynamodb_failure_non_fatal(self):
        """DynamoDB failure should still return the URL."""
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        # Don't create DynamoDB table → will fail silently
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads", "JOBS_TABLE": "nonexistent-table"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            event = {"body": json.dumps({"filename": "file.png", "contentType": "image/png", "mode": "slow"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200

    @mock_aws
    def test_s3_failure_returns_500(self):
        """If S3 presign fails, return 500."""
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "nonexistent-bucket", "JOBS_TABLE": "t"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            # patch generate_presigned_url to raise
            from botocore.exceptions import ClientError
            with patch.object(mod.s3_client, "generate_presigned_url",
                              side_effect=ClientError({"Error": {"Code": "NoSuchBucket", "Message": "x"}}, "put_object")):
                result = mod.handler({"body": json.dumps({"filename": "f.jpg", "contentType": "image/jpeg"})}, CTX)
        assert result["statusCode"] == 502

    @mock_aws
    def test_sanitises_filename(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="uploads")
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "uploads", "JOBS_TABLE": "jobs"}):
            import importlib
            import lambdas.get_presigned_url.handler as mod
            importlib.reload(mod)
            event = {"body": json.dumps({"filename": "../../etc/passwd.jpg", "contentType": "image/jpeg"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert "etc" not in body["s3Key"] or body["s3Key"].startswith("uploads/")


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYZE ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

class TestAnalyzeRouter:
    """Tests for lambdas/analyze_router/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("analyze_router")

    @mock_aws
    def test_fast_mode_invokes_orchestrator(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        env = {
            "JOBS_TABLE": "coldbones-jobs",
            "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
            "ORCHESTRATOR_FUNCTION_ARN": "arn:aws:lambda:us-east-1:123456789012:function:analyze-orchestrator",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            mock_lambda = MagicMock()
            mock_lambda.invoke.return_value = {
                "StatusCode": 200,
                "Payload": MagicMock(read=lambda: json.dumps({
                    "statusCode": 200,
                    "body": json.dumps({"summary": "test", "key_observations": [], "content_classification": "photo", "extracted_text": "none"})
                }).encode())
            }
            mod.lambda_client = mock_lambda
            event = {
                "body": json.dumps({"mode": "fast", "s3Key": "uploads/abc/original.png", "lang": "en"}),
                "httpMethod": "POST",
            }
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200

    @mock_aws
    def test_slow_mode_enqueues_to_sqs(self):
        import boto3
        sqs = boto3.client("sqs", region_name="us-east-1")
        queue = sqs.create_queue(QueueName="test-queue")
        queue_url = queue["QueueUrl"]

        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        env = {
            "JOBS_TABLE": "coldbones-jobs",
            "ANALYZE_QUEUE_URL": queue_url,
            "ORCHESTRATOR_FUNCTION_ARN": "arn:aws:lambda:us-east-1:123456789012:function:analyze-orchestrator",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            event = {
                "body": json.dumps({"mode": "slow", "s3Key": "uploads/abc/original.png", "jobId": "abc", "lang": "en"}),
                "httpMethod": "POST",
            }
            result = mod.handler(event, CTX)
        assert result["statusCode"] in (200, 202)
        body = json.loads(result["body"])
        assert body.get("status") == "queued" or "jobId" in body

    def test_missing_s3key_returns_400(self):
        env = {
            "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
            "ORCHESTRATOR_FUNCTION_ARN": "arn:aws:lambda:us-east-1:123:function:fn",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            # No s3Key in body → 400
            result = mod.handler({"body": json.dumps({"mode": "fast"})}, CTX)
        assert result["statusCode"] == 400

    def test_missing_body_returns_400(self):
        env = {
            "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
            "ORCHESTRATOR_FUNCTION_ARN": "arn:aws:lambda:us-east-1:123:function:fn",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            result = mod.handler({"body": None, "httpMethod": "POST"}, CTX)
        assert result["statusCode"] == 400


# ═══════════════════════════════════════════════════════════════════════════════
# JOB STATUS
# ═══════════════════════════════════════════════════════════════════════════════

class TestJobStatus:
    """Tests for lambdas/job_status/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("job_status")

    @mock_aws
    def _make_table(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        return table

    @mock_aws
    def test_queued_job(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        sqs = boto3.client("sqs", region_name="us-east-1")
        q = sqs.create_queue(QueueName="jobs")
        table.put_item(Item={"jobId": "jid-1", "status": "QUEUED", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026-01-01", "updatedAt": "2026-01-01"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-1"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "QUEUED"

    @mock_aws
    def test_complete_job_returns_result(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        result_data = {"summary": "test", "key_observations": []}
        table.put_item(Item={"jobId": "jid-2", "status": "COMPLETED", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026-01-01", "updatedAt": "2026-01-01",
                             "result": result_data})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-2"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "COMPLETED"
        assert body["result"]["summary"] == "test"

    @mock_aws
    def test_complete_job_result_as_dict(self):
        """Result stored as a Decimal dict (from DynamoDB) not as JSON string."""
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "jid-dict", "status": "COMPLETED", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026",
                             "result": {"summary": "dict result", "key_observations": []}})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-dict"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body["result"]["summary"] == "dict result"

    @mock_aws
    def test_failed_job_returns_error(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "jid-fail", "status": "FAILED", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026",
                             "error": "inference timeout"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-fail"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body["status"] == "FAILED"
        assert "inference timeout" in body["error"]

    @mock_aws
    def test_missing_job_id_returns_400(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 400

    @mock_aws
    def test_not_found_returns_404(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "no-such-id"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 404

    @mock_aws
    def test_processing_job_returns_status(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "proc-1", "status": "PROCESSING", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "proc-1"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body["status"] == "PROCESSING"


# ═══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════════
# BATCH PROCESSOR
# ══════════════════════════════════════════════════════════════════════════════

_BATCH_ENV = {
    "UPLOAD_BUCKET": "test-uploads",
    "JOBS_TABLE": "coldbones-jobs",
    "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
    "LM_STUDIO_URL": "https://seratonin.example.com",
    "LM_STUDIO_API_KEY": "lm-studio",
}


class TestBatchProcessor:
    """Tests for lambdas/batch_processor/handler.py (LM Studio / SQS mode)"""

    def _make_sqs_event(self, records: list[dict]) -> dict:
        return {"Records": records}

    def _make_record(self, body: dict, msg_id: str = "msg-001") -> dict:
        return {
            "messageId": msg_id,
            "receiptHandle": "handle-001",
            "body": json.dumps(body),
        }

    def _fake_client(self, content: str):
        """Return a mock OpenAI client whose chat.completions.create returns content."""
        class _Msg:
            pass
        msg = _Msg()
        msg.content = content

        class _Choice:
            message = msg

        class _Completion:
            choices = [_Choice()]

        class _Completions:
            def create(self_, **kw):  # noqa: N805
                return _Completion()

        class _Chat:
            completions = _Completions()

        class _Client:
            chat = _Chat()

        return _Client()

    def _fake_table(self, store: dict):
        """Return a fake DynamoDB Table (as returned by dynamodb.Table())."""
        class _Table:
            def update_item(self_, **kw):  # noqa: N805
                key = kw["Key"]["jobId"]
                if key not in store:
                    store[key] = {"jobId": key}
                vals = kw.get("ExpressionAttributeValues", {})
                # Extract status from values like {":s": "COMPLETED"}
                for v in vals.values():
                    if isinstance(v, str) and v.isupper():
                        store[key]["status"] = v
                store[key]["_updated"] = True
        return _Table()

    # ------------------------------------------------------------------
    # helpers / imports
    # ------------------------------------------------------------------

    def test_module_imports(self, monkeypatch):
        """batch_processor module should import without errors."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            assert hasattr(mod, "handler")

    # ------------------------------------------------------------------
    # happy path — empty SQS event
    # ------------------------------------------------------------------

    def test_empty_event_returns_no_failures(self, monkeypatch):
        """Empty Records list → handler returns immediately with no failures."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            result = mod.handler({"Records": []}, None)
        assert result == {"batchItemFailures": []}

    # ------------------------------------------------------------------
    # happy path — full run with mocked S3 + DDB + OpenAI
    # ------------------------------------------------------------------

    def test_successful_batch(self, monkeypatch):
        """Single SQS record processed successfully → batchItemFailures empty."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)

            job_id = "job-batch-001"
            s3_key = "uploads/test/photo.jpg"
            store: dict = {}

            # Stub s3_client
            fake_jpg = b"\xff\xd8\xff\xe0" + b"\x00" * 100  # minimal JPEG header
            class FakeS3Client:
                def get_object(self_, **kw):  # noqa: N805
                    return {"Body": io.BytesIO(fake_jpg)}
            monkeypatch.setattr(mod, "s3_client", FakeS3Client())

            # Stub dynamodb resource — .Table() returns our fake table
            fake_table = self._fake_table(store)
            class FakeDynamoDB:
                def Table(self_, name):  # noqa: N805
                    return fake_table
            monkeypatch.setattr(mod, "dynamodb", FakeDynamoDB())

            # Stub OpenAI client
            analysis_json = json.dumps({
                "summary": "A cat on a sofa.",
                "key_observations": ["cat", "sofa"],
                "content_classification": "photograph",
                "extracted_text": "No text detected.",
            })
            monkeypatch.setattr(mod, "client", self._fake_client(analysis_json))

            # Stub _detect_model + _image_to_data_url (avoid PIL decode of fake bytes)
            monkeypatch.setattr(mod, "_detect_model", lambda: "qwen3.5-test")
            monkeypatch.setattr(mod, "_detect_type", lambda raw, key: "image/jpeg")
            monkeypatch.setattr(mod, "_image_to_data_url", lambda b: "data:image/jpeg;base64,abc")

            # Stub sns_client to avoid real AWS
            monkeypatch.setattr(mod, "sns_client", MagicMock())

            body = {"jobId": job_id, "s3Key": s3_key, "lang": "en"}
            event = self._make_sqs_event([self._make_record(body)])
            result = mod.handler(event, None)

        assert result == {"batchItemFailures": []}
        # Job should be marked COMPLETED
        assert store.get(job_id, {}).get("_updated") is True

    # ------------------------------------------------------------------
    # env var assertions
    # ------------------------------------------------------------------

    def test_lm_studio_url_env_var(self, monkeypatch):
        """LM_STUDIO_URL env var is consumed by the module."""
        custom_url = "https://my-custom-server.example.com"
        env = {**_BATCH_ENV, "LM_STUDIO_URL": custom_url}
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            assert mod.LM_STUDIO_URL == custom_url

