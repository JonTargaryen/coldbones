# Coldbones

> Upload an image or PDF. Get intelligent analysis back. Powered by a self-hosted Qwen3.5-35B-A3B vision-language model on AWS.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Research Findings](#research-findings)
3. [Architecture Overview](#architecture-overview)
4. [Fast & Slow Modes](#fast--slow-modes)
5. [Infrastructure as Code (AWS CDK)](#infrastructure-as-code-aws-cdk)
6. [User Stories (MVP)](#user-stories-mvp)
7. [Implementation Phases](#implementation-phases)
8. [Open Questions & Risks](#open-questions--risks)

---

## Project Overview

**Coldbones** is an MVP web application where users upload an image or PDF and receive AI-generated analysis — a description, key observations, and structured feedback — powered by a self-hosted quantized vision-language model.

### Tech Stack Summary

| Layer | Choice | Rationale |
|---|---|---|
| **Frontend** | React SPA (Vite) on S3 + CloudFront | Simple, fast, no SSR needed for MVP |
| **API** | API Gateway + Lambda (Python) | Serverless, pay-per-use, scales to zero |
| **File Storage** | S3 (upload bucket) | Pre-signed URLs for direct browser upload |
| **PDF Processing** | Lambda (pdf2image + Poppler) | Convert PDF pages to images before model inference |
| **Model Serving** | Qwen3.5-35B-A3B (Q4 GGUF) on EC2 GPU | Self-hosted VLM with OpenAI-compatible API |
| **GPU Instance** | EC2 g5.2xlarge (1× A10G 24GB) or g5.12xlarge (4× A10G) | Right-sized for Q4 quant (~18-22GB VRAM) |
| **Model Server** | vLLM or llama.cpp server | OpenAI-compatible `/v1/chat/completions` endpoint |
| **IaC** | AWS CDK (TypeScript) | AWS-native, imperative, strong typing |
| **Auth** | None (MVP) — rate limiting via API Gateway | Simplest path; add Cognito later |
| **Queue** | SQS (slow mode) | Decouple upload from inference; batch processing |
| **Orchestration** | Step Functions (slow mode) | Manage spot instance lifecycle + retry logic |
| **Compute (fast)** | EC2 On-Demand g5.2xlarge (always warm) | Instant inference, GPU stays hot |
| **Compute (slow)** | EC2 Spot g5.2xlarge via ASG | Up to 90% savings, batch-oriented |
| **Scaling** | Auto Scaling Group + EventBridge + Lambda | Spin up/down based on queue depth + time-of-day |
| **Notifications** | SNS + WebSocket (API Gateway v2) | Notify users when slow-mode results are ready |

---

## Research Findings

### Model: Qwen3.5-35B-A3B

**Critical discovery: This IS a native Vision-Language Model.** Unlike Qwen3-30B-A3B (text-only), Qwen3.5 has a built-in vision encoder via early fusion training on multimodal tokens.

| Property | Detail |
|---|---|
| **Type** | Causal LM with Vision Encoder (Image-Text-to-Text) |
| **Total params** | 35B (3B activated — MoE with 256 experts, 8 routed + 1 shared) |
| **Architecture** | Gated Delta Networks + sparse MoE (hybrid attention) |
| **Context length** | 262,144 native, extensible to 1,010,000 via YaRN |
| **Vision input** | Images normalized by vision encoder, video frames supported |
| **Output** | Text (up to 81,920 tokens recommended for complex tasks) |
| **Languages** | 201 languages and dialects |
| **Released** | February 2026 |

#### GGUF Q4 Quantization Sizes (Unsloth)

| Variant | Size |
|---|---|
| UD-IQ4_XS | 17.5 GB |
| UD-IQ4_NL | 17.8 GB |
| Q4_K_S | 20.7 GB |
| MXFP4_MOE | 21.6 GB |
| Q4_K_M | 22.0 GB |
| UD-Q4_K_XL | 22.2 GB |

**Recommendation:** `Q4_K_M` (22 GB) for best quality-to-size ratio, or `UD-IQ4_XS` (17.5 GB) if VRAM is tight on a single A10G (24 GB).

### PDF Support

**Neither Qwen3.5 nor any current open VLM natively accepts PDF files.** The standard pipeline is:

1. User uploads PDF → stored in S3
2. Lambda function converts each PDF page to an image using `pdf2image` (backed by Poppler)
3. Page images are sent to the model as image inputs
4. Model analyzes each page and returns consolidated results

### Image Support & Limits

- **Natively supported formats:** JPEG, PNG, WebP, BMP, TIFF, GIF (first frame)
- **Resolution handling:** Images are normalized by the vision encoder. No hard pixel limit — the model's processor handles resizing. Each image encodes to a variable number of visual tokens.
- **Practical upload limit for MVP:** **20 MB per file** (API Gateway default max is 10 MB for synchronous; use S3 pre-signed URLs for larger files)
- **Batch limit for MVP:** Up to **10 files** per request (to keep inference time reasonable)

### AWS GPU Instance Options

| Instance | GPUs | VRAM | vCPUs | RAM | On-Demand $/hr | Notes |
|---|---|---|---|---|---|---|
| g5.xlarge | 1× A10G | 24 GB | 4 | 16 GB | ~$1.006 | Tight for Q4 + KV cache |
| g5.2xlarge | 1× A10G | 24 GB | 8 | 32 GB | ~$1.212 | **MVP sweet spot** — more CPU/RAM for preprocessing |
| g5.12xlarge | 4× A10G | 96 GB | 48 | 192 GB | ~$5.672 | For multi-GPU / higher throughput |
| g6.xlarge | 1× L4 | 24 GB | 4 | 16 GB | ~$0.805 | Newer, cheaper, but check framework support |
| g6e.2xlarge | 1× L40S | 48 GB | 8 | 64 GB | ~$1.861 | Comfortable headroom for Q4 |

**MVP Recommendation:** Start with `g5.2xlarge` (1× A10G 24 GB, 32 GB system RAM). If Q4_K_M (22 GB) is too tight with KV cache overhead, either drop to `UD-IQ4_XS` (17.5 GB) or upgrade to `g6e.2xlarge` (48 GB L40S).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USERS (Browser)                           │
│                                                                    │
│  React SPA (Vite)                                                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Mode Toggle   │  Upload Zone  │  Preview  │  Analysis Panel│   │
│  │  [⚡Fast|🐢Slow]│              │           │                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS
                            ▼
┌──────────────────── AWS CLOUD ──────────────────────────────────────┐
│                                                                    │
│  CloudFront ──► S3 (static site bucket)                            │
│                                                                    │
│  API Gateway (REST + WebSocket)                                    │
│  ├── POST /upload       → Lambda (get-presigned-url)               │
│  ├── POST /analyze      → Lambda (analyze-router)                  │
│  │                         ├─ mode=fast → direct model call        │
│  │                         └─ mode=slow → enqueue to SQS          │
│  ├── GET  /status/{id}  → Lambda (job-status)                      │
│  └── WSS  $connect      → Lambda (ws-connect)  [slow mode push]   │
│                                                                    │
│  ┌──────────── FAST PATH (synchronous) ──────────────────────┐     │
│  │                                                           │     │
│  │  Lambda (analyze-orchestrator)                            │     │
│  │  ├── Download from S3, preprocess                         │     │
│  │  ├── Call warm GPU instance /v1/chat/completions          │     │
│  │  └── Return result directly (target: <15s)                │     │
│  │                                                           │     │
│  │  EC2 On-Demand GPU (g5.2xlarge) ── ALWAYS WARM            │     │
│  │  ├── Qwen3.5-35B-A3B Q4 GGUF                             │     │
│  │  ├── llama.cpp server on :8000                            │     │
│  │  ├── Model pre-loaded in VRAM at boot                     │     │
│  │  └── Managed by ASG (min=1, max=1) with health checks    │     │
│  │                                                           │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                    │
│  ┌──────────── SLOW PATH (asynchronous, cost-optimized) ─────┐    │
│  │                                                           │     │
│  │  SQS Queue (analyze-jobs)                                 │     │
│  │  ├── Batches messages (up to 10 per poll)                 │     │
│  │  ├── Visibility timeout: 600s                             │     │
│  │  └── DLQ after 3 retries                                  │     │
│  │                                                           │     │
│  │  Step Functions (slow-mode-orchestrator)                   │     │
│  │  ├── 1. Check if GPU instance is running                  │     │
│  │  ├── 2. If not → launch Spot instance via ASG             │     │
│  │  ├── 3. Wait for model server health check                │     │
│  │  ├── 4. Process queued jobs (batch inference)             │     │
│  │  ├── 5. Write results to S3 + DynamoDB                    │     │
│  │  └── 6. Notify via SNS → WebSocket push                   │     │
│  │                                                           │     │
│  │  EC2 Spot GPU (g5.2xlarge) ── EPHEMERAL                   │     │
│  │  ├── Launched by ASG on queue activity                    │     │
│  │  ├── Spot interrupt handler (2-min warning → drain queue) │     │
│  │  ├── Auto-terminates after idle timeout (15 min)          │     │
│  │  └── Never runs overnight (scheduled scale-to-zero)       │     │
│  │                                                           │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                    │
│  S3 (upload bucket)                                                │
│  ├── /uploads/{uuid}/original.*                                    │
│  ├── /uploads/{uuid}/pages/*.png  (converted PDF pages)            │
│  └── /results/{uuid}/analysis.json (slow-mode results)             │
│                                                                    │
│  DynamoDB (job-status)                                             │
│  ├── PK: jobId                                                     │
│  ├── status: queued | processing | complete | failed               │
│  ├── mode: fast | slow                                             │
│  ├── result: analysis JSON (on completion)                         │
│  └── TTL: 24 hours                                                 │
│                                                                    │
│  ┌──────────── SCALING & LIFECYCLE ──────────────────────────┐     │
│  │                                                           │     │
│  │  EventBridge Scheduled Rules                              │     │
│  │  ├── "overnight-shutdown" → 11 PM: scale slow ASG to 0   │     │
│  │  ├── "morning-warmup"    → 7 AM: allow slow ASG scaling   │     │
│  │  └── "fast-mode-schedule" → optional weekend shutdown     │     │
│  │                                                           │     │
│  │  CloudWatch Alarms                                        │     │
│  │  ├── SQS ApproximateNumberOfMessages > 0 → scale up       │     │
│  │  ├── SQS idle 15 min → scale down to 0                   │     │
│  │  ├── Fast GPU unhealthy → auto-replace via ASG            │     │
│  │  └── Spot interruption → trigger drain + relaunch         │     │
│  │                                                           │     │
│  │  Lambda (lifecycle-manager)                               │     │
│  │  ├── Handles ASG lifecycle hooks                          │     │
│  │  ├── Waits for model server to be healthy before          │     │
│  │  │   marking instance InService                           │     │
│  │  └── Drains in-flight requests on termination             │     │
│  │                                                           │     │
│  └───────────────────────────────────────────────────────────┘     │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Request Flow: Fast Mode (Synchronous)

1. **User** toggles to ⚡ **Fast** mode and uploads file(s)
2. **Frontend** uploads to S3 via pre-signed URL
3. **Frontend** calls `POST /analyze` with `{ mode: "fast", s3Key: "..." }`
4. **Lambda** directly calls the warm GPU instance's `/v1/chat/completions`
5. **Model** processes and returns analysis (target: <15 seconds)
6. **Lambda** returns JSON result synchronously
7. **Frontend** renders result immediately

### Request Flow: Slow Mode (Asynchronous, Cost-Optimized)

1. **User** toggles to 🐢 **Slow** mode and uploads file(s)
2. **Frontend** uploads to S3 via pre-signed URL
3. **Frontend** calls `POST /analyze` with `{ mode: "slow", s3Keys: [...] }`
4. **Lambda** enqueues job(s) to SQS, writes `queued` status to DynamoDB, returns `jobId`
5. **Frontend** establishes WebSocket connection for push notifications
6. **SQS message triggers Step Functions** orchestrator:
   a. Check if Spot GPU instance is running
   b. If not → set ASG desired capacity to 1, wait for instance + health check
   c. Pull batch of messages from SQS
   d. Process sequentially on Spot GPU
   e. Write results to S3 + DynamoDB
   f. Push notification via SNS → API Gateway WebSocket → user's browser
7. **Frontend** receives push notification, fetches result from `/status/{jobId}`
8. **After 15 min idle** (no new SQS messages) → ASG scales Spot instance to 0

---

## Fast & Slow Modes

Coldbones operates in two mutually selectable processing modes. Users pick their mode before submitting — the frontend remembers their last choice.

### Mode Comparison

| Dimension | ⚡ Fast Mode | 🐢 Slow Mode |
|---|---|---|
| **Response time** | <15 seconds (synchronous) | 1–10 minutes (asynchronous) |
| **GPU instance** | On-Demand g5.2xlarge, always warm | Spot g5.2xlarge, launched on demand |
| **Cost (GPU)** | ~$1.21/hr (24/7 = ~$870/mo) | ~$0.36/hr Spot (~70% savings), only when jobs exist |
| **Availability** | 99.9% (On-Demand guarantee) | Best-effort (Spot can be interrupted, auto-retried) |
| **Batch support** | One file at a time (sequential) | Up to 50 files batched per session |
| **Result delivery** | Inline in the HTTP response | WebSocket push + polling fallback |
| **Overnight** | Runs 24/7 (or optional weekend shutdown) | Scales to zero every night at 11 PM |
| **Best for** | Interactive use, single-file analysis, demos | Bulk document processing, background jobs, cost-conscious usage |

### Fast Mode — How It Works

The fast-mode GPU instance is managed by an Auto Scaling Group with `min=1, max=1`. This guarantees:
- **Self-healing**: if the instance crashes or fails health checks, ASG replaces it automatically
- **Model pre-loaded**: user data script downloads weights and starts llama.cpp on boot; model stays resident in VRAM
- **No cold start for users**: the model is always hot and ready

The `analyze-orchestrator` Lambda calls the GPU instance directly over the VPC private network. The entire round-trip (download from S3 → preprocess → inference → response) targets **under 15 seconds** for a single image.

**Cost control options for fast mode:**
- Optional **scheduled scale-to-zero** on weekends via EventBridge (saves ~28% monthly if unused Sat/Sun)
- Optional **instance type downgrade** to g5.xlarge ($1.006/hr) if memory allows
- Swap to **Reserved Instance** or **Savings Plan** for 30–60% savings on the On-Demand price if usage is sustained

### Slow Mode — How It Works

Slow mode is designed around **"pay only for what you use"** principles:

1. **Job enqueuing**: `POST /analyze` immediately returns a `jobId`. Files are referenced by S3 key, not re-uploaded. Jobs enter an SQS queue.

2. **GPU spin-up on demand**: A CloudWatch alarm monitors `SQS ApproximateNumberOfMessages`. When messages appear:
   - ASG desired capacity set to 1
   - A Spot instance launches (with fallback to On-Demand if Spot unavailable)
   - User data script installs drivers, downloads model weights (cached on EBS snapshot for fast boot), starts llama.cpp
   - Lifecycle hook holds the instance in `Pending:Wait` until `/health` returns 200
   - Instance marked `InService` — ready to process

3. **Batch processing**: A Step Functions workflow polls SQS, processes jobs sequentially (or in small batches), and writes results to S3 + DynamoDB.

4. **Result notification**: On completion, SNS publishes to a topic. A Lambda subscriber pushes the result through API Gateway WebSocket to the user's browser. If the user has disconnected, they can poll `GET /status/{jobId}`.

5. **Idle spin-down**: If no SQS messages arrive for **15 minutes**, a CloudWatch alarm triggers ASG scale-to-zero. The Spot instance is terminated. No GPU cost accrues.

6. **Overnight shutdown**: An EventBridge scheduled rule at **11:00 PM** (configurable) sets the slow-mode ASG `max=0`, preventing any launches overnight. At **7:00 AM**, it restores `max=1` to allow on-demand scaling.

7. **Spot interruption handling**: The instance runs a spot-interrupt-handler daemon that:
   - Listens for the 2-minute interruption warning via instance metadata
   - Drains the current inference request (finishes it if possible)
   - Re-enqueues any unfinished SQS messages (changes visibility timeout)
   - ASG automatically launches a replacement

### Spin-Up Time Budget (Slow Mode)

| Phase | Duration | Notes |
|---|---|---|
| Spot instance launch | 30–90s | Depends on AZ availability |
| NVIDIA driver init | 10–20s | Pre-baked in AMI to skip install |
| Model weight load from EBS | 30–60s | EBS snapshot pre-loaded with Q4_K_M weights |
| llama.cpp server start + VRAM load | 20–40s | Model loaded into GPU memory |
| Health check pass | 5–10s | `/health` returns 200 |
| **Total cold start** | **~2–4 minutes** | Subsequent jobs while warm: instant |

### Cost Comparison (Estimated Monthly)

| Scenario | Fast Mode Cost | Slow Mode Cost | Combined |
|---|---|---|---|
| Always-on, no traffic | $870 (GPU) + $35 (NAT) | $0 (scaled to zero) | $905 |
| 8 hrs/day weekdays only | $870 or $200 (scheduled) | $0 | $200–870 |
| 100 jobs/day, 5 min each | $870 (always on) | ~$18 (8.3 hrs Spot) | ~$18–888 |
| 1000 jobs/day, batch | $870 (always on) | ~$55 (45 hrs Spot) | ~$55–925 |

---

## Infrastructure as Code (AWS CDK)

### CDK Stack Breakdown

The project will have **7 CDK stacks**, deployed in order:

#### Stack 1: `NetworkStack`
- VPC with public + private subnets (2 AZs)
- Security groups (fast GPU SG, slow GPU SG, Lambda SG)
- NAT Gateway (for Lambda in private subnet to reach internet)
- VPC endpoints for S3, DynamoDB, SQS (reduce NAT costs)

#### Stack 2: `StorageStack`
- S3 bucket for static site (React SPA)
- S3 bucket for file uploads (lifecycle: auto-delete after 24h)
- S3 prefix `/results/` for slow-mode analysis outputs
- CloudFront distribution pointing to static site bucket
- CORS configuration on upload bucket
- DynamoDB table `coldbones-jobs` (PK: jobId, TTL: 24h)

#### Stack 3: `ModelStack` (Fast Mode GPU)
- Auto Scaling Group: `min=1, max=1, desired=1` (On-Demand)
- Launch template: g5.2xlarge, custom AMI (NVIDIA drivers pre-installed)
- EBS snapshot with Q4_K_M model weights attached at `/models/`
- User data script: mount EBS, start llama.cpp systemd service
- ELB health check on `:8000/health` (interval 60s, threshold 3)
- IAM role: S3 read, CloudWatch agent
- Security group: ingress on 8000 from Lambda SG only

#### Stack 4: `SpotModelStack` (Slow Mode GPU)
- Auto Scaling Group: `min=0, max=1, desired=0` (Spot with On-Demand fallback)
- Mixed instances policy: `g5.2xlarge`, `g5.xlarge`, `g6.xlarge`
- Spot allocation strategy: `capacity-optimized`
- Same launch template as fast mode (custom AMI + EBS snapshot)
- Lifecycle hook `EC2_INSTANCE_LAUNCHING` → Lambda health-check waiter
- Lifecycle hook `EC2_INSTANCE_TERMINATING` → Lambda graceful drain
- Step scaling policies:
  - Scale up: SQS messages > 0 for 1 min → desired = 1
  - Scale down: SQS messages = 0 for 15 min → desired = 0
- Spot interrupt handler installed via user data (systemd service)

#### Stack 5: `QueueStack` (Slow Mode Pipeline)
- SQS queue `coldbones-analyze-jobs`:
  - Visibility timeout: 600s
  - Message retention: 24h
  - DLQ `coldbones-analyze-jobs-dlq` after 3 failed receives
- Step Functions state machine `slow-mode-orchestrator`
- EventBridge pipe: SQS → Step Functions trigger
- SNS topic `coldbones-job-complete` for result notifications

#### Stack 6: `ApiStack`
- API Gateway REST API with CORS
- API Gateway WebSocket API (for slow-mode push notifications)
- Lambda functions:
  - `get-presigned-url`: Generates S3 pre-signed PUT URL
  - `analyze-router`: Inspects `mode` field, routes to fast or slow path
  - `analyze-orchestrator`: Downloads file, preprocesses, calls model (fast mode)
  - `pdf-to-images`: Converts PDF pages to images (Lambda layer with Poppler)
  - `batch-processor`: Pulls SQS, calls GPU, writes results (slow mode)
  - `job-status`: Returns job status from DynamoDB (polling fallback)
  - `ws-connect` / `ws-disconnect`: WebSocket connection management
  - `ws-notify`: Pushes results to connected WebSocket clients
  - `lifecycle-manager`: Handles ASG lifecycle hooks (health check + drain)
- Lambda layers:
  - `pdf2image` + Poppler binaries
  - `Pillow` for image handling
  - `openai` Python SDK (to call model server)
- API Gateway usage plan + throttling (rate limiting for open access)

#### Stack 7: `ScheduleStack` (Scaling Lifecycle)
- EventBridge scheduled rules:
  - `overnight-shutdown`: 11 PM daily → Lambda sets slow ASG `max=0`
  - `morning-warmup`: 7 AM daily → Lambda restores slow ASG `max=1`
  - `weekend-fast-shutdown` (optional, disabled by default): Friday 11 PM → fast ASG `min=0`
  - `weekend-fast-warmup` (optional): Monday 7 AM → fast ASG `min=1`
- CloudWatch alarms:
  - Slow ASG SQS-based scaling alarms
  - Fast ASG unhealthy host alarm
  - Billing threshold alarm (via AWS Budgets)
- CloudWatch dashboard `coldbones-cost-ops`
- CDK context variables: `overnightShutdownHour`, `morningWarmupHour`, `timezone`, `enableWeekendFastShutdown`

### CDK Project Structure

```
coldbones/
├── README.md
├── infrastructure/
│   ├── bin/
│   │   └── app.ts                    # CDK app entry point
│   ├── lib/
│   │   ├── network-stack.ts
│   │   ├── storage-stack.ts
│   │   ├── model-stack.ts            # Fast-mode ASG (On-Demand)
│   │   ├── spot-model-stack.ts       # Slow-mode ASG (Spot)
│   │   ├── queue-stack.ts            # SQS + Step Functions + SNS
│   │   ├── api-stack.ts
│   │   └── schedule-stack.ts         # EventBridge rules + alarms
│   ├── constructs/
│   │   ├── gpu-asg.ts                # Shared ASG construct (fast/slow)
│   │   └── model-launch-template.ts  # Shared launch template
│   ├── cdk.json
│   ├── tsconfig.json
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── UploadZone.tsx        # Drag-and-drop file upload
│   │   │   ├── FilePreview.tsx       # Image viewer / PDF viewer
│   │   │   ├── AnalysisPanel.tsx     # Model response display
│   │   │   ├── BatchUpload.tsx       # Multi-file upload
│   │   │   ├── ModeToggle.tsx        # ⚡Fast / 🐢Slow toggle
│   │   │   └── JobTracker.tsx        # Slow-mode job status panel
│   │   ├── hooks/
│   │   │   ├── useUpload.ts          # Pre-signed URL + S3 upload logic
│   │   │   ├── useAnalysis.ts        # Fast-mode: POST /analyze (sync)
│   │   │   ├── useSlowAnalysis.ts    # Slow-mode: submit + track jobs
│   │   │   └── useWebSocket.ts       # WebSocket connection for push
│   │   ├── contexts/
│   │   │   └── ModeContext.tsx        # Fast/Slow mode state provider
│   │   ├── utils/
│   │   │   └── validation.ts         # File type + size validation
│   │   └── types/
│   │       └── index.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── lambdas/
│   ├── get_presigned_url/
│   │   └── handler.py
│   ├── analyze_router/
│   │   └── handler.py                # Routes to fast or slow path
│   ├── analyze_orchestrator/
│   │   └── handler.py                # Fast-mode: sync inference
│   ├── batch_processor/
│   │   └── handler.py                # Slow-mode: SQS → GPU → results
│   ├── pdf_to_images/
│   │   └── handler.py
│   ├── job_status/
│   │   └── handler.py                # GET /status/{jobId}
│   ├── lifecycle_manager/
│   │   └── handler.py                # ASG lifecycle hooks
│   ├── schedule_manager/
│   │   └── handler.py                # Overnight shutdown / warmup
│   ├── ws_connect/
│   │   └── handler.py                # WebSocket $connect
│   ├── ws_disconnect/
│   │   └── handler.py                # WebSocket $disconnect
│   └── ws_notify/
│       └── handler.py                # Push results to WebSocket
├── scripts/
│   ├── setup-model-server.sh         # EC2 user data script
│   ├── spot-interrupt-handler.sh     # Spot interruption daemon
│   ├── build-ami.sh                  # Packer script for custom GPU AMI
│   └── deploy.sh                     # Full deployment script
└── step-functions/
    └── slow-mode-orchestrator.asl.json  # State machine definition
```

---

## User Stories (MVP)

### Epic 1: File Upload

#### US-1.1: Single Image Upload
**As a** user  
**I want to** upload a single image file  
**So that** I can get AI analysis of it  

**Acceptance Criteria:**
- [ ] User can click to browse or drag-and-drop an image
- [ ] Accepted formats: JPEG, PNG, WebP, GIF, BMP, TIFF
- [ ] Files larger than 20 MB are rejected with a clear error message
- [ ] Files with wrong extensions/MIME types are rejected
- [ ] Upload progress bar shows during transfer
- [ ] On success, the image appears in the preview panel

**Technical Tasks:**
1. Create `UploadZone` React component with react-dropzone
2. Implement client-side validation in `validation.ts` (MIME type check + size check)
3. Create `get-presigned-url` Lambda that generates S3 pre-signed PUT URLs
4. Implement `useUpload` hook for the pre-signed URL flow
5. Configure S3 upload bucket with CORS for browser PUT
6. Add upload progress tracking via XMLHttpRequest or axios

---

#### US-1.2: Single PDF Upload
**As a** user  
**I want to** upload a PDF document  
**So that** I can get AI analysis of its contents  

**Acceptance Criteria:**
- [ ] User can upload a PDF file (`.pdf` MIME type)
- [ ] PDFs up to 20 MB / 50 pages are accepted
- [ ] PDFs beyond 50 pages are rejected with a message
- [ ] Upload progress is shown
- [ ] On success, the first page renders in the preview panel

**Technical Tasks:**
1. Extend `UploadZone` to accept `application/pdf`
2. Add PDF-specific validation (page count check using pdf.js on client side)
3. Extend `useUpload` hook for PDF uploads
4. Create `pdf-to-images` Lambda with Poppler Lambda layer
5. Integrate pdf2image library in Lambda for page→PNG conversion

---

#### US-1.3: Batch File Upload
**As a** user  
**I want to** upload multiple images or PDFs at once  
**So that** I can analyze a batch of documents efficiently  

**Acceptance Criteria:**
- [ ] User can select or drag multiple files (up to 10)
- [ ] Each file is validated independently
- [ ] Progress is shown per-file
- [ ] Invalid files show individual error messages without blocking valid ones
- [ ] All valid files appear in a thumbnail gallery in the preview panel

**Technical Tasks:**
1. Create `BatchUpload` component wrapping `UploadZone` for multi-file
2. Implement parallel pre-signed URL generation (batch Lambda call)
3. Add file queue management in `useUpload` hook
4. Create thumbnail gallery component for batch preview

---

### Epic 2: File Preview

#### US-2.1: Image Preview
**As a** user  
**I want to** see a preview of my uploaded image  
**So that** I can confirm it uploaded correctly before analysis  

**Acceptance Criteria:**
- [ ] Uploaded image renders in the preview panel at a reasonable size
- [ ] User can zoom in/out
- [ ] Preview loads from local file (before upload) for instant feedback
- [ ] After upload completes, preview switches to S3 URL

**Technical Tasks:**
1. Create `FilePreview` component with image rendering
2. Use `URL.createObjectURL()` for instant local preview
3. Add pinch-to-zoom / scroll-to-zoom functionality

---

#### US-2.2: PDF Preview
**As a** user  
**I want to** see a preview of my uploaded PDF  
**So that** I can confirm the right document was selected  

**Acceptance Criteria:**
- [ ] First page of PDF renders in the preview panel
- [ ] Page navigation (prev/next) for multi-page PDFs
- [ ] Page count displayed (e.g., "Page 2 of 12")
- [ ] Renders client-side using pdf.js (no server round-trip for preview)

**Technical Tasks:**
1. Integrate `pdfjs-dist` for client-side PDF rendering
2. Create PDF page navigation controls
3. Render PDF to canvas element

---

### Epic 3: AI Analysis

#### US-3.1: Automatic Initial Analysis
**As a** user  
**I want to** get an automatic AI analysis of my uploaded file without writing a prompt  
**So that** I can quickly understand what the AI sees in my image/document  

**Acceptance Criteria:**
- [ ] After upload completes, an "Analyze" button appears (NOT auto-triggered — user controls cost)
- [ ] Clicking Analyze sends the file for inference with a default system prompt
- [ ] Loading state shown during inference (with estimated time: ~10-30s for images, longer for PDFs)
- [ ] Analysis result includes:
  - **Summary**: 2-3 sentence overview of what the file contains
  - **Key Observations**: Bullet list of notable elements
  - **Content Type Classification**: What kind of image/document this is (photo, chart, invoice, receipt, diagram, handwriting, etc.)
  - **Extracted Text** (if applicable): Any readable text in the image/PDF
- [ ] Results render in a clean, formatted panel next to the preview

**Technical Tasks:**
1. Create `analyze-orchestrator` Lambda
2. Design default system prompt for balanced, useful initial analysis
3. Create OpenAI-compatible client call to model server
4. Build `AnalysisPanel` React component
5. Implement `useAnalysis` hook with loading/error/success states
6. Design response JSON schema and parse model output

**Default System Prompt (Draft):**
```
You are a precise visual analyst. Examine the provided image carefully and respond with:

1. **Summary**: A concise 2-3 sentence description of what this image contains.
2. **Key Observations**: A bullet list of the most notable or important elements.
3. **Content Classification**: Classify this as one of: photograph, screenshot, chart/graph, diagram, invoice/receipt, form/document, handwriting, artwork, map, medical image, or other (specify).
4. **Extracted Text**: If there is readable text in the image, transcribe it accurately. If no text, state "No text detected."

Be factual and specific. Do not speculate beyond what is clearly visible.
```

---

#### US-3.2: Batch Analysis
**As a** user  
**I want to** analyze all files in a batch upload  
**So that** I can process multiple documents in one session  

**Acceptance Criteria:**
- [ ] "Analyze All" button processes each file sequentially
- [ ] Progress indicator shows "Analyzing file 3 of 7..."
- [ ] Each file's result appears as it completes (streaming results)
- [ ] User can click on any file in the batch to see its individual analysis
- [ ] Total processing time estimate shown

**Technical Tasks:**
1. Implement sequential analysis queue in frontend
2. Extend `analyze-orchestrator` Lambda to handle batch references
3. Create batch results gallery component
4. Add per-file status tracking (pending/analyzing/complete/error)

---

#### US-3.3: PDF Multi-Page Analysis
**As a** user  
**I want to** get analysis of a multi-page PDF  
**So that** I can understand the document as a whole  

**Acceptance Criteria:**
- [ ] PDF pages are converted to images server-side
- [ ] Model receives all pages (up to a reasonable limit based on context window)
- [ ] Analysis covers the document holistically, not just page-by-page
- [ ] For PDFs with many pages, analysis is summarized with key pages highlighted

**Technical Tasks:**
1. Implement PDF→images pipeline in Lambda
2. Design multi-image prompt strategy (send pages as multiple images in one request)
3. Calculate token budget: each image ≈ 256 vision tokens → 50 pages ≈ 12,800 tokens (well within 262K context)
4. Create aggregate prompt for multi-page document analysis

---

### Epic 4: Infrastructure & Deployment

#### US-4.1: CDK Network Stack
**As a** developer  
**I want to** provision the VPC and networking via CDK  
**So that** all resources have secure, proper network connectivity  

**Acceptance Criteria:**
- [ ] VPC with 2 public + 2 private subnets across 2 AZs
- [ ] NAT Gateway in public subnet
- [ ] Security groups for EC2 (model server) and Lambda
- [ ] Model server SG allows inbound 8000 only from Lambda SG

**Technical Tasks:**
1. Initialize CDK TypeScript project
2. Create `NetworkStack` with VPC, subnets, security groups
3. Export VPC and SG references for other stacks

---

#### US-4.2: CDK Storage Stack
**As a** developer  
**I want to** provision S3 buckets and CloudFront via CDK  
**So that** the frontend is served and uploads are stored  

**Acceptance Criteria:**
- [ ] Static site S3 bucket with CloudFront distribution
- [ ] Upload S3 bucket with:
  - CORS allowing PUT from CloudFront domain
  - Lifecycle rule: delete objects after 24 hours
  - Server-side encryption (AES-256)
- [ ] CloudFront has HTTPS with default certificate

**Technical Tasks:**
1. Create `StorageStack` with both S3 buckets
2. Configure CloudFront distribution with OAC (Origin Access Control)
3. Set up bucket policies and CORS
4. Add lifecycle rule for upload bucket

---

#### US-4.3: CDK Model Stack
**As a** developer  
**I want to** provision the GPU EC2 instance with model serving via CDK  
**So that** the VLM is running and accessible to Lambda  

**Acceptance Criteria:**
- [ ] EC2 g5.2xlarge instance in private subnet
- [ ] Deep Learning AMI (or Ubuntu with NVIDIA drivers)
- [ ] User data script installs dependencies and starts model server
- [ ] Model weights stored on EBS volume (persists across restarts)
- [ ] Instance auto-restarts model server on reboot (systemd)
- [ ] Health check endpoint (`/health`) accessible from Lambda

**Technical Tasks:**
1. Create `ModelStack` with EC2 instance
2. Write `setup-model-server.sh` user data script
3. Configure EBS volume attachment
4. Create IAM role for EC2 (S3 read for model download, CloudWatch for logs)
5. Set up systemd service for llama.cpp / vLLM
6. Add CloudWatch agent for monitoring

---

#### US-4.4: CDK API Stack
**As a** developer  
**I want to** provision API Gateway and Lambda functions via CDK  
**So that** the frontend can communicate with the backend  

**Acceptance Criteria:**
- [ ] API Gateway REST API with CORS enabled
- [ ] Three Lambda functions deployed with correct IAM roles
- [ ] Lambda in VPC (same as model server) for internal communication
- [ ] API Gateway throttling: 10 requests/second, 100 burst
- [ ] Lambda timeout: 60s for presigned URL, 300s for analyze
- [ ] Lambda memory: 256 MB for presigned URL, 1024 MB for analyze, 2048 MB for PDF processing

**Technical Tasks:**
1. Create `ApiStack` with API Gateway + Lambdas
2. Create Lambda layers (pdf2image + Poppler, openai SDK, Pillow)
3. Configure Lambda VPC, IAM roles, timeouts, memory
4. Set up API Gateway throttling and CORS
5. Add API Gateway stage (prod)

---

### Epic 5: Validation & Error Handling

#### US-5.1: Client-Side Validation
**As a** user  
**I want to** get immediate feedback if my file is invalid  
**So that** I don't waste time uploading unsupported files  

**Acceptance Criteria:**
- [ ] Invalid file type → "Unsupported file type. Accepted: JPEG, PNG, WebP, GIF, BMP, TIFF, PDF"
- [ ] File too large → "File exceeds 20 MB limit. Please upload a smaller file."
- [ ] PDF too many pages → "PDF exceeds 50 page limit."
- [ ] Batch too many files → "Maximum 10 files per batch."
- [ ] Validation runs before any upload begins
- [ ] Error messages are user-friendly, not technical

**Technical Tasks:**
1. Implement MIME type validation (check both extension and file magic bytes)
2. Implement file size validation
3. Implement PDF page count validation (using pdf.js)
4. Create error toast/banner component
5. Write unit tests for all validation rules

---

#### US-5.2: Server-Side Validation
**As a** developer  
**I want to** validate files server-side  
**So that** the system is protected from malicious or corrupted uploads  

**Acceptance Criteria:**
- [ ] Lambda validates file magic bytes (not just extension)
- [ ] Lambda rejects files exceeding size limit
- [ ] Lambda validates PDF structure before processing
- [ ] Invalid files return 400 with descriptive error
- [ ] All validation errors are logged to CloudWatch

**Technical Tasks:**
1. Add magic byte validation in analyze Lambda (python-magic or manual header check)
2. Add S3 object size check before download
3. Add PDF corruption check in pdf-to-images Lambda
4. Implement structured error responses

---

### Epic 6: Fast & Slow Mode Selection

#### US-6.1: Mode Toggle
**As a** user  
**I want to** toggle between Fast and Slow mode before submitting files  
**So that** I can choose between instant results or cheaper batch processing  

**Acceptance Criteria:**
- [ ] A prominent toggle (⚡ Fast / 🐢 Slow) is visible in the upload interface
- [ ] Default mode is **Fast** for first-time visitors
- [ ] Selected mode persists in `localStorage` across sessions
- [ ] Switching mode before upload changes the processing path
- [ ] Mode cannot be changed after submitting (disabled until results return or job completes)
- [ ] Tooltip explains the trade-off: "Fast: instant results, higher cost. Slow: queued processing, lower cost."
- [ ] If fast-mode GPU is in a scheduled shutdown window, the toggle auto-defaults to Slow with an explanatory banner

**Technical Tasks:**
1. Create `ModeToggle` React component (segmented control or toggle button)
2. Store mode preference in `localStorage` and React context
3. Pass `mode` field in `POST /analyze` request body
4. Create `ModeContext` provider for app-wide mode awareness
5. Add conditional UI rendering based on active mode (sync result panel vs. job tracker)

---

#### US-6.2: Fast Mode — Synchronous Analysis
**As a** user in Fast mode  
**I want to** receive my analysis result in the same HTTP response  
**So that** I get near-instant feedback without waiting or polling  

**Acceptance Criteria:**
- [ ] `POST /analyze` with `mode: "fast"` returns the analysis JSON inline  
- [ ] Response time target: **<15 seconds** for a single image  
- [ ] Loading spinner with elapsed-time counter shown during inference  
- [ ] If the fast GPU is unavailable (health check failing), return a clear error suggesting Slow mode  
- [ ] Timeout at 60 seconds with a retry prompt if model is overloaded  
- [ ] Sequential processing: each file analyzed one at a time (no batching)

**Technical Tasks:**
1. Implement `analyze-router` Lambda that inspects `mode` field and routes accordingly
2. For fast mode: invoke `analyze-orchestrator` Lambda synchronously
3. `analyze-orchestrator` calls warm GPU `/v1/chat/completions` with 55s timeout
4. Return structured JSON or 504 Gateway Timeout on failure
5. Frontend `useAnalysis` hook handles synchronous fast-mode response
6. Add elapsed-time display in `AnalysisPanel`

---

#### US-6.3: Slow Mode — Asynchronous Job Submission
**As a** user in Slow mode  
**I want to** submit files and get a job ID back immediately  
**So that** I can close the browser and come back for results later  

**Acceptance Criteria:**
- [ ] `POST /analyze` with `mode: "slow"` returns `{ jobId, status: "queued", estimatedWait }` within 1 second  
- [ ] Supports batch submission: up to **50 files** in a single request  
- [ ] Each file creates a separate sub-job under the parent `jobId`  
- [ ] Frontend shows a job tracker panel with per-file status  
- [ ] Estimated wait time displayed (based on queue depth + GPU spin-up estimate)  
- [ ] Job ID is copy-able so user can check status from another device

**Technical Tasks:**
1. Create SQS queue `coldbones-analyze-jobs` with:
   - Visibility timeout: 600s
   - Message retention: 24 hours
   - Dead-letter queue after 3 failed receives
2. Create DynamoDB table `coldbones-jobs`:
   - PK: `jobId` (UUID)
   - Attributes: `status`, `mode`, `s3Keys[]`, `results[]`, `createdAt`, `updatedAt`
   - TTL: 24 hours on `expiresAt`
3. `analyze-router` Lambda for slow mode:
   - Generate `jobId` UUID
   - Write `queued` record to DynamoDB
   - Send SQS message(s) for each file (with `jobId` + `s3Key`)
   - Return `jobId` + estimated wait
4. Implement `useSlowAnalysis` React hook for job submission + tracking
5. Create `JobTracker` React component showing per-file status badges

---

#### US-6.4: Slow Mode — Result Delivery via WebSocket
**As a** user waiting for slow-mode results  
**I want to** receive a push notification when my analysis is ready  
**So that** I don't have to keep refreshing the page  

**Acceptance Criteria:**
- [ ] Frontend establishes a WebSocket connection after submitting a slow-mode job  
- [ ] When a job completes, the result pushes to the browser in real-time  
- [ ] If WebSocket disconnects, automatic reconnect with exponential backoff  
- [ ] Fallback: `GET /status/{jobId}` polling every 10 seconds if WebSocket unavailable  
- [ ] Completed results render in the same `AnalysisPanel` as fast-mode results  
- [ ] Browser notification (if permitted) when result arrives and tab is not focused

**Technical Tasks:**
1. Create API Gateway WebSocket API with `$connect`, `$disconnect`, `$default` routes
2. Create `ws-connect` Lambda to register connection IDs in DynamoDB
3. Create `ws-disconnect` Lambda to clean up connection IDs
4. On job completion: SNS publish → Lambda → API Gateway `postToConnection`
5. Implement `useWebSocket` React hook with reconnect logic
6. Add `GET /status/{jobId}` Lambda for polling fallback
7. Add browser Notification API integration for background tab alerts

---

#### US-6.5: Slow Mode — Batch Processing Pipeline
**As a** developer  
**I want to** process queued jobs efficiently on the Spot GPU  
**So that** slow-mode jobs complete reliably and cost-effectively  

**Acceptance Criteria:**
- [ ] SQS consumer pulls up to 10 messages per poll cycle  
- [ ] Jobs processed sequentially on the GPU (no concurrent inference on single A10G)  
- [ ] Each completed job: result written to S3 + DynamoDB updated to `complete`  
- [ ] Failed jobs: retried up to 3 times, then moved to DLQ with `failed` status in DynamoDB  
- [ ] Spot interruption: in-flight job re-enqueued, DynamoDB status reset to `queued`  
- [ ] Processing logs written to CloudWatch with `jobId` for traceability

**Technical Tasks:**
1. Create Step Functions state machine `slow-mode-orchestrator`:
   - State 1: `CheckGpuAvailability` (describe ASG instances)
   - State 2: `LaunchGpuIfNeeded` (update ASG desired capacity)
   - State 3: `WaitForHealthy` (poll `/health` with backoff, timeout 5 min)
   - State 4: `ProcessBatch` (Lambda that pulls SQS, calls GPU, writes results)
   - State 5: `NotifyCompletion` (SNS publish per completed job)
   - Error handler: catch Spot interruption, re-enqueue, retry from State 1
2. Create `batch-processor` Lambda (handles SQS → GPU → S3/DynamoDB)
3. Create `spot-interrupt-handler` script running on EC2 (polls metadata endpoint)
4. Configure SQS → EventBridge pipe to trigger Step Functions on new messages
5. Add structured CloudWatch logging with `jobId` correlation

---

### Epic 7: GPU Scaling & Lifecycle Management

#### US-7.1: Fast Mode — Always-Warm GPU via ASG
**As a** developer  
**I want to** keep the fast-mode GPU instance always running and self-healing  
**So that** fast-mode users never experience cold starts  

**Acceptance Criteria:**
- [ ] Fast-mode GPU runs in an ASG with `min=1, max=1, desired=1`  
- [ ] ASG uses On-Demand instances (no Spot for fast mode)
- [ ] Health check: HTTP GET to `:8000/health` every 60 seconds  
- [ ] If health check fails 3 times → instance replaced automatically  
- [ ] New instance has model pre-loaded via EBS snapshot (no re-download from HuggingFace)  
- [ ] Launch template uses custom AMI with NVIDIA drivers pre-installed  
- [ ] Replacement instance fully healthy within 4 minutes of failure detection

**Technical Tasks:**
1. Create launch template for fast-mode GPU (On-Demand, g5.2xlarge)
2. Create custom AMI with:
   - Ubuntu 22.04 + NVIDIA 535 driver + CUDA 12.x
   - llama.cpp pre-compiled
   - systemd service for llama.cpp server
3. Create EBS snapshot with Q4_K_M weights pre-loaded at `/models/`
4. Create ASG with ELB health check on `:8000/health`
5. User data script: attach EBS snapshot volume, start systemd service
6. Add CloudWatch alarm for `UnhealthyHostCount > 0`

---

#### US-7.2: Slow Mode — Spot Instance On-Demand Scaling
**As a** developer  
**I want to** launch Spot GPU instances only when there are queued jobs  
**So that** slow mode costs near-zero when idle  

**Acceptance Criteria:**
- [ ] Slow-mode ASG default: `min=0, max=1, desired=0`  
- [ ] When SQS `ApproximateNumberOfMessages > 0` for 1 minute → ASG desired = 1  
- [ ] When SQS has 0 messages for **15 minutes** → ASG desired = 0  
- [ ] ASG uses Spot instances with On-Demand fallback (mixed instances policy)  
- [ ] Instance types pool: `g5.2xlarge`, `g5.xlarge`, `g6.xlarge` (best Spot availability)  
- [ ] Spot allocation strategy: `capacity-optimized` (least likely to be interrupted)  
- [ ] Instance launch to first inference: **<4 minutes**

**Technical Tasks:**
1. Create launch template for slow-mode GPU (Spot, mixed instances policy)
2. Create ASG with mixed instances: 0% On-Demand base, 100% Spot
3. Configure Spot allocation strategy: `capacity-optimized`
4. Create CloudWatch alarm: SQS messages > 0 → step scaling policy (add 1)
5. Create CloudWatch alarm: SQS messages = 0 for 15 min → step scaling policy (remove 1)
6. Use same custom AMI + EBS snapshot as fast mode
7. Add lifecycle hook `EC2_INSTANCE_LAUNCHING`:
   - Lambda waits for `/health` 200, then completes hook
   - Timeout 5 minutes → abandon launch, ASG retries

---

#### US-7.3: Overnight Shutdown Schedule
**As a** developer  
**I want to** prevent GPU instances from running overnight  
**So that** costs are minimized during off-hours  

**Acceptance Criteria:**
- [ ] **Slow mode ASG**: EventBridge rule at 11:00 PM sets `max=0` (hard shutdown)  
- [ ] **Slow mode ASG**: EventBridge rule at 7:00 AM restores `max=1` (allow scaling)  
- [ ] **Fast mode ASG**: Optional EventBridge rule (disabled by default) for weekend shutdown  
- [ ] Any in-flight jobs at 11 PM are completed before instance terminates (graceful drain)  
- [ ] Jobs queued during overnight hours remain in SQS and process at 7 AM  
- [ ] Overnight window is configurable via CDK context variable  
- [ ] CloudWatch dashboard shows overnight savings

**Technical Tasks:**
1. Create EventBridge scheduled rule `overnight-shutdown`:
   - Cron: `0 23 * * ? *` (11 PM daily)
   - Target: Lambda that sets slow ASG `max=0, desired=0`
2. Create EventBridge scheduled rule `morning-warmup`:
   - Cron: `0 7 * * ? *` (7 AM daily)
   - Target: Lambda that restores slow ASG `max=1`
3. Create optional EventBridge rule `weekend-fast-shutdown`:
   - Cron: `0 23 ? * FRI *` (Friday 11 PM)
   - Target: Lambda that sets fast ASG `desired=0, min=0`
   - Matching `weekend-fast-warmup` on Monday 7 AM restores `min=1, desired=1`
4. Add ASG lifecycle hook `EC2_INSTANCE_TERMINATING`:
   - Lambda checks for in-flight inference, waits up to 5 min for completion
   - Completes lifecycle hook after drain
5. Add CDK context variables: `overnightShutdownHour`, `morningWarmupHour`, `timezone`
6. Create CloudWatch dashboard widget: GPU hours by time-of-day

---

#### US-7.4: Spot Interruption Handling
**As a** developer  
**I want to** gracefully handle EC2 Spot interruptions  
**So that** in-flight jobs are not lost and users are not impacted  

**Acceptance Criteria:**
- [ ] Spot interruption warning (2-minute notice) is detected within 5 seconds  
- [ ] Current inference job completes if estimated to finish within 90 seconds  
- [ ] If inference won't finish in time, job is re-enqueued to SQS with `requeued` status  
- [ ] DynamoDB job status reset from `processing` to `queued` for re-enqueued jobs  
- [ ] ASG launches a replacement Spot instance automatically  
- [ ] User sees status change: `processing → queued → processing` (transparent retry)  
- [ ] CloudWatch metric tracks Spot interruption frequency

**Technical Tasks:**
1. Create `spot-interrupt-handler.sh` script on EC2:
   - Polls `http://169.254.169.254/latest/meta-data/spot/instance-action` every 5s
   - On interrupt: signal llama.cpp to finish current request
   - If inference in progress: wait up to 90s, else re-enqueue
   - Change SQS message visibility timeout to 0 (re-enqueue immediately)
   - Update DynamoDB status to `queued`
2. Register script as systemd service (starts before llama.cpp)
3. Add CloudWatch custom metric: `SpotInterruptions` counter
4. Create EventBridge rule for EC2 Spot interruption events → Lambda notification
5. Test with `aws ec2 send-spot-instance-interruptions` (simulation)

---

### Epic 8: Cost Observability & Controls

#### US-8.1: Cost Dashboard
**As a** developer  
**I want to** see GPU compute costs and job throughput in a dashboard  
**So that** I can monitor spend and optimize mode allocation  

**Acceptance Criteria:**
- [ ] CloudWatch dashboard with:
  - GPU instance hours (fast vs. slow, daily)
  - Total jobs processed (fast vs. slow, daily)
  - Average inference latency by mode
  - SQS queue depth over time
  - Spot interruption count
  - Estimated daily/monthly cost by mode
- [ ] Alarm if estimated monthly GPU cost exceeds configurable threshold

**Technical Tasks:**
1. Create CloudWatch dashboard `coldbones-cost-ops` via CDK
2. Add custom metrics from Lambda: `JobsProcessed`, `InferenceLatencyMs`, `Mode`
3. Create billing alarm via AWS Budgets (configurable threshold)
4. Add GPU utilization metrics via CloudWatch agent on EC2
5. Create composite alarm: high cost + low job volume = suggest shutdown

---

## Implementation Phases

### Phase 1: Foundation — Fast Mode GPU (Week 1) 
> Core infrastructure + always-warm GPU responding to API calls

- [ ] Initialize CDK project with TypeScript
- [ ] Deploy `NetworkStack` (VPC, subnets, security groups, VPC endpoints)
- [ ] Deploy `StorageStack` (S3 buckets, CloudFront, DynamoDB table)
- [ ] Build custom GPU AMI (Ubuntu + NVIDIA drivers + llama.cpp + model weights on EBS snapshot)
- [ ] Deploy `ModelStack` — fast-mode ASG (On-Demand g5.2xlarge, `min=1`)
- [ ] **Verification:** `curl` the model server `/health` from within VPC
- [ ] **Verification:** `curl` with a base64 image and get a vision analysis response

### Phase 2: Fast Mode API (Week 2)
> Lambda → GPU, synchronous analysis, end-to-end

- [ ] Deploy `ApiStack` (API Gateway REST + Lambdas)
- [ ] Implement `get-presigned-url` Lambda
- [ ] Implement `analyze-router` Lambda (fast-mode path only)
- [ ] Implement `analyze-orchestrator` Lambda (images only first)
- [ ] **Verification:** Upload image to S3, `POST /analyze` with `mode=fast`, get response <15s
- [ ] Implement `pdf-to-images` Lambda with Poppler layer
- [ ] **Verification:** Upload a PDF, get page images converted, get analysis

### Phase 3: Frontend + Fast Mode Flow (Week 3)
> React SPA with mode toggle, upload, preview, results (fast mode complete)

- [ ] Scaffold React + Vite + TypeScript project
- [ ] Build `ModeToggle` component (defaulting to Fast)
- [ ] Build `ModeContext` provider
- [ ] Build `UploadZone` component with drag-and-drop
- [ ] Build `FilePreview` component (image + PDF viewer)
- [ ] Build `AnalysisPanel` component
- [ ] Wire up `useUpload` and `useAnalysis` hooks to API (fast mode)
- [ ] Deploy to S3 + CloudFront
- [ ] **Verification:** Full end-to-end fast-mode flow in browser

### Phase 4: Slow Mode Infrastructure (Week 4)
> Spot GPU, SQS queue, Step Functions, DynamoDB job tracking

- [ ] Deploy `SpotModelStack` — slow-mode ASG (Spot, `min=0, max=1`)
- [ ] Deploy `QueueStack` — SQS queue + DLQ, Step Functions state machine, SNS topic
- [ ] Implement `batch-processor` Lambda (SQS → GPU → S3/DynamoDB)
- [ ] Implement `job-status` Lambda (`GET /status/{jobId}`)
- [ ] Implement `lifecycle-manager` Lambda (ASG lifecycle hooks)
- [ ] Configure CloudWatch alarms for SQS-based scaling
- [ ] Create `spot-interrupt-handler.sh` EC2 daemon
- [ ] **Verification:** Enqueue a job via SQS → Spot instance launches → job processes → result in DynamoDB

### Phase 5: Slow Mode Frontend + WebSocket (Week 5)
> Async flow: submit → track → push notification → results

- [ ] Extend `analyze-router` Lambda for slow-mode path (enqueue to SQS)
- [ ] Create API Gateway WebSocket API
- [ ] Implement `ws-connect`, `ws-disconnect`, `ws-notify` Lambdas
- [ ] Build `JobTracker` React component
- [ ] Implement `useSlowAnalysis` hook (submit + poll)
- [ ] Implement `useWebSocket` hook (push notifications with reconnect)
- [ ] **Verification:** Submit slow-mode batch → track job status → receive WebSocket push → view results

### Phase 6: Scaling & Lifecycle (Week 6)
> Overnight shutdown, weekend schedules, cost dashboard

- [ ] Deploy `ScheduleStack` — EventBridge rules for overnight shutdown/warmup
- [ ] Implement `schedule-manager` Lambda (set ASG min/max/desired)
- [ ] Configure optional weekend fast-mode shutdown (disabled by default)
- [ ] Add ASG lifecycle hook for graceful termination (drain in-flight requests)
- [ ] Create CloudWatch dashboard `coldbones-cost-ops`
- [ ] Add billing alarm via AWS Budgets
- [ ] **Verification:** At 11 PM, slow ASG scales to 0; at 7 AM, scaling re-enabled; queued jobs process

### Phase 7: Polish & Harden (Week 7)
> Validation, error handling, batch support, rate limiting

- [ ] Add client-side + server-side validation
- [ ] Add batch upload support (up to 50 files in slow mode)
- [ ] Add API Gateway throttling
- [ ] Add error handling and user-friendly error messages
- [ ] Add loading states and UX polish
- [ ] Handle edge cases: fast GPU unavailable → suggest slow mode
- [ ] Handle edge cases: Spot interruption mid-job → transparent retry
- [ ] **Verification:** Test edge cases (large files, wrong types, batch, Spot interruptions, overnight queue)

### Phase 8: Future Enhancements (Post-MVP)
- [ ] Custom user prompts ("Ask a question about this document")
- [ ] Follow-up conversation about the uploaded file
- [ ] User authentication via Cognito
- [ ] Auto-mode selection: if queue depth > N, auto-route to slow mode
- [ ] Multi-model support (let users choose between models)
- [ ] Reserved Instances / Savings Plans for sustained fast-mode usage
- [ ] Multi-region Spot diversification for higher slow-mode availability
- [ ] OCR comparison mode (model OCR vs. Tesseract)

---

## Open Questions & Risks

### Questions to Resolve Before Building

1. **Model server framework**: llama.cpp vs. vLLM vs. KTransformers for Q4 GGUF on a single A10G?
   - llama.cpp: Best GGUF support, single-GPU, lower overhead
   - vLLM: Better throughput for concurrent users, but GGUF support may be limited for Qwen3.5's architecture
   - KTransformers: CPU-GPU heterogeneous computing, promising for MoE models, but newer
   - **Recommendation:** Start with llama.cpp server for simplicity and proven GGUF support

2. **VRAM fit**: Will Q4_K_M (22 GB) + KV cache + vision encoder fit in 24 GB A10G?
   - Vision encoder adds overhead during image processing
   - KV cache size depends on context length and batch size
   - **Mitigation:** Use UD-IQ4_XS (17.5 GB) to leave ~6.5 GB for KV cache + vision, or upgrade to g6e.2xlarge (48 GB L40S)

3. **Inference latency**: What's the expected response time per image on a Q4 model?
   - Estimated: 10-30 seconds for a single image analysis (depends on output length)
   - PDFs with many pages will take proportionally longer
   - **Mitigation:** Set realistic user expectations via UI; slow mode absorbs long-running jobs naturally

4. **Cost management**: Dual-mode architecture adds complexity — is it worth it?
   - Fast mode alone: $870/month (always-on GPU)
   - Slow mode alone: $18–55/month for typical usage (but no instant results)
   - Combined: best of both, but 7 CDK stacks + more Lambdas to maintain
   - **Recommendation:** Build fast mode first (Phases 1–3), add slow mode only if cost is a concern or batch use cases emerge

5. **Spot instance availability**: Will `g5.2xlarge` Spot capacity be reliably available?
   - Spot availability varies by AZ and time of day
   - g5 instances are popular for ML workloads — may see frequent interruptions
   - **Mitigation:** Mixed instance types (`g5.2xlarge`, `g5.xlarge`, `g6.xlarge`), `capacity-optimized` allocation, On-Demand fallback

6. **Slow-mode cold start**: Is 2–4 minutes acceptable for job start?
   - Users submitting slow-mode jobs expect a delay, but 4 min before processing even begins may feel slow
   - **Mitigation:** Pre-baked AMI + EBS snapshot avoids HuggingFace download; target <2 min cold start
   - **Alternative:** Keep a warm Spot instance during business hours (more cost, less latency)

7. **WebSocket vs. polling for slow mode**: Is WebSocket worth the complexity?
   - WebSocket gives instant push but needs connection management (connect, disconnect, reconnect)
   - Polling every 10s is simpler but less responsive
   - **Recommendation:** Implement polling first, add WebSocket as Phase 5 enhancement

### Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Q4 quant doesn't fit on single A10G with vision | Blocks MVP | Medium | Test first; fall back to smaller quant or larger GPU |
| llama.cpp doesn't support Qwen3.5 architecture yet | Blocks MVP | Low (GGUF published) | Fall back to vLLM with safetensors or KTransformers |
| Inference too slow for fast-mode target (<15s) | Degrades fast-mode UX | Medium | Reduce output tokens, optimize prompt, upgrade GPU |
| Spot interruptions during slow-mode inference | Delays slow-mode jobs | Medium | Interrupt handler re-enqueues; ASG auto-relaunches |
| Spot capacity unavailable for slow mode | Slow mode unusable | Low | Mixed instance types + On-Demand fallback in ASG |
| Cold start of Spot GPU exceeds 4 min target | Poor slow-mode experience | Low | Pre-baked AMI, EBS snapshot, lifecycle hook timeout |
| Overnight SQS messages pile up | Large morning processing burst | Low | SQS retention is 24h; morning warmup processes queue |
| WebSocket connection instability | Missed result notifications | Medium | Polling fallback; reconnect with exponential backoff |
| ASG lifecycle hook timeouts | Instance stuck in Pending:Wait | Low | 5 min timeout with abandon; CloudWatch alarm for stuck hooks |
| Dual-mode complexity hard to maintain | Slows development | Medium | Build fast mode first; slow mode is additive, can be disabled |

---

## Quick Start (Coming Soon)

```bash
# Prerequisites: Node.js 18+, AWS CLI configured, CDK CLI installed

# Deploy infrastructure
cd infrastructure
npm install
npx cdk deploy --all

# Deploy frontend
cd ../frontend
npm install
npm run build
aws s3 sync dist/ s3://<static-site-bucket>

# Test model server (from within VPC)
curl http://<model-server-ip>:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.5","messages":[{"role":"user","content":"Hello!"}]}'
```
