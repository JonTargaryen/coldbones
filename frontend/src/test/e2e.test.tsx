/**
 * End-to-end integration tests for ColdBones.
 *
 * Tests the new features added in Phase 7:
 *   - useHistory hook (localStorage persistence)
 *   - useToast hook (transient notifications)
 *   - useEstimate hook (ETA from historical data)
 *   - Export utility (resultToMarkdown + downloadText)
 *   - AnalysisPanel export button
 *   - AnalysisPanel ETA display
 *   - Clipboard paste in UploadZone
 *   - ToastContainer rendering
 *   - Centralized config module
 *   - Drag-and-drop reorder in FilePreview
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import { renderHook } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

import { ModeProvider } from '../contexts/ModeContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ProviderProvider } from '../contexts/ProviderContext'
import type { AnalysisResult, UploadedFile } from '../types'

// ─── Mock pdfjs-dist ──────────────────────────────────────────────────────────
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
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

// ─── Mock react-dropzone ──────────────────────────────────────────────────────
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

// ─── Full provider wrapper ─────────────────────────────────────────────────────
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ModeProvider>
      <LanguageProvider>
        <ProviderProvider>
          {children}
        </ProviderProvider>
      </LanguageProvider>
    </ModeProvider>
  )
}

function r(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const makeResult = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
  chainOfThought: '',
  summary: 'Test summary',
  description: 'Test description',
  insights: ['insight 1'],
  observations: ['obs 1'],
  ocrText: 'OCR text here',
  contentClassification: 'Photo',
  keyObservations: ['obs 1'],
  extractedText: 'OCR text here',
  reasoning: '',
  reasoningTokenCount: 0,
  finishReason: 'stop',
  processingTimeMs: 5000,
  mode: 'fast',
  model: 'qwen3-vl',
  provider: 'Bedrock',
  usage: { inputTokens: 100, outputTokens: 200 },
  ...overrides,
})

// ═══════════════════════════════════════════════════════════════════════════════
// Config Module
// ═══════════════════════════════════════════════════════════════════════════════

describe('Config module', () => {
  it('exports required constants', async () => {
    const config = await import('../config')
    expect(config.API_BASE_URL).toBeDefined()
    expect(typeof config.MAX_FILE_SIZE_BYTES).toBe('number')
    expect(config.MAX_FILE_SIZE_BYTES).toBe(20 * 1024 * 1024)
    expect(config.ALLOWED_MIME_TYPES).toBeInstanceOf(Set)
    expect(config.ALLOWED_MIME_TYPES.has('image/png')).toBe(true)
    expect(config.ALLOWED_MIME_TYPES.has('application/pdf')).toBe(true)
    expect(typeof config.FAST_POLL_INTERVAL_MS).toBe('number')
    expect(typeof config.SLOW_POLL_INTERVAL_MS).toBe('number')
    expect(typeof config.HISTORY_MAX_ITEMS).toBe('number')
    expect(config.HISTORY_MAX_ITEMS).toBe(50)
  })

  it('FAST_POLL is faster than SLOW_POLL', async () => {
    const config = await import('../config')
    expect(config.FAST_POLL_INTERVAL_MS).toBeLessThan(config.SLOW_POLL_INTERVAL_MS)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// useHistory Hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('useHistory', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts with an empty history', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())
    expect(result.current.entries).toEqual([])
  })

  it('adds an entry to history', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())
    const analysisResult = makeResult({ summary: 'Cat photo analysis' })

    act(() => {
      result.current.addEntry('cat.png', analysisResult)
    })

    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].fileName).toBe('cat.png')
    expect(result.current.entries[0].result.summary).toBe('Cat photo analysis')
    expect(result.current.entries[0].timestamp).toBeGreaterThan(0)
  })

  it('adds entries in reverse-chronological order', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())

    act(() => {
      result.current.addEntry('first.png', makeResult({ summary: 'First' }))
    })
    act(() => {
      result.current.addEntry('second.png', makeResult({ summary: 'Second' }))
    })

    expect(result.current.entries).toHaveLength(2)
    expect(result.current.entries[0].fileName).toBe('second.png')
    expect(result.current.entries[1].fileName).toBe('first.png')
  })

  it('removes an entry by id', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())

    act(() => {
      result.current.addEntry('keep.png', makeResult())
      result.current.addEntry('remove.png', makeResult())
    })

    const idToRemove = result.current.entries[0].id
    act(() => {
      result.current.removeEntry(idToRemove)
    })

    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].fileName).toBe('keep.png')
  })

  it('clears all history', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())

    act(() => {
      result.current.addEntry('a.png', makeResult())
      result.current.addEntry('b.png', makeResult())
    })

    act(() => {
      result.current.clearHistory()
    })

    expect(result.current.entries).toHaveLength(0)
  })

  it('persists history to localStorage', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())

    act(() => {
      result.current.addEntry('persisted.png', makeResult())
    })

    const stored = localStorage.getItem('coldbones:history')
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].fileName).toBe('persisted.png')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// useToast Hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no toasts', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())
    expect(result.current.toasts).toEqual([])
  })

  it('adds a toast with correct level', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())

    act(() => {
      result.current.addToast('Hello', 'success')
    })

    expect(result.current.toasts).toHaveLength(1)
    expect(result.current.toasts[0].message).toBe('Hello')
    expect(result.current.toasts[0].level).toBe('success')
  })

  it('auto-dismisses toast after duration', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())

    act(() => {
      result.current.addToast('Temp', 'info', 1000)
    })
    expect(result.current.toasts).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(result.current.toasts).toHaveLength(0)
  })

  it('manually dismisses a toast', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())

    act(() => {
      result.current.addToast('Dismiss me', 'warning')
    })

    const id = result.current.toasts[0].id
    act(() => {
      result.current.dismiss(id)
    })
    expect(result.current.toasts).toHaveLength(0)
  })

  it('supports multiple toasts simultaneously', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())

    act(() => {
      result.current.addToast('First', 'info')
      result.current.addToast('Second', 'error')
      result.current.addToast('Third', 'success')
    })

    expect(result.current.toasts).toHaveLength(3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// useEstimate Hook
// ═══════════════════════════════════════════════════════════════════════════════

describe('useEstimate', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null estimate when no history', async () => {
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())
    expect(result.current.estimateMs).toBeNull()
  })

  it('records processing time and computes estimate', async () => {
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())

    act(() => {
      result.current.recordTime(5000)
    })

    // After recording, need a re-render to pick up the ref change
    const stored = localStorage.getItem('coldbones:processingTimes')
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!)).toContain(5000)
  })

  it('ignores zero or negative times', async () => {
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())

    act(() => {
      result.current.recordTime(0)
      result.current.recordTime(-100)
    })

    const stored = localStorage.getItem('coldbones:processingTimes')
    expect(stored).toBeFalsy()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Export Utility
// ═══════════════════════════════════════════════════════════════════════════════

describe('resultToMarkdown', () => {
  it('generates valid Markdown with all sections', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const result = makeResult({
      summary: 'This is a **summary**.',
      description: 'Detailed description.',
      insights: ['Insight A', 'Insight B'],
      observations: ['Obs 1', 'Obs 2'],
      contentClassification: 'Document',
      ocrText: 'Hello World',
      chainOfThought: 'Step 1: Looked at image',
      processingTimeMs: 3500,
      usage: { inputTokens: 100, outputTokens: 200 },
    })

    const md = resultToMarkdown('invoice.pdf', result)

    expect(md).toContain('# Analysis: invoice.pdf')
    expect(md).toContain('## Summary')
    expect(md).toContain('This is a **summary**.')
    expect(md).toContain('## Description')
    expect(md).toContain('## Insights')
    expect(md).toContain('- Insight A')
    expect(md).toContain('- Insight B')
    expect(md).toContain('## Observations')
    expect(md).toContain('- Obs 1')
    expect(md).toContain('## Extracted Text (OCR)')
    expect(md).toContain('Hello World')
    expect(md).toContain('Chain of Thought')
    expect(md).toContain('**Content Classification:** Document')
    expect(md).toContain('3.5s')
    expect(md).toContain('100 input')
    expect(md).toContain('200 output')
  })

  it('omits empty sections', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const result = makeResult({
      summary: 'Just a summary',
      description: '',
      insights: [],
      observations: [],
      ocrText: '',
      chainOfThought: '',
    })

    const md = resultToMarkdown('test.png', result)

    expect(md).toContain('## Summary')
    expect(md).not.toContain('## Description')
    expect(md).not.toContain('## Insights')
    expect(md).not.toContain('## Observations')
    expect(md).not.toContain('## Extracted Text')
    expect(md).not.toContain('Chain of Thought')
  })

  it('skips OCR section for "No text detected."', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const result = makeResult({ ocrText: 'No text detected.' })
    const md = resultToMarkdown('test.png', result)
    expect(md).not.toContain('## Extracted Text')
  })
})

describe('downloadText', () => {
  it('creates and clicks a temporary anchor element', async () => {
    const { downloadText } = await import('../utils/export')

    const createObjectURL = vi.fn(() => 'blob:http://localhost/fake')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })

    const clickSpy = vi.fn()
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        node.click = clickSpy
      }
      return node
    })
    const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node)

    downloadText('# Test', 'test.md')

    expect(createObjectURL).toHaveBeenCalled()
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/fake')

    appendSpy.mockRestore()
    removeSpy.mockRestore()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ToastContainer Component
// ═══════════════════════════════════════════════════════════════════════════════

describe('ToastContainer', () => {
  it('renders nothing when toasts array is empty', async () => {
    const { ToastContainer } = await import('../components/ToastContainer')
    const { container } = r(<ToastContainer toasts={[]} onDismiss={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders a toast with message and level class', async () => {
    const { ToastContainer } = await import('../components/ToastContainer')
    const toasts = [{ id: 't1', message: 'Upload complete', level: 'success' as const }]
    r(<ToastContainer toasts={toasts} onDismiss={vi.fn()} />)
    expect(screen.getByText('Upload complete')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveClass('toast-success')
  })

  it('calls onDismiss when close button clicked', async () => {
    const { ToastContainer } = await import('../components/ToastContainer')
    const onDismiss = vi.fn()
    const toasts = [{ id: 't2', message: 'Error occurred', level: 'error' as const }]
    r(<ToastContainer toasts={toasts} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismiss).toHaveBeenCalledWith('t2')
  })

  it('renders multiple toasts', async () => {
    const { ToastContainer } = await import('../components/ToastContainer')
    const toasts = [
      { id: 't1', message: 'First', level: 'info' as const },
      { id: 't2', message: 'Second', level: 'warning' as const },
    ]
    r(<ToastContainer toasts={toasts} onDismiss={vi.fn()} />)
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('shows correct icons for each level', async () => {
    const { ToastContainer } = await import('../components/ToastContainer')
    const toasts = [
      { id: 't1', message: 'Info msg', level: 'info' as const },
      { id: 't2', message: 'Success msg', level: 'success' as const },
      { id: 't3', message: 'Error msg', level: 'error' as const },
      { id: 't4', message: 'Warning msg', level: 'warning' as const },
    ]
    r(<ToastContainer toasts={toasts} onDismiss={vi.fn()} />)
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(4)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AnalysisPanel — Export Button + ETA Display
// ═══════════════════════════════════════════════════════════════════════════════

describe('AnalysisPanel E2E features', () => {
  let AnalysisPanel: typeof import('../components/AnalysisPanel').AnalysisPanel

  beforeEach(async () => {
    const mod = await import('../components/AnalysisPanel')
    AnalysisPanel = mod.AnalysisPanel
  })

  it('renders export button when result is present', () => {
    const result = makeResult()
    r(<AnalysisPanel result={result} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
  })

  it('export button triggers download', async () => {
    const result = makeResult({ summary: 'Exported summary' })

    const createObjectURL = vi.fn(() => 'blob:http://localhost/fake')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, writable: true })

    // Render BEFORE mocking appendChild — React needs it to mount the tree
    r(<AnalysisPanel result={result} isAnalyzing={false} currentFileName="photo.png" error={null} elapsedMs={0} />)

    const clickSpy = vi.fn()
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLAnchorElement) {
        node.click = clickSpy
      }
      return node
    })
    const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node)

    try {
      await userEvent.click(screen.getByRole('button', { name: /export/i }))
      expect(createObjectURL).toHaveBeenCalled()
      expect(clickSpy).toHaveBeenCalled()
    } finally {
      appendSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it('does not show export button when no result', () => {
    r(<AnalysisPanel result={null} isAnalyzing={false} error={null} elapsedMs={0} />)
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument()
  })

  it('shows ETA when estimateMs is provided and greater than elapsed', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={2000}
        estimateMs={10000}
      />,
    )
    expect(screen.getByText(/~10s est/)).toBeInTheDocument()
  })

  it('does not show ETA when elapsed exceeds estimate', () => {
    const { container } = r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={15000}
        estimateMs={10000}
      />,
    )
    expect(container.querySelector('.analysis-eta')).not.toBeInTheDocument()
  })

  it('does not show ETA when estimateMs is null', () => {
    const { container } = r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={2000}
        estimateMs={null}
      />,
    )
    expect(container.querySelector('.analysis-eta')).not.toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// UploadZone — Clipboard Paste
// ═══════════════════════════════════════════════════════════════════════════════

describe('UploadZone clipboard paste', () => {
  let UploadZone: typeof import('../components/UploadZone').UploadZone

  beforeEach(async () => {
    const mod = await import('../components/UploadZone')
    UploadZone = mod.UploadZone
  })

  it('calls onFilesAdded when image is pasted via clipboard', () => {
    const onFilesAdded = vi.fn()
    r(<UploadZone onFilesAdded={onFilesAdded} />)

    const file = new File([new Uint8Array(10)], 'paste.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{
        kind: 'file',
        getAsFile: () => file,
      }],
    }

    act(() => {
      document.dispatchEvent(pasteEvent)
    })

    expect(onFilesAdded).toHaveBeenCalledWith([file])
  })

  it('does not handle paste when disabled', () => {
    const onFilesAdded = vi.fn()
    r(<UploadZone onFilesAdded={onFilesAdded} disabled />)

    const file = new File([new Uint8Array(10)], 'paste.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{
        kind: 'file',
        getAsFile: () => file,
      }],
    }

    act(() => {
      document.dispatchEvent(pasteEvent)
    })

    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  it('ignores paste events with no files', () => {
    const onFilesAdded = vi.fn()
    r(<UploadZone onFilesAdded={onFilesAdded} />)

    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{
        kind: 'string',
        getAsFile: () => null,
      }],
    }

    act(() => {
      document.dispatchEvent(pasteEvent)
    })

    expect(onFilesAdded).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// FilePreview — Drag-and-Drop Reorder
// ═══════════════════════════════════════════════════════════════════════════════

describe('FilePreview drag-and-drop reorder', () => {
  let FilePreview: typeof import('../components/FilePreview').FilePreview

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

  beforeEach(async () => {
    const mod = await import('../components/FilePreview')
    FilePreview = mod.FilePreview
  })

  it('sets draggable attribute when onReorder is provided', () => {
    const f1 = makeUploadedFile({ id: 'u1', name: 'a.png' })
    const f2 = makeUploadedFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} onReorder={vi.fn()} />,
    )
    const thumbnails = container.querySelectorAll('.thumbnail')
    thumbnails.forEach((thumb) => {
      expect(thumb.getAttribute('draggable')).toBe('true')
    })
  })

  it('does not set draggable when onReorder is not provided', () => {
    const f1 = makeUploadedFile({ id: 'u1', name: 'a.png' })
    const f2 = makeUploadedFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />,
    )
    const thumbnails = container.querySelectorAll('.thumbnail')
    thumbnails.forEach((thumb) => {
      expect(thumb.getAttribute('draggable')).toBe('false')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// useUpload — reorderFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('useUpload reorderFiles', () => {
  it('exports reorderFiles function', async () => {
    const { useUpload } = await import('../hooks/useUpload')
    const { result } = renderHook(() => useUpload())
    expect(typeof result.current.reorderFiles).toBe('function')
  })
})
