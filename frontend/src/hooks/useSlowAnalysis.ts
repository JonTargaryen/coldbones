/**
 * useSlowAnalysis — submits files in slow mode for local, self-hosted processing.
 *
 * Flow:
 *  1. POST /api/analyze with mode=slow using multipart form data
 *  2. Mark each local job as processing while request is in flight
 *  3. Store complete/failed result once request finishes
 */

import { useState, useCallback } from 'react';
import type { UploadedFile, JobStatus, AnalysisResult } from '../types';
import type { Language } from '../i18n/translations';

export interface SlowJob {
  jobId: string;
  fileName: string;
  fileId: string;
  status: JobStatus['status'];
  result: AnalysisResult | null;
  createdAt: string;
  errorMessage: string | null;
}

interface UseSlowAnalysisReturn {
  jobs: SlowJob[];
  isSubmitting: boolean;
  submitSlowJob: (files: UploadedFile[], lang?: Language) => Promise<void>;
  clearJobs: () => void;
}

export function useSlowAnalysis(): UseSlowAnalysisReturn {
  const [jobs, setJobs] = useState<SlowJob[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitSlowJob = useCallback(
    async (files: UploadedFile[], lang: Language = 'en') => {
      if (files.length === 0) return;
      setIsSubmitting(true);

      for (const file of files) {
        if (file.status === 'error') continue;
        const jobId = `local-${file.id}-${Date.now()}`;

        setJobs(prev => [
          ...prev,
          {
            jobId,
            fileName: file.name,
            fileId: file.id,
            status: 'processing',
            result: null,
            createdAt: new Date().toISOString(),
            errorMessage: null,
          },
        ]);

        try {
          const formData = new FormData();
          formData.append('file', file.file);
          formData.append('mode', 'slow');
          formData.append('lang', lang);
          const res = await fetch('/api/analyze', { method: 'POST', body: formData });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({ detail: 'Submission failed' }));
            setJobs(prev => prev.map(job => (
              job.jobId === jobId
                ? {
                    ...job,
                    status: 'failed',
                    errorMessage: errData.detail ?? `HTTP ${res.status}`,
                  }
                : job
            )));
            continue;
          }

          const data = await res.json();
          const result: AnalysisResult = {
            fileId: file.id,
            summary: data.summary ?? '',
            keyObservations: data.key_observations ?? [],
            contentClassification: data.content_classification ?? '',
            extractedText: data.extracted_text ?? '',
            reasoning: data.reasoning ?? '',
            reasoningTokenCount: data.reasoning_token_count ?? 0,
            finishReason: data.finish_reason ?? '',
            processingTimeMs: data.processing_time_ms ?? 0,
            mode: 'slow',
          };

          setJobs(prev => prev.map(job => (
            job.jobId === jobId
              ? {
                  ...job,
                  status: 'complete',
                  result,
                  errorMessage: null,
                }
              : job
          )));
        } catch (err) {
          setJobs(prev => prev.map(job => (
            job.jobId === jobId
              ? {
                  ...job,
                  status: 'failed',
                  errorMessage: err instanceof Error ? err.message : 'Unknown error',
                }
              : job
          )));
        }
      }

      setIsSubmitting(false);
    },
    [],
  );

  const clearJobs = useCallback(() => {
    setJobs([]);
  }, []);

  return { jobs, isSubmitting, submitSlowJob, clearJobs };
}
