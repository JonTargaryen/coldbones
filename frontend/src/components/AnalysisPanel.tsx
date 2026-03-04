import { useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import type { AnalysisResult } from '../types';

interface AnalysisPanelProps {
  result: AnalysisResult | null;
  isAnalyzing: boolean;
  currentFileName?: string;
  error: string | null;
  elapsedMs: number;
}

export function AnalysisPanel({ result, isAnalyzing, currentFileName, error, elapsedMs }: AnalysisPanelProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const { t } = useLanguage();

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
        </p>
        <p className="analysis-thinking-hint">{t.thinkingHint}</p>
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

  return (
    <div className="analysis-panel has-result" role="region" aria-label={t.summary}>
      {/* Reasoning / Thinking section — collapsible */}
      {result.reasoning && (
        <div className="result-section reasoning-section">
          <button
            className="reasoning-toggle"
            onClick={() => setReasoningOpen(!reasoningOpen)}
            aria-expanded={reasoningOpen}
            aria-controls="reasoning-content"
          >
            <span className="reasoning-toggle-icon" aria-hidden="true">{reasoningOpen ? '▼' : '▶'}</span>
            <h3>
              <span aria-hidden="true">🧠</span> {t.reasoning}
              <span className="reasoning-meta">
                {(result.reasoningTokenCount ?? 0).toLocaleString()} {t.tokens}
              </span>
            </h3>
          </button>
          {reasoningOpen && (
            <pre className="reasoning-content" id="reasoning-content" tabIndex={0}>{result.reasoning}</pre>
          )}
        </div>
      )}

      <div className="result-section">
        <h3>{t.summary}</h3>
        <p>{result.summary}</p>
      </div>

      {result.keyObservations.length > 0 && (
        <div className="result-section">
          <h3>{t.keyObservations}</h3>
          <ul>
            {result.keyObservations.map((obs, i) => (
              <li key={i}>{obs}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="result-section">
        <h3>{t.contentClassification}</h3>
        <span className="classification-badge">{result.contentClassification}</span>
      </div>

      {result.extractedText && (
        <div className="result-section">
          <h3>{t.extractedText}</h3>
          <pre className="extracted-text" tabIndex={0}>{result.extractedText}</pre>
        </div>
      )}

      <div className="result-meta">
        <span>{t.mode}: {result.mode === 'fast' ? `⚡ ${t.fast}` : `🐢 ${t.slow}`}</span>
        <span>{t.processedIn(((result.processingTimeMs ?? 0) / 1000).toFixed(1))}</span>
        {result.finishReason === 'length' && (
          <span className="finish-warning" title={t.truncatedTooltip} role="alert">
            ⚠️ {t.truncated}
          </span>
        )}
      </div>
    </div>
  );
}
