import { useRef, useEffect, useState, useCallback, WheelEvent } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { UploadedFile } from '../types';
import { isImage } from '../utils/validation';

// Configure pdfjs worker (bundled via Vite)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).href;

/* ─── PDF Canvas Renderer ─── */
function PdfCanvas({ file, page, scale }: { file: File; page: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    let doc: PDFDocumentProxy | null = null;
    let cancelled = false;

    async function render() {
      if (!canvasRef.current) return;
      try {
        const arrayBuffer = await file.arrayBuffer();
        doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        if (cancelled) return;
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;

        const viewport = pdfPage.getViewport({ scale });
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d')!;
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        if (renderTaskRef.current) renderTaskRef.current.cancel();
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== 'Rendering cancelled') setError(msg);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      doc?.destroy();
    };
  }, [file, page, scale]);

  if (error) return <div className="preview-error">PDF render error: {error}</div>;
  return <canvas ref={canvasRef} className="pdf-canvas" />;
}

/* ─── PDF Page Count ─── */
async function getPdfPageCount(file: File): Promise<number> {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const count = doc.numPages;
  doc.destroy();
  return count;
}

/* ─── Main FilePreview ─── */
interface FilePreviewProps {
  file: UploadedFile | null;
  files: UploadedFile[];
  onSelect: (fileId: string) => void;
  onRemove: (fileId: string) => void;
}

export function FilePreview({ file, files, onSelect, onRemove }: FilePreviewProps) {
  const [zoom, setZoom] = useState(1);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);

  // Reset zoom and page when file changes
  useEffect(() => {
    setZoom(1);
    setPdfPage(1);
    setPdfPageCount(null);
    if (file && !isImage(file.file)) {
      getPdfPageCount(file.file)
        .then(count => setPdfPageCount(count))
        .catch(() => setPdfPageCount(null));
    }
  }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(z => Math.min(5, Math.max(0.3, z - e.deltaY * 0.002)));
    }
  }, []);

  const resetZoom = useCallback(() => setZoom(1), []);

  if (files.length === 0) {
    return (
      <div className="file-preview empty">
        <p className="preview-placeholder">No files uploaded yet</p>
      </div>
    );
  }

  return (
    <div className="file-preview">
      {/* Thumbnail strip for multiple files */}
      {files.length > 1 && (
        <div className="thumbnail-strip" role="list" aria-label="Uploaded files">
          {files.map(f => (
            <div
              key={f.id}
              className={`thumbnail ${file?.id === f.id ? 'active' : ''} ${f.status === 'error' ? 'error' : ''}`}
              onClick={() => onSelect(f.id)}
              role="listitem button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(f.id); }}
              aria-label={f.name}
              aria-current={file?.id === f.id}
            >
              {isImage(f.file) ? (
                <img src={f.previewUrl} alt={f.name} />
              ) : (
                <div className="pdf-thumb" aria-label="PDF">PDF</div>
              )}
              <button
                className="thumb-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}
                aria-label={`Remove ${f.name}`}
                title="Remove file"
              >
                ×
              </button>
              <StatusBadge status={f.status} progress={f.progress} />
            </div>
          ))}
        </div>
      )}

      {/* Main preview */}
      {file && (
        <div className="preview-main">
          <div className="preview-header">
            <span className="preview-filename">{file.name}</span>
            <span className="preview-size">{formatSize(file.size)}</span>
            <div className="preview-controls">
              {zoom !== 1 && (
                <button className="zoom-reset" onClick={resetZoom} title="Reset zoom">
                  {Math.round(zoom * 100)}% ↺
                </button>
              )}
              <button
                className="zoom-btn"
                onClick={() => setZoom(z => Math.min(5, z + 0.25))}
                aria-label="Zoom in"
                title="Zoom in (or Ctrl+scroll)"
              >
                +
              </button>
              <button
                className="zoom-btn"
                onClick={() => setZoom(z => Math.max(0.3, z - 0.25))}
                aria-label="Zoom out"
                title="Zoom out (or Ctrl+scroll)"
              >
                −
              </button>
              {files.length === 1 && (
                <button className="btn-remove" onClick={() => onRemove(file.id)} aria-label="Remove file">
                  Remove
                </button>
              )}
            </div>
          </div>

          <div
            className="preview-image-container"
            onWheel={handleWheel}
            role="img"
            aria-label={`Preview of ${file.name}`}
          >
            {isImage(file.file) ? (
              <img
                src={file.previewUrl}
                alt={file.name}
                className="preview-image"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.1s ease' }}
                draggable={false}
              />
            ) : (
              <div className="pdf-preview-wrap" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center', transition: 'transform 0.1s ease' }}>
                <PdfCanvas file={file.file} page={pdfPage} scale={1.2} />
              </div>
            )}
          </div>

          {/* PDF page navigation */}
          {!isImage(file.file) && pdfPageCount !== null && pdfPageCount > 1 && (
            <div className="pdf-nav" role="navigation" aria-label="PDF pages">
              <button
                className="pdf-nav-btn"
                onClick={() => setPdfPage(p => Math.max(1, p - 1))}
                disabled={pdfPage === 1}
                aria-label="Previous page"
              >
                ‹
              </button>
              <span className="pdf-page-info" aria-current="page">
                Page {pdfPage} of {pdfPageCount}
              </span>
              <button
                className="pdf-nav-btn"
                onClick={() => setPdfPage(p => Math.min(pdfPageCount, p + 1))}
                disabled={pdfPage === pdfPageCount}
                aria-label="Next page"
              >
                ›
              </button>
            </div>
          )}

          {file.error && (
            <div className="preview-error" role="alert">{file.error}</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, progress }: { status: UploadedFile['status']; progress: number }) {
  const labels: Record<UploadedFile['status'], string> = {
    pending: '',
    uploading: `${Math.max(0, Math.min(100, Math.round(progress)))}%`,
    uploaded: '✓',
    analyzing: '…',
    complete: '✓',
    error: '×',
  };
  if (!labels[status]) return null;
  return <span className={`status-badge status-${status}`} aria-label={`Status: ${status}`}>{labels[status]}</span>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

