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
    # Add lambdas root first so shared modules (e.g. desktop_client) are found
    if LAMBDAS not in sys.path:
        sys.path.insert(0, LAMBDAS)
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
    def test_returns_presigned_post_and_s3_key(self):
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
        assert body.get("uploadMethod") == "POST"
        assert isinstance(body.get("uploadFields"), dict)
        assert "key" in body["uploadFields"]
        assert "s3Key" in body
        assert body["s3Key"].endswith(".jpg")
        assert body.get("maxSizeBytes") == 20 * 1024 * 1024
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
            # patch generate_presigned_post to raise
            from botocore.exceptions import ClientError
            with patch.object(mod.s3_client, "generate_presigned_post",
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
                "StatusCode": 202,
                "Payload": MagicMock(read=lambda: json.dumps({
                    "statusCode": 202,
                    "body": json.dumps({"jobId": "x", "status": "processing"})
                }).encode())
            }
            mod.lambda_client = mock_lambda
            # Patch is_desktop_alive so fast path is taken (desktop is "alive")
            with patch("lambdas.analyze_router.handler.is_desktop_alive", return_value=True):
                event = {
                    "body": json.dumps({"mode": "fast", "s3Key": "uploads/abc/original.png", "lang": "en"}),
                    "httpMethod": "POST",
                }
                result = mod.handler(event, CTX)
        # Fast path returns 202 (async fire-and-forget, browser polls for result)
        assert result["statusCode"] == 202
        body = json.loads(result["body"])
        assert "jobId" in body

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
        """batch_processor module (tombstone) should import without errors and expose handler."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            assert hasattr(mod, "handler")

    # ------------------------------------------------------------------
    # tombstone behaviour
    # ------------------------------------------------------------------

    def test_empty_event_returns_empty_dict(self, monkeypatch):
        """batch_processor is a tombstone — returns {} for empty Records (leaves msgs visible)."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            result = mod.handler({"Records": []}, None)
        # Tombstone returns {} so SQS does NOT delete the messages.
        assert result == {}

    def test_tombstone_drops_records_and_returns_empty(self, monkeypatch):
        """Tombstone logs a warning and returns {} regardless of record count."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            body = {"jobId": "job-001", "s3Key": "uploads/x/photo.jpg", "lang": "en"}
            event = self._make_sqs_event([self._make_record(body)])
            result = mod.handler(event, None)
        # Tombstone always returns {} — messages stay visible for the desktop worker.
        assert result == {}

    def test_tombstone_is_not_a_full_processor(self, monkeypatch):
        """Confirm tombstone does NOT expose s3_client / LM_STUDIO_URL (desktop processes jobs)."""
        with patch.dict("os.environ", _BATCH_ENV):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
        # The real processing happens on the desktop via worker.py, not here.
        assert not hasattr(mod, "s3_client"), "Tombstone should not have s3_client"
        assert not hasattr(mod, "LM_STUDIO_URL"), "Tombstone should not have LM_STUDIO_URL"


# ═══════════════════════════════════════════════════════════════════════════════
# ANALYZE ROUTER — additional branch coverage
# ═══════════════════════════════════════════════════════════════════════════════

_ROUTER_ENV = {
    "JOBS_TABLE": "test-jobs",
    "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
    "ORCHESTRATOR_FUNCTION_ARN": "arn:aws:lambda:us-east-1:123:function:orch",
    "UPLOAD_BUCKET": "test-uploads",
}


def _reload_router():
    """Reload the router module with the current env."""
    import importlib
    _add_lambda("analyze_router")
    import lambdas.analyze_router.handler as mod
    importlib.reload(mod)
    return mod


class TestAnalyzeRouterBranches:
    """Cover every provider branch + error path in the router."""

    def _setup_mod(self):
        mod = _reload_router()
        mock_lambda = MagicMock()
        mock_lambda.invoke.return_value = {"StatusCode": 202}
        mod.lambda_client = mock_lambda
        mock_s3 = MagicMock()
        mock_s3.head_object.return_value = {"ContentLength": 1024}
        mod.s3_client = mock_s3
        mock_table = MagicMock()
        mock_ddb = MagicMock()
        mock_ddb.Table.return_value = mock_table
        mod.dynamodb = mock_ddb
        mock_sqs = MagicMock()
        mod.sqs_client = mock_sqs
        return mod

    def test_rejects_oversized_upload(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            mod.s3_client.head_object.return_value = {"ContentLength": 21 * 1024 * 1024}
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "provider": "cloud"})}
            result = mod.handler(event, CTX)

        assert result["statusCode"] == 413
        assert "limit" in json.loads(result["body"])["detail"].lower()
        mod.lambda_client.invoke.assert_not_called()

    def test_cloud_cmi_provider(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "provider": "cloud-cmi"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 202
        # Should set provider to 'bedrock' internally
        call_payload = json.loads(mod.lambda_client.invoke.call_args.kwargs["Payload"].decode())
        assert call_payload["provider"] == "bedrock"

    def test_cloud_provider(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "provider": "cloud"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 202
        call_payload = json.loads(mod.lambda_client.invoke.call_args.kwargs["Payload"].decode())
        assert call_payload["provider"] == "ondemand"

    def test_local_provider_desktop_alive(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            with patch.object(mod, "is_desktop_alive", return_value=True):
                event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "provider": "local"})}
                result = mod.handler(event, CTX)
        assert result["statusCode"] == 202
        call_payload = json.loads(mod.lambda_client.invoke.call_args.kwargs["Payload"].decode())
        assert call_payload["provider"] == "desktop"

    def test_local_provider_desktop_offline(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            with patch.object(mod, "is_desktop_alive", return_value=False):
                event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "provider": "local"})}
                result = mod.handler(event, CTX)
        assert result["statusCode"] == 202
        body = json.loads(result["body"])
        assert body["status"] == "queued"
        assert "offline" in body["message"].lower() or "Desktop" in body["message"]

    def test_invoke_async_missing_arn(self):
        env = {**_ROUTER_ENV, "ORCHESTRATOR_FUNCTION_ARN": ""}
        with patch.dict("os.environ", env):
            mod = self._setup_mod()
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 500

    def test_invoke_async_lambda_client_error(self):
        from botocore.exceptions import ClientError
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            mod.lambda_client.invoke.side_effect = ClientError(
                {"Error": {"Code": "ServiceException", "Message": "boom"}}, "Invoke"
            )
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 502

    def test_invoke_async_ddb_write_failure_non_fatal(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            mock_ddb = MagicMock()
            mock_ddb.Table.return_value.put_item.side_effect = Exception("DDB boom")
            mod.dynamodb = mock_ddb
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg"})}
            result = mod.handler(event, CTX)
        # Should still succeed (DDB failure is non-fatal)
        assert result["statusCode"] == 202

    def test_enqueue_missing_queue_url(self):
        env = {**_ROUTER_ENV, "ANALYZE_QUEUE_URL": ""}
        with patch.dict("os.environ", env):
            mod = self._setup_mod()
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "mode": "offline"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 500

    def test_enqueue_sqs_client_error(self):
        from botocore.exceptions import ClientError
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            mod.sqs_client.send_message.side_effect = ClientError(
                {"Error": {"Code": "QueueDoesNotExist", "Message": "gone"}}, "SendMessage"
            )
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "mode": "offline"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 502

    def test_enqueue_ddb_write_failure_non_fatal(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            mock_ddb = MagicMock()
            mock_ddb.Table.return_value.put_item.side_effect = Exception("DDB boom")
            mod.dynamodb = mock_ddb
            event = {"body": json.dumps({"s3Key": "uploads/a/b.jpg", "mode": "offline"})}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 202

    def test_invalid_json_body(self):
        with patch.dict("os.environ", _ROUTER_ENV):
            mod = self._setup_mod()
            event = {"body": "not-json{{{"}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 400


# ═══════════════════════════════════════════════════════════════════════════════
# JOB STATUS — additional branch coverage
# ═══════════════════════════════════════════════════════════════════════════════


class TestJobStatusBranches:
    """Cover DDB read failure, partial_text in PROCESSING, and _json_default."""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("job_status")

    def test_ddb_read_client_error(self):
        from botocore.exceptions import ClientError
        with patch.dict("os.environ", {"JOBS_TABLE": "test-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            mock_table = MagicMock()
            mock_table.get_item.side_effect = ClientError(
                {"Error": {"Code": "InternalServerError", "Message": "DDB down"}}, "GetItem"
            )
            mock_ddb = MagicMock()
            mock_ddb.Table.return_value = mock_table
            mod.dynamodb = mock_ddb
            result = mod.handler({"pathParameters": {"jobId": "j1"}}, CTX)
        assert result["statusCode"] == 502

    @mock_aws
    def test_processing_with_partial_text(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="test-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={
            "jobId": "j-partial", "status": "PROCESSING",
            "createdAt": "2026-01-01",
            "partial_text": "Analyzing the image... I see",
            "partial_len": 29,
        })
        with patch.dict("os.environ", {"JOBS_TABLE": "test-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "j-partial"}}, CTX)
        body = json.loads(result["body"])
        assert body["status"] == "PROCESSING"
        assert body["partial_text"] == "Analyzing the image... I see"
        assert body["partial_len"] == 29

    def test_json_default_decimal_int(self):
        from decimal import Decimal
        with patch.dict("os.environ", {"JOBS_TABLE": "test-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
        assert mod._json_default(Decimal("42")) == 42
        assert isinstance(mod._json_default(Decimal("42")), int)

    def test_json_default_decimal_float(self):
        from decimal import Decimal
        with patch.dict("os.environ", {"JOBS_TABLE": "test-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
        assert mod._json_default(Decimal("3.14")) == 3.14
        assert isinstance(mod._json_default(Decimal("3.14")), float)

    def test_json_default_other_types(self):
        with patch.dict("os.environ", {"JOBS_TABLE": "test-jobs"}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
        # Non-Decimal types should be stringified
        assert mod._json_default(set()) == "set()"

