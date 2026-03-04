# Coldbones

> Upload an image or PDF. Get intelligent analysis back. Powered by **Amazon Bedrock** (Claude 3.5 Sonnet v2).

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Deploy to AWS](#deploy-to-aws)
4. [Point Your Domain](#point-your-domain)
5. [Deploy the Frontend](#deploy-the-frontend)
6. [Local Development](#local-development)
7. [Project Structure](#project-structure)
8. [Fast & Slow Modes](#fast--slow-modes)
9. [Environment Variables](#environment-variables)

---

## Architecture

```
Browser
  │  (1) POST /api/presign  →  presigned S3 PUT URL
  │  (2) PUT file directly to S3
  │  (3) POST /api/analyze  →  fast: sync Bedrock response
  │                            slow: SQS job, poll /api/status/{jobId}
  │
  ▼
CloudFront (app.omlahiri.com)
  ├── /api/*  →  API Gateway  →  Lambda (Python + boto3)
  │                                    │
  │                              Amazon Bedrock
  │                        (anthropic.claude-3-5-sonnet-20241022-v2:0)
  │
  └── /*  →  S3 (React SPA)
```

### CDK Stacks

| Stack | Resources |
|---|---|
| **ColdbonesStorage** | S3 (upload + site), CloudFront, DynamoDB, Route53, ACM |
| **ColdbonesQueue** | SQS (main + DLQ), SNS |
| **ColdbonesApi** | Lambda × 5, API Gateway, IAM (Bedrock) |

---

## Prerequisites

1. **AWS CLI** configured (`aws configure`) for `us-east-1`
2. **Bedrock model access** enabled in the AWS Console
   → *Bedrock → Model access → Request access* → enable **Claude 3.5 Sonnet v2**
3. **Node.js 20+** and **Python 3.12+** installed
4. CDK dependencies installed:
   ```bash
   cd infrastructure && npm install
   ```

---

## Deploy to AWS

```bash
# From the repo root:
./scripts/deploy.sh
```

This bootstraps CDK (if needed) then deploys all three stacks in order.
At the end, the script prints the **Route 53 nameservers** you need to paste into Squarespace.

> **Immediate testing** — you can use the CloudFront URL shown in the `CloudFrontDomain` output right away, before DNS changes.

---

## Point Your Domain

After `deploy.sh` completes, copy the four nameservers from the output (e.g. `ns-XXXX.awsdns-XX.com`).

1. Log in to [Squarespace Domains](https://account.squarespace.com/domains)
2. Select **omlahiri.com** → **DNS Settings** → **Nameservers**
3. Switch to **Custom nameservers** and paste all four
4. Save — DNS propagation typically takes 10–60 minutes.

Once propagated, the app is live at **https://app.omlahiri.com**.

---

## Deploy the Frontend

Build the React app and push it to S3:

```bash
./scripts/deploy-frontend.sh
```

This reads `scripts/cdk-outputs.json` (written by `deploy.sh`) to find the bucket name
and CloudFront distribution ID, then syncs the Vite build output and creates a cache invalidation.

---

## Local Development

### Backend (FastAPI)

```bash
cd backend
cp .env.example .env     # set AWS_REGION + BEDROCK_MODEL_ID if needed
pip install -r requirements.txt
uvicorn main:app --reload
```

API available at `http://localhost:8000`. AWS credentials from `aws configure` are used automatically.

### Frontend

```bash
cd frontend
cp .env.example .env     # set VITE_API_BASE_URL=http://localhost:8000
npm install
npm run dev
```

Open `http://localhost:5173`.

---

## Project Structure

```
coldbones/
├── backend/               FastAPI local dev server
│   ├── main.py
│   └── requirements.txt
├── frontend/              React + Vite + TypeScript
│   └── src/
│       ├── components/    AnalysisPanel, FilePreview, UploadZone, …
│       ├── hooks/         useUpload, useAnalysis, useSlowAnalysis
│       ├── i18n/          EN / HI / ES / BN translations
│       └── types/
├── infrastructure/        AWS CDK (TypeScript)
│   ├── bin/app.ts
│   └── lib/               storage-stack, queue-stack, api-stack
├── lambdas/               Python Lambda handlers
│   ├── analyze_orchestrator/   Bedrock InvokeModel (sync)
│   ├── analyze_router/         Fast vs slow routing
│   ├── batch_processor/        SQS → Bedrock → DynamoDB
│   ├── get_presigned_url/      S3 presigned PUT
│   └── job_status/             DynamoDB job polling
└── scripts/
    ├── deploy.sh
    └── deploy-frontend.sh
```

---

## Fast & Slow Modes

| Mode | Flow | Latency |
|---|---|---|
| **Fast** | Sync Bedrock call through Lambda | ~5–20 s |
| **Slow** | SQS → async Lambda → DynamoDB; browser polls `/api/status/{jobId}` | 20 s – several minutes |

Select the mode before submitting. Fast mode for single images; slow mode for large PDFs.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `us-east-1` | AWS region |
| `BEDROCK_MODEL_ID` | `anthropic.claude-3-5-sonnet-20241022-v2:0` | Bedrock model ID |

### Frontend (`frontend/.env`)

| Variable | Default (prod) | Description |
|---|---|---|
| `VITE_API_BASE_URL` | *(empty — same origin via CloudFront)* | API base URL override for local dev |

---

## Supported Languages

- 🇬🇧 English (`en`)
- 🇮🇳 Hindi (`hi`)
- 🇪🇸 Spanish (`es`)
- 🇧🇩 Bengali (`bn`)
