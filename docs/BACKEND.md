# ColdBones — Backend & Worker Documentation

> AWS Lambda functions (Python 3.12), FastAPI dev server, and desktop SQS worker.

---

## Lambda Functions

All Lambdas run Python 3.12 on ARM64 (Graviton2) for 20% cost savings. Dependencies are bundled via CDK asset bundling with pip.

### 1. get_presigned_url (POST /api/presign)

**Purpose:** Generate a short-lived S3 presigned PUT URL for direct browser uploads.

**Input:**
```json
{
  "filename": "photo.jpg",
  "contentType": "image/jpeg"
}
```

**Output:**
```json
{
  "uploadUrl": "https://coldbones-uploads.s3.amazonaws.com/...",
  "s3Key": "uploads/<uuid>_photo.jpg"
}
```

**Behavior:**
- Generates UUID-prefixed S3 key to prevent collisions
- Presigned URL expires in 5 minutes
- Content-Type must match during PUT (S3 signature verification)

**Config:** 10s timeout, 128 MB memory

---

### 2. analyze_router (POST /api/analyze)

**Purpose:** Single entry point for all analysis requests. Routes to the correct inference provider.

**Input:**
```json
{
  "s3Key": "uploads/<uuid>_photo.jpg",
  "filename": "photo.jpg",
  "lang": "en",
  "mode": "fast",
  "provider": "auto"
}
```

**Output:** `202 { "jobId": "<uuid>", "status": "processing" }`

**Routing logic:**
1. Write job to DynamoDB (status=QUEUED)
2. Determine provider:
   - `auto` or `cloud` → Bedrock On-Demand
   - `local` + desktop alive → async invoke orchestrator Lambda
   - `local` + desktop offline → enqueue to SQS
   - `cloud-cmi` → orchestrator with Bedrock CMI
   - `mode='offline'` → always SQS
3. Return 202 immediately (non-blocking)

**Desktop health check:** Calls `is_desktop_alive()` which pings `/v1/models` on the Tailscale Funnel URL with a 4-second timeout.

**Config:** 30s timeout, 256 MB memory

---

### 3. analyze_orchestrator (async invoke)

**Purpose:** The inference workhorse. Downloads file, processes through AI model, saves results.

**Trigger:** Async Lambda.Invoke from analyze_router (fire-and-forget).

**Pipeline:**
1. Download file from S3 upload bucket
2. Detect file type via magic bytes (PNG, JPEG, PDF, video)
3. Convert to optimized PNG data-URLs:
   - Images: resize to max 1568px, JPEG 85% quality
   - PDFs: extract up to 20 pages as individual PNGs
   - Videos: extract up to 20 frames
4. Build multimodal prompt (system instructions + data-URLs)
5. Call inference provider:
   - `bedrock_ondemand_client` → Bedrock Converse API
   - `desktop_client` → OpenAI-compatible LM Studio
   - `bedrock_client` → Legacy Bedrock CMI
6. Parse structured JSON response
7. Write result JSON to S3 (`results/<jobId>.json`)
8. Update DynamoDB: status=COMPLETED, store result
9. On failure: status=FAILED + error message

**Config:** 10 min timeout, 256 MB memory

---

### 4. job_status (GET /api/status/{jobId})

**Purpose:** Return current job status, result, and streaming partial text.

**Output (QUEUED):**
```json
{ "status": "QUEUED" }
```

**Output (PROCESSING with streaming):**
```json
{ "status": "PROCESSING", "partial_text": "This image shows..." }
```

**Output (COMPLETED):**
```json
{
  "status": "COMPLETED",
  "result": {
    "summary": "...",
    "description": "...",
    "insights": ["..."],
    "observations": ["..."],
    "ocr_text": "...",
    "content_classification": "photograph",
    "chain_of_thought": "...",
    "usage": { "input_tokens": 1200, "output_tokens": 800 },
    "processing_time_ms": 15234,
    "model": "qwen3-vl-235b",
    "provider": "bedrock-ondemand"
  }
}
```

**Config:** 10s timeout, 128 MB memory

---

### 5. health (GET /api/health)

**Purpose:** Inline Lambda returning hardcoded health status for the frontend.

**Output:**
```json
{
  "status": "ok",
  "model": "qwen3-vl",
  "provider": "Bedrock",
  "model_loaded": true,
  "providers": {
    "local": { "name": "Local", "status": "configured" },
    "cloud": { "name": "Cloud", "status": "configured" }
  }
}
```

**Config:** 5s timeout, 128 MB memory

---

## Inference Clients

### bedrock_ondemand_client.py (Default)

**Model:** `qwen.qwen3-vl-235b-a22b` (Qwen3 VL 235B MoE)  
**API:** Bedrock Converse API (unified, model-agnostic)  
**Cost:** $0.35/M input tokens, $1.40/M output tokens (~$0.003/image)

**Advantages:**
- Pay-per-token (zero cost at idle)
- No cold start (<1s)
- Automatic scaling
- Foundation-model agnostic API

**Retry:** Exponential backoff for transient errors (max 3 retries)

### desktop_client.py (Local GPU)

**Model:** `Qwen/Qwen3.5-35B-A3B-AWQ` (quantized, fits 32GB VRAM)  
**Endpoint:** Tailscale Funnel URL (discovered via SSM parameters)  
**API:** OpenAI-compatible (LM Studio)  
**Cost:** $0 (home GPU)

**Connection:**
- SSM params: `/coldbones/desktop-url` + `/coldbones/desktop-port`
- URL cached for 60s per Lambda container (avoids repeated SSM calls)
- Health check: ping `/v1/models` with 4s timeout
- Inference timeout: 580s (large PDFs: 30-90s per page)

### bedrock_client.py (Legacy CMI)

**Model:** ARN from SSM `/coldbones/bedrock-model-arn`  
**API:** `invoke_model` (raw Qwen prompt template, not Converse)  
**Billing:** 5-min windows

**Status:** Backward-compatible fallback. Kept for users who imported custom models.

### logger.py

Structured JSON logging with configurable levels. Integrates with CloudWatch Logs and Lambda Powertools patterns.

---

## FastAPI Dev Server (`backend/main.py`)

Local-only development server that simulates the Lambda/API Gateway stack.

### Routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/presign` | Synthetic presigned URL (local storage) |
| PUT | `/api/localupload/{token}/{filename}` | Receive XHR PUT (memory store) |
| POST | `/api/analyze` | Direct inference (synchronous, no polling) |
| GET | `/api/health` | Probe LM Studio `/v1/models` |

### Key differences from production:
- **Synchronous analysis** — returns 200 with result (no 202 → polling flow)
- **In-memory file storage** — no S3 (files stored in `_local_store` dict)
- **Direct LM Studio** — calls local LM Studio via `http://localhost:1234`
- **Model auto-detect** — queries `/v1/models` on startup

### Configuration:
- `LM_STUDIO_URL` — default `http://localhost:1234`
- CORS: `localhost:5173` (Vite), `localhost:4173` (preview), `*`

### Testing:
- **228 tests, 95.19% coverage**
- Uses pytest + pytest-cov + moto (AWS mock)
- Tests cover: presign, analyze, health, error handling, multipart uploads

---

## Desktop Worker (`worker/worker.py`)

Long-running Python process on the RTX 5090 machine. Long-polls SQS and processes jobs via LM Studio.

### Architecture

```
worker.py
    │
    ├── Wait for LM Studio health (/v1/models)
    │
    ├── Main loop:
    │   ├── sqs.receive_message(MaxMessages=1, WaitTimeSeconds=20)
    │   ├── Download file from S3
    │   ├── Detect type (magic bytes)
    │   ├── Convert to PNG data-URLs (max 1568px, JPEG 85%)
    │   ├── For PDFs: extract pages (up to 20)
    │   ├── For videos: extract frames (up to 20)
    │   ├── Call LM Studio (OpenAI chat completions)
    │   ├── Parse structured JSON response
    │   ├── Write result to S3 + DynamoDB
    │   ├── Delete SQS message
    │   └── On failure (3x): mark FAILED, skip
    │
    └── SIGTERM/SIGINT → graceful shutdown (finish current job)
```

### Configuration (environment variables):

| Variable | Description |
|---|---|
| `QUEUE_URL` | SQS queue URL |
| `UPLOAD_BUCKET` | S3 bucket for uploads |
| `JOBS_TABLE` | DynamoDB table name |
| `LM_STUDIO_URL` | LM Studio endpoint (default: `http://localhost:1234`) |
| `MODEL_NAME` | Model identifier |
| `MAX_TOKENS` | Max output tokens |
| `MAX_PDF_PAGES` | Max PDF pages to process (default: 20) |
| `MAX_VIDEO_FRAMES` | Max video frames to extract (default: 20) |

### Deployment:
- **Systemd service:** `coldbones-worker@.service` (auto-restart, journald logging)
- **Setup guide:** `worker/SETUP.md`
- **Requirements:** Python 3.10+, AWS credentials, LM Studio running

### Resilience:
- **Poison messages:** After 3 failed deliveries (SQS redrive policy), moved to DLQ
- **Visibility timeout:** 900s (15 min) per message — prevents dual-processing
- **Graceful shutdown:** SIGTERM sets `_running = False`, finishes current job before exiting
- **Health gate:** Won't start polling until LM Studio is responsive, infinite retry for connection to the server
