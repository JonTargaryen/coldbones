/**
 * Additional AnalysisPanel tests targeting uncovered paths:
 * partialText streaming, Full Model Response toggle, Description,
 * Insights list, OCR copy button, ScrollBox, export button, token usage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { LanguageProvider } from '../contexts/LanguageContext'
import { AnalysisPanel } from '../components/AnalysisPanel'
import type { AnalysisResult } from '../types'

function Wrapper({ children }: { children: React.ReactNode }) {
  return <LanguageProvider>{children}</LanguageProvider>
}

function r(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

const makeResult = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
  summary: 'A summary of the file.',
  description: '',
  insights: [],
  observations: [],
  contentClassification: 'Photo',
  ocrText: '',
  chainOfThought: '',
  mode: 'fast',
  processingTimeMs: 2500,
  finishReason: 'stop',
  ...overrides,
})

describe('AnalysisPanel — streaming preview', () => {
  it('renders partial text during analysis', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={3000}
        partialText="Streaming **output** here"
      />,
    )
    expect(screen.getByText('Live Model Output')).toBeInTheDocument()
    expect(screen.getByText(/output/)).toBeInTheDocument()
    // Char count should be shown
    expect(screen.getByText(/chars/)).toBeInTheDocument()
  })

  it('hides streaming preview when no partialText', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={1000}
      />,
    )
    expect(screen.queryByText('Live Model Output')).toBeNull()
  })

  it('shows ETA when estimateMs > elapsedMs', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={2000}
        estimateMs={5000}
      />,
    )
    expect(screen.getByText(/~5s est\./)).toBeInTheDocument()
  })

  it('hides ETA when estimateMs < elapsedMs', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="test.png"
        error={null}
        elapsedMs={6000}
        estimateMs={5000}
      />,
    )
    expect(screen.queryByText(/~\d+s est\./)).toBeNull()
  })
})

describe('AnalysisPanel — Full Model Response toggle', () => {
  it('shows Full Model Response button when result is present', () => {
    r(
      <AnalysisPanel
        result={makeResult()}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText(/Full Model Response/)).toBeInTheDocument()
  })

  it('toggles Full Model Response content on click', async () => {
    r(
      <AnalysisPanel
        result={makeResult({ summary: 'Toggle test summary' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    const btn = screen.getByRole('button', { name: /Full Model Response/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')

    // Open
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    // Full response content should have the summary
    expect(screen.getByRole('region')).toBeInTheDocument()

    // Close
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('AnalysisPanel — Description section', () => {
  it('renders description when present', () => {
    r(
      <AnalysisPanel
        result={makeResult({ description: 'A detailed description of the image.' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText(/A detailed description/)).toBeInTheDocument()
  })

  it('omits description when empty', () => {
    r(
      <AnalysisPanel
        result={makeResult({ description: '' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.queryByText('Description')).toBeNull()
  })
})

describe('AnalysisPanel — Insights section', () => {
  it('renders insights as list items', () => {
    r(
      <AnalysisPanel
        result={makeResult({ insights: ['First insight', 'Second insight', 'Third insight'] })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText('Insights')).toBeInTheDocument()
    expect(screen.getByText(/First insight/)).toBeInTheDocument()
    expect(screen.getByText(/Second insight/)).toBeInTheDocument()
    expect(screen.getByText(/Third insight/)).toBeInTheDocument()
  })

  it('omits insights section when empty', () => {
    r(
      <AnalysisPanel
        result={makeResult({ insights: [] })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.queryByText('Insights')).toBeNull()
  })
})

describe('AnalysisPanel — OCR copy button', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('copies OCR text via clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    r(
      <AnalysisPanel
        result={makeResult({ ocrText: 'Extracted text content' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText('Extracted Text (OCR)')).toBeInTheDocument()
    expect(screen.getByText('Extracted text content')).toBeInTheDocument()

    const copyBtn = screen.getByRole('button', { name: /copy extracted text/i })
    expect(copyBtn).toHaveTextContent('⧉ Copy')

    await act(async () => {
      await userEvent.click(copyBtn)
    })

    expect(writeText).toHaveBeenCalledWith('Extracted text content')
    expect(copyBtn).toHaveTextContent('✓ Copied')

    // Wait for reset
    act(() => { vi.advanceTimersByTime(2100) })
    expect(copyBtn).toHaveTextContent('⧉ Copy')
  })

  it('falls back to execCommand when clipboard API fails', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    // jsdom doesn't have execCommand — define it
    document.execCommand = vi.fn().mockReturnValue(true)

    r(
      <AnalysisPanel
        result={makeResult({ ocrText: 'Fallback text' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )

    const copyBtn = screen.getByRole('button', { name: /copy extracted text/i })
    await act(async () => {
      await userEvent.click(copyBtn)
    })

    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(copyBtn).toHaveTextContent('✓ Copied')
    delete (document as any).execCommand
  })

  it('omits OCR section for "No text detected."', () => {
    r(
      <AnalysisPanel
        result={makeResult({ ocrText: 'No text detected.' })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.queryByText('Extracted Text (OCR)')).toBeNull()
  })
})

describe('AnalysisPanel — token usage and export', () => {
  it('displays token usage when present', () => {
    r(
      <AnalysisPanel
        result={makeResult({ usage: { inputTokens: 1500, outputTokens: 800 } })}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText(/1,500↓/)).toBeInTheDocument()
    expect(screen.getByText(/800↑ tokens/)).toBeInTheDocument()
  })

  it('export button is rendered and clickable', async () => {
    // Mock URL.createObjectURL to avoid jsdom errors
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn(() => 'blob:mock')
    URL.revokeObjectURL = vi.fn()

    r(
      <AnalysisPanel
        result={makeResult({ summary: 'Export test' })}
        isAnalyzing={false}
        currentFileName="photo.jpg"
        error={null}
        elapsedMs={0}
      />,
    )

    const exportBtn = screen.getByRole('button', { name: /export analysis/i })
    expect(exportBtn).toHaveTextContent('↓ Export')
    await userEvent.click(exportBtn)

    // The click exercises resultToMarkdown + downloadText code paths
    expect(URL.createObjectURL).toHaveBeenCalled()

    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  })
})

describe('AnalysisPanel — ScrollBox auto-scroll', () => {
  it('renders ScrollBox inside streaming preview', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="scroll.png"
        error={null}
        elapsedMs={1000}
        partialText="Scrolling content"
      />,
    )
    // ScrollBox renders a div with className "full-response-content"
    const scrollBox = document.querySelector('.full-response-content')
    expect(scrollBox).toBeTruthy()
  })

  it('ScrollBox disables auto-scroll when user scrolls up', () => {
    r(
      <AnalysisPanel
        result={null}
        isAnalyzing
        currentFileName="scroll.png"
        error={null}
        elapsedMs={1000}
        partialText="Test content"
      />,
    )
    const scrollBox = document.querySelector('.full-response-content')!

    // Trigger a scroll event
    Object.defineProperty(scrollBox, 'scrollTop', { value: 0, writable: true })
    Object.defineProperty(scrollBox, 'scrollHeight', { value: 500, writable: true })
    Object.defineProperty(scrollBox, 'clientHeight', { value: 200, writable: true })
    fireEvent.scroll(scrollBox)
    // Auto-scroll should be disabled because user is far from bottom
  })
})

describe('AnalysisPanel — full result with all sections', () => {
  it('renders result with description, insights, observations, OCR, CoT', () => {
    const result = makeResult({
      summary: 'Complete summary',
      description: 'Full description here',
      insights: ['Insight A'],
      observations: ['Obs 1', 'Obs 2'],
      ocrText: 'OCR result text',
      chainOfThought: 'Thinking process...',
      usage: { inputTokens: 200, outputTokens: 100 },
    })
    r(
      <AnalysisPanel
        result={result}
        isAnalyzing={false}
        error={null}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText('Description')).toBeInTheDocument()
    expect(screen.getByText('Insights')).toBeInTheDocument()
    expect(screen.getByText('Observations')).toBeInTheDocument()
    expect(screen.getByText('Extracted Text (OCR)')).toBeInTheDocument()
    expect(screen.getByText('Chain of Thought')).toBeInTheDocument()
  })
})
