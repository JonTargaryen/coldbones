# ColdBones — Happy Paths & Data Flows

> Complete walkthrough of every user-facing workflow, from file upload to result export.

---

## 1. Upload Flow

```
User drags file onto UploadZone
         │
         ▼
┌─ useUpload.addFiles() ─────────────────────────────────────┐
│                                                             │
│  1. Validate each file:                                     │
│     • MIME type ∈ {image/*, application/pdf, video/*}       │
│     • Size ≤ 20 MB                                          │
│                                                             │
│  2. Create UploadedFile entries (status: 'pending')         │
│     • Generate UUID                                         │
│     • Create previewUrl (blob URL) for images               │
│     • Add to files[] state immediately (instant UI update)  │
│                                                             │
│  3. For each valid file, call _uploadToS3():                │
│     a. POST /api/presign {filename, contentType}            │
│        → Lambda returns {uploadUrl, s3Key}                  │
│     b. XHR PUT to uploadUrl (presigned S3 URL)              │
│        → upload.onprogress updates progress bar             │
│     c. On success: status='uploaded', s3Key stored          │
│     d. On error: status='error', error message shown        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Upload States
| State | Visual | Description |
|---|---|---|
| `pending` | Grey dot | File queued for upload |
| `uploading` | Blue progress bar | XHR PUT in progress |
| `uploaded` | Green check | Ready for analysis |
| `analyzing` | Spinning icon | Analysis in progress |
| `complete` | Full result panel | Analysis finished |
| `error` | Red X | Upload or analysis failed |

---

## 2. Fast Mode Analysis (Default)

The primary user flow. Takes 15-90 seconds depending on file type and provider.

```
User clicks "Analyze Now" (or ⌘+Enter)
         │
         ▼
┌─ useAnalysis.analyze() ──────────────────────────────────────┐
│                                                               │
│  1. Set file status = 'analyzing'                             │
│  2. Start elapsed timer (updates every 100ms)                 │
│                                                               │
│  3. POST /api/analyze {s3Key, filename, lang, mode:'fast',    │
│                         provider: 'auto'|'local'|'cloud'}     │
│                                                               │
│  ══════════════════ SERVER SIDE ══════════════════             │
│                                                               │
│  4. analyze_router Lambda receives request:                   │
│     a. Write job to DynamoDB (status=QUEUED)                  │
│     b. Check provider routing:                                │
│        • auto/cloud → invoke orchestrator w/ Bedrock OD       │
│        • local (alive) → invoke orchestrator w/ desktop       │
│        • local (offline) → enqueue to SQS                     │
│     c. Return 202 {jobId, status:'processing'}                │
│                                                               │
│  5. analyze_orchestrator Lambda (async, up to 10 min):        │
│     a. Download file from S3                                  │
│     b. Detect type (magic bytes: PNG, JPEG, PDF, video)       │
│     c. Convert to optimized PNG data-URLs (max 1568px,        │
│        JPEG 85%, target <5MB per image)                       │
│     d. For PDFs: extract up to 20 pages                       │
│     e. For video: extract up to 20 frames                     │
│     f. Call inference provider:                                │
│        → Bedrock Converse API (Qwen3 VL 235B)                 │
│        → or Desktop LM Studio (Qwen3.5 35B AWQ)               │
│     g. Parse structured JSON response                         │
│     h. Write result to S3 + DynamoDB (status=COMPLETED)       │
│     i. On failure: status=FAILED + error message              │
│                                                               │
│  ══════════════════ CLIENT SIDE ══════════════════             │
│                                                               │
│  6. Frontend polls GET /api/status/{jobId} every 3 seconds:   │
│     • PROCESSING: show streaming partialText preview          │
│     • COMPLETED: mapResult() → display AnalysisPanel          │
│     • FAILED: show error, stop polling                        │
│     • Timeout after 10 minutes                                │
│                                                               │
│  7. On completion:                                            │
│     • Set file status = 'complete'                            │
│     • Stop elapsed timer, show processingTimeMs               │
│     • Save to history (localStorage)                          │
│     • Record time for future ETA estimates                    │
│     • Show toast notification                                 │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. Slow Mode Analysis (Queued)

For batch processing on cheaper Spot GPU instances. Jobs are tracked in the sidebar.

```
User switches to Slow mode → clicks "Analyze Now"
         │
         ▼
┌─ useSlowAnalysis.enqueue() ──────────────────────────────────┐
│                                                               │
│  1. POST /api/analyze {s3Key, filename, lang, mode:'slow',    │
│                         provider}                             │
│                                                               │
│  2. Router receives → enqueues to SQS queue                   │
│     → Returns 202 {jobId}                                     │
│                                                               │
│  3. Frontend creates SlowJob entry:                           │
│     • Added to JobTracker sidebar                             │
│     • Status: 'queued'                                        │
│                                                               │
│  4. Desktop Worker (if online) long-polls SQS:                │
│     a. Receive message (MaxMessages=1)                        │
│     b. Download file from S3                                  │
│     c. Convert to PNG data-URLs                               │
│     d. Call LM Studio (580s timeout for large PDFs)           │
│     e. Write result to S3 + DynamoDB                          │
│     f. Delete message from SQS                                │
│                                                               │
│  5. Frontend polls GET /api/status/{jobId} every 4 seconds:   │
│     • queued → processing → complete/failed                   │
│     • Updates sidebar status badges                           │
│     • On complete: result panel expandable in sidebar         │
│     • Timeout after 15 minutes                                │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Slow Mode Job States
| State | Icon | Badge | Description |
|---|---|---|---|
| `queued` | ○ | Queued | In SQS, waiting for worker |
| `processing` | ◎ | Processing | Worker is running inference |
| `complete` | ✓ | Complete | Result available (click to view) |
| `failed` | × | Failed | Error message shown |

---

## 4. Clipboard Paste Upload

```
User pastes image from clipboard (⌘+V)
         │
         ▼
document.addEventListener('paste', handlePaste)
         │
         ▼
┌────────────────────────────────────────────────────┐
│  1. Read clipboardData.items                        │
│  2. Filter items where kind === 'file'              │
│  3. Call getAsFile() for each                       │
│  4. If any files found:                             │
│     • preventDefault() (stop native paste)          │
│     • Call onFilesAdded(files)                      │
│     • Files flow into normal upload pipeline        │
│  5. If no files: ignore (allow normal paste)        │
└────────────────────────────────────────────────────┘
```

---

## 5. PDF Viewing Flow

```
PDF file uploaded → FilePreview renders PdfCanvas
         │
         ▼
┌────────────────────────────────────────────────────┐
│  1. getPdfPageCount(file)                           │
│     • file.arrayBuffer() → pdfjsLib.getDocument()   │
│     • Returns numPages                              │
│                                                     │
│  2. PdfCanvas renders page 1:                       │
│     • getDocument() → getPage(page)                 │
│     • getViewport({scale: 1.2})                     │
│     • Render to <canvas> element                    │
│                                                     │
│  3. User interactions:                              │
│     • ‹/› buttons: navigate pages                   │
│     • +/− buttons: zoom in/out                      │
│     • Ctrl+scroll: continuous zoom                  │
│     • Reset button: zoom back to 100%               │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

## 6. Result Export Flow

```
User clicks Export button in AnalysisPanel
         │
         ▼
┌────────────────────────────────────────────────────┐
│  1. resultToMarkdown(fileName, result)              │
│     Generates structured Markdown:                  │
│     • # Analysis: {filename}                        │
│     • ## Summary                                    │
│     • ## Description                                │
│     • ## Classification                             │
│     • ## Key Observations (bulleted list)            │
│     • ## Insights (bulleted list)                    │
│     • ## Extracted Text (code block)                 │
│     • <details> Chain of Thought (collapsible)       │
│     • --- Metadata (mode, model, provider, time,     │
│          token counts)                               │
│                                                     │
│  2. downloadText(content, filename, mimeType)       │
│     • Create Blob → URL.createObjectURL()           │
│     • Create hidden <a> element with download attr  │
│     • Programmatically click → browser downloads    │
│     • Revoke object URL                              │
│                                                     │
│  Output: {filename}-analysis.md                      │
└────────────────────────────────────────────────────┘
```

---

## 7. Health Check Flow

```
App component mounts
         │
         ▼
┌────────────────────────────────────────────────────┐
│  1. Fetch GET /api/health on mount + every 30s     │
│                                                     │
│  2. Response includes:                              │
│     • status: 'ok' | error                          │
│     • model: 'qwen3-vl' (model name)                │
│     • provider: 'Bedrock' | 'Local' | etc.          │
│     • model_loaded: true/false                      │
│     • providers: {                                  │
│         local: {status: 'configured'|'unknown'},    │
│         cloud: {status: 'configured'|'unknown'}     │
│       }                                             │
│                                                     │
│  3. UI renders health indicator:                    │
│     • ● Green "Bedrock" — model_loaded=true         │
│     • ● Red "Server offline" — model_loaded=false   │
│     • ● Red "Offline" — fetch failed                │
│     • ● Grey "Connecting…" — still loading          │
│                                                     │
│  4. ProviderPicker shows per-provider status dots:  │
│     • Green — status='configured'                   │
│     • Grey — status='unknown'                       │
│     • Red — other status                            │
│                                                     │
│  5. UploadZone + Analyze button disabled until      │
│     health.status === 'ok'                          │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

## 8. Inference Pipeline (Server-Side Detail)

### Image Optimization
```
Raw file from S3
     │
     ▼
Detect type via magic bytes:
  \x89PNG → PNG
  \xff\xd8 → JPEG
  %PDF → PDF
  ftypmp4/ftypisom → MP4
     │
     ▼
Convert to data-URLs:
  • Images: resize to max 1568px, JPEG 85%, base64
  • PDFs: extract each page as PNG (up to 20 pages)
  • Videos: extract up to 20 frames as PNG
     │
     ▼
Build prompt with system instructions + data-URLs
     │
     ▼
Call inference provider (Bedrock Converse or LM Studio)
     │
     ▼
Parse JSON response → structured fields:
  chain_of_thought, summary, description,
  insights[], observations[], ocr_text,
  content_classification, usage metrics
     │
     ▼
Save to DynamoDB + S3
```

### System Prompt Structure
The model receives a structured prompt asking it to:
1. Think step-by-step through each submitted image/page/frame
2. Return a strictly-formatted JSON object with 11 fields
3. Respond in the user's selected language (en/hi/es/bn)
4. Use chain-of-thought reasoning before summarizing

---

## 9. Error Handling

| Error | Location | Recovery |
|---|---|---|
| Invalid file type | `useUpload.addFiles()` | Silently filtered out |
| File too large (>20MB) | `useUpload.addFiles()` | Silently filtered out |
| Too many PDF pages (>20) | `validatePdfPageCount()` | Error message shown |
| Presign API fails | `_uploadToS3()` | File status → 'error' |
| S3 PUT fails | `_uploadToS3()` XHR | File status → 'error' |
| Analysis API fails | `useAnalysis.analyze()` | File status → 'error' |
| Polling timeout (10/15 min) | `_pollForResult()` | "Timed out" error |
| Desktop offline | `analyze_router` | Falls back to SQS queue |
| Bedrock throttle | `bedrock_ondemand_client` | 3 retries with exponential backoff |
| Worker crash | SQS visibility timeout | Message redelivered (max 3 attempts) |
| Poison message | SQS DLQ | Moved to DLQ after 3 failures |
| PDF render error | `PdfCanvas` | Shows "PDF render error: {msg}" |
| Clipboard paste empty | `UploadZone` | Silently ignored |
