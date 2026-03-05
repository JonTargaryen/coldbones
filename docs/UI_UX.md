# ColdBones — UI/UX Documentation

> Material Design 3, dark-first, accessibility-aware single-page application.

---

## Design System

### Theme: Google Material Design 3 (Dark)

ColdBones uses a dark-first MD3 design with Google Blue as the primary color. A light theme auto-activates via `prefers-color-scheme: light`.

**Color Palette (Dark):**

| Token | Value | Usage |
|---|---|---|
| `--md-primary` | `#8AB4F8` | Buttons, links, focus rings, active states |
| `--md-on-primary` | `#00234E` | Text on primary surfaces |
| `--md-background` | `#202124` | Page background (Google Dark) |
| `--md-surface` | `#202124` | Card backgrounds |
| `--md-surface-container` | `#303134` | Elevated cards |
| `--md-error` | `#F28B82` | Error states, validation |
| `--md-success` | `#57BB6E` | Online status, completion |
| `--md-warning` | `#FDD663` | Caution indicators |
| `--md-outline` | `#8E9099` | Muted text, borders |

**Shape Tokens:**

| Token | Value | Usage |
|---|---|---|
| `--md-shape-xs` | 4px | Small chips, tags |
| `--md-shape-sm` | 8px | Cards, input fields |
| `--md-shape-md` | 12px | Larger cards |
| `--md-shape-lg` | 16px | Dialogs, panels |
| `--md-shape-full` | 9999px | Pills, circular buttons |

**Elevation (box-shadow):**

| Level | Usage |
|---|---|
| `--md-elev-1` | Cards at rest |
| `--md-elev-2` | Hover/focus states |
| `--md-elev-3` | Dialogs, overlays |

**Typography:**
- **Primary:** Roboto (300, 400, 500, 700)
- **Monospace:** JetBrains Mono (results, code blocks)
- **Body:** 16px base, `letter-spacing: 0.25px`

---

## Layout

### Single-Page Split Layout

```
┌─ Header ──────────────────────────────────────────────────┐
│  Logo · Title · LanguagePicker · ModeToggle · Provider    │
├──────────────────────┬────────────────────────────────────┤
│   Upload / Preview   │     Analysis Results               │
│      (left panel)    │       (right panel)                │
│                      │                                    │
│  ┌────────────────┐  │  ┌────────────────────────────┐   │
│  │  Upload Zone   │  │  │  Summary                   │   │
│  │  (drag & drop) │  │  │  Description               │   │
│  └────────────────┘  │  │  Insights                   │   │
│                      │  │  Observations               │   │
│  ┌────────────────┐  │  │  OCR text (copy button)     │   │
│  │  File Preview  │  │  │  Chain of Thought (toggle)  │   │
│  │  (image/PDF/   │  │  │  Model info + timing        │   │
│  │   video thumb) │  │  │  Export button               │   │
│  └────────────────┘  │  └────────────────────────────┘   │
│                      │                                    │
│  ┌────────────────┐  │  ┌────────────────────────────┐   │
│  │  Thumbnail     │  │  │  Job Tracker               │   │
│  │  Strip (multi- │  │  │  (slow mode queue)          │   │
│  │  file batch)   │  │  └────────────────────────────┘   │
│  └────────────────┘  │                                    │
├──────────────────────┴────────────────────────────────────┤
│  Footer (minimal)                                         │
└───────────────────────────────────────────────────────────┘
```

**Responsive:** On narrow viewports (<768px), the layout stacks vertically (upload on top, results below).

---

## Components & UX Patterns

### UploadZone

**Interactions:**
- **Drag & drop:** Full-zone drop target with visual `drag-active` state (blue border, dimmed background)
- **Click to browse:** File picker dialog via hidden `<input type="file">`
- **Clipboard paste:** `Ctrl+V` / `Cmd+V` — captures pasted images from clipboard
- **Multi-file:** Accepts multiple files; builds a batch queue

**Accepted types:** Images (JPEG, PNG, GIF, WebP, BMP, TIFF), PDFs, Videos (MP4, MOV, AVI, WebM)

**States:**
| State | Visual |
|---|---|
| Default | Cloud upload icon + "Drop files here or click to browse" |
| Drag active | Blue border, icon scales up, text changes to "Drop here" |
| Disabled | Grayed out, cursor: not-allowed |

### FilePreview

**Interactions:**
- **Zoom:** Mouse wheel zooms in/out (0.25x – 4x), with smooth scaling
- **PDF pagination:** Arrow buttons to navigate pages, page counter `1 / 5`
- **Thumbnail strip:** Horizontal filmstrip below preview for multi-file batches
- **Drag reorder:** Drag thumbnails to reorder the processing queue
- **Remove:** "×" button on each thumbnail to remove from batch

**File type rendering:**
| Type | Rendering |
|---|---|
| Image | `<img>` with object-fit: contain |
| PDF | `<canvas>` via pdf.js (rendered at current page + zoom) |
| Video | `<video>` with native controls |
| Unknown | Icon + filename |

**Thumbnail generation:**
- Images: `createImageBitmap()` → canvas → blob URL
- PDFs: render page 1 at thumbnail resolution
- Videos: seek to 1s → canvas capture

### AnalysisPanel

**States:**

| State | Display |
|---|---|
| Empty | Welcome message with instructions |
| Loading | Spinner + elapsed timer + ETA + progress bar + "Model is thinking..." |
| Streaming | Partial text rendering (Markdown) with auto-scroll |
| Complete | Full structured result with all sections |
| Error | Red alert with error message |

**Streaming UX:**
- During inference, `partial_text` from polling renders as live Markdown
- Auto-scroll follows new content (disengages if user scrolls up manually)
- ScrollBox component tracks `scrollTop` vs `scrollHeight` to detect user scroll intent

**Result sections:**
1. **Summary** — 1-2 sentence headline
2. **Description** — Detailed analysis (Markdown with headings, lists, emphasis)
3. **Insights** — Numbered list of analytical observations
4. **Observations** — Additional factual details
5. **OCR Text** — Extracted text with one-click copy button
6. **Chain of Thought** — Collapsible `<details>` toggle showing the model's reasoning process
7. **Meta bar** — Model name, provider, token counts, processing time
8. **Export** — "Download as Markdown" button

**Copy to clipboard:**
- Primary: `navigator.clipboard.writeText()`
- Fallback: `execCommand('copy')` for older browsers
- Visual: "Copied!" confirmation for 2 seconds

### ModeToggle

Two-button pill toggle: **Fast** | **Slow**

| Mode | Behavior |
|---|---|
| Fast | Synchronous — returns result immediately (default) |
| Slow | Queue via SQS — poll for results, supports batch |

**States:** Active button gets `active` class (primary color fill). Disabled state prevents mode switching during analysis.

### ProviderPicker

Three-button group: **Auto** | **Local** | **Cloud**

| Provider | Description |
|---|---|
| Auto | Cloud-primary with local fallback |
| Local | RTX 5090 via LM Studio (Tailscale Funnel) |
| Cloud | Bedrock On-Demand (pay-per-token) |

**Status dots:** Each provider button shows a colored status indicator:
- 🟢 Green (`online`): Provider configured and available
- ⚫ Grey (`unknown`): Status not yet determined
- 🔴 Red (`offline`): Provider not responding

### JobTracker

Visible when slow-mode jobs exist. Expandable list of queued/processing/completed jobs.

| Status | Icon | Color |
|---|---|---|
| QUEUED | ⏳ | Grey |
| PROCESSING | ⚙️ | Blue (spinning) |
| COMPLETED | ✅ | Green |
| FAILED | ❌ | Red |

**Interaction:** Click a completed job to expand and view its results inline.

### LanguagePicker

Dropdown selector for UI language. Available locales:

| Code | Language | Script |
|---|---|---|
| `en` | English | Latin |
| `es` | Español | Latin |
| `hi` | हिन्दी | Devanagari |
| `bn` | বাংলা | Bengali |

**Implementation:** React Context (`LanguageContext`) with `localStorage` persistence. All UI strings are served from `i18n/locales/*.ts` — the model's analysis language is controlled by the `lang` parameter sent to the API, not the UI locale.

---

## Accessibility

### WCAG 2.1 AA Compliance

| Feature | Implementation |
|---|---|
| **Skip link** | Hidden "Skip to main content" link, visible on focus |
| **Focus rings** | `2px solid var(--md-primary)` on `:focus-visible` |
| **ARIA roles** | `role="button"` on UploadZone, `role="group"` on toggles, `role="alert"` on errors, `role="status"` on loading |
| **ARIA labels** | All interactive elements have descriptive `aria-label` or `title` |
| **aria-pressed** | ModeToggle and ProviderPicker buttons use `aria-pressed` |
| **aria-live** | Loading states use `aria-live="polite"` for screen reader announcements |
| **Keyboard nav** | All controls reachable via Tab, activated via Enter/Space |
| **Reduced motion** | `prefers-reduced-motion: reduce` disables all animations |
| **Touch targets** | Minimum 48px (`--min-touch: 48px`) per MD3 guidelines |
| **Color contrast** | `#E3E3E3` on `#202124` = 12.6:1 (exceeds AAA 7:1) |

### Dark / Light Theme

- **Default:** Dark theme (MD3 dark color scheme)
- **Auto-switch:** `@media (prefers-color-scheme: light)` overrides `:root` variables
- **No manual toggle:** Follows OS preference (respects user system settings)

---

## Animations & Transitions

| Element | Animation | Duration |
|---|---|---|
| Upload zone drag-active | Border color + scale(1.02) | 200ms ease |
| Analysis spinner | CSS rotate | 1.5s infinite |
| Progress bar fill | Width shimmer | 2s infinite |
| Card hover | Elevation lift + background shift | 150ms ease |
| Toast notification | Slide in from top + fade | 300ms ease-out |
| Focus ring | Outline appears | Instant |

All animations respect `prefers-reduced-motion` — durations collapse to ~0ms.

---

## Error Handling UX

| Error Type | Display |
|---|---|
| Network failure | Toast notification + inline error in AnalysisPanel |
| File too large | Validation before upload, toast with size limit |
| Unsupported type | File rejected by dropzone, no upload attempt |
| API 4xx | Error message in AnalysisPanel with retry suggestion |
| API 5xx | Generic error with "Please try again" |
| Presign failure | Toast notification |

---

## Performance

| Optimization | Implementation |
|---|---|
| **Code splitting** | Vite automatic chunk splitting |
| **Font loading** | Google Fonts with `display=swap` |
| **Image handling** | Blob URLs for thumbnails (no re-encoding) |
| **PDF rendering** | pdf.js web worker (off-main-thread) |
| **Polling** | 2s interval with exponential backoff on repeated errors |
| **Compression** | CloudFront gzip + brotli |
| **Caching** | `CACHING_OPTIMIZED` policy on CloudFront |
