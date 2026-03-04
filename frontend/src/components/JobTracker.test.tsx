import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JobTracker } from './JobTracker';

vi.mock('./AnalysisPanel', () => ({
  AnalysisPanel: () => <div>MockAnalysisPanel</div>,
}));

describe('JobTracker', () => {
  it('renders empty state', () => {
    render(<JobTracker jobs={[]} />);
    expect(screen.getByText(/Results will appear here when complete/i)).toBeInTheDocument();
  });

  it('renders processing and failed jobs', () => {
    render(
      <JobTracker
        jobs={[
          {
            jobId: 'job-1',
            fileName: 'a.png',
            fileId: 'f1',
            status: 'processing',
            result: null,
            createdAt: new Date().toISOString(),
            errorMessage: null,
          },
          {
            jobId: 'job-2',
            fileName: 'b.png',
            fileId: 'f2',
            status: 'failed',
            result: null,
            createdAt: new Date().toISOString(),
            errorMessage: 'bad',
          },
        ]}
      />
    );

    expect(screen.getByText(/pending/i)).toBeInTheDocument();
    expect(screen.getByText('bad')).toBeInTheDocument();
  });

  it('expands completed result and supports copy action', async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboard } });

    render(
      <JobTracker
        jobs={[
          {
            jobId: 'job-3-long-id-for-copy',
            fileName: 'c.png',
            fileId: 'f3',
            status: 'complete',
            result: {
              fileId: 'f3',
              summary: 'ok',
              keyObservations: [],
              contentClassification: 'photo',
              extractedText: '',
              reasoning: '',
              reasoningTokenCount: 0,
              finishReason: 'stop',
              processingTimeMs: 100,
              mode: 'slow',
            },
            createdAt: new Date().toISOString(),
            errorMessage: null,
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /copy job id/i }));
    expect(clipboard).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /status: complete/i }));
    expect(screen.getByText('MockAnalysisPanel')).toBeInTheDocument();
  });
});
