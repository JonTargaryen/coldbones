# ColdBones — System Architecture

> **Version 1.0** · A multimodal vision-language analysis platform built on AWS serverless + local GPU inference.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                   │
│   React 18 + TypeScript + Vite SPA (S3 → CloudFront → app.omlahiri.com)│
│                                                                         │
│   ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐  │
│   │UploadZone│  │FilePreview│ │AnalysisPanel│ │JobTracker│  │ModeToggle│ │
│   │(drag/drop│  │(PDF/img/ │ │(results + │  │(slow-mode│  │(fast/  │  │
│   │ + paste) │  │ video)   │ │ streaming)│  │ sidebar) │  │ slow)  │  │
│   └────┬─────┘  └─────────┘  └───────────┘  └──────────┘  └────────┘  │
│        │                                                                │
│   ┌────┴──────────────────────────────────────────────────────────────┐ │
│   │  Hooks: useUpload · useAnalysis · useSlowAnalysis · useEstimate  │ │
│   │         useHistory · useToast                                     │ │
│   └────┬──────────────────────────────────────────────────────────────┘ │
│        │ fetch() / XHR                                                  │
└────────┼────────────────────────────────────────────────────────────────┘
         │
    CloudFront /api/* proxy
         │
┌────────┼────────────────────────────────────────────────────────────────┐
│        ▼         AWS HTTP API Gateway (v2)                              │
│   ┌─────────┐  ┌──────────────┐  ┌─────────┐  ┌──────────┐            │
│   │ presign │  │analyze_router│  │job_status│  │  health   │            │
│   │  POST   │  │    POST      │  │   GET    │  │   GET     │            │
│   │/api/    │  │/api/analyze  │  │/api/     │  │/api/      │            │
│   │presign  │  │              │  │status/   │  │health     │            │
│   └────┬────┘  └──────┬───────┘  │{jobId}   │  └──────────┘            │
│        │              │          └────┬──────┘                           │
│   ┌────▼────┐    ┌────▼───────────┐  │                                  │
│   │S3 Upload│    │ Route Decision │  │                                  │
│   │ Bucket  │    │                │  │                                  │
│   │(presign │    │ provider=auto  │  │                                  │
│   │ PUT URL)│    │   → Bedrock OD │  │                                  │
│   └─────────┘    │ provider=local │  │                                  │
│                  │   (alive)      │  │                                  │
│                  │   → Orchestr.  │  │                                  │
│                  │ provider=local │  │                                  │
│                  │   (offline)    │  │                                  │
│                  │   → SQS Queue  │──┼──────────────┐                   │
│                  └────┬───────────┘  │              │                   │
│                       │              │              ▼                   │
│              ┌────────▼──────────┐   │    ┌─────────────────┐           │
│              │analyze_orchestrator│  │    │  SQS Analysis   │           │
│              │ (10 min timeout)  │   │    │     Queue       │           │
│              │                   │   │    │ (16 min vis.    │           │
│              │ S3 download       │   │    │  timeout)       │           │
│              │ → image optimize  │   │    └────────┬────────┘           │
│              │ → inference call  │   │             │                    │
│              │ → DynamoDB write  │   │             │ long-poll          │
│              │ → S3 result       │   │             │                    │
│              └────────┬──────────┘   │    ┌────────▼────────┐           │
│                       │              │    │  Desktop Worker  │           │
│                       ▼              ▼    │  (RTX 5090)      │           │
│              ┌─────────────────┐          │  ┌────────────┐  │           │
│              │   DynamoDB      │◄─────────┤  │ LM Studio  │  │           │
│              │ (coldbones-jobs)│          │  │ Qwen3.5    │  │           │
│              │  jobId (PK)     │          │  │ 35B-A3B    │  │           │
│              │  status         │          │  └────────────┘  │           │
│              │  result         │          └──────────────────┘           │
│              │  24h TTL        │                                        │
│              └─────────────────┘                                        │
│                                                                         │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                    INFERENCE PROVIDERS                           │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │   │
│   │  │Bedrock       │  │Desktop       │  │Bedrock CMI           │  │   │
│   │  │On-Demand     │  │(Tailscale    │  │(Legacy, Custom       │  │   │
│   │  │(Default)     │  │ Funnel)      │  │ Model Import)        │  │   │
│   │  │              │  │              │  │                      │  │   │
│   │  │Qwen3 VL 235B │  │Qwen3.5      │  │Qwen2.5-VL           │  │   │
│   │  │$0.35/M in    │  │35B-A3B AWQ  │  │5-min billing         │  │   │
│   │  │$1.40/M out   │  │$0/inference │  │windows               │  │   │
│   │  └──────────────┘  └──────────────┘  └──────────────────────┘  │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Technology | Runtime |
|---|---|---|
| **Frontend** | React 18, TypeScript, Vite | Browser (SPA) |
| **Hosting** | S3 + CloudFront | AWS |
| **API** | HTTP API Gateway v2 | AWS Managed |
| **Compute** | AWS Lambda (Python 3.12, ARM64 Graviton2) | Serverless |
| **Storage** | S3 (uploads + results), DynamoDB (job tracking) | AWS Managed |
| **Queue** | SQS + Dead-Letter Queue | AWS Managed |
| **Security** | WAF v2, HSTS, CSP, CloudFront OAC | AWS Managed |
| **DNS** | Route 53 + ACM | AWS Managed |
| **Infrastructure** | AWS CDK (TypeScript) | Local/CI |
| **AI (Cloud)** | Amazon Bedrock Converse API | AWS Managed |
| **AI (Local)** | LM Studio + Tailscale Funnel | Home GPU (RTX 5090) |
| **Dev Server** | FastAPI + Uvicorn | Local Python |
| **Testing** | Vitest (frontend), pytest (backend) | Local |

---

## AWS Resources (3 CDK Stacks)

### StorageStack
| Resource | Name | Purpose |
|---|---|---|
| S3 Bucket | `coldbones-uploads` | Presigned PUT uploads, 1-day expiration |
| S3 Bucket | `coldbones-site` | Static SPA assets |
| CloudFront | Distribution | CDN + WAF + `/api/*` proxy to API GW |
| DynamoDB | `coldbones-jobs` | Job status tracking (jobId PK, 24h TTL) |
| WAF v2 | Web ACL | Rate limiting (500 req/5 min), OWASP rules |
| Route 53 | A Record | `app.omlahiri.com` → CloudFront |
| ACM | Certificate | TLS for custom domain |

### QueueStack
| Resource | Name | Purpose |
|---|---|---|
| SQS Queue | `coldbones-analysis` | Slow-mode job queue (16 min visibility) |
| SQS DLQ | `coldbones-analysis-dlq` | Failed messages after 3 attempts |

### ApiStack
| Resource | Name | Purpose |
|---|---|---|
| HTTP API v2 | `ColdbonesApi` | REST endpoints for frontend |
| Lambda | `PresignedUrlFn` | Generate S3 presigned PUT URLs |
| Lambda | `AnalyzeRouterFn` | Route analysis to correct provider |
| Lambda | `AnalyzeOrchestratorFn` | Execute inference + save results |
| Lambda | `JobStatusFn` | Return job status + partial results |
| Lambda | `HealthFn` | Health check endpoint |

---

## Component Hierarchy (Frontend)

```
App
├── <header>
│   ├── ColdBones (title)
│   ├── LanguagePicker (en|hi|es|bn)
│   ├── ModeToggle (fast|slow)
│   ├── ProviderPicker (auto|local|cloud)
│   └── HealthIndicator (● online/offline)
│
├── <main>
│   ├── Hero Section
│   │   ├── UploadZone (drag-drop + paste + file input)
│   │   ├── Analyze Now (button + keyboard shortcut ⌘+Enter)
│   │   ├── Clear All
│   │   └── Status hints (file count, analysis complete, kbd hint)
│   │
│   ├── Results Grid
│   │   ├── FilePreview (left panel)
│   │   │   ├── ThumbnailStrip (multi-file, drag-reorder)
│   │   │   ├── PdfCanvas (pdfjs-dist, page nav, zoom)
│   │   │   ├── ImagePreview (zoom, pan)
│   │   │   └── VideoPreview
│   │   │
│   │   └── AnalysisPanel (right panel)
│   │       ├── StreamingPreview (partialText)
│   │       ├── ETA countdown
│   │       ├── Full Model Response (collapsible CoT)
│   │       ├── Description
│   │       ├── Insights
│   │       ├── OCR text (copy button)
│   │       ├── Token usage
│   │       └── Export (Markdown download)
│   │
│   └── JobTracker (slow-mode sidebar)
│       ├── Job Queue header (counts)
│       └── Job items (status, ETA, result panel)
│
└── ToastContainer (notifications)
```

---

## State Management

### Contexts (persisted to localStorage)
| Context | State | Persistence Key |
|---|---|---|
| `LanguageContext` | `lang: 'en'\|'hi'\|'es'\|'bn'` | `coldbones-lang` |
| `ModeContext` | `mode: 'fast'\|'slow'` | `coldbones-mode` |
| `ProviderContext` | `provider: 'auto'\|'local'\|'cloud'\|'cloud-cmi'` | `coldbones-provider` |

### Custom Hooks
| Hook | Purpose | Key State |
|---|---|---|
| `useUpload` | File validation → presign → XHR PUT | `files: UploadedFile[]` |
| `useAnalysis` | POST /api/analyze + poll for result | Updates file status |
| `useSlowAnalysis` | Enqueue to SQS + poll sidebar | `slowJobs: SlowJob[]` |
| `useEstimate` | Median processing time for ETA | `estimateMs: number \| null` |
| `useHistory` | localStorage result cache (max 50) | `entries: HistoryEntry[]` |
| `useToast` | Notification queue + auto-dismiss | `toasts: Toast[]` |

---

## Lambda Functions

| Function | Route | Timeout | Memory | Purpose |
|---|---|---|---|---|
| `PresignedUrlFn` | POST `/api/presign` | 10s | 128 MB | Generate S3 presigned PUT URL (5-min expiry) |
| `AnalyzeRouterFn` | POST `/api/analyze` | 30s | 256 MB | Route to Bedrock/Desktop/SQS based on provider + health |
| `AnalyzeOrchestratorFn` | (async invoke) | 10 min | 256 MB | Download from S3 → optimize → inference → save result |
| `JobStatusFn` | GET `/api/status/{jobId}` | 10s | 128 MB | Read DynamoDB job status + partial_text |
| `HealthFn` | GET `/api/health` | 5s | 128 MB | Return provider status + model info |

---

## Inference Providers

| Provider | Model | API | Latency | Cost | Use Case |
|---|---|---|---|---|---|
| **Bedrock On-Demand** | Qwen3 VL 235B | Converse API | 15-90s | ~$0.003/image | Default (cloud-primary) |
| **Desktop (LM Studio)** | Qwen3.5 35B AWQ | OpenAI compat. | 5-60s | $0 | Local GPU via Tailscale |
| **Bedrock CMI** | Qwen2.5-VL | invoke_model | 20-120s | 5-min windows | Legacy fallback |

### Routing Logic (analyze_router)
```
if provider == 'auto' or 'cloud'  → Bedrock On-Demand (immediate)
if provider == 'local':
    if desktop alive             → Lambda.InvokeAsync(orchestrator)
    if desktop offline           → SQS.SendMessage(queue)
if provider == 'cloud-cmi'       → Orchestrator with Bedrock CMI
if mode == 'offline' (any)       → Always SQS
```

---

## Security

- **WAF v2**: OWASP Core Rules, Known Bad Inputs, SQLi Protection, IP rate limiting (500/5min)
- **Response Headers**: CSP, HSTS (365 days + preload), X-Frame-Options DENY, Permissions-Policy
- **CloudFront OAC**: S3 not publicly accessible; only CloudFront can read
- **Presigned URLs**: 5-minute expiry, scoped to exact key + content-type
- **DynamoDB TTL**: Auto-purge job data after 24 hours
- **S3 Lifecycle**: Upload bucket objects expire after 1 day
- **No API Keys / Auth**: Intentionally public for portfolio demo; WAF rate limiting prevents abuse
