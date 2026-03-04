import { useCallback } from 'react';
import type { UploadedFile, AnalysisResult, ApiAnalysisResult } from '../types';

const API = import.meta.env.VITE_API_BASE_URL ?? '';

/** Normalize the sentinel string the Lambda puts in extracted_text when no text is found. */
const NO_TEXT_SENTINEL = 'No text detected.';

/** Convert snake_case API response to camelCase AnalysisResult */
function mapResult(raw: ApiAnalysisResult): AnalysisResult {
  const extractedText = raw.extracted_text ?? '';
  return {
    summary: raw.summary ?? '',
    keyObservations: raw.key_observations ?? [],
    contentClassification: raw.content_classification ?? '',
    extractedText: extractedText === NO_TEXT_SENTINEL ? '' : extractedText,
    reasoning: raw.reasoning ?? '',
    reasoningTokenCount: raw.reasoning_token_count ?? 0,
    finishReason: raw.finish_reason ?? 'stop',
    processingTimeMs: raw.processing_time_ms ?? 0,
    mode: (raw.mode as 'fast' | 'slow') ?? 'fast',
    model: raw.model,
    provider: raw.provider,
  };
}

export function useAnalysis(
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
) {
  const analyze = useCallback(async (
    fileId: string,
    s3Key: string,
    filename: string,
    lang: string,
  ) => {
    const update = (patch: Partial<UploadedFile>) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f)));

    update({ status: 'analyzing' });

    try {
      const res = await fetch(`${API}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key, filename, lang, mode: 'fast' }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, string>;
        throw new Error(err.detail ?? `Analysis failed: ${res.status}`);
      }

      const data = await res.json();
      // API Gateway wraps Lambda response — unwrap body if needed
      const raw: ApiAnalysisResult = data.body ? JSON.parse(data.body) : data;
      update({ status: 'complete', result: mapResult(raw) });
    } catch (err) {
      update({
        status: 'error',
        error: err instanceof Error ? err.message : 'Analysis failed',
      });
    }
  }, [setFiles]);

  return { analyze };
}
