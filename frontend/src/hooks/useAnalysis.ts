import { useState, useCallback } from 'react';
import type { AnalysisResult, UploadedFile, ProcessingMode } from '../types';
import type { Language } from '../i18n/translations';

interface UseAnalysisReturn {
  results: Map<string, AnalysisResult>;
  isAnalyzing: boolean;
  currentFileId: string | null;
  error: string | null;
  analyzeFile: (file: UploadedFile, mode: ProcessingMode, lang?: Language) => Promise<AnalysisResult | null>;
  analyzeAll: (files: UploadedFile[], mode: ProcessingMode, onProgress: (fileId: string, status: UploadedFile['status']) => void, lang?: Language) => Promise<void>;
  clearResults: () => void;
}

export function useAnalysis(): UseAnalysisReturn {
  const [results, setResults] = useState<Map<string, AnalysisResult>>(new Map());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentFileId, setCurrentFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const analyzeFile = useCallback(async (file: UploadedFile, mode: ProcessingMode, lang: Language = 'en'): Promise<AnalysisResult | null> => {
    setCurrentFileId(file.id);
    setError(null);

    try {
      const response = await (async () => {
        if (file.s3Key) {
          return fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: file.uploadJobId,
              s3Key: file.s3Key,
              mode,
              lang,
              filename: file.name,
            }),
          });
        }

        const formData = new FormData();
        formData.append('file', file.file);
        formData.append('mode', mode);
        formData.append('lang', lang);

        return fetch('/api/analyze', {
          method: 'POST',
          body: formData,
        });
      })();

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ detail: 'Analysis failed' }));
        throw new Error(errData.detail || `HTTP ${response.status}`);
      }

      const data = await response.json();

      const result: AnalysisResult = {
        fileId: file.id,
        summary: data.summary || '',
        keyObservations: data.key_observations || [],
        contentClassification: data.content_classification || '',
        extractedText: data.extracted_text || '',
        reasoning: data.reasoning || '',
        reasoningTokenCount: data.reasoning_token_count || 0,
        finishReason: data.finish_reason || '',
        processingTimeMs: data.processing_time_ms || 0,
        mode,
      };

      setResults(prev => new Map(prev).set(file.id, result));
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);
      return null;
    }
  }, []);

  const analyzeAll = useCallback(async (
    files: UploadedFile[],
    mode: ProcessingMode,
    onProgress: (fileId: string, status: UploadedFile['status']) => void,
    lang: Language = 'en'
  ) => {
    setIsAnalyzing(true);
    setError(null);

    const validFiles = files.filter(f => f.status !== 'error');

    for (const file of validFiles) {
      onProgress(file.id, 'analyzing');
      const result = await analyzeFile(file, mode, lang);
      onProgress(file.id, result ? 'complete' : 'error');
    }

    setIsAnalyzing(false);
    setCurrentFileId(null);
  }, [analyzeFile]);

  const clearResults = useCallback(() => {
    setResults(new Map());
    setError(null);
  }, []);

  return { results, isAnalyzing, currentFileId, error, analyzeFile, analyzeAll, clearResults };
}
