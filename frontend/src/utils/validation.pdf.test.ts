import { describe, expect, it, vi } from 'vitest';

describe('validation pdf branch', () => {
  it('rejects PDFs over page limit and validates batch', async () => {
    vi.resetModules();
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.resolve({ numPages: 60, destroy: () => {} }) }),
    }));

    const { validatePdfPageCount, validateBatch } = await import('./validation');

    const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(pdf, 'arrayBuffer', {
      value: async () => new ArrayBuffer(8),
    });
    const err = await validatePdfPageCount(pdf);
    expect(err).toContain('Maximum allowed: 50 pages');

    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ];
    const out = validateBatch(files, 'fast');
    expect(out).toHaveLength(0);
  });

  it('swallows pdf parser errors and returns null', async () => {
    vi.resetModules();
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: () => ({ promise: Promise.reject(new Error('broken')) }),
    }));

    const mod = await import('./validation');
    const pdf = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });
    const err = await mod.validatePdfPageCount(pdf);
    expect(err).toBeNull();
  });
});
