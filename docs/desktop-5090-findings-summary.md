# Coldbones Desktop 5090 Findings Summary

## Goal

Run Qwen3.5 35B A3B (Q4 quant, multimodal) on a physical RTX 5090 desktop to reduce cloud GPU cost, while keeping the website globally reachable.

## What We Found In The Current System

### 1) Existing request path (current production design)

1. Browser asks `POST /api/presign`
2. Browser uploads file directly to S3 using presigned URL
3. Browser calls `POST /api/analyze` (`fast` or `slow` mode)
4. Backend routes:
   - **Fast**: synchronous Lambda -> orchestrator -> vLLM on cloud GPU
   - **Slow**: SQS queue -> batch processor Lambda -> vLLM on cloud GPU
5. Browser polls `GET /api/status/{jobId}` for completion

### 2) Current infrastructure footprint

- `ColdbonesStorage`: S3 + CloudFront + Route53 + DynamoDB
- `ColdbonesQueue`: SQS + SNS
- `ColdbonesNetwork`: VPC + endpoints + SGs
- `ColdbonesGpu`: ASG + EC2 GPU lifecycle + SSM params + CloudWatch scheduling/alarms
- `ColdbonesApi`: REST + WS APIs and all Lambda handlers

### 3) Key technical findings

- Frontend already works with **polling status**; WebSocket is optional, not required for MVP.
- There is **legacy duplicate code** in multiple lambdas (historical LM Studio paths and duplicated handlers).
- Some documentation is stale (mentions Bedrock/Claude while implementation now uses vLLM-style flow).
- Main complexity/cost driver is cloud GPU lifecycle orchestration (ASG, lifecycle hooks, GPU warmup scheduling).

## Recommended Runtime Choice

## vLLM (recommended)

- Best fit for production-style OpenAI-compatible API + concurrency.
- Strong alignment with existing code patterns (`chat.completions`, image+text message payloads).
- Better operational path than LM Studio for server workloads.

## LM Studio (not primary)

- Great for local testing and UX, not ideal as the primary internet-facing production runtime.

## Ollama (secondary option)

- Easiest local setup, but less flexible than vLLM for this project shape and future scaling controls.

## Assumption to validate early

Q4 format must be in a runtime-compatible quantization format for your chosen serving stack (for example AWQ/GPTQ-style flow if serving via vLLM).

## Target Architecture (Global Web + Local 5090)

## Keep in cloud

- CloudFront + S3 static site hosting
- API Gateway + lightweight Lambdas for control plane
- S3 for uploads/results
- SQS for async jobs
- DynamoDB for job state

## Move to desktop

- Inference execution (vLLM)
- File processing + multimodal inference worker (queue consumer)

## Remove from cloud

- Cloud GPU ASG and GPU lifecycle orchestration
- Dedicated cloud VPC/network stack used only for GPU path
- GPU scheduling lambdas and lifecycle glue
- Optional: websocket notification stack (if polling remains the UX)

## Information Flow (target)

1. User uploads image/PDF via presigned URL to S3.
2. API writes job metadata to DynamoDB and sends SQS message.
3. Desktop worker (outbound HTTPS only) long-polls SQS.
4. Worker downloads S3 object, performs conversion + inference on local vLLM.
5. Worker writes result to DynamoDB (+ optional S3 result artifact).
6. Frontend polls `/api/status/{jobId}` and displays result.

## Networking and Security Decisions

- Prefer **outbound-only** desktop connectivity (no home router inbound port exposure).
- Desktop worker uses scoped AWS IAM credentials:
  - SQS receive/delete
  - S3 get/put on controlled prefixes
  - DynamoDB update/get for jobs table
  - Optional CloudWatch metrics/logs
- Keep public domain and frontend globally available via CloudFront.
- Use queue-based backpressure to protect the desktop GPU.

## Migration Principles

1. Keep user-facing API contract stable during transition.
2. Cut over compute plane first (desktop worker), then remove cloud GPU stacks.
3. De-risk with a reversible rollout and explicit rollback path.
