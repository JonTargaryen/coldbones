import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnalysis } from './useAnalysis';

const file = new File(['x'], 'x.png', { type: 'image/png' });
const uploaded = {
  id: 'f1',
  file,
  name: 'x.png',
  size: file.size,
  type: file.type,
  previewUrl: 'blob://x',
  status: 'uploaded' as const,
  progress: 100,
};

describe('useAnalysis', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('analyzes a file successfully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: 'ok',
        key_observations: ['a'],
        content_classification: 'photo',
        extracted_text: 'No text detected.',
        reasoning: 'r',
        reasoning_token_count: 2,
        finish_reason: 'stop',
        processing_time_ms: 123,
      }),
    }));

    const { result } = renderHook(() => useAnalysis());
    const out = await act(async () => result.current.analyzeFile(uploaded, 'fast', 'en'));

    expect(out?.summary).toBe('ok');
    expect(result.current.results.get('f1')?.contentClassification).toBe('photo');
  });

  it('handles analyze error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'bad' }),
    }));

    const { result } = renderHook(() => useAnalysis());
    const out = await act(async () => result.current.analyzeFile(uploaded, 'fast', 'en'));

    expect(out).toBeNull();
    expect(result.current.error).toBe('bad');
  });

  it('handles analyze error response with invalid error json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new Error('invalid json'); },
    }));

    const { result } = renderHook(() => useAnalysis());
    const out = await act(async () => result.current.analyzeFile(uploaded, 'fast', 'en'));

    expect(out).toBeNull();
    expect(result.current.error).toContain('Analysis failed');
  });

  it('analyzeAll updates status callbacks and clears state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'ok', key_observations: [], content_classification: 'x', extracted_text: '', reasoning: '', reasoning_token_count: 0, finish_reason: 'stop', processing_time_ms: 1 }),
    }));

    const onProgress = vi.fn();
    const { result } = renderHook(() => useAnalysis());

    await act(async () => {
      await result.current.analyzeAll([uploaded], 'fast', onProgress, 'en');
    });

    expect(onProgress).toHaveBeenCalledWith('f1', 'analyzing');
    expect(onProgress).toHaveBeenCalledWith('f1', 'complete');
    expect(result.current.isAnalyzing).toBe(false);
    expect(result.current.currentFileId).toBeNull();

    act(() => result.current.clearResults());
    expect(result.current.results.size).toBe(0);
  });
});
