# Coldbones

> Upload an image or PDF. Get intelligent analysis back. Inference runs locally on a desktop RTX 5090 via [LM Studio](https://lmstudio.ai), reachable from AWS via Tailscale Funnel.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Deploy to AWS](#deploy-to-aws)
4. [Deploy the Frontend](#deploy-the-frontend)
5. [Local Development](#local-development)
6. [Desktop Worker](#desktop-worker)
7. [Project Structure](#project-structure)
8. [Environment Variables](#environment-variables)

---

## Architecture

```
Browser
  │  (1) POST /api/presign  →  presigned S3 PUT URL
  │  (2) PUT file directly to S3  (no Lambda, full throughput)
  │  (3) POST /api/analyze  →  202 + jobId
  │  (4) GET  /api/status/{jobId}  (poll every 4 s)
  │
  ▼
CloudFront (app.omlahiri.com)
  ├── /api/*  →  API Gateway  →  Lambda (Python)
  │                                    │
  │                     fast path: async Lambda invoke → analyze_orchestrator
  │                    (desktop unreachable: fallback to SQS queue below)
  │
  │                     offline path: SQS queue
  │                          │
  │                     Desktop worker (home RTX 5090)
  │                          │  long-polls SQS
  │                          └→ LM Studio (Qwen3.5-35B, via Tailscale Funnel)
  │                                    │
  │                          DynamoDB job record ← writes result
  │
  └── /*  →  S3 (React SPA)
```

### How it works

1. **Presign** — `/api/presign` returns a signed S3 PUT URL scoped to a single key, content type, and 5-minute expiry.
2. **Upload** — browser PUTs the file directly to S3, bypassing Lambda's 10 MB limit.
3. **Analyze** — `/api/analyze` accepts `{s3Key, lang, mode}` and always returns `202 + jobId` immediately.
   - **fast** mode: `analyze_router` checks if the desktop is alive (pings `/v1/models`). If yes, it invokes `analyze_orchestrator` asynchronously and returns. If the desktop is offline, it falls back to the SQS queue.
   - **offline** mode: always enqueues to SQS; the desktop worker picks it up when available.
4. **Status** — browser polls `/api/status/{jobId}` which reads DynamoDB. Terminal states: `COMPLETED` (with result) or `FAILED` (with error message).
5. **Desktop worker** — `worker/worker.py` runs on the RTX 5090. It long-polls SQS, downloads uploads from S3, calls LM Studio locally, and writes results back to DynamoDB.

### CDK Stacks

| Stack | Resources |
|---|---|
| **ColdbonesStorage** | S3 (uploads + site), CloudFront, DynamoDB, Route53, ACM |
| **ColdbonesQueue** | SQS (main + DLQ), SNS |
| **ColdbonesApi** | Lambda × 5, API Gateway, IAM |

---

## Prerequisites

1. **AWS CLI** configured (`aws configure`) for `us-east-1`
2. **Node.js 20+** and **Python 3.12+** installed
3. CDK dependencies installed:
   ```bash
   cd infrastructure && npm install
   ```
4. Desktop worker set up — see [worker/SETUP.md](worker/SETUP.md)

---

## Deploy to AWS

```bash
# From the repo root — deploys Storage → Queue → Api in order:
./scripts/deploy.sh

# Or deploy individual stacks:
./scripts/deploy.sh storage
./scripts/deploy.sh queue
./scripts/deploy.sh api
```

First-time deploy order:

```
1. deploy.sh storage   → creates S3, CloudFront, DynamoDB
2. deploy.sh queue     → creates SQS queue (needed by Api lambdas)
3. deploy.sh api       → creates Lambdas + API Gateway
4. Set cdk.json:       coldbones.apiGatewayDomain = <domain from cdk-outputs.json>
5. deploy.sh storage   → adds CloudFront /api/* behavior pointing at API Gateway
6. deploy-frontend.sh  → builds React app and syncs to S3
```

After deploying, the app is live at **https://app.omlahiri.com**.

---

## Deploy the Frontend

```bash
./scripts/deploy-frontend.sh
```

Builds the Vite app, syncs it to S3, and invalidates the CloudFront cache. Reads bucket name and distribution ID from `scripts/cdk-outputs.json`.

---

## Local Development

### Backend (FastAPI — local dev only)

The `backend/` server is a local dev shim. It accepts the same API contract as the Lambda functions but runs entirely in-process: uploads are stored in memory, and inference goes directly to LM Studio via Tailscale.

```bash
cd backend
pip install -r requirements.txt
LM_STUDIO_URL=https://seratonin.tail40ae2c.ts.net uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Set `VITE_API_BASE_URL=http://localhost:8000` (or leave empty to use CloudFront in production).

---

## Desktop Worker

The worker runs on the home RTX 5090. See **[worker/SETUP.md](worker/SETUP.md)** for full setup instructions including Tailscale Funnel config, LM Studio, and AWS SSM parameters.

Quick start once the desktop is configured:

```bash
cd worker
pip install -r requirements.txt
cp .env.example .env   # fill in ANALYZE_QUEUE_URL, UPLOAD_BUCKET, JOBS_TABLE
python worker.py
```

The worker long-polls SQS, downloads each uploaded file from S3, converts images/PDFs to base64 PNGs, calls LM Studio, and writes the result back to DynamoDB.

---

## Project Structure

```
coldbones/
├── backend/               FastAPI local-dev server (not deployed to AWS)
├── frontend/              React + Vite + TypeScript SPA
│   └── src/
│       ├── components/    AnalysisPanel, FilePreview, UploadZone, …
│       ├── hooks/         useUpload, useAnalysis
│       ├── i18n/          EN / HI / ES / BN translations
│       └── types/
├── infrastructure/        AWS CDK (TypeScript)
│   └── lib/               storage-stack, queue-stack, api-stack
├── lambdas/               Python Lambda handlers
│   ├── analyze_orchestrator/   Downloads S3 file → LM Studio → DynamoDB
│   ├── analyze_router/         Routes fast (async invoke) vs offline (SQS)
│   ├── batch_processor/        Tombstone — messages handled by desktop worker
│   ├── get_presigned_url/      S3 presigned PUT URL generation
│   ├── job_status/             DynamoDB job state polling
│   └── desktop_client.py       Shared: SSM-cached LM Studio OpenAI client
├── worker/                Desktop SQS worker (runs on RTX 5090)
│   ├── worker.py
│   ├── SETUP.md
│   └── requirements.txt
└── scripts/
    ├── deploy.sh          CDK deploy (Storage / Queue / Api)
    ├── deploy-frontend.sh S3 sync + CloudFront invalidation
    └── validate.sh        End-to-end API smoke test
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `LM_STUDIO_URL` | `http://localhost:1234` | LM Studio base URL (Tailscale Funnel for remote) |
| `LM_STUDIO_API_KEY` | *(required)* | LM Studio API key — LM Studio → Developer → API Keys |
| `MODEL_NAME` | `qwen/qwen3.5-35b-a3b` | Model identifier |
| `MAX_INFERENCE_TOKENS` | `8192` | Max tokens per response |
| `MAX_PDF_PAGES` | `20` | Max PDF pages to render and send |

### Worker (`worker/.env`)

| Variable | Required | Description |
|---|---|---|
| `ANALYZE_QUEUE_URL` | ✓ | SQS queue URL (from `cdk-outputs.json`) |
| `UPLOAD_BUCKET` | ✓ | S3 bucket name for uploads |
| `JOBS_TABLE` | ✓ | DynamoDB table name |
| `LM_STUDIO_URL` | ✓ | LM Studio base URL (usually `http://localhost:1234`) |
| `LM_STUDIO_API_KEY` | ✓ | LM Studio API key — LM Studio → Developer → API Keys |
| `MODEL_NAME` | | Defaults to `Qwen/Qwen3.5-35B-A3B-AWQ` |

### Lambda environment (set via CDK / cdk.json)

| Variable | Description |
|---|---|
| `UPLOAD_BUCKET` | S3 uploads bucket |
| `JOBS_TABLE` | DynamoDB jobs table |
| `ORCHESTRATOR_FUNCTION_ARN` | ARN of `analyze_orchestrator` Lambda |
| `ANALYZE_QUEUE_URL` | SQS queue URL |
| `/coldbones/desktop-url` *(SSM)* | Tailscale Funnel URL for LM Studio |
| `/coldbones/desktop-port` *(SSM)* | LM Studio port (443 via Funnel) |
| `/coldbones/desktop-apikey` *(SSM, SecureString)* | LM Studio API key (Bearer token) |

---

## Supported Languages

- English (`en`)
- Hindi (`hi`)
- Spanish (`es`)
- Bengali (`bn`)
