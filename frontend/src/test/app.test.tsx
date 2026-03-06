/**
 * Tests for the App component (main application shell).
 * Mocks all hooks to isolate App's rendering and wiring logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

// ─── Mock pdfjs-dist ──────────────────────────────────────────────────────
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(() =>
        Promise.resolve({
          getViewport: vi.fn(() => ({ width: 800, height: 600 })),
          render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
        }),
      ),
      destroy: vi.fn(),
    }),
  })),
}))

// ─── Mock react-dropzone ──────────────────────────────────────────────────
vi.mock('react-dropzone', () => ({
  useDropzone: vi.fn(({ onDrop, disabled }: any) => ({
    getRootProps: () => ({ onClick: () => {}, tabIndex: 0 }),
    getInputProps: () => ({ type: 'file', multiple: true }),
    isDragActive: false,
  })),
}))

// ─── Mock hooks ───────────────────────────────────────────────────────────
const mockAddFiles = vi.fn()
const mockRemoveFile = vi.fn()
const mockClearAll = vi.fn()
const mockReorderFiles = vi.fn()
const mockSetFiles = vi.fn()
const mockAnalyze = vi.fn()
const mockEnqueue = vi.fn()
const mockAddEntry = vi.fn()
const mockAddToast = vi.fn()
const mockDismiss = vi.fn()
const mockRecordTime = vi.fn()

let mockFiles: any[] = []
let mockSlowJobs: any[] = []

vi.mock('../hooks/useUpload', () => ({
  useUpload: () => ({
    files: mockFiles,
    setFiles: mockSetFiles,
    addFiles: mockAddFiles,
    removeFile: mockRemoveFile,
    clearAll: mockClearAll,
    reorderFiles: mockReorderFiles,
  }),
}))

vi.mock('../hooks/useAnalysis', () => ({
  useAnalysis: () => ({ analyze: mockAnalyze }),
}))

vi.mock('../hooks/useSlowAnalysis', () => ({
  useSlowAnalysis: () => ({ slowJobs: mockSlowJobs, enqueue: mockEnqueue }),
}))

vi.mock('../hooks/useHistory', () => ({
  useHistory: () => ({
    entries: [],
    addEntry: mockAddEntry,
    removeEntry: vi.fn(),
    clearHistory: vi.fn(),
  }),
}))

vi.mock('../hooks/useToast', () => ({
  useToast: () => ({
    toasts: [],
    addToast: mockAddToast,
    dismiss: mockDismiss,
  }),
}))

vi.mock('../hooks/useEstimate', () => ({
  useEstimate: () => ({
    estimateMs: null,
    recordTime: mockRecordTime,
  }),
}))

import App from '../App'
import { ModeProvider } from '../contexts/ModeContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import { ProviderProvider } from '../contexts/ProviderContext'

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ModeProvider>
      <LanguageProvider>
        <ProviderProvider>{children}</ProviderProvider>
      </LanguageProvider>
    </ModeProvider>
  )
}

const origFetch = globalThis.fetch

// ═══════════════════════════════════════════════════════════════════════════

describe('App', () => {
  beforeEach(() => {
    localStorage.clear()
    mockFiles = []
    mockSlowJobs = []
    mockAnalyze.mockReset()
    mockEnqueue.mockReset()
    mockAddEntry.mockReset()
    mockAddToast.mockReset()

    // Mock fetch for health check
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: 'ok',
          model: 'qwen3-vl',
          provider: 'Bedrock',
          model_loaded: true,
          providers: {
            local: { name: 'Local', status: 'configured' },
            cloud: { name: 'Cloud', status: 'configured' },
          },
        }),
    })
  })

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('renders ColdBones title and Visual Analyzer heading', async () => {
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    expect(screen.getByText('ColdBones')).toBeInTheDocument()
    expect(screen.getByText('Visual Analyzer')).toBeInTheDocument()
  })

  it('renders ModeToggle, LanguagePicker, and ProviderPicker', async () => {
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    expect(screen.getByRole('group', { name: /processing mode/i })).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument() // LanguagePicker
    expect(screen.getByRole('group', { name: /inference provider/i })).toBeInTheDocument()
  })

  it('shows health indicator after successful health check', async () => {
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    // Wait for the health check fetch to resolve
    await act(async () => {})
    expect(screen.getByText(/Bedrock/)).toBeInTheDocument()
    expect(screen.getByText('●')).toBeInTheDocument()
  })

  it('shows Connecting/Offline when health check fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('timeout'))
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})
    // Should show error indicator
    expect(screen.getByText(/offline/i)).toBeInTheDocument()
  })

  it('shows "Server offline" when health returns but model_loaded=false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: 'ok',
          model: 'test',
          provider: 'test',
          model_loaded: false,
        }),
    })
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})
    expect(screen.getByText(/server offline/i)).toBeInTheDocument()
  })

  it('disables Analyze Now button when no files', async () => {
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    const analyzeBtn = screen.getByRole('button', { name: /analyze now/i })
    expect(analyzeBtn).toBeDisabled()
  })

  it('renders file list when files are present', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'test.png', { type: 'image/png' }),
        name: 'test.png',
        size: 100,
        previewUrl: 'blob:fake',
        status: 'uploaded',
        progress: 100,
        s3Key: 'uploads/test.png',
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText('test.png')).toBeInTheDocument()
    // Analyze Now should be enabled (file uploaded + health ok)
    const analyzeBtn = screen.getByRole('button', { name: /analyze now/i })
    expect(analyzeBtn).not.toBeDisabled()
  })

  it('calls analyze when Analyze Now clicked in fast mode', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'test.png', { type: 'image/png' }),
        name: 'test.png',
        size: 100,
        previewUrl: 'blob:fake',
        status: 'uploaded',
        progress: 100,
        s3Key: 'uploads/test.png',
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    await userEvent.click(screen.getByRole('button', { name: /analyze now/i }))
    expect(mockAnalyze).toHaveBeenCalledWith('f1', 'uploads/test.png', 'test.png', 'en', 'auto')
  })

  it('shows Clear All button when files present', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }),
        name: 'a.png',
        size: 100,
        status: 'uploaded',
        progress: 100,
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText(/clear all/i)).toBeInTheDocument()
  })

  it('shows upload hint text', async () => {
    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    expect(screen.getAllByText(/images.*pdf/i).length).toBeGreaterThan(0)
  })

  it('shows Analyzing text when file is analyzing', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'test.png', { type: 'image/png' }),
        name: 'test.png',
        size: 100,
        status: 'analyzing',
        progress: 100,
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    const analyzeBtn = screen.getByRole('button', { name: /analyz/i })
    expect(analyzeBtn).toBeDisabled()
  })

  it('renders slow job tracker when slowJobs present', async () => {
    mockSlowJobs = [
      {
        jobId: 'j1',
        fileId: 'f1',
        fileName: 'slow.png',
        status: 'queued',
        estimatedWait: 60,
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText('slow.png')).toBeInTheDocument()
  })

  it('handles health check with non-ok HTTP status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    })

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText(/offline/i)).toBeInTheDocument()
  })

  it('shows kbd hint when canAnalyze is true', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'test.png', { type: 'image/png' }),
        name: 'test.png',
        size: 100,
        previewUrl: 'blob:fake',
        status: 'uploaded',
        progress: 100,
        s3Key: 'uploads/test.png',
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText(/⌘/)).toBeInTheDocument()
  })

  it('Ctrl+Enter triggers analyze', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'test.png', { type: 'image/png' }),
        name: 'test.png',
        size: 100,
        previewUrl: 'blob:fake',
        status: 'uploaded',
        progress: 100,
        s3Key: 'uploads/test.png',
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    })

    expect(mockAnalyze).toHaveBeenCalled()
  })

  it('shows file count hint when files are uploaded', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'a.png', { type: 'image/png' }),
        name: 'a.png',
        size: 100,
        status: 'uploaded',
        progress: 100,
        s3Key: 'k1',
      },
      {
        id: 'f2',
        file: new File([new Uint8Array(100)], 'b.png', { type: 'image/png' }),
        name: 'b.png',
        size: 100,
        status: 'uploaded',
        progress: 100,
        s3Key: 'k2',
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText(/2 files ready/)).toBeInTheDocument()
  })

  it('shows "Analysis complete" hint when selected file is complete', async () => {
    mockFiles = [
      {
        id: 'f1',
        file: new File([new Uint8Array(100)], 'done.png', { type: 'image/png' }),
        name: 'done.png',
        size: 100,
        status: 'complete',
        progress: 100,
        result: {
          summary: 'Done',
          contentClassification: 'Photo',
          keyObservations: [],
          extractedText: '',
          chainOfThought: '',
          description: '',
          insights: [],
          observations: [],
          ocrText: '',
        },
      },
    ]

    await act(async () => {
      render(<App />, { wrapper: Wrapper })
    })
    await act(async () => {})

    expect(screen.getByText(/analysis complete/i)).toBeInTheDocument()
  })
})
