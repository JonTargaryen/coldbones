import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilePreview } from './FilePreview';
import type { UploadedFile } from '../types';

vi.mock('pdfjs-dist', () => {
  const doc = {
    numPages: 3,
    getPage: async () => ({
      getViewport: () => ({ height: 100, width: 100 }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    }),
    destroy: () => {},
  };
  return {
    default: {},
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({ promise: Promise.resolve(doc) }),
  };
});

const mkUploaded = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
  id: 'f1',
  file: new File(['img'], 'a.png', { type: 'image/png' }),
  name: 'a.png',
  size: 1024,
  type: 'image/png',
  previewUrl: 'blob://x',
  status: 'uploaded',
  progress: 100,
  ...overrides,
});

describe('FilePreview', () => {
  it('renders pdf preview with page navigation and zoom controls', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({} as CanvasRenderingContext2D));
    const pdfFile = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(pdfFile, 'arrayBuffer', {
      value: async () => new ArrayBuffer(8),
    });

    const pdf = mkUploaded({
      id: 'pdf1',
      name: 'doc.pdf',
      file: pdfFile,
      type: 'application/pdf',
      size: 2 * 1024 * 1024,
    });

    render(<FilePreview file={pdf} files={[pdf]} onSelect={() => {}} onRemove={() => {}} />);

    expect(await screen.findByText(/Page 1 of 3/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next page/i }));
    expect(await screen.findByText(/Page 2 of 3/i)).toBeInTheDocument();

    const container = screen.getByRole('img', { name: /Preview of doc.pdf/i });
    fireEvent.wheel(container, { ctrlKey: true, deltaY: -20 });
    expect(screen.getByTitle(/Reset zoom/i)).toBeInTheDocument();
  });

  it('renders empty state when no files', () => {
    render(<FilePreview file={null} files={[]} onSelect={() => {}} onRemove={() => {}} />);
    expect(screen.getByText(/No files uploaded yet/i)).toBeInTheDocument();
  });

  it('renders image preview and remove button for single file', () => {
    const onRemove = vi.fn();
    const file = mkUploaded();
    render(<FilePreview file={file} files={[file]} onSelect={() => {}} onRemove={onRemove} />);

    expect(screen.getByText('a.png')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove file/i }));
    expect(onRemove).toHaveBeenCalledWith('f1');
  });

  it('renders multiple thumbnails and handles select/remove', () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    const f1 = mkUploaded();
    const f2 = mkUploaded({ id: 'f2', name: 'b.pdf', file: new File(['pdf'], 'b.pdf', { type: 'application/pdf' }), type: 'application/pdf', status: 'error', error: 'bad' });

    render(<FilePreview file={f1} files={[f1, f2]} onSelect={onSelect} onRemove={onRemove} />);

    fireEvent.click(screen.getByLabelText('b.pdf'));
    expect(onSelect).toHaveBeenCalledWith('f2');

    fireEvent.click(screen.getByLabelText('Remove b.pdf'));
    expect(onRemove).toHaveBeenCalledWith('f2');
  });
});
