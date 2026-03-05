# ColdBones — Frontend Documentation

> React 18 + TypeScript + Vite single-page application for multimodal file analysis.

---

## Overview

The frontend is a responsive SPA that handles file upload, real-time analysis tracking, and result visualization. It communicates with the backend via REST API calls through CloudFront's `/api/*` proxy.

**Entry point**: `src/main.tsx` → wraps `<App />` in context providers  
**Build**: Vite with TypeScript strict mode  
**Deployment**: `npm run build` → S3 upload → CloudFront invalidation  

---

## Component Reference

### App (`src/App.tsx`)
The root component. Manages file selection, elapsed timer, health polling, and keyboard shortcuts.

**Key responsibilities:**
- Polls `/api/health` on mount and every 30 seconds
- Maintains `selectedFileId` for the currently previewed file
- Runs an elapsed-time timer during analysis (100ms interval)
- Saves completed analyses to history + shows toast notifications
- Handles ⌘/Ctrl+Enter keyboard shortcut for analysis
- Conditionally renders Fast vs Slow mode UI

**Props**: None (root component)

### UploadZone (`src/components/UploadZone.tsx`)
Drag-and-drop + clipboard paste file upload zone.

**Features:**
- Uses `react-dropzone` for drag-drop and file dialog
- Listens on `document` for clipboard paste events
- Accepts images, PDFs, and video files
- Shows drag-active visual feedback

**Props:**
- `onFilesAdded: (files: File[]) => void`
- `disabled?: boolean`

### FilePreview (`src/components/FilePreview.tsx`)
Full-featured file previewer with thumbnail strip, zoom, and PDF navigation.

**Sub-components:**
- `PdfCanvas` — Renders PDF pages using pdfjs-dist on `<canvas>`
- `StatusBadge` — Shows upload/analysis status indicator

**Features:**
- Thumbnail strip for multi-file (drag-to-reorder)
- PDF: page navigation (‹/›), page counter
- Images: zoom in/out (+/−), Ctrl+scroll, reset
- Video: renders video element
- File removal (per-file and bulk)

**Props:**
- `file: UploadedFile | null` — currently selected
- `files: UploadedFile[]` — all files
- `onSelect: (id: string) => void`
- `onRemove: (id: string) => void`
- `onReorder?: (from: number, to: number) => void`

### AnalysisPanel (`src/components/AnalysisPanel.tsx`)
Displays analysis results with streaming preview, chain-of-thought, and export.

**Sections (in order):**
1. **Streaming preview** — Shows `partialText` during analysis
2. **ETA countdown** — Estimated time based on historical median
3. **Full Model Response** — Collapsible chain-of-thought reasoning
4. **Description** — Rich prose description of the content
5. **Insights** — Analytical observations (bulleted list)
6. **OCR text** — Extracted text with copy button (Clipboard API + execCommand fallback)
7. **Token usage** — Input/output token counts
8. **Export button** — Downloads Markdown report

**Props:**
- `result: AnalysisResult | null`
- `isAnalyzing: boolean`
- `currentFileName: string`
- `error: string | null`
- `elapsedMs: number`
- `estimateMs?: number | null`
- `partialText?: string`

### JobTracker (`src/components/JobTracker.tsx`)
Sidebar for slow-mode queued jobs.

**Features:**
- Job list with status icons and badges
- Expandable result panels for completed jobs
- Processing progress bar (indeterminate)
- Failed job error messages
- Copy job ID button
- Header with done/pending/failed counts

**Props:**
- `jobs: SlowJob[]`

### ModeToggle (`src/components/ModeToggle.tsx`)
Fast/Slow mode toggle button group.

**Props:**
- `disabled?: boolean`

### ProviderPicker (`src/components/ProviderPicker.tsx`)
Inference provider selector (Auto/Local/Cloud).

**Features:**
- Status dots showing provider availability (online/offline/unknown)
- Tooltips explaining each provider

**Props:**
- `disabled?: boolean`
- `health: HealthResponse | null`

### LanguagePicker (`src/components/LanguagePicker.tsx`)
Language dropdown (English/Hindi/Spanish/Bengali).

### ToastContainer (`src/components/ToastContainer.tsx`)
Floating notification system with auto-dismiss.

---

## Hooks Reference

### useUpload (`src/hooks/useUpload.ts`)
Manages the file upload lifecycle.

**Returns:**
- `files: UploadedFile[]` — all files with status
- `setFiles` — state setter (used by useAnalysis)
- `addFiles(files: File[])` — validate + upload to S3
- `removeFile(id: string)` — remove single file
- `clearAll()` — remove all files
- `reorderFiles(from, to)` — drag-reorder

**Upload pipeline:** validate → create entries → POST /api/presign → XHR PUT to S3

### useAnalysis (`src/hooks/useAnalysis.ts`)
Handles fast-mode analysis with polling.

**Returns:**
- `analyze(fileId, s3Key, filename, lang, provider)` — trigger analysis

**Flow:** POST /api/analyze → receive 202 → poll /api/status/{jobId} every 3s → update file status

**Key function:** `mapResult(raw)` — converts snake_case API response to camelCase TypeScript type

### useSlowAnalysis (`src/hooks/useSlowAnalysis.ts`)
Handles slow-mode analysis with SQS queue.

**Returns:**
- `slowJobs: SlowJob[]` — queued jobs
- `enqueue(fileId, s3Key, filename, lang, provider)` — submit job

**Flow:** POST /api/analyze (mode='slow') → receive jobId → poll every 4s → update sidebar

### useEstimate (`src/hooks/useEstimate.ts`)
Calculates ETA based on historical processing times.

**Returns:**
- `estimateMs: number | null` — median of recorded times
- `recordTime(ms: number)` — add a new observation

**Storage:** localStorage key `coldbones-times`, keeps odd/even item limit for stable median

### useHistory (`src/hooks/useHistory.ts`)
Persists completed analysis results to localStorage.

**Returns:**
- `entries: HistoryEntry[]`
- `addEntry(name, result)` — save (max 50 items)
- `removeEntry(id)` — delete one
- `clearHistory()` — delete all

**Resilience:** Handles corrupted/invalid localStorage data gracefully, retries on QuotaExceededError by trimming older entries

### useToast (`src/hooks/useToast.ts`)
Notification management.

**Returns:**
- `toasts: Toast[]`
- `addToast(message, type)` — show notification (auto-dismiss 5s)
- `dismiss(id)` — manually remove

---

## Contexts

### LanguageContext (`src/contexts/LanguageContext.tsx`)
Manages UI language with 4 locales.

| Language | Key | Flag |
|---|---|---|
| English | `en` | 🇺🇸 |
| Hindi | `hi` | 🇮🇳 |
| Spanish | `es` | 🇪🇸 |
| Bengali | `bn` | 🇧🇩 |

**Persistence:** `coldbones-lang` in localStorage  
**Fallback:** Invalid languages default to 'en'

### ModeContext (`src/contexts/ModeContext.tsx`)
Fast vs Slow processing mode.

**Persistence:** `coldbones-mode` in localStorage  

### ProviderContext (`src/contexts/ProviderContext.tsx`)
Inference provider selection.

| Provider | Description |
|---|---|
| `auto` | System chooses (default: Bedrock On-Demand) |
| `local` | Desktop GPU via Tailscale |
| `cloud` | Bedrock On-Demand |
| `cloud-cmi` | Bedrock Custom Model Import (legacy) |

**Persistence:** `coldbones-provider` in localStorage  

---

## Type System (`src/types/index.ts`)

```typescript
type ProcessingMode = 'fast' | 'slow'
type InferenceProvider = 'auto' | 'local' | 'cloud' | 'cloud-cmi'
type FileStatus = 'pending' | 'uploading' | 'uploaded' | 'analyzing' | 'complete' | 'error'

interface UploadedFile {
  id: string
  file: File
  name: string
  size: number
  previewUrl?: string
  status: FileStatus
  progress: number
  s3Key?: string
  result?: AnalysisResult
  error?: string
  partialText?: string
}

interface AnalysisResult {
  summary: string
  description: string
  insights: string[]
  observations: string[]
  ocrText: string
  contentClassification: string
  keyObservations: string[]
  extractedText: string
  chainOfThought: string
  reasoning: string
  reasoningTokenCount: number
  finishReason: string
  processingTimeMs: number
  mode: 'fast' | 'slow'
  model?: string
  provider?: string
  usage?: { inputTokens: number; outputTokens: number }
}
```

---

## Configuration (`src/config.ts`)

| Constant | Value | Description |
|---|---|---|
| `API_BASE_URL` | `''` (prod) / `'http://localhost:8000'` (dev) | Backend API origin |
| `MAX_FILE_SIZE_BYTES` | 20 MB | Maximum upload size |
| `ALLOWED_MIME_TYPES` | image/*, application/pdf, video/* | Accepted file types |
| `MAX_PDF_PAGES` | 20 | PDF page limit |
| `MAX_BATCH_SIZE_FAST` | 10 | Fast mode file limit |
| `MAX_BATCH_SIZE_SLOW` | 50 | Slow mode file limit |
| `FAST_POLL_INTERVAL_MS` | 3000 | Polling interval (fast mode) |
| `FAST_POLL_TIMEOUT_MS` | 600000 | 10 min timeout |
| `SLOW_POLL_INTERVAL_MS` | 4000 | Polling interval (slow mode) |
| `SLOW_POLL_TIMEOUT_MS` | 900000 | 15 min timeout |
| `HISTORY_MAX_ITEMS` | 50 | Max localStorage entries |

---

## Testing

**Framework:** Vitest 4.0.18 with v8 coverage  
**Libraries:** @testing-library/react, @testing-library/user-event, @testing-library/jest-dom  

**Test files:**
| File | Tests | Focus |
|---|---|---|
| `components.test.tsx` | 56 | Component rendering, interactions |
| `contexts.test.tsx` | — | Context providers |
| `validation.test.ts` | — | File validation utilities |
| `e2e.test.tsx` | 37 | Integration flows |
| `hooks.test.ts` | 41 | Custom hook logic |
| `provider.test.tsx` | 24 | Provider context + picker |
| `app.test.tsx` | 17 | App shell rendering |
| `coverage-filepreview.test.tsx` | 22 | FilePreview edge cases |
| `coverage-analysispanel.test.tsx` | 18 | AnalysisPanel edge cases |
| `coverage-extras.test.ts` | — | Translations, estimate, history, validation |
| `coverage-final.test.tsx` | 12 | PDF nav, video, JobTracker |
| `coverage-branches.test.tsx` | 26 | V8 branch coverage (hooks, export, paste) |
| `coverage-threshold.test.tsx` | 17 | Coverage threshold targets |

**Coverage thresholds** (vite.config.ts):
- Statements: 97%
- Branches: 90%
- Functions: 97%
- Lines: 97%
