import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useLanguage } from '../contexts/LanguageContext';
import { resultToMarkdown, downloadText } from '../utils/export';
import type { AnalysisResult } from '../types';

interface AnalysisPanelProps {
  result: AnalysisResult | null;
  isAnalyzing: boolean;
  currentFileName?: string;
  error: string | null;
  elapsedMs: number;
  estimateMs?: number | null;
  partialText?: string;
}

/** Copy text to clipboard with visual feedback */
function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, []);
  return { copied, copy };
}

/** Auto-scrolling container that scrolls to bottom when content changes */
function ScrollBox({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [children, autoScroll]);

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    // If user scrolled up more than 50px from bottom, disable auto-scroll
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  return (
    <div ref={ref} className={className} onScroll={handleScroll}>
      {children}
    </div>
  );
}

export function AnalysisPanel({ result, isAnalyzing, currentFileName, error, elapsedMs, estimateMs, partialText }: AnalysisPanelProps) {
  const [cotOpen, setCotOpen] = useState(false);
  const [fullResponseOpen, setFullResponseOpen] = useState(false);
  const { t } = useLanguage();
  const ocrCopy = useCopyToClipboard();

  if (error) {
    return (
      <div className="analysis-panel error-state" role="alert">
        <h3>{t.analysisError}</h3>
        <p className="analysis-error">{error}</p>
      </div>
    );
  }

  if (isAnalyzing) {
    return (
      <div className="analysis-panel loading-state" role="status" aria-live="polite">
        <div className="analysis-spinner" aria-hidden="true" />
        <p className="analysis-loading-text">
          {t.analyzing(currentFileName)}
        </p>
        <p className="analysis-elapsed" aria-label={`${(elapsedMs / 1000).toFixed(1)} seconds elapsed`}>
          {(elapsedMs / 1000).toFixed(1)}s
          {estimateMs && estimateMs > elapsedMs && (
            <span className="analysis-eta"> / ~{(estimateMs / 1000).toFixed(0)}s est.</span>
          )}
        </p>
        <p className="analysis-thinking-hint">{t.thinkingHint}</p>
        <div className="analysis-progress-bar" aria-hidden="true">
          <div className="analysis-progress-fill" />
        </div>
        {partialText && (
          <div className="streaming-preview">
            <div className="streaming-header">
              <span className="streaming-dot" aria-hidden="true" />
              <span className="streaming-label">Live Model Output</span>
              <span className="streaming-chars">{partialText.length.toLocaleString()} chars</span>
            </div>
            <ScrollBox className="full-response-content">
              <div className="markdown-body" tabIndex={0}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{partialText}</ReactMarkdown>
              </div>
            </ScrollBox>
          </div>
        )}
      </div>
    );
  }

  if (!result) {
    return (
      <div className="analysis-panel empty-state">
        <p className="analysis-placeholder">
          {t.emptyAnalysis}
        </p>
      </div>
    );
  }

  const hasCoT = result.chainOfThought && result.chainOfThought.length > 0;
  const hasInsights = result.insights && result.insights.length > 0;
  const hasObservations = result.observations && result.observations.length > 0;
  const hasOcr = result.ocrText && result.ocrText !== 'No text detected.' && result.ocrText.length > 0;
  const hasDescription = result.description && result.description.length > 0;

  // Build the full raw response for the collapsible viewer
  const fullResponseParts: string[] = [];
  if (result.summary) fullResponseParts.push(`## Summary\n\n${result.summary}`);
  if (hasDescription) fullResponseParts.push(`## Description\n\n${result.description}`);
  if (hasInsights) fullResponseParts.push(`## Insights\n\n${result.insights.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}`);
  if (hasObservations) fullResponseParts.push(`## Observations\n\n${result.observations.map((o, idx) => `${idx + 1}. ${o}`).join('\n')}`);
  if (hasOcr) fullResponseParts.push(`## Extracted Text (OCR)\n\n\`\`\`\n${result.ocrText}\n\`\`\``);
  if (hasCoT) fullResponseParts.push(`## Chain of Thought\n\n${result.chainOfThought}`);
  const fullResponse = fullResponseParts.join('\n\n---\n\n');

  return (
    <div className="analysis-panel has-result" role="region" aria-label={t.summary}>

      {/* ── Full Model Response — collapsible, closed by default ── */}
      <div className="result-section full-response-section">
        <button
          className="full-response-toggle"
          onClick={() => setFullResponseOpen(!fullResponseOpen)}
          aria-expanded={fullResponseOpen}
          aria-controls="full-response-content"
        >
          <span className={`full-response-toggle-icon ${fullResponseOpen ? 'open' : ''}`} aria-hidden="true">▶</span>
          <h3>
            Full Model Response
            <span className="full-response-meta">
              {fullResponse.length.toLocaleString()} chars
            </span>
          </h3>
        </button>
        {fullResponseOpen && (
          <ScrollBox className="full-response-content">
            <div className="markdown-body" id="full-response-content" tabIndex={0}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{fullResponse}</ReactMarkdown>
            </div>
          </ScrollBox>
        )}
      </div>

      {/* ── Summary ── */}
      <div className="result-section summary-section">
        <h3>{t.summary}</h3>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{result.summary}</ReactMarkdown>
        </div>
      </div>

      {/* ── Chain of Thought — collapsible ── */}
      {hasCoT && (
        <div className="result-section cot-section">
          <button
            className="cot-toggle"
            onClick={() => setCotOpen(!cotOpen)}
            aria-expanded={cotOpen}
            aria-controls="cot-content"
          >
            <span className={`cot-toggle-icon ${cotOpen ? 'open' : ''}`} aria-hidden="true">▶</span>
            <h3>
              Chain of Thought
              <span className="cot-meta">
                {result.chainOfThought.length.toLocaleString()} chars
              </span>
            </h3>
          </button>
          {cotOpen && (
            <ScrollBox className="cot-content" >
              <div className="markdown-body" id="cot-content" tabIndex={0}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{result.chainOfThought}</ReactMarkdown>
              </div>
            </ScrollBox>
          )}
        </div>
      )}

      {/* ── Description ── */}
      {hasDescription && (
        <div className="result-section description-section">
          <h3>Description</h3>
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{result.description}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* ── Insights ── */}
      {hasInsights && (
        <div className="result-section insights-section">
          <h3>Insights</h3>
          <ul className="insights-list">
            {result.insights.map((insight, i) => (
              <li key={i}>
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{insight}</ReactMarkdown>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Observations ── */}
      {hasObservations && (
        <div className="result-section observations-section">
          <h3>Observations</h3>
          <ul>
            {result.observations.map((obs, i) => (
              <li key={i}>{obs}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Content Classification ── */}
      <div className="result-section">
        <h3>{t.contentClassification}</h3>
        <span className="classification-badge">{result.contentClassification}</span>
      </div>

      {/* ── OCR Text — copy-pastable ── */}
      {hasOcr && (
        <div className="result-section ocr-section">
          <div className="ocr-header">
            <h3>Extracted Text (OCR)</h3>
            <button
              className="btn-copy"
              onClick={() => ocrCopy.copy(result.ocrText)}
              title="Copy to clipboard"
              aria-label="Copy extracted text to clipboard"
            >
              {ocrCopy.copied ? '✓ Copied' : '⧉ Copy'}
            </button>
          </div>
          <ScrollBox className="ocr-text-box">
            <pre className="ocr-text" tabIndex={0}>{result.ocrText}</pre>
          </ScrollBox>
        </div>
      )}

      {/* ── Metadata ── */}
      <div className="result-meta">
        <span>{t.mode}: {result.mode === 'fast' ? t.fast : t.slow}</span>
        <span>{t.processedIn(((result.processingTimeMs ?? 0) / 1000).toFixed(1))}</span>
        {result.usage && (
          <span title="Token usage: input / output">
            {(result.usage.inputTokens ?? 0).toLocaleString()}↓ / {(result.usage.outputTokens ?? 0).toLocaleString()}↑ tokens
          </span>
        )}
        {result.finishReason === 'length' && (
          <span className="finish-warning" title={t.truncatedTooltip} role="alert">
            {t.truncated}
          </span>
        )}
        <button
          className="btn-export"
          onClick={() => {
            const md = resultToMarkdown(currentFileName ?? 'analysis', result);
            const base = (currentFileName ?? 'analysis').replace(/\.[^.]+$/, '');
            downloadText(md, `${base}-analysis.md`);
          }}
          title="Export analysis as Markdown"
          aria-label="Export analysis as Markdown"
        >
          ↓ Export
        </button>
      </div>
    </div>
  );
}
