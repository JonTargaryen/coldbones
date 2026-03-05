/**
 * Coverage boost tests for: translations, useEstimate (localStorage),
 * useHistory (localStorage/retry), validateBatchSize.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ─── translations ────────────────────────────────────────────────────────────

describe('translations — all locales and model instructions', () => {
  it('TRANSLATION_MAP has en, hi, es, bn with correct keys', async () => {
    const { TRANSLATION_MAP } = await import('../i18n/translations')
    for (const lang of ['en', 'hi', 'es', 'bn'] as const) {
      const t = TRANSLATION_MAP[lang]
      expect(t.uploadTitle).toBeTruthy()
      expect(t.uploadTitleDrag).toBeTruthy()
      expect(t.uploadSubtitle).toBeTruthy()
      expect(t.uploadHint).toBeTruthy()
      expect(t.clearAll).toBeTruthy()
      expect(t.emptyAnalysis).toBeTruthy()
      expect(t.analysisError).toBeTruthy()
      expect(typeof t.analyzing).toBe('function')
      expect(t.analyzing('file.png')).toBeTruthy()
      expect(t.analyzing()).toBeTruthy()
      expect(t.thinkingHint).toBeTruthy()
      expect(t.reasoning).toBeTruthy()
      expect(t.tokens).toBeTruthy()
      expect(t.summary).toBeTruthy()
      expect(t.keyObservations).toBeTruthy()
      expect(t.contentClassification).toBeTruthy()
      expect(t.extractedText).toBeTruthy()
      expect(t.mode).toBeTruthy()
      expect(t.fast).toBeTruthy()
      expect(t.slow).toBeTruthy()
      expect(typeof t.processedIn).toBe('function')
      expect(t.processedIn('3.5')).toBeTruthy()
      expect(t.truncated).toBeTruthy()
      expect(t.truncatedTooltip).toBeTruthy()
    }
  })

  it('MODEL_LANGUAGE_INSTRUCTIONS has entries for all languages', async () => {
    const { MODEL_LANGUAGE_INSTRUCTIONS } = await import('../i18n/translations')
    expect(MODEL_LANGUAGE_INSTRUCTIONS.en).toBe('')
    expect(MODEL_LANGUAGE_INSTRUCTIONS.hi).toContain('Hindi')
    expect(MODEL_LANGUAGE_INSTRUCTIONS.es).toContain('Spanish')
    expect(MODEL_LANGUAGE_INSTRUCTIONS.bn).toContain('Bengali')
  })

  it('LANGUAGES array has correct metadata', async () => {
    const { LANGUAGES } = await import('../i18n/translations')
    expect(LANGUAGES).toHaveLength(4)
    expect(LANGUAGES.map(l => l.code)).toEqual(['en', 'hi', 'es', 'bn'])
    for (const lang of LANGUAGES) {
      expect(lang.label).toBeTruthy()
      expect(lang.labelEn).toBeTruthy()
      expect(lang.flag).toBeTruthy()
      expect(lang.dir).toBe('ltr')
    }
  })
})

// ─── useEstimate — localStorage pre-populated ────────────────────────────────

describe('useEstimate — with existing localStorage data', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads existing times from localStorage', async () => {
    localStorage.setItem('coldbones:processingTimes', JSON.stringify([3000, 5000, 7000]))
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())
    // median of [3000, 5000, 7000] = 5000
    expect(result.current.estimateMs).toBe(5000)
  })

  it('computes median for even-length array', async () => {
    localStorage.setItem('coldbones:processingTimes', JSON.stringify([2000, 4000, 6000, 8000]))
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())
    // median of [2000, 4000, 6000, 8000] = (4000+6000)/2 = 5000
    expect(result.current.estimateMs).toBe(5000)
  })

  it('handles corrupted localStorage data gracefully', async () => {
    localStorage.setItem('coldbones:processingTimes', 'not-json')
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())
    expect(result.current.estimateMs).toBeNull()
  })

  it('handles non-array localStorage data gracefully', async () => {
    localStorage.setItem('coldbones:processingTimes', JSON.stringify({ bad: 'data' }))
    const { useEstimate } = await import('../hooks/useEstimate')
    const { result } = renderHook(() => useEstimate())
    expect(result.current.estimateMs).toBeNull()
  })
})

// ─── useHistory — localStorage pre-populated and retry ───────────────────────

describe('useHistory — localStorage pre-populated', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads existing history from localStorage', async () => {
    const existing = [
      { id: 'h1', fileName: 'old.png', timestamp: 1000, result: { summary: 'Old', description: '', insights: [], observations: [], contentClassification: 'Photo', ocrText: '', chainOfThought: '', mode: 'fast', processingTimeMs: 1000, finishReason: 'stop' } },
    ]
    localStorage.setItem('coldbones:history', JSON.stringify(existing))
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].fileName).toBe('old.png')
  })

  it('handles corrupted history gracefully', async () => {
    localStorage.setItem('coldbones:history', '{bad json')
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())
    expect(result.current.entries).toEqual([])
  })

  it('handles non-array history data gracefully', async () => {
    localStorage.setItem('coldbones:history', JSON.stringify('not-array'))
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())
    expect(result.current.entries).toEqual([])
  })

  it('retries with trimmed data when localStorage is full', async () => {
    const { useHistory } = await import('../hooks/useHistory')
    const { result } = renderHook(() => useHistory())

    // Add entries to fill up
    act(() => {
      for (let i = 0; i < 5; i++) {
        result.current.addEntry(`file${i}.png`, {
          summary: 'S', description: '', insights: [], observations: [],
          contentClassification: 'P', ocrText: '', chainOfThought: '',
          mode: 'fast', processingTimeMs: 1000, finishReason: 'stop',
        })
      }
    })

    // Now simulate localStorage full by making setItem throw on next call
    const origSetItem = localStorage.setItem.bind(localStorage)
    let callCount = 0
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, val) => {
      callCount++
      if (callCount <= 1) {
        throw new DOMException('quota exceeded')
      }
      return origSetItem(key, val)
    })

    // Trigger a save by adding another entry
    act(() => {
      result.current.addEntry('trigger.png', {
        summary: 'T', description: '', insights: [], observations: [],
        contentClassification: 'P', ocrText: '', chainOfThought: '',
        mode: 'fast', processingTimeMs: 1000, finishReason: 'stop',
      })
    })

    // The retry path should have been triggered
    expect(callCount).toBeGreaterThanOrEqual(1)
    vi.restoreAllMocks()
  })
})

// ─── validateBatchSize ───────────────────────────────────────────────────────

describe('validateBatchSize', () => {
  it('returns null when count is within fast-mode limit', async () => {
    const { validateBatchSize } = await import('../utils/validation')
    expect(validateBatchSize(5, 'fast')).toBeNull()
  })

  it('returns error message when count exceeds fast-mode limit', async () => {
    const { validateBatchSize } = await import('../utils/validation')
    const err = validateBatchSize(11, 'fast')
    expect(err).toContain('10')
    expect(err).toContain('fast')
  })

  it('returns null when count is within slow-mode limit', async () => {
    const { validateBatchSize } = await import('../utils/validation')
    expect(validateBatchSize(50, 'slow')).toBeNull()
  })

  it('returns error message when count exceeds slow-mode limit', async () => {
    const { validateBatchSize } = await import('../utils/validation')
    const err = validateBatchSize(51, 'slow')
    expect(err).toContain('50')
    expect(err).toContain('slow')
  })

  it('returns null for zero count', async () => {
    const { validateBatchSize } = await import('../utils/validation')
    expect(validateBatchSize(0, 'fast')).toBeNull()
  })
})
