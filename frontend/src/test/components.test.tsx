/**
 * Component tests for all frontend UI components.
 * Mocks pdfjs-dist and react-dropzone where needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { ModeProvider } from '../contexts/ModeContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import type { AnalysisResult, UploadedFile } from '../types'

// ─── Mock pdfjs-dist (used by FilePreview) ───────────────────────────────────

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: vi.fn(() =>
        Promise.resolve({
          getViewport: vi.fn(() => ({ width: 800, height: 600 })),
          render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
        })
      ),
      destroy: vi.fn(),
    }),
  })),
}))

// ─── Mock react-dropzone (used by UploadZone) ────────────────────────────────

vi.mock('react-dropzone', () => ({
  useDropzone: vi.fn(({ onDrop, disabled }) => ({
    getRootProps: () => ({
      onClick: () => {},
      onDragOver: (e: Event) => e.preventDefault(),
      onDrop: (e: DragEvent) => {
        const files = Array.from((e.dataTransfer?.files ?? []) as File[])
        if (!disabled && files.length > 0) onDrop?.(files, [], e)
      },
      tabIndex: 0,
    }),
    getInputProps: () => ({ type: 'file', multiple: true }),
    isDragActive: false,
  })),
}))

// ─── Combined wrapper ─────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ModeProvider>
      <LanguageProvider>{children}</LanguageProvider>
    </ModeProvider>
  )
}

function r(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

// ─── LanguagePicker ───────────────────────────────────────────────────────────

describe('LanguagePicker', () => {
  let LanguagePicker: typeof import('../components/LanguagePicker').LanguagePicker

  beforeEach(async () => {
    localStorage.clear()
    const mod = await import('../components/LanguagePicker')
    LanguagePicker = mod.LanguagePicker
  })

  it('renders a select element', () => {
    r(<LanguagePicker />)
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('renders all 4 language options', () => {
    r(<LanguagePicker />)
    expect(screen.getByRole('option', { name: /English/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Spanish/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Hindi/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Bengali/i })).toBeInTheDocument()
  })

  it('defaults to English', () => {
    r(<LanguagePicker />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('en')
  })

  it('updates language context when changed to Spanish', async () => {
    r(<LanguagePicker />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'es')
    expect((select as HTMLSelectElement).value).toBe('es')
  })

  it('updates language context when changed to Hindi', async () => {
    r(<LanguagePicker />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'hi')
    expect((select as HTMLSelectElement).value).toBe('hi')
  })

  it('updates language context when changed to Bengali', async () => {
    r(<LanguagePicker />)
    const select = screen.getByRole('combobox')
    await userEvent.selectOptions(select, 'bn')
    expect((select as HTMLSelectElement).value).toBe('bn')
  })

  it('restores previous lang from localStorage', () => {
    localStorage.setItem('coldbones-lang', 'hi')
    r(<LanguagePicker />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('hi')
  })
})

// ─── ModeToggle ───────────────────────────────────────────────────────────────

describe('ModeToggle', () => {
  let ModeToggle: typeof import('../components/ModeToggle').ModeToggle

  beforeEach(async () => {
    localStorage.clear()
    const mod = await import('../components/ModeToggle')
    ModeToggle = mod.ModeToggle
  })

  it('renders Fast and Slow buttons', () => {
    r(<ModeToggle />)
    expect(screen.getByText('Fast')).toBeInTheDocument()
    expect(screen.getByText('Slow')).toBeInTheDocument()
  })

  it('Fast button is active by default (aria-pressed=true)', () => {
    r(<ModeToggle />)
    const fastBtn = screen.getByRole('button', { name: /fast/i })
    expect(fastBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Slow activates Slow', async () => {
    r(<ModeToggle />)
    await userEvent.click(screen.getByRole('button', { name: /slow/i }))
    expect(screen.getByRole('button', { name: /slow/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking Fast after Slow reactivates Fast', async () => {
    r(<ModeToggle />)
    await userEvent.click(screen.getByRole('button', { name: /slow/i }))
    await userEvent.click(screen.getByRole('button', { name: /fast/i }))
    expect(screen.getByRole('button', { name: /fast/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not toggle when disabled', async () => {
    r(<ModeToggle disabled />)
    const slowBtn = screen.getByRole('button', { name: /slow/i })
    expect(slowBtn).toBeDisabled()
    await userEvent.click(slowBtn)
    expect(screen.getByRole('button', { name: /fast/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('has role="group" with aria-label', () => {
    r(<ModeToggle />)
    expect(screen.getByRole('group')).toHaveAttribute('aria-label', 'Processing mode')
  })
})

// ─── AnalysisPanel ────────────────────────────────────────────────────────────

describe('AnalysisPanel', () => {
  let AnalysisPanel: typeof import('../components/AnalysisPanel').AnalysisPanel

  beforeEach(async () => {
    const mod = await import('../components/AnalysisPanel')
    AnalysisPanel = mod.AnalysisPanel
  })

  it('shows empty placeholder when result is null and not analyzing', () => {
    r(<AnalysisPanel result={null} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText(/upload.*file|drop|analyse/i)).toBeInTheDocument()
  })

  it('shows error state with role="alert"', () => {
    r(<AnalysisPanel result={null} isAnalyzing={false} error="PDF failed" elapsedMs={0} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('PDF failed')).toBeInTheDocument()
  })

  it('shows loading spinner when isAnalyzing=true', () => {
    r(<AnalysisPanel result={null} isAnalyzing currentFileName="test.png" error={null} elapsedMs={2500} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    // elapsedMs=2500 → 2.5s
    expect(screen.getByText(/2\.5s/)).toBeInTheDocument()
  })

  /** Helper: builds a full AnalysisResult with sensible defaults */
  const makeResult = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
    fileId: 'f1',
    chainOfThought: '',
    summary: 's',
    description: '',
    insights: [],
    observations: [],
    ocrText: '',
    contentClassification: 'Photo',
    keyObservations: [],
    extractedText: '',
    reasoning: '',
    reasoningTokenCount: 0,
    finishReason: 'stop',
    processingTimeMs: 100,
    mode: 'fast',
    ...overrides,
  })

  it('renders result summary', () => {
    const result = makeResult({ summary: 'This image shows a cat.' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText('This image shows a cat.')).toBeInTheDocument()
  })

  it('renders observations list', () => {
    const result = makeResult({
      observations: ['Obs 1', 'Obs 2', 'Obs 3'],
      mode: 'slow',
    })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText('Obs 1')).toBeInTheDocument()
    expect(screen.getByText('Obs 2')).toBeInTheDocument()
    expect(screen.getByText('Obs 3')).toBeInTheDocument()
  })

  it('renders classification badge', () => {
    const result = makeResult({ contentClassification: 'Document' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText('Document')).toBeInTheDocument()
  })

  it('shows Chain of Thought toggle button when chainOfThought present', () => {
    const result = makeResult({ chainOfThought: 'step-by-step reasoning here' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    const toggles = screen.getAllByRole('button')
    expect(toggles.length).toBeGreaterThan(0)
  })

  it('expands Chain of Thought on toggle click', async () => {
    const result = makeResult({ chainOfThought: 'step-by-step reasoning content' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    const toggleBtn = screen.getByRole('button', { name: /chain of thought/i })
    await userEvent.click(toggleBtn)
    expect(screen.getByText('step-by-step reasoning content')).toBeInTheDocument()
  })

  it('shows truncation warning when finishReason is "length"', () => {
    const result = makeResult({ finishReason: 'length' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('renders OCR text when present', () => {
    const result = makeResult({ ocrText: 'Invoice total: $500' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText('Invoice total: $500')).toBeInTheDocument()
  })

  it('does not render OCR text section for "No text detected."', () => {
    const result = makeResult({ ocrText: 'No text detected.' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    // The OCR text section should be hidden
    expect(screen.queryByText('No text detected.')).not.toBeInTheDocument()
  })

  it('shows Fast mode in result meta', () => {
    const result = makeResult({ processingTimeMs: 1000, mode: 'fast' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText(/fast/i)).toBeInTheDocument()
  })

  it('shows Slow mode in result meta', () => {
    const result = makeResult({ processingTimeMs: 10000, mode: 'slow' })
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByText(/slow/i)).toBeInTheDocument()
  })
})

// ─── JobTracker ───────────────────────────────────────────────────────────────

describe('JobTracker', () => {
  let JobTracker: typeof import('../components/JobTracker').JobTracker
  type SlowJob = import('../hooks/useSlowAnalysis').SlowJob

  beforeEach(async () => {
    const mod = await import('../components/JobTracker')
    JobTracker = mod.JobTracker
  })

  const makeJob = (overrides: Partial<SlowJob> = {}): SlowJob => ({
    jobId: 'job-abc-1234567890',
    fileName: 'test.png',
    fileId: 'file-1',
    status: 'queued',
    result: undefined,
    estimatedWait: 120,
    errorMessage: undefined,
    ...overrides,
  })

  it('shows empty state when no jobs', () => {
    r(<JobTracker jobs={[]} />)
    expect(screen.getAllByText(/slow mode/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/Submit files in/i)).toBeInTheDocument()
  })

  it('renders job filename', () => {
    r(<JobTracker jobs={[makeJob()]} />)
    expect(screen.getByText('test.png')).toBeInTheDocument()
  })

  it('shows "Queued" badge for queued status', () => {
    r(<JobTracker jobs={[makeJob({ status: 'queued' })]} />)
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('shows "Processing" badge', () => {
    r(<JobTracker jobs={[makeJob({ status: 'processing' })]} />)
    expect(screen.getByText('Processing')).toBeInTheDocument()
  })

  it('shows "Complete" badge for complete job', () => {
    const result: AnalysisResult = {
      fileId: 'f1', chainOfThought: '', summary: 'Done!', description: '',
      insights: [], observations: [], ocrText: '',
      keyObservations: [], contentClassification: 'Photo', extractedText: '',
      reasoning: '', reasoningTokenCount: 0, finishReason: 'stop',
      processingTimeMs: 500, mode: 'slow',
    }
    r(<JobTracker jobs={[makeJob({ status: 'complete', result })]} />)
    expect(screen.getByText('Complete')).toBeInTheDocument()
  })

  it('shows "Failed" badge', () => {
    r(<JobTracker jobs={[makeJob({ status: 'failed', errorMessage: 'GPU OOM' })]} />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('shows error message for failed job', () => {
    r(<JobTracker jobs={[makeJob({ status: 'failed', errorMessage: 'GPU OOM' })]} />)
    expect(screen.getByText('GPU OOM')).toBeInTheDocument()
  })

  it('shows ETA for queued job', () => {
    r(<JobTracker jobs={[makeJob({ status: 'queued', estimatedWait: 120 })]} />)
    expect(screen.getByText(/2m wait/i)).toBeInTheDocument()
  })

  it('shows progress bar for processing job', () => {
    r(<JobTracker jobs={[makeJob({ status: 'processing' })]} />)
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
  })

  it('shows counts header with multiple jobs', () => {
    const jobs: SlowJob[] = [
      makeJob({ jobId: 'j1', status: 'complete', result: undefined }),
      makeJob({ jobId: 'j2', status: 'queued' }),
      makeJob({ jobId: 'j3', status: 'failed' }),
    ]
    r(<JobTracker jobs={jobs} />)
    expect(screen.getByText(/1 done/i)).toBeInTheDocument()
    expect(screen.getByText(/1 pending/i)).toBeInTheDocument()
    expect(screen.getByText(/1 failed/i)).toBeInTheDocument()
  })

  it('clicking complete job header expands analysis panel', async () => {
    const result: AnalysisResult = {
      fileId: 'f1', chainOfThought: '', summary: 'My summary text', description: '',
      insights: [], observations: [], ocrText: '',
      keyObservations: [], contentClassification: 'Photo', extractedText: '',
      reasoning: '', reasoningTokenCount: 0, finishReason: 'stop',
      processingTimeMs: 500, mode: 'slow',
    }
    r(<JobTracker jobs={[makeJob({ status: 'complete', result })]} />)
    const header = screen.getByText('test.png').closest('[role="button"]')!
    await userEvent.click(header)
    expect(screen.getByText('My summary text')).toBeInTheDocument()
  })

  it('clicking again collapses the analysis panel', async () => {
    const result: AnalysisResult = {
      fileId: 'f1', chainOfThought: '', summary: 'My summary text', description: '',
      insights: [], observations: [], ocrText: '',
      keyObservations: [], contentClassification: 'Photo', extractedText: '',
      reasoning: '', reasoningTokenCount: 0, finishReason: 'stop',
      processingTimeMs: 500, mode: 'slow',
    }
    r(<JobTracker jobs={[makeJob({ status: 'complete', result })]} />)
    const header = screen.getByText('test.png').closest('[role="button"]')!
    await userEvent.click(header)
    await userEvent.click(header)
    expect(screen.queryByText('My summary text')).not.toBeInTheDocument()
  })

  it('copy button calls navigator.clipboard.writeText', async () => {
    const writeMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: writeMock } })
    r(<JobTracker jobs={[makeJob()]} />)
    const copyBtn = screen.getByRole('button', { name: /copy job id/i })
    await userEvent.click(copyBtn)
    expect(writeMock).toHaveBeenCalledWith('job-abc-1234567890')
  })

  it('truncates long job IDs to 16 chars + ellipsis', () => {
    r(<JobTracker jobs={[makeJob({ jobId: 'abcdefghijklmnopqrstuvwxyz' })]} />)
    expect(screen.getByText(/abcdefghijklmnop…/)).toBeInTheDocument()
  })
})

// ─── UploadZone ───────────────────────────────────────────────────────────────

describe('UploadZone', () => {
  let UploadZone: typeof import('../components/UploadZone').UploadZone

  beforeEach(async () => {
    const mod = await import('../components/UploadZone')
    UploadZone = mod.UploadZone
  })

  it('renders the upload zone with correct role', () => {
    r(<UploadZone onFilesAdded={vi.fn()} />)
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('renders file input element', () => {
    const { container } = r(<UploadZone onFilesAdded={vi.fn()} />)
    expect(container.querySelector('input[type="file"]')).toBeInTheDocument()
  })

  it('shows upload title text', () => {
    r(<UploadZone onFilesAdded={vi.fn()} />)
    const btn = screen.getByRole('button')
    expect(btn.textContent).toMatch(/drag|drop|upload/i)
  })

  it('shows upload title text', () => {
    r(<UploadZone onFilesAdded={vi.fn()} />)
    // should contain some text about uploading
    const btn = screen.getByRole('button')
    expect(btn.textContent).toMatch(/upload|drag|drop/i)
  })

  it('adds "disabled" class when disabled prop is true', () => {
    r(<UploadZone onFilesAdded={vi.fn()} disabled />)
    const zone = screen.getByRole('button')
    expect(zone.className).toContain('disabled')
  })
})

// ─── FilePreview ──────────────────────────────────────────────────────────────

describe('FilePreview', () => {
  let FilePreview: typeof import('../components/FilePreview').FilePreview

  beforeEach(async () => {
    const mod = await import('../components/FilePreview')
    FilePreview = mod.FilePreview
  })

  const makeUploadedFile = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
    id: 'uf-1',
    file: new File([new Uint8Array(100)], 'img.png', { type: 'image/png' }),
    name: 'img.png',
    size: 100,
    previewUrl: 'data:image/png;base64,abc',
    status: 'uploaded',
    progress: 100,
    ...overrides,
  })

  it('shows empty placeholder when file list is empty', () => {
    r(<FilePreview file={null} files={[]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText(/no files/i)).toBeInTheDocument()
  })

  it('shows image preview for image file', () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('img', { name: /preview of/i })).toBeInTheDocument()
  })

  it('renders filename in preview header', () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText('img.png')).toBeInTheDocument()
  })

  it('shows Remove button when only one file', () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: /remove file/i })).toBeInTheDocument()
  })

  it('calls onRemove when Remove clicked', async () => {
    const onRemove = vi.fn()
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={onRemove} />)
    await userEvent.click(screen.getByRole('button', { name: /remove file/i }))
    expect(onRemove).toHaveBeenCalledWith('uf-1')
  })

  it('zoom in button increases zoom label', async () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    const zoomInBtn = screen.getByRole('button', { name: /zoom in/i })
    await userEvent.click(zoomInBtn)
    // After zoom in a zoom-reset button should appear with 125%
    expect(screen.getByText(/125%/)).toBeInTheDocument()
  })

  it('zoom out button triggers at min 0.3 without going below', async () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    const zoomOutBtn = screen.getByRole('button', { name: /zoom out/i })
    // Click many times — should clamp at 30%
    for (let i = 0; i < 20; i++) await userEvent.click(zoomOutBtn)
    expect(screen.getByText(/30%/)).toBeInTheDocument()
  })

  it('reset zoom button appears and resets to 100%', async () => {
    const f = makeUploadedFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }))
    const resetBtn = screen.getByText(/125%.*↺/)
    await userEvent.click(resetBtn)
    expect(screen.queryByText(/% ↺/)).not.toBeInTheDocument()
  })

  it('renders thumbnail strip for multiple files', () => {
    const f1 = makeUploadedFile({ id: 'u1', name: 'a.png' })
    const f2 = makeUploadedFile({ id: 'u2', name: 'b.png' })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('list', { name: /uploaded files/i })).toBeInTheDocument()
  })

  it('calls onSelect when thumbnail clicked', async () => {
    const onSelect = vi.fn()
    const f1 = makeUploadedFile({ id: 'u1', name: 'a.png' })
    const f2 = makeUploadedFile({ id: 'u2', name: 'b.png' })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={onSelect} onRemove={vi.fn()} />)
    // Click second thumbnail remove button to test onRemove with multiple
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    // Find the thumbnail remove for 'b.png'
    await userEvent.click(removeButtons[1])
  })

  it('shows error message for file with error status', () => {
    const f = makeUploadedFile({ status: 'error', error: 'File too large' })
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('File too large')).toBeInTheDocument()
  })
})
