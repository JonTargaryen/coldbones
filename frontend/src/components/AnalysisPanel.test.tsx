import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../contexts/LanguageContext';
import { AnalysisPanel } from './AnalysisPanel';
import type { AnalysisResult } from '../types';

const baseResult: AnalysisResult = {
  fileId: 'f1',
  summary: 'Test summary',
  keyObservations: ['One', 'Two'],
  contentClassification: 'photograph',
  extractedText: 'Detected text',
  reasoning: 'Some internal reasoning',
  reasoningTokenCount: 12,
  finishReason: 'stop',
  processingTimeMs: 1100,
  mode: 'fast',
};

function renderPanel(props: Partial<React.ComponentProps<typeof AnalysisPanel>> = {}) {
  return render(
    <LanguageProvider>
      <AnalysisPanel
        result={null}
        isAnalyzing={false}
        currentFileName={undefined}
        error={null}
        elapsedMs={0}
        {...props}
      />
    </LanguageProvider>
  );
}

describe('AnalysisPanel', () => {
  it('renders error state', () => {
    renderPanel({ error: 'boom' });
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('renders analyzing state', () => {
    renderPanel({ isAnalyzing: true, currentFileName: 'x.png', elapsedMs: 1500 });
    expect(screen.getByText(/Analyzing "x.png"/i)).toBeInTheDocument();
    expect(screen.getByText('1.5s')).toBeInTheDocument();
  });

  it('renders empty state without result', () => {
    renderPanel();
    expect(screen.getByText(/Upload a file and click Analyze/i)).toBeInTheDocument();
  });

  it('renders result with reasoning toggle and metadata', () => {
    renderPanel({ result: { ...baseResult, finishReason: 'length' } });

    expect(screen.getByText('Test summary')).toBeInTheDocument();
    expect(screen.getByText('One')).toBeInTheDocument();
    expect(screen.getByText('Detected text')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Model Reasoning/i }));
    expect(screen.getByText('Some internal reasoning')).toBeInTheDocument();

    expect(screen.getByText(/Processed in 1.1s/)).toBeInTheDocument();
    expect(screen.getByText(/Truncated/)).toBeInTheDocument();
  });

  it('hides extracted text when no text detected marker is present', () => {
    renderPanel({ result: { ...baseResult, extractedText: 'No text detected.' } });
    expect(screen.queryByText('Detected text')).not.toBeInTheDocument();
  });
});
