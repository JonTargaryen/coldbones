/**
 * Targeted branch coverage tests.
 * Focuses on v8 branch paths: ?.  ??  ||  ternary  if/else
 * that have 100% line coverage but below-threshold branch coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

vi.mock('../config', () => ({
  API_BASE_URL: '',
  FAST_POLL_INTERVAL_MS: 10,
  FAST_POLL_TIMEOUT_MS: 100,
  SLOW_POLL_INTERVAL_MS: 10,
  SLOW_POLL_TIMEOUT_MS: 100,
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  MAX_BATCH_SIZE_FAST: 10,
  MAX_BATCH_SIZE_SLOW: 50,
  HISTORY_MAX_ITEMS: 50,
}))

// ─── useAnalysis branch coverage ────────────────────────────────────────────

describe('useAnalysis — branch coverage', () => {
  const setFiles = vi.fn()

  beforeEach(() => {
    setFiles.mockReset()
    vi.restoreAllMocks()
  })

  function patchFrom(call: number): any {
    const fn = setFiles.mock.calls[call]?.[0]
    if (typeof fn === 'function') {
      return fn([{
        id: 'f1', file: new File([], 'x'), name: 'x', size: 1,
        status: 'analyzing', progress: 100,
      }])[0]
    }
    return undefined
  }

  it('handles response WITHOUT usage field (undefined branch)', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    // Mock fetch returning a 200 result without usage field
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        summary: 'Test',
        content_classification: 'Photo',
        // No usage field, no body wrapper
      }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1) // second call is the result update
    expect(patch.status).toBe('complete')
    expect(patch.result.usage).toBeUndefined()
  })

  it('handles response WITH body wrapper (API Gateway path)', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        body: JSON.stringify({
          summary: 'Wrapped',
          content_classification: 'Doc',
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
      }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.status).toBe('complete')
    expect(patch.result.summary).toBe('Wrapped')
    expect(patch.result.usage?.inputTokens).toBe(50)
  })

  it('handles 202 without jobId (error branch)', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: () => Promise.resolve({ status: 'queued' }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.status).toBe('error')
    expect(patch.error).toContain('jobId')
  })

  it('handles non-ok response without detail field', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.status).toBe('error')
    expect(patch.error).toContain('500')
  })

  it('handles non-ok response with parse failure', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('bad json')),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.status).toBe('error')
    expect(patch.error).toContain('502')
  })

  it('handles non-Error throw from analyze', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockRejectedValue('string error')

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.status).toBe('error')
    expect(patch.error).toBe('Analysis failed')
  })

  it('polling: FAILED status with body wrapper', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    let pollCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/analyze')) {
        return Promise.resolve({
          ok: true, status: 202,
          json: () => Promise.resolve({ jobId: 'j1', status: 'queued' }),
        })
      }
      // status endpoint — FAILED with body wrapper
      pollCount++
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          body: JSON.stringify({ status: 'FAILED', error: 'GPU crash' }),
        }),
      })
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    const lastPatch = patchFrom(setFiles.mock.calls.length - 1)
    expect(lastPatch.status).toBe('error')
    expect(lastPatch.error).toContain('GPU crash')
  })

  it('polling: partial_text update during PROCESSING', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    let pollCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/analyze')) {
        return Promise.resolve({
          ok: true, status: 202,
          json: () => Promise.resolve({ jobId: 'j2', status: 'queued' }),
        })
      }
      pollCount++
      if (pollCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'PROCESSING', partial_text: 'Working...' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          status: 'COMPLETED',
          result: { summary: 'Done', content_classification: 'X' },
        }),
      })
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    // Check that partialText was updated at some point
    const calls = setFiles.mock.calls
    const partialCall = calls.find((c: any) => {
      if (typeof c[0] !== 'function') return false
      const r = c[0]([{ id: 'f1', partialText: undefined }])
      return r[0]?.partialText === 'Working...'
    })
    expect(partialCall).toBeTruthy()
  })

  it('mapResult handles missing fields with defaults', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    // Minimal response with mostly null/undefined fields
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        summary: 'Min',
        // all other fields missing
      }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'f.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.result.chainOfThought).toBe('')
    expect(patch.result.description).toBe('')
    expect(patch.result.insights).toEqual([])
    expect(patch.result.observations).toEqual([])
    expect(patch.result.ocrText).toBe('')
    expect(patch.result.contentClassification).toBe('')
    expect(patch.result.reasoning).toBe('')
    expect(patch.result.reasoningTokenCount).toBe(0)
    expect(patch.result.finishReason).toBe('stop')
    expect(patch.result.processingTimeMs).toBe(0)
    expect(patch.result.mode).toBe('fast')
    expect(patch.result.usage).toBeUndefined()
  })

  it('mapResult uses key_observations fallback for observations', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        summary: 'S',
        key_observations: ['obs1'],
        // no observations field
      }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'f.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.result.observations).toEqual(['obs1'])
    expect(patch.result.keyObservations).toEqual(['obs1'])
  })

  it('mapResult filters NO_TEXT_SENTINEL from ocrText and extractedText', async () => {
    const { useAnalysis } = await import('../hooks/useAnalysis')
    const { result } = renderHook(() => useAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        summary: 'S',
        ocr_text: 'No text detected.',
        extracted_text: 'No text detected.',
      }),
    })

    await act(async () => {
      await result.current.analyze('f1', 'key', 'f.png', 'en')
    })

    const patch = patchFrom(1)
    expect(patch.result.ocrText).toBe('')
    expect(patch.result.extractedText).toBe('')
  })
})

// ─── useSlowAnalysis branch coverage ────────────────────────────────────────

describe('useSlowAnalysis — branch coverage', () => {
  const setFiles = vi.fn()

  beforeEach(() => {
    setFiles.mockReset()
    vi.restoreAllMocks()
  })

  it('handles body wrapper in enqueue response', async () => {
    const { useSlowAnalysis } = await import('../hooks/useSlowAnalysis')
    const { result } = renderHook(() => useSlowAnalysis(setFiles))

    let pollCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/analyze')) {
        return Promise.resolve({
          ok: true, json: () => Promise.resolve({
            body: JSON.stringify({ jobId: 'slow-1' }),
          }),
        })
      }
      pollCount++
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          status: 'COMPLETED',
          result: { summary: 'Slow done', content_classification: 'X' },
        }),
      })
    })

    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    // Give polling time to resolve
    await act(async () => {
      await new Promise(r => setTimeout(r, 50))
    })

    expect(result.current.slowJobs.length).toBeGreaterThanOrEqual(1)
  })

  it('handles non-ok polling response', async () => {
    const { useSlowAnalysis } = await import('../hooks/useSlowAnalysis')
    const { result } = renderHook(() => useSlowAnalysis(setFiles))

    let pollCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/analyze')) {
        return Promise.resolve({
          ok: true, json: () => Promise.resolve({ jobId: 'slow-2' }),
        })
      }
      pollCount++
      if (pollCount <= 1) {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          status: 'COMPLETED',
          result: { summary: 'R', content_classification: 'X' },
        }),
      })
    })

    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await act(async () => {
      await new Promise(r => setTimeout(r, 80))
    })

    // Should eventually complete
    expect(result.current.slowJobs.some(j => j.status === 'complete')).toBe(true)
  })

  it('handles PROCESSING status then FAILED', async () => {
    const { useSlowAnalysis } = await import('../hooks/useSlowAnalysis')
    const { result } = renderHook(() => useSlowAnalysis(setFiles))

    let pollCount = 0
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/analyze')) {
        return Promise.resolve({
          ok: true, json: () => Promise.resolve({ jobId: 'slow-3' }),
        })
      }
      pollCount++
      if (pollCount === 1) {
        return Promise.resolve({
          ok: true

,
          json: () => Promise.resolve({ status: 'PROCESSING' }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'FAILED', error: 'OOM' }),
      })
    })

    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await act(async () => {
      await new Promise(r => setTimeout(r, 80))
    })

    expect(result.current.slowJobs.some(j => j.status === 'failed')).toBe(true)
  })

  it('handles non-Error throw from enqueue', async () => {
    const { useSlowAnalysis } = await import('../hooks/useSlowAnalysis')
    const { result } = renderHook(() => useSlowAnalysis(setFiles))

    globalThis.fetch = vi.fn().mockRejectedValue('string error')

    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    const calls = setFiles.mock.calls
    const errorPatch = calls.find((c: any) => {
      if (typeof c[0] !== 'function') return false
      return c[0]([{ id: 'f1', status: 'analyzing' }])[0]?.status === 'error'
    })
    expect(errorPatch).toBeTruthy()
  })
})

// ─── useToast branch coverage ───────────────────────────────────────────────

describe('useToast — branch coverage', () => {
  it('dismiss with non-existent ID does not throw', async () => {
    const { useToast } = await import('../hooks/useToast')
    const { result } = renderHook(() => useToast())

    act(() => {
      result.current.dismiss('nonexistent-id')
    })

    expect(result.current.toasts).toEqual([])
  })
})

// ─── export.ts branch coverage ──────────────────────────────────────────────

describe('resultToMarkdown — additional branch coverage', () => {
  it('handles result with no model/provider/processingTime/usage', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const md = resultToMarkdown('test.png', {
      summary: 'S',
      description: '',
      insights: [],
      observations: [],
      contentClassification: '',
      ocrText: '',
      chainOfThought: '',
      mode: 'fast',
      processingTimeMs: 0,
      finishReason: 'stop',
      // model, provider, usage are all undefined
    })
    expect(md).toContain('unknown')
    expect(md).not.toContain('Processing time')
    expect(md).not.toContain('Tokens')
  })

  it('handles result with "No text detected." ocrText (no OCR section)', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const md = resultToMarkdown('test.png', {
      summary: 'S',
      description: '',
      insights: [],
      observations: [],
      contentClassification: 'Photo',
      ocrText: 'No text detected.',
      chainOfThought: '',
      mode: 'fast',
      processingTimeMs: 0,
      finishReason: 'stop',
    })
    expect(md).not.toContain('Extracted Text')
  })

  it('handles result with no summary (empty)', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const md = resultToMarkdown('test.png', {
      summary: '',
      description: 'Desc',
      insights: ['I1'],
      observations: ['O1'],
      contentClassification: '',
      ocrText: 'Hello',
      chainOfThought: 'Think',
      mode: 'fast',
      processingTimeMs: 5000,
      finishReason: 'stop',
      model: 'qwen',
      provider: 'bedrock',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(md).not.toContain('## Summary')
    expect(md).toContain('## Description')
    expect(md).toContain('## Insights')
    expect(md).toContain('## Observations')
    expect(md).toContain('Extracted Text')
    expect(md).toContain('Chain of Thought')
    expect(md).toContain('5.0s')
    expect(md).toContain('100 input')
  })

  it('handles result with no contentClassification', async () => {
    const { resultToMarkdown } = await import('../utils/export')
    const md = resultToMarkdown('test.png', {
      summary: 'S',
      description: '',
      insights: [],
      observations: [],
      contentClassification: '',
      ocrText: '',
      chainOfThought: '',
      mode: 'fast',
      processingTimeMs: 0,
      finishReason: 'stop',
    })
    expect(md).not.toContain('Content Classification')
  })
})

// ─── UploadZone clipboard paste branch coverage ─────────────────────────────

import { UploadZone } from '../components/UploadZone'
import { LanguageProvider } from '../contexts/LanguageContext'

describe('UploadZone — clipboard paste branches', () => {
  it('handles paste with file items', async () => {
    const onFilesAdded = vi.fn()
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} />
      </LanguageProvider>,
    )

    const file = new File(['test'], 'pasted.png', { type: 'image/png' })
    // UploadZone adds a paste listener to `document`, fire it via dispatchEvent
    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{ kind: 'file', getAsFile: () => file }],
    }
    pasteEvent.preventDefault = vi.fn()
    document.dispatchEvent(pasteEvent)

    expect(onFilesAdded).toHaveBeenCalledWith([file])
    expect(pasteEvent.preventDefault).toHaveBeenCalled()
  })

  it('ignores paste with only string items', () => {
    const onFilesAdded = vi.fn()
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} />
      </LanguageProvider>,
    )

    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{ kind: 'string', getAsFile: () => null }],
    }
    document.dispatchEvent(pasteEvent)

    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  it('ignores paste when getAsFile returns null', () => {
    const onFilesAdded = vi.fn()
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} />
      </LanguageProvider>,
    )

    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{ kind: 'file', getAsFile: () => null }],
    }
    document.dispatchEvent(pasteEvent)

    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  it('ignores paste when disabled', () => {
    const onFilesAdded = vi.fn()
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} disabled />
      </LanguageProvider>,
    )

    const file = new File(['test'], 'pasted.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = {
      items: [{ kind: 'file', getAsFile: () => file }],
    }
    document.dispatchEvent(pasteEvent)

    expect(onFilesAdded).not.toHaveBeenCalled()
  })

  it('handles paste with no clipboardData items', () => {
    const onFilesAdded = vi.fn()
    render(
      <LanguageProvider>
        <UploadZone onFilesAdded={onFilesAdded} />
      </LanguageProvider>,
    )

    const pasteEvent = new Event('paste', { bubbles: true }) as any
    pasteEvent.clipboardData = { items: undefined }
    document.dispatchEvent(pasteEvent)

    expect(onFilesAdded).not.toHaveBeenCalled()
  })
})

// ─── ModeToggle branch coverage ─────────────────────────────────────────────

import { ModeProvider, useMode } from '../contexts/ModeContext'
import { ModeToggle } from '../components/ModeToggle'

describe('ModeToggle — branch coverage', () => {
  it('starts in fast mode and switches to slow', async () => {
    function TestApp() {
      const { mode } = useMode()
      return (
        <div>
          <span data-testid="mode">{mode}</span>
          <ModeToggle />
        </div>
      )
    }

    render(
      <ModeProvider>
        <LanguageProvider>
          <TestApp />
        </LanguageProvider>
      </ModeProvider>,
    )

    expect(screen.getByTestId('mode')).toHaveTextContent('fast')
    const slowBtn = screen.getByRole('button', { name: /slow/i })
    await userEvent.click(slowBtn)
    expect(screen.getByTestId('mode')).toHaveTextContent('slow')
  })
})
