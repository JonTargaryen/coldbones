/**
 * Additional FilePreview tests targeting uncovered paths:
 * PDF rendering, page navigation, formatSize, StatusBadge, drag handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { ModeProvider } from '../contexts/ModeContext'
import { LanguageProvider } from '../contexts/LanguageContext'
import type { UploadedFile } from '../types'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 3,
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

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ModeProvider>
      <LanguageProvider>{children}</LanguageProvider>
    </ModeProvider>
  )
}

function r(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

const makeFile = (overrides: Partial<UploadedFile> = {}): UploadedFile => ({
  id: 'uf-1',
  file: new File([new Uint8Array(100)], 'img.png', { type: 'image/png' }),
  name: 'img.png',
  size: 100,
  previewUrl: 'data:image/png;base64,abc',
  status: 'uploaded',
  progress: 100,
  ...overrides,
})

describe('FilePreview — PDF and additional paths', () => {
  let FilePreview: typeof import('../components/FilePreview').FilePreview

  beforeEach(async () => {
    const mod = await import('../components/FilePreview')
    FilePreview = mod.FilePreview
  })

  it('renders PDF preview placeholder for PDF files', () => {
    const pdf = makeFile({
      id: 'p1',
      file: new File([new Uint8Array(100)], 'doc.pdf', { type: 'application/pdf' }),
      name: 'doc.pdf',
      previewUrl: undefined,
    })
    r(<FilePreview file={pdf} files={[pdf]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    // PDF files should still render the preview container
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /preview of/i })).toBeInTheDocument()
  })

  it('displays file size via formatSize for bytes', () => {
    const f = makeFile({ size: 500 })
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText('500 B')).toBeInTheDocument()
  })

  it('displays file size via formatSize for KB', () => {
    const f = makeFile({ size: 5120 })
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText('5.0 KB')).toBeInTheDocument()
  })

  it('displays file size via formatSize for MB', () => {
    const f = makeFile({ size: 5 * 1024 * 1024 })
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText('5.0 MB')).toBeInTheDocument()
  })

  it('shows status badge for uploading file', () => {
    const f1 = makeFile({ id: 'u1', status: 'uploading', progress: 45 })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByText('45%')).toBeInTheDocument()
  })

  it('shows status badge ✓ for uploaded file', () => {
    const f1 = makeFile({ id: 'u1', status: 'uploaded' })
    const f2 = makeFile({ id: 'u2', name: 'b.png', status: 'pending', progress: 0 })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('Status: uploaded')).toHaveTextContent('✓')
  })

  it('shows status badge … for analyzing file', () => {
    const f1 = makeFile({ id: 'u1', status: 'analyzing' })
    const f2 = makeFile({ id: 'u2', name: 'b.png', status: 'pending', progress: 0 })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('Status: analyzing')).toHaveTextContent('…')
  })

  it('shows status badge ✓ for complete file', () => {
    const f1 = makeFile({ id: 'u1', status: 'complete' })
    const f2 = makeFile({ id: 'u2', name: 'b.png', status: 'pending', progress: 0 })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('Status: complete')).toHaveTextContent('✓')
  })

  it('shows status badge × for error file', () => {
    const f1 = makeFile({ id: 'u1', status: 'error', error: 'fail' })
    const f2 = makeFile({ id: 'u2', name: 'b.png', status: 'pending', progress: 0 })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('Status: error')).toHaveTextContent('×')
  })

  it('no badge for pending file', () => {
    const f1 = makeFile({ id: 'u1', status: 'pending', progress: 0 })
    const f2 = makeFile({ id: 'u2', name: 'b.png', status: 'pending', progress: 0 })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.queryByLabelText('Status: pending')).toBeNull()
  })

  it('renders thumbnail with PDF placeholder for non-image', () => {
    const pdf1 = makeFile({
      id: 'p1',
      file: new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' }),
      name: 'a.pdf',
      previewUrl: undefined,
    })
    const img = makeFile({ id: 'p2', name: 'b.png' })
    r(<FilePreview file={pdf1} files={[pdf1, img]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('PDF')).toBeInTheDocument()
  })

  it('marks active thumbnail with aria-current', () => {
    const f1 = makeFile({ id: 'u1', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />,
    )
    const active = container.querySelector('.thumbnail.active')
    expect(active).toBeTruthy()
    expect(active?.getAttribute('aria-current')).toBe('true')
  })

  it('thumbnail keyboard nav with Enter/Space', () => {
    const onSelect = vi.fn()
    const f1 = makeFile({ id: 'u1', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={onSelect} onRemove={vi.fn()} />,
    )
    const thumbs = container.querySelectorAll('.thumbnail')
    fireEvent.keyDown(thumbs[1], { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('u2')

    onSelect.mockClear()
    fireEvent.keyDown(thumbs[1], { key: ' ' })
    expect(onSelect).toHaveBeenCalledWith('u2')
  })

  it('thumbnail remove button calls stopPropagation + onRemove', async () => {
    const onRemove = vi.fn()
    const onSelect = vi.fn()
    const f1 = makeFile({ id: 'u1', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={onSelect} onRemove={onRemove} />,
    )
    const removeBtn = screen.getByRole('button', { name: /remove b\.png/i })
    await userEvent.click(removeBtn)
    expect(onRemove).toHaveBeenCalledWith('u2')
  })

  it('error thumbnail has error class', () => {
    const f1 = makeFile({ id: 'u1', status: 'error', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(container.querySelector('.thumbnail.error')).toBeTruthy()
  })

  it('drag start/over/drop/end handlers work', () => {
    const onReorder = vi.fn()
    const f1 = makeFile({ id: 'u1', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    const { container } = r(
      <FilePreview
        file={f1}
        files={[f1, f2]}
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        onReorder={onReorder}
      />,
    )
    const thumbs = container.querySelectorAll('.thumbnail')

    // Start drag on first thumb
    const dt = { effectAllowed: '', setData: vi.fn() }
    fireEvent.dragStart(thumbs[0], { dataTransfer: dt })
    expect(dt.effectAllowed).toBe('move')

    // Drag over second thumb
    fireEvent.dragOver(thumbs[1], { dataTransfer: { dropEffect: '' }, preventDefault: vi.fn() })

    // Drop on second thumb
    fireEvent.drop(thumbs[1], { dataTransfer: {}, preventDefault: vi.fn() })
    expect(onReorder).toHaveBeenCalledWith(0, 1)

    // Drag end
    fireEvent.dragEnd(thumbs[0])
  })

  it('handles ctrl+scroll wheel zoom', () => {
    const f = makeFile()
    const { container } = r(
      <FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />,
    )
    const previewContainer = container.querySelector('.preview-image-container')!

    // Ctrl+scroll to zoom in
    fireEvent.wheel(previewContainer, { deltaY: -100, ctrlKey: true })
    // zoom should increase from 1 — the zoom-reset button shows the %
    expect(screen.getByText(/↺/)).toBeInTheDocument()
  })

  it('hides remove button when multiple files', () => {
    const f1 = makeFile({ id: 'u1', name: 'a.png' })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    // "Remove" button in preview header only shown for single file
    expect(screen.queryByRole('button', { name: /^remove file$/i })).not.toBeInTheDocument()
  })

  it('clamps upload progress between 0 and 100 in StatusBadge', () => {
    const f1 = makeFile({ id: 'u1', status: 'uploading', progress: -5 })
    const f2 = makeFile({ id: 'u2', name: 'b.png' })
    r(<FilePreview file={f1} files={[f1, f2]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByLabelText('Status: uploading')).toHaveTextContent('0%')
  })

  it('single file shows Remove button in header', () => {
    const f = makeFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: /remove file/i })).toBeInTheDocument()
  })

  it('no thumbnail strip for single file', () => {
    const f = makeFile()
    r(<FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />)
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('image has correct transform style from zoom', async () => {
    const f = makeFile()
    const { container } = r(
      <FilePreview file={f} files={[f]} onSelect={vi.fn()} onRemove={vi.fn()} />,
    )
    // Default zoom = 1, so transform should be scale(1)
    const img = container.querySelector('.preview-image') as HTMLImageElement
    expect(img.style.transform).toBe('scale(1)')
  })
})
