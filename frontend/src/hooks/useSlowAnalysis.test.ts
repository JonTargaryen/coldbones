import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSlowAnalysis } from './useSlowAnalysis';

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

describe('useSlowAnalysis', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates complete job when backend succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        summary: 'ok',
        key_observations: [],
        content_classification: 'photo',
        extracted_text: '',
        reasoning: '',
        reasoning_token_count: 0,
        finish_reason: 'stop',
        processing_time_ms: 25,
      }),
    }));

    const { result } = renderHook(() => useSlowAnalysis());

    await act(async () => {
      await result.current.submitSlowJob([uploaded], 'en');
    });

    expect(result.current.jobs).toHaveLength(1);
    expect(result.current.jobs[0].status).toBe('complete');
  });

  it('returns early on empty input', async () => {
    const { result } = renderHook(() => useSlowAnalysis());
    await act(async () => {
      await result.current.submitSlowJob([], 'en');
    });
    expect(result.current.jobs).toHaveLength(0);
  });

  it('skips files already in error state', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderHook(() => useSlowAnalysis());

    await act(async () => {
      await result.current.submitSlowJob([{ ...uploaded, status: 'error', error: 'bad' }], 'en');
    });

    expect(result.current.jobs).toHaveLength(0);
  });

  it('marks failed when backend returns non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'bad input' }),
    }));

    const { result } = renderHook(() => useSlowAnalysis());

    await act(async () => {
      await result.current.submitSlowJob([uploaded], 'en');
    });

    expect(result.current.jobs[0].status).toBe('failed');
    expect(result.current.jobs[0].errorMessage).toContain('bad input');
  });

  it('marks failed on network error and clears jobs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { result } = renderHook(() => useSlowAnalysis());

    await act(async () => {
      await result.current.submitSlowJob([uploaded], 'en');
    });

    expect(result.current.jobs[0].status).toBe('failed');
    expect(result.current.jobs[0].errorMessage).toContain('network down');

    act(() => result.current.clearJobs());
    expect(result.current.jobs).toHaveLength(0);
  });
});
