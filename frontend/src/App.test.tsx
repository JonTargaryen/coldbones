import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

vi.mock('./components/UploadZone', () => ({
  UploadZone: ({ onFilesAdded, disabled }: { onFilesAdded: (files: File[]) => void; disabled?: boolean }) => (
    <div>
      <button
        onClick={() => onFilesAdded([new File(['x'], 'x.png', { type: 'image/png' })])}
        disabled={disabled}
      >
        AddOne
      </button>
      <button
        onClick={() => onFilesAdded(Array.from({ length: 11 }, (_, i) => new File(['x'], `f-${i}.png`, { type: 'image/png' })))}
        disabled={disabled}
      >
        AddMany
      </button>
    </div>
  ),
}));

vi.mock('./components/FilePreview', () => ({
  FilePreview: ({ files, file, onRemove }: { files: Array<{ id: string; name: string }>; file: { id: string; name: string } | null; onRemove: (id: string) => void }) => (
    <div>
      {files.length === 0 ? 'No files uploaded yet' : `Files:${files.length}`}
      {file ? <button onClick={() => onRemove(file.id)}>RemoveSelected</button> : null}
    </div>
  ),
}));

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return {
          ok: true,
          json: async () => ({ model_loaded: true, model_name: 'fake', lm_studio_url: 'http://localhost:1234/v1' }),
        } as Response;
      }

      if (url.includes('/api/analyze')) {
        return {
          ok: true,
          json: async () => ({
            summary: 'Analysis done',
            key_observations: ['obs'],
            content_classification: 'photograph',
            extracted_text: '',
            reasoning: '',
            reasoning_token_count: 0,
            finish_reason: 'stop',
            processing_time_ms: 42,
          }),
        } as Response;
      }

      return { ok: false, json: async () => ({ detail: 'unknown endpoint' }) } as Response;
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob://x'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders health and fast mode analyze flow', async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText(/Model Ready/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('AddOne'));

    const analyzeBtn = await screen.findByRole('button', { name: /Analyze 1 file/i });
    fireEvent.click(analyzeBtn);

    await waitFor(() => {
      expect(screen.getByText('Analysis done')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Clear All/i }));
    expect(screen.getByText(/No files uploaded yet/i)).toBeInTheDocument();
  });

  it('shows validation error for oversized fast batch', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Model Ready/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('AddMany'));
    fireEvent.click(await screen.findByRole('button', { name: /Analyze 11 files/i }));

    await waitFor(() => {
      expect(screen.getByText(/Maximum 10 files per batch in fast mode/i)).toBeInTheDocument();
    });
  });

  it('runs slow mode and renders job tracker', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Model Ready/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Slow/i }));
    fireEvent.click(screen.getByText('AddOne'));

    fireEvent.click(await screen.findByRole('button', { name: /Analyze 1 file/i }));

    await waitFor(() => {
      expect(screen.getByText(/Job Queue/i)).toBeInTheDocument();
      expect(screen.getByText(/done/i)).toBeInTheDocument();
    });
  });

  it('shows model-missing and offline states from health endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return {
          ok: true,
          json: async () => ({ model_loaded: false, model_name: '', lm_studio_url: '' }),
        } as Response;
      }
      return { ok: false, json: async () => ({ detail: 'err' }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText(/No Model Loaded/i)).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  });

  it('handles remove callback for selected file', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Model Ready/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText('AddOne'));
    expect(await screen.findByText('Files:1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('RemoveSelected'));
    await waitFor(() => expect(screen.getByText('No files uploaded yet')).toBeInTheDocument());
  });
});
