/**
 * Tests for useAnalysis, useUpload, and useSlowAnalysis hooks.
 * Mocks config with short poll intervals for fast tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ─── Mock config with short intervals ──────────────────────────────────────
vi.mock('../config', () => ({
  API_BASE_URL: '',
  FAST_POLL_INTERVAL_MS: 10,
  FAST_POLL_TIMEOUT_MS: 100,
  SLOW_POLL_INTERVAL_MS: 10,
  SLOW_POLL_TIMEOUT_MS: 100,
  ALLOWED_MIME_TYPES: new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'image/bmp', 'image/tiff', 'application/pdf',
  ]),
  MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024,
  HISTORY_MAX_ITEMS: 50,
}))

import { useAnalysis } from '../hooks/useAnalysis'
import { useUpload } from '../hooks/useUpload'
import { useSlowAnalysis } from '../hooks/useSlowAnalysis'

// ─── helpers ───────────────────────────────────────────────────────────────

function apiResult(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Summary',
    content_classification: 'Photo',
    key_observations: ['obs1'],
    extracted_text: 'hello',
    processing_time_ms: 1000,
    mode: 'fast',
    ...overrides,
  }
}

/** Call the updater captured by a vi.fn() setFiles mock and return the patched file */
function patchFrom(
  mockSetFiles: ReturnType<typeof vi.fn>,
  callIndex: number,
  fileId = 'f1',
) {
  const updater = mockSetFiles.mock.calls[callIndex][0]
  const prev = [{ id: fileId, status: 'pending' }]
  return updater(prev).find((f: any) => f.id === fileId)
}

const origFetch = globalThis.fetch
const origXHR = globalThis.XMLHttpRequest
const origCreateURL = URL.createObjectURL
const origRevokeURL = URL.revokeObjectURL

afterEach(() => {
  globalThis.fetch = origFetch
  globalThis.XMLHttpRequest = origXHR
  URL.createObjectURL = origCreateURL
  URL.revokeObjectURL = origRevokeURL
})

// ═══════════════════════════════════════════════════════════════════════════
// useAnalysis
// ═══════════════════════════════════════════════════════════════════════════

describe('useAnalysis', () => {
  const setFiles = vi.fn()

  beforeEach(() => setFiles.mockReset())

  it('handles 200 response and maps all result fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          apiResult({
            summary: 'Cat photo',
            chain_of_thought: 'Step 1',
            description: 'A cat',
            insights: ['cute'],
            observations: ['fur'],
            ocr_text: 'meow',
            finish_reason: 'stop',
            model: 'qwen3vl',
            provider: 'Bedrock',
            reasoning: 'r1',
            reasoning_token_count: 5,
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        ),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'key', 'file.png', 'en')
    })

    expect(setFiles).toHaveBeenCalledTimes(2)
    expect(patchFrom(setFiles, 0).status).toBe('analyzing')

    const p = patchFrom(setFiles, 1)
    expect(p.status).toBe('complete')
    expect(p.result.summary).toBe('Cat photo')
    expect(p.result.chainOfThought).toBe('Step 1')
    expect(p.result.description).toBe('A cat')
    expect(p.result.insights).toEqual(['cute'])
    expect(p.result.observations).toEqual(['fur'])
    expect(p.result.ocrText).toBe('meow')
    expect(p.result.reasoning).toBe('r1')
    expect(p.result.reasoningTokenCount).toBe(5)
    expect(p.result.usage.inputTokens).toBe(100)
    expect(p.result.usage.outputTokens).toBe(50)
    expect(p.result.model).toBe('qwen3vl')
    expect(p.result.provider).toBe('Bedrock')
  })

  it('maps "No text detected." sentinel to empty string', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          apiResult({ extracted_text: 'No text detected.', ocr_text: 'No text detected.' }),
        ),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const p = patchFrom(setFiles, 1)
    expect(p.result.ocrText).toBe('')
    expect(p.result.extractedText).toBe('')
  })

  it('unwraps API Gateway body wrapper', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ body: JSON.stringify(apiResult({ summary: 'unwrapped' })) }),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(patchFrom(setFiles, 1).result.summary).toBe('unwrapped')
  })

  it('handles missing optional fields gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          summary: 'min',
          content_classification: 'X',
          key_observations: [],
          extracted_text: '',
        }),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const r = patchFrom(setFiles, 1).result
    expect(r.chainOfThought).toBe('')
    expect(r.description).toBe('')
    expect(r.insights).toEqual([])
    expect(r.reasoning).toBe('')
    expect(r.reasoningTokenCount).toBe(0)
    expect(r.finishReason).toBe('stop')
    expect(r.processingTimeMs).toBe(0)
    expect(r.mode).toBe('fast')
    expect(r.usage).toBeUndefined()
  })

  it('polls from 202 until COMPLETED', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1)
        return { ok: true, status: 202, json: async () => ({ jobId: 'j1', status: 'processing' }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult({ summary: 'polled' }) }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(n).toBeGreaterThanOrEqual(2)
    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('complete')
    expect(last.result.summary).toBe('polled')
  })

  it('sets error on FAILED poll status', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, status: 202, json: async () => ({ jobId: 'j2' }) }
      return { ok: true, json: async () => ({ status: 'FAILED', error: 'GPU OOM' }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('error')
    expect(last.error).toContain('GPU OOM')
  })

  it('FAILED without error message uses default', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, status: 202, json: async () => ({ jobId: 'j2b' }) }
      return { ok: true, json: async () => ({ status: 'FAILED' }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.error).toContain('Analysis failed on server')
  })

  it('times out when polling exceeds deadline', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/status'))
        return { ok: true, json: async () => ({ status: 'PROCESSING' }) }
      return { ok: true, status: 202, json: async () => ({ jobId: 'j3' }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('error')
    expect(last.error).toContain('timed out')
  })

  it('surfaces partial_text during polling', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, status: 202, json: async () => ({ jobId: 'j4' }) }
      if (n === 2) return { ok: true, json: async () => ({ status: 'PROCESSING', partial_text: 'thinking...' }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const partialCall = setFiles.mock.calls.find((c: any[]) => {
      const patched = c[0]([{ id: 'f1' }])
      return patched[0].partialText === 'thinking...'
    })
    expect(partialCall).toBeDefined()
  })

  it('errors when 202 has no jobId', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ status: 'processing' }),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('error')
    expect(last.error).toContain('no jobId')
  })

  it('errors on non-ok response with detail', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'Bad request' }),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(patchFrom(setFiles, setFiles.mock.calls.length - 1).error).toContain('Bad request')
  })

  it('errors on non-ok response when json parsing fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse')),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(patchFrom(setFiles, setFiles.mock.calls.length - 1).error).toContain('500')
  })

  it('errors when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Network down')) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(patchFrom(setFiles, setFiles.mock.calls.length - 1).error).toContain('Network down')
  })

  it('passes provider and lang in fetch body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(apiResult()),
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'hi', 'local')
    })

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)
    expect(body.provider).toBe('local')
    expect(body.lang).toBe('hi')
    expect(body.mode).toBe('fast')
  })

  it('unwraps body wrapper in poll response', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, status: 202, json: async () => ({ jobId: 'j5' }) }
      return {
        ok: true,
        json: async () => ({
          body: JSON.stringify({ status: 'COMPLETED', result: apiResult({ summary: 'wrapped-poll' }) }),
        }),
      }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.result.summary).toBe('wrapped-poll')
  })

  it('handles non-Error throw in catch', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce('string error') as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(patchFrom(setFiles, setFiles.mock.calls.length - 1).error).toBe('Analysis failed')
  })

  it('keeps polling after transient network error during poll', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, status: 202, json: async () => ({ jobId: 'j6' }) }
      if (n === 2) throw new Error('transient')
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useAnalysis(setFiles))
    await act(async () => {
      await result.current.analyze('f1', 'k', 'f.png', 'en')
    })

    expect(n).toBeGreaterThanOrEqual(3)
    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('complete')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// useUpload
// ═══════════════════════════════════════════════════════════════════════════

/** Create an XMLHttpRequest mock class */
function makeXhrClass(type: 'success' | 'error' | 'non2xx') {
  return class MockXHR {
    status = type === 'non2xx' ? 403 : 200
    private _listeners: Record<string, Function> = {}
    upload = {
      _progressCb: null as Function | null,
      addEventListener(e: string, cb: Function) {
        if (e === 'progress') this._progressCb = cb
      },
    }
    addEventListener(e: string, cb: Function) {
      this._listeners[e] = cb
    }
    open() {}
    setRequestHeader() {}
    send() {
      const listeners = this._listeners
      const progressCb = this.upload._progressCb
      queueMicrotask(() => {
        progressCb?.({ lengthComputable: true, loaded: 100, total: 100 })
        if (type === 'error') listeners['error']?.()
        else listeners['load']?.()
      })
    }
  }
}

describe('useUpload', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
  })

  it('starts with empty files', () => {
    const { result } = renderHook(() => useUpload())
    expect(result.current.files).toEqual([])
  })

  it('filters out invalid MIME types', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const valid = new File([new Uint8Array(10)], 'ok.png', { type: 'image/png' })
    const invalid = new File([new Uint8Array(10)], 'bad.exe', { type: 'application/x-msdownload' })

    await act(async () => {
      await result.current.addFiles([valid, invalid])
    })

    expect(result.current.files).toHaveLength(1)
    expect(result.current.files[0].name).toBe('ok.png')
  })

  it('filters out oversized files', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const big = new File([new Uint8Array(21 * 1024 * 1024)], 'huge.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([big])
    })

    expect(result.current.files).toHaveLength(0)
  })

  it('uploads valid file through presign + S3', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ uploadUrl: 'https://s3/put', s3Key: 'uploads/test.png', expiresIn: 3600 }),
    })
    globalThis.XMLHttpRequest = makeXhrClass('success') as any

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(100)], 'photo.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    expect(result.current.files).toHaveLength(1)
    expect(result.current.files[0].status).toBe('uploaded')
    expect(result.current.files[0].s3Key).toBe('uploads/test.png')
    expect(result.current.files[0].progress).toBe(100)
  })

  it('sets error when presign fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ detail: 'Unauthorized' }),
    })

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    expect(result.current.files[0].status).toBe('error')
    expect(result.current.files[0].error).toContain('Unauthorized')
  })

  it('sets error when presign json parse fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('parse')),
    })

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    expect(result.current.files[0].status).toBe('error')
    expect(result.current.files[0].error).toContain('500')
  })

  it('sets error on XHR network error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ uploadUrl: 'https://s3/put', s3Key: 'k', expiresIn: 3600 }),
    })
    globalThis.XMLHttpRequest = makeXhrClass('error') as any

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    expect(result.current.files[0].status).toBe('error')
    expect(result.current.files[0].error).toContain('network error')
  })

  it('sets error on XHR non-2xx status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ uploadUrl: 'https://s3/put', s3Key: 'k', expiresIn: 3600 }),
    })
    globalThis.XMLHttpRequest = makeXhrClass('non2xx') as any

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    expect(result.current.files[0].status).toBe('error')
    expect(result.current.files[0].error).toContain('S3 upload failed')
  })

  it('creates previewUrl for image files only', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const img = new File([new Uint8Array(10)], 'img.png', { type: 'image/png' })
    const pdf = new File([new Uint8Array(10)], 'doc.pdf', { type: 'application/pdf' })

    await act(async () => {
      await result.current.addFiles([img, pdf])
    })

    const imgEntry = result.current.files.find((f) => f.name === 'img.png')
    const pdfEntry = result.current.files.find((f) => f.name === 'doc.pdf')
    expect(imgEntry?.previewUrl).toBe('blob:fake')
    expect(pdfEntry?.previewUrl).toBeUndefined()
  })

  it('removeFile removes file and revokes previewUrl', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const file = new File([new Uint8Array(10)], 'test.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([file])
    })

    const id = result.current.files[0].id
    act(() => result.current.removeFile(id))

    expect(result.current.files).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake')
  })

  it('clearAll removes all files and revokes all URLs', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const f1 = new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })
    const f2 = new File([new Uint8Array(10)], 'b.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([f1, f2])
    })

    act(() => result.current.clearAll())

    expect(result.current.files).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })

  it('reorderFiles moves a file', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('skip'))

    const { result } = renderHook(() => useUpload())
    const a = new File([new Uint8Array(10)], 'a.png', { type: 'image/png' })
    const b = new File([new Uint8Array(10)], 'b.png', { type: 'image/png' })
    const c = new File([new Uint8Array(10)], 'c.png', { type: 'image/png' })

    await act(async () => {
      await result.current.addFiles([a, b, c])
    })

    act(() => result.current.reorderFiles(0, 2))

    expect(result.current.files[0].name).toBe('b.png')
    expect(result.current.files[1].name).toBe('c.png')
    expect(result.current.files[2].name).toBe('a.png')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// useSlowAnalysis
// ═══════════════════════════════════════════════════════════════════════════

describe('useSlowAnalysis', () => {
  const setFiles = vi.fn()

  beforeEach(() => setFiles.mockReset())

  it('enqueue posts with mode=slow and creates slow job', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj1' }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))

    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    // Check POST body
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)
    expect(body.mode).toBe('slow')

    // Slow job created
    expect(result.current.slowJobs.length).toBeGreaterThanOrEqual(1)
    expect(result.current.slowJobs[0].jobId).toBe('sj1')
    expect(result.current.slowJobs[0].fileName).toBe('file.png')

    // Wait for polling to complete
    await waitFor(() => {
      const job = result.current.slowJobs.find((j) => j.jobId === 'sj1')
      expect(job?.status).toBe('complete')
    })
  })

  it('polls until FAILED and updates both slowJob and file', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj2' }) }
      return { ok: true, json: async () => ({ status: 'FAILED', error: 'OOM' }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      const job = result.current.slowJobs.find((j) => j.jobId === 'sj2')
      expect(job?.status).toBe('failed')
      expect(job?.errorMessage).toBe('OOM')
    })

    // File also marked as error
    const lastPatch = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(lastPatch.status).toBe('error')
  })

  it('FAILED without error uses default message', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj2b' }) }
      return { ok: true, json: async () => ({ status: 'FAILED' }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      expect(result.current.slowJobs[0]?.errorMessage).toBe('Job failed')
    })
  })

  it('times out after deadline', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/status'))
        return { ok: true, json: async () => ({ status: 'QUEUED' }) }
      return { ok: true, json: async () => ({ jobId: 'sj3' }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(
      () => {
        const job = result.current.slowJobs.find((j) => j.jobId === 'sj3')
        expect(job?.status).toBe('failed')
        expect(job?.errorMessage).toContain('timed out')
      },
      { timeout: 500 },
    )
  })

  it('updates slowJob to processing status', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj4' }) }
      if (n === 2) return { ok: true, json: async () => ({ status: 'PROCESSING' }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      const job = result.current.slowJobs.find((j) => j.jobId === 'sj4')
      expect(job?.status).toBe('complete')
    })
  })

  it('keeps polling after network error', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj5' }) }
      if (n === 2) throw new Error('transient')
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      expect(result.current.slowJobs[0]?.status).toBe('complete')
    })
  })

  it('skips non-ok poll response and continues', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj6' }) }
      if (n === 2) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      expect(result.current.slowJobs[0]?.status).toBe('complete')
    })
  })

  it('errors when enqueue fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('down')) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.status).toBe('error')
    expect(last.error).toContain('down')
  })

  it('errors when enqueue response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'Rate limited' }),
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    const last = patchFrom(setFiles, setFiles.mock.calls.length - 1)
    expect(last.error).toContain('Rate limited')
  })

  it('unwraps body wrapper in enqueue response', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1)
        return { ok: true, json: async () => ({ body: JSON.stringify({ jobId: 'sj7' }) }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      expect(result.current.slowJobs[0]?.jobId).toBe('sj7')
    })
  })

  it('passes provider to enqueue fetch body', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj8' }) }
      return { ok: true, json: async () => ({ status: 'COMPLETED', result: apiResult() }) }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'es', 'cloud')
    })

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body)
    expect(body.provider).toBe('cloud')
    expect(body.lang).toBe('es')
    expect(body.mode).toBe('slow')
  })

  it('maps result through mapResult on COMPLETED', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) return { ok: true, json: async () => ({ jobId: 'sj9' }) }
      return {
        ok: true,
        json: async () => ({
          status: 'COMPLETED',
          result: apiResult({
            chain_of_thought: 'cot',
            ocr_text: 'No text detected.',
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
        }),
      }
    }) as any

    const { result } = renderHook(() => useSlowAnalysis(setFiles))
    await act(async () => {
      await result.current.enqueue('f1', 'key', 'file.png', 'en')
    })

    await waitFor(() => {
      const job = result.current.slowJobs[0]
      expect(job?.result?.chainOfThought).toBe('cot')
      expect(job?.result?.ocrText).toBe('')
      expect(job?.result?.usage?.inputTokens).toBe(10)
    })
  })
})
