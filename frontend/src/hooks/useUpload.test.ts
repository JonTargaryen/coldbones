import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUpload } from './useUpload';
import { validatePdfPageCount } from '../utils/validation';

vi.mock('../utils/validation', async () => {
  const actual = await vi.importActual<typeof import('../utils/validation')>('../utils/validation');
  return {
    ...actual,
    validatePdfPageCount: vi.fn(async () => null),
  };
});

describe('useUpload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob://x'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('adds valid files and marks uploaded', async () => {
    const { result } = renderHook(() => useUpload());
    const file = new File(['x'], 'x.png', { type: 'image/png' });

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => {
      expect(result.current.files[0].status).toBe('uploaded');
    });
  });

  it('marks pdf as error when page validation fails', async () => {
    vi.mocked(validatePdfPageCount).mockResolvedValueOnce('too many pages');
    const { result } = renderHook(() => useUpload());
    const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });

    act(() => {
      result.current.addFiles([pdf]);
    });

    await waitFor(() => {
      expect(result.current.files[0].status).toBe('error');
      expect(result.current.files[0].error).toContain('too many pages');
    });
  });

  it('marks upload as error if processing throws', async () => {
    vi.mocked(validatePdfPageCount).mockRejectedValueOnce(new Error('validator crash'));
    const { result } = renderHook(() => useUpload());
    const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });

    act(() => {
      result.current.addFiles([pdf]);
    });

    await waitFor(() => {
      expect(result.current.files[0].status).toBe('error');
      expect(result.current.files[0].error).toContain('validator crash');
    });
  });

  it('marks invalid files as error', () => {
    const { result } = renderHook(() => useUpload());
    const bad = new File(['x'], 'x.txt', { type: 'text/plain' });

    act(() => {
      result.current.addFiles([bad]);
    });

    expect(result.current.files[0].status).toBe('error');
  });

  it('removes and clears files', async () => {
    const { result } = renderHook(() => useUpload());
    const file = new File(['x'], 'x.png', { type: 'image/png' });

    act(() => {
      result.current.addFiles([file]);
    });

    await waitFor(() => expect(result.current.files.length).toBe(1));

    const id = result.current.files[0].id;
    act(() => result.current.removeFile(id));
    expect(result.current.files.length).toBe(0);

    act(() => {
      result.current.addFiles([file]);
    });
    act(() => result.current.clearFiles());
    expect(result.current.files.length).toBe(0);
  });
});
