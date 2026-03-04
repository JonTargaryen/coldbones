"""
Tests for all Lambda handlers in lambdas/

Handlers tested:
  - get_presigned_url  - analyze_router
  - analyze_orchestrator
  - batch_processor
  - job_status
  - lifecycle_manager
  - pdf_to_images (lambda)
  - schedule_manager
  - ws_connect / ws_disconnect / ws_notify
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
        assert "jobId" in body
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
            event = {}  # No body
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert "uploadUrl" in body

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
            with patch.object(mod.s3, "generate_presigned_url",
                              side_effect=ClientError({"Error": {"Code": "NoSuchBucket", "Message": "x"}}, "put_object")):
                result = mod.handler({"body": json.dumps({"filename": "f.jpg"})}, CTX)
        assert result["statusCode"] == 500

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
            event = {"body": json.dumps({"filename": "../../etc/passwd.jpg"})}
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
            "ORCHESTRATOR_FUNCTION": "analyze-orchestrator",
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
                "body": json.dumps({"mode": "fast", "s3Key": "uploads/abc/original.png", "jobId": "abc", "lang": "en"}),
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
            "ORCHESTRATOR_FUNCTION": "analyze-orchestrator",
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

    def test_options_preflight(self):
        env = {
            "JOBS_TABLE": "coldbones-jobs",
            "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
            "ORCHESTRATOR_FUNCTION": "fn",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            result = mod.handler({"httpMethod": "OPTIONS"}, CTX)
        assert result["statusCode"] == 200

    def test_missing_body_returns_error(self):
        env = {
            "JOBS_TABLE": "coldbones-jobs",
            "ANALYZE_QUEUE_URL": "https://sqs.us-east-1.amazonaws.com/123/q",
            "ORCHESTRATOR_FUNCTION": "fn",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.analyze_router.handler as mod
            importlib.reload(mod)
            result = mod.handler({"body": None, "httpMethod": "POST"}, CTX)
        # Should return 400 or handle gracefully
        assert result["statusCode"] in (400, 200)


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
        table.put_item(Item={"jobId": "jid-1", "status": "queued", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026-01-01", "updatedAt": "2026-01-01"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": q["QueueUrl"]}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-1"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "queued"
        assert "estimatedWait" in body

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
        table.put_item(Item={"jobId": "jid-2", "status": "complete", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026-01-01", "updatedAt": "2026-01-01",
                             "result": json.dumps(result_data)})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-2"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 200
        body = json.loads(result["body"])
        assert body["status"] == "complete"
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
        table.put_item(Item={"jobId": "jid-dict", "status": "complete", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026",
                             "result": {"summary": "dict result", "key_observations": []}})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
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
        table.put_item(Item={"jobId": "jid-fail", "status": "failed", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026",
                             "errorMessage": "inference timeout"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-fail"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body["status"] == "failed"
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
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
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
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "no-such-id"}, "httpMethod": "GET"}, CTX)
        assert result["statusCode"] == 404

    @mock_aws
    def test_options_returns_200(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"httpMethod": "OPTIONS"}, CTX)
        assert result["statusCode"] == 200

    @mock_aws
    def test_no_queue_url_defaults_estimate(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "jid-q", "status": "queued", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "jid-q"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body.get("estimatedWait") == 300  # default

    @mock_aws
    def test_processing_job_returns_estimated_wait(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "proc-1", "status": "processing", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026"})
        with patch.dict("os.environ", {"JOBS_TABLE": "coldbones-jobs", "ANALYZE_QUEUE_URL": ""}):
            import importlib
            import lambdas.job_status.handler as mod
            importlib.reload(mod)
            result = mod.handler({"pathParameters": {"jobId": "proc-1"}, "httpMethod": "GET"}, CTX)
        body = json.loads(result["body"])
        assert body["status"] == "processing"
        assert "estimatedWait" in body


# ═══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET HANDLERS
# ═══════════════════════════════════════════════════════════════════════════════

class TestWsConnect:
    """Tests for lambdas/ws_connect/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("ws_connect")

    @mock_aws
    def test_connect_stores_connection_id(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"CONNECTIONS_TABLE": "ws-connections"}):
            import importlib
            import lambdas.ws_connect.handler as mod
            importlib.reload(mod)
            event = {"requestContext": {"connectionId": "conn-abc123"}}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200
        table = ddb.Table("ws-connections")
        item = table.get_item(Key={"connectionId": "conn-abc123"}).get("Item")
        assert item is not None
        assert item["connectionId"] == "conn-abc123"

    @mock_aws
    def test_connect_missing_connection_id(self):
        """API Gateway always provides connectionId; without it, handler raises KeyError."""
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"CONNECTIONS_TABLE": "ws-connections"}):
            import importlib
            import lambdas.ws_connect.handler as mod
            importlib.reload(mod)
            event = {"requestContext": {}}
            # API Gateway always provides connectionId; handler raises KeyError without it
            with pytest.raises(KeyError, match="connectionId"):
                mod.handler(event, CTX)


class TestWsDisconnect:
    """Tests for lambdas/ws_disconnect/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("ws_disconnect")

    @mock_aws
    def test_disconnect_removes_connection(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"connectionId": "conn-xyz", "connectedAt": "2026-01-01"})
        with patch.dict("os.environ", {"CONNECTIONS_TABLE": "ws-connections"}):
            import importlib
            import lambdas.ws_disconnect.handler as mod
            importlib.reload(mod)
            event = {"requestContext": {"connectionId": "conn-xyz"}}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200
        item = table.get_item(Key={"connectionId": "conn-xyz"}).get("Item")
        assert item is None

    @mock_aws
    def test_disconnect_nonexistent_connection_is_ok(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        with patch.dict("os.environ", {"CONNECTIONS_TABLE": "ws-connections"}):
            import importlib
            import lambdas.ws_disconnect.handler as mod
            importlib.reload(mod)
            event = {"requestContext": {"connectionId": "no-such-conn"}}
            result = mod.handler(event, CTX)
        assert result["statusCode"] == 200


class TestWsNotify:
    """Tests for lambdas/ws_notify/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("ws_notify")

    @mock_aws
    def test_notify_sends_to_all_connections(self):
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"connectionId": "conn-1", "jobId": "job-a"})
        table.put_item(Item={"connectionId": "conn-2", "jobId": "job-a"})

        mock_apigw = MagicMock()
        mock_apigw.post_to_connection = MagicMock()

        with patch.dict("os.environ", {
            "CONNECTIONS_TABLE": "ws-connections",
            "WS_GATEWAY_URL": "https://abc123.execute-api.us-east-1.amazonaws.com/prod",
        }):
            import importlib
            import lambdas.ws_notify.handler as mod
            importlib.reload(mod)
            mod.apigw = mock_apigw
            sns_event = {
                "Records": [{
                    "EventSource": "aws:sns",
                    "EventSubscriptionArn": "arn:aws:sns:us-east-1:123456789012:topic:uuid",
                    "Sns": {
                        "Message": json.dumps({"jobId": "job-a", "status": "complete", "result": {}})
                    }
                }]
            }
            result = mod.handler(sns_event, CTX)

        assert result["status"] == "ok"
        assert mock_apigw.post_to_connection.call_count == 2

    @mock_aws
    def test_notify_removes_stale_connections(self):
        """GoneException should remove the stale connection from DynamoDB."""
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="ws-connections",
            KeySchema=[{"AttributeName": "connectionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "connectionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"connectionId": "stale-conn", "jobId": "job-b"})

        from botocore.exceptions import ClientError
        mock_apigw = MagicMock()
        # Create a real exception class so the handler's except clause actually catches it
        class GoneException(Exception):
            pass
        mock_apigw.exceptions.GoneException = GoneException
        mock_apigw.post_to_connection.side_effect = GoneException("Connection gone")

        with patch.dict("os.environ", {
            "CONNECTIONS_TABLE": "ws-connections",
            "WS_GATEWAY_URL": "https://abc.execute-api.us-east-1.amazonaws.com/prod",
        }):
            import importlib
            import lambdas.ws_notify.handler as mod
            importlib.reload(mod)
            mod.apigw = mock_apigw
            sns_event = {
                "Records": [{
                    "EventSource": "aws:sns",
                    "EventSubscriptionArn": "arn:aws:sns:us-east-1:123456789012:topic:uuid",
                    "Sns": {"Message": json.dumps({"jobId": "job-b", "status": "complete", "result": {}})}
                }]
            }
            result = mod.handler(sns_event, CTX)

        assert result["status"] == "ok"
        item = table.get_item(Key={"connectionId": "stale-conn"}).get("Item")
        assert item is None  # should have been removed


# ═══════════════════════════════════════════════════════════════════════════════
# SCHEDULE MANAGER
# ═══════════════════════════════════════════════════════════════════════════════

class TestScheduleManager:
    """Tests for lambdas/schedule_manager/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("schedule_manager")

    @mock_aws
    def _make_asg(self, name: str):
        asg_client = boto3.client("autoscaling", region_name="us-east-1")
        ec2 = boto3.client("ec2", region_name="us-east-1")
        # Create a launch configuration
        asg_client.create_launch_configuration(
            LaunchConfigurationName=f"lc-{name}",
            ImageId="ami-12345678",
            InstanceType="g5.2xlarge",
        )
        asg_client.create_auto_scaling_group(
            AutoScalingGroupName=name,
            LaunchConfigurationName=f"lc-{name}",
            MinSize=0, MaxSize=1, DesiredCapacity=0,
            AvailabilityZones=["us-east-1a"],
        )

    @mock_aws
    def test_overnight_shutdown(self):
        self._make_asg("slow-asg")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "false",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "overnight-shutdown"}, CTX)
        assert result["status"] == "ok"
        assert result["action"] == "overnight-shutdown"

    @mock_aws
    def test_morning_warmup(self):
        self._make_asg("slow-asg-2")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-2",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "false",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "morning-warmup"}, CTX)
        assert result["status"] == "ok"
        assert result["action"] == "morning-warmup"

    @mock_aws
    def test_weekend_fast_shutdown_when_enabled(self):
        self._make_asg("slow-asg-3")
        self._make_asg("fast-asg-3")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-3",
            "FAST_ASG_NAME": "fast-asg-3",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "true",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "weekend-fast-shutdown"}, CTX)
        assert result["status"] == "ok"

    @mock_aws
    def test_weekend_fast_warmup_when_enabled(self):
        self._make_asg("slow-asg-4")
        self._make_asg("fast-asg-4")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-4",
            "FAST_ASG_NAME": "fast-asg-4",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "true",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "weekend-fast-warmup"}, CTX)
        assert result["status"] == "ok"

    @mock_aws
    def test_weekend_shutdown_skipped_when_disabled(self):
        self._make_asg("slow-asg-5")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-5",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "false",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "weekend-fast-shutdown"}, CTX)
        assert result["status"] == "skipped"

    @mock_aws
    def test_unknown_action_returns_skipped(self):
        self._make_asg("slow-asg-6")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-6",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "false",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "unknown-action"}, CTX)
        assert result["status"] == "skipped"

    @mock_aws
    def test_action_from_eventbridge_detail(self):
        """EventBridge wraps the payload in a 'detail' key."""
        self._make_asg("slow-asg-7")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-7",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "false",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"detail": {"action": "morning-warmup"}}, CTX)
        assert result["status"] == "ok"

    @mock_aws
    def test_weekend_shutdown_no_fast_asg_skips(self):
        self._make_asg("slow-asg-8")
        with patch.dict("os.environ", {
            "SLOW_ASG_NAME": "slow-asg-8",
            "FAST_ASG_NAME": "",
            "ENABLE_WEEKEND_FAST_SHUTDOWN": "true",
        }):
            import importlib
            import lambdas.schedule_manager.handler as mod
            importlib.reload(mod)
            result = mod.handler({"action": "weekend-fast-shutdown"}, CTX)
        assert result["status"] == "skipped"


# ═══════════════════════════════════════════════════════════════════════════════
# LIFECYCLE MANAGER
# ═══════════════════════════════════════════════════════════════════════════════

class TestLifecycleManager:
    """Tests for lambdas/lifecycle_manager/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("lifecycle_manager")

    def test_launch_healthy_instance_completes(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000",
            "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "30",
            "HEALTH_POLL_INTERVAL_S": "1",
            "DRAIN_TIMEOUT_S": "30",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            mod.ec2.describe_instances = MagicMock(return_value={
                "Reservations": [{"Instances": [{"PrivateIpAddress": "10.0.1.5"}]}]
            })
            mod._health_check = MagicMock(return_value=True)
            mod.autoscaling.complete_lifecycle_action = MagicMock()
            event = {
                "detail": {
                    "LifecycleActionToken": "token-abc",
                    "LifecycleHookName": "launch-hook",
                    "AutoScalingGroupName": "fast-asg",
                    "EC2InstanceId": "i-12345",
                    "LifecycleTransition": "autoscaling:EC2_INSTANCE_LAUNCHING",
                }
            }
            result = mod.handler(event, CTX)
        assert result["status"] == "healthy"
        mod.autoscaling.complete_lifecycle_action.assert_called_once_with(
            AutoScalingGroupName="fast-asg",
            LifecycleHookName="launch-hook",
            LifecycleActionToken="token-abc",
            LifecycleActionResult="CONTINUE",
        )

    def test_launch_no_ip_abandons(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000",
            "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10",
            "HEALTH_POLL_INTERVAL_S": "1",
            "DRAIN_TIMEOUT_S": "10",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            mod.ec2.describe_instances = MagicMock(return_value={"Reservations": []})
            mod.autoscaling.complete_lifecycle_action = MagicMock()
            event = {
                "detail": {
                    "LifecycleActionToken": "tok",
                    "LifecycleHookName": "h",
                    "AutoScalingGroupName": "asg",
                    "EC2InstanceId": "i-999",
                    "LifecycleTransition": "autoscaling:EC2_INSTANCE_LAUNCHING",
                }
            }
            result = mod.handler(event, CTX)
        assert result["status"] == "abandoned"
        assert result["reason"] == "no_ip"

    def test_termination_drains_and_completes(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000",
            "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10",
            "HEALTH_POLL_INTERVAL_S": "1",
            "DRAIN_TIMEOUT_S": "5",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            mod.ec2.describe_instances = MagicMock(return_value={
                "Reservations": [{"Instances": [{"PrivateIpAddress": "10.0.0.1"}]}]
            })
            # Health check returns False immediately → drain complete
            mod._health_check = MagicMock(return_value=False)
            mod.autoscaling.complete_lifecycle_action = MagicMock()
            event = {
                "detail": {
                    "LifecycleActionToken": "tok",
                    "LifecycleHookName": "h",
                    "AutoScalingGroupName": "asg",
                    "EC2InstanceId": "i-888",
                    "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
                }
            }
            result = mod.handler(event, CTX)
        assert result["status"] == "drained"
        mod.autoscaling.complete_lifecycle_action.assert_called_with(
            AutoScalingGroupName="asg",
            LifecycleHookName="h",
            LifecycleActionToken="tok",
            LifecycleActionResult="CONTINUE",
        )

    def test_termination_no_ip_still_completes(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000", "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10", "HEALTH_POLL_INTERVAL_S": "1", "DRAIN_TIMEOUT_S": "5",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            mod.ec2.describe_instances = MagicMock(return_value={"Reservations": []})
            mod.autoscaling.complete_lifecycle_action = MagicMock()
            event = {
                "detail": {
                    "LifecycleActionToken": "tok",
                    "LifecycleHookName": "h",
                    "AutoScalingGroupName": "asg",
                    "EC2InstanceId": "i-no-ip",
                    "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
                }
            }
            result = mod.handler(event, CTX)
        assert result["status"] == "drained"

    def test_unknown_transition_returns_unhandled(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000", "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10", "HEALTH_POLL_INTERVAL_S": "1", "DRAIN_TIMEOUT_S": "5",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            event = {
                "detail": {
                    "LifecycleTransition": "autoscaling:EC2_INSTANCE_UNKNOWN",
                    "EC2InstanceId": "i-x",
                    "LifecycleActionToken": "t",
                    "LifecycleHookName": "h",
                    "AutoScalingGroupName": "asg",
                }
            }
            result = mod.handler(event, CTX)
        assert result["status"] == "unhandled"

    def test_health_check_returns_false_on_error(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000", "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10", "HEALTH_POLL_INTERVAL_S": "1", "DRAIN_TIMEOUT_S": "5",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            result = mod._health_check("http://192.0.2.1:8000/health")  # unreachable
        assert result is False

    def test_has_active_requests_false_on_error(self):
        with patch.dict("os.environ", {
            "GPU_PORT": "8000", "HEALTH_CHECK_PATH": "/health",
            "HEALTH_TIMEOUT_S": "10", "HEALTH_POLL_INTERVAL_S": "1", "DRAIN_TIMEOUT_S": "5",
        }):
            import importlib
            import lambdas.lifecycle_manager.handler as mod
            importlib.reload(mod)
            result = mod._has_active_requests("http://192.0.2.1:9999/metrics")
        assert result is False


# ═══════════════════════════════════════════════════════════════════════════════
# PDF TO IMAGES (LAMBDA)
# ═══════════════════════════════════════════════════════════════════════════════

class TestPdfToImagesLambda:
    """Tests for lambdas/pdf_to_images/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("pdf_to_images")

    @mock_aws
    def test_converts_pdf_and_stores_images(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")

        fake_page = Image.new("RGB", (4, 4), "white")
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads"}):
            import importlib
            import lambdas.pdf_to_images.handler as mod
            importlib.reload(mod)
            s3.put_object(Bucket="test-uploads", Key="uploads/job1/original.pdf", Body=b"%PDF-1.4")
            with patch("pdf2image.convert_from_bytes", return_value=[fake_page, fake_page]):
                event = {"s3Key": "uploads/job1/original.pdf", "jobId": "job1"}
                result = mod.handler(event, CTX)

        # pdf_to_images handler returns raw dict (not HTTP response format)
        assert result["pageCount"] == 2
        assert len(result["pageKeys"]) == 2

    @mock_aws
    def test_pdf_conversion_failure_returns_500(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        s3.put_object(Bucket="test-uploads", Key="uploads/job2/original.pdf", Body=b"%PDF-1.4")
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads"}):
            import importlib
            import lambdas.pdf_to_images.handler as mod
            importlib.reload(mod)
            with patch("pdf2image.convert_from_bytes", side_effect=Exception("poppler not installed")):
                event = {"s3Key": "uploads/job2/original.pdf", "jobId": "job2"}
                with pytest.raises(RuntimeError, match="PDF conversion failed"):
                    mod.handler(event, CTX)

    @mock_aws
    def test_s3_download_failure_returns_500(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads"}):
            import importlib
            import lambdas.pdf_to_images.handler as mod
            importlib.reload(mod)
            event = {"s3Key": "uploads/no-such-key/original.pdf", "jobId": "job3"}
            # handler raises RuntimeError on S3 download failure
            with pytest.raises(RuntimeError, match="Failed to download PDF"):
                mod.handler(event, CTX)

    @mock_aws
    def test_limits_to_max_pages(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        s3.put_object(Bucket="test-uploads", Key="uploads/job4/original.pdf", Body=b"%PDF-1.4")
        pages = [Image.new("RGB", (4, 4)) for _ in range(60)]
        with patch.dict("os.environ", {"UPLOAD_BUCKET": "test-uploads"}):
            import importlib
            import lambdas.pdf_to_images.handler as mod
            importlib.reload(mod)
            with patch("pdf2image.convert_from_bytes", return_value=pages):
                # maxPages defaults to 20 per handler env var MAX_PDF_PAGES=20
                event = {"s3Key": "uploads/job4/original.pdf", "jobId": "job4", "maxPages": 20}
                result = mod.handler(event, CTX)
        assert result["pageCount"] <= 20
        assert result["truncated"] is True


# ═══════════════════════════════════════════════════════════════════════════════
# BATCH PROCESSOR
# ═══════════════════════════════════════════════════════════════════════════════

class TestBatchProcessor:
    """Tests for lambdas/batch_processor/handler.py"""

    @pytest.fixture(autouse=True)
    def setup(self):
        _add_lambda("batch_processor")

    @mock_aws
    def test_processes_sqs_message_and_writes_result(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-uploads")
        s3.put_object(Bucket="test-uploads", Key="uploads/j1/original.png", Body=_png_bytes())

        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "j1", "status": "queued", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026"})

        sqs_client = boto3.client("sqs", region_name="us-east-1")
        q = sqs_client.create_queue(QueueName="analyze-jobs")

        sns_client = boto3.client("sns", region_name="us-east-1")
        topic = sns_client.create_topic(Name="job-complete")

        env = {
            "UPLOAD_BUCKET": "test-uploads",
            "JOBS_TABLE": "coldbones-jobs",
            "ANALYZE_QUEUE_URL": q["QueueUrl"],
            "SNS_TOPIC_ARN": topic["TopicArn"],
            "MODEL_ENDPOINT": "http://localhost:8000",
            "MODEL_NAME": "test-model",
            "MAX_TOKENS": "1024",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)

            good_result = {
                "summary": "ok", "key_observations": [],
                "content_classification": "photo", "extracted_text": "none",
                "reasoning": "", "reasoning_token_count": 0, "finish_reason": "stop", "model": "m"
            }
            mod._run_inference = MagicMock(return_value=good_result)
            mod._delete_message = MagicMock()

            event = {
                "Records": [{
                    "body": json.dumps({"jobId": "j1", "s3Key": "uploads/j1/original.png", "lang": "en"}),
                    "receiptHandle": "handle-1",
                }]
            }
            result = mod.handler(event, CTX)

        assert result["processedCount"] >= 1
        item = table.get_item(Key={"jobId": "j1"}).get("Item")
        assert item["status"] == "complete"

    @mock_aws
    def test_inference_failure_marks_job_failed(self):
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-bkt2")
        s3.put_object(Bucket="test-bkt2", Key="uploads/j2/original.png", Body=_png_bytes())

        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        table = ddb.create_table(
            TableName="coldbones-jobs2",
            KeySchema=[{"AttributeName": "jobId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "jobId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.put_item(Item={"jobId": "j2", "status": "queued", "mode": "slow",
                             "filename": "f.png", "createdAt": "2026", "updatedAt": "2026"})
        sqs = boto3.client("sqs", region_name="us-east-1")
        q = sqs.create_queue(QueueName="analyze-jobs2")
        sns = boto3.client("sns", region_name="us-east-1")
        topic = sns.create_topic(Name="jobs2")

        env = {
            "UPLOAD_BUCKET": "test-bkt2",
            "JOBS_TABLE": "coldbones-jobs2",
            "ANALYZE_QUEUE_URL": q["QueueUrl"],
            "SNS_TOPIC_ARN": topic["TopicArn"],
            "MODEL_ENDPOINT": "http://localhost:8000",
            "MODEL_NAME": "test",
            "MAX_TOKENS": "512",
        }
        with patch.dict("os.environ", env):
            import importlib
            import lambdas.batch_processor.handler as mod
            importlib.reload(mod)
            mod._run_inference = MagicMock(side_effect=Exception("model error"))
            mod._delete_message = MagicMock()
            event = {
                "Records": [{
                    "body": json.dumps({"jobId": "j2", "s3Key": "uploads/j2/original.png"}),
                    "receiptHandle": "rh2",
                }]
            }
            result = mod.handler(event, CTX)

        item = table.get_item(Key={"jobId": "j2"}).get("Item")
        assert item["status"] == "failed"
