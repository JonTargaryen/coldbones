/**
 * useSlowAnalysis — submits files in slow mode (async/queued).
 *
 * Flow:
 *  1. POST /api/analyze with mode=slow for each file (or batch)
 *  2. If response contains jobId → poll /api/status/{jobId} every 5s (when available)
 *  3. If response contains full result (local dev fallback) → store immediately
 *  4. WebSocket push notifications are handled separately by useWebSocket
 */

import { useState, useCallback, useRef } from 'react';
import type { UploadedFile, JobStatus, AnalysisResult } from '../types';
import type { Language } from '../i18n/translations';

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 120; // 10 minutes max

export interface SlowJob {
  jobId: string;
  fileName: string;
  fileId: string;
  status: JobStatus['status'];
  result: AnalysisResult | null;
  estimatedWait: number | null;
  createdAt: string;
  errorMessage: string | null;
  pollAttempts: number;
}

interface UseSlowAnalysisReturn {
  jobs: SlowJob[];
  isSubmitting: boolean;
  submitSlowJob: (files: UploadedFile[], lang?: Language) => Promise<void>;
  applyJobEvent: (event: {
    jobId: string;
    status: JobStatus['status'];
    result?: AnalysisResult;
    error?: string;
  }) => void;
  clearJobs: () => void;
}

export function useSlowAnalysis(): UseSlowAnalysisReturn {
  const [jobs, setJobs] = useState<SlowJob[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const updateJob = useCallback((jobId: string, updates: Partial<SlowJob>) => {
    setJobs(prev => prev.map(j => j.jobId === jobId ? { ...j, ...updates } : j));
  }, []);

  const clearPollTimer = useCallback((jobId: string) => {
    const timer = pollTimersRef.current.get(jobId);
    if (timer) {
      clearTimeout(timer);
      pollTimersRef.current.delete(jobId);
    }
  }, []);

  const applyJobEvent = useCallback(
    (event: {
      jobId: string;
      status: JobStatus['status'];
      result?: AnalysisResult;
      error?: string;
    }) => {
      const updates: Partial<SlowJob> = {
        status: event.status,
      };

      if (event.status === 'complete') {
        updates.result = event.result ?? null;
        updates.errorMessage = null;
        clearPollTimer(event.jobId);
      }

      if (event.status === 'failed') {
        updates.errorMessage = event.error ?? 'Job failed on the server.';
        clearPollTimer(event.jobId);
      }

      updateJob(event.jobId, updates);
    },
    [clearPollTimer, updateJob],
  );

  const pollJobStatus = useCallback(
    (jobId: string, attempt = 0) => {
      if (attempt >= MAX_POLL_ATTEMPTS) {
        updateJob(jobId, { status: 'failed', errorMessage: 'Polling timeout — job took too long.' });
        return;
      }

      const timer = setTimeout(async () => {
        try {
          const res = await fetch(`/api/status/${jobId}`);
          if (!res.ok) throw new Error(`Status check failed: HTTP ${res.status}`);
          const data: {
            status: JobStatus['status'];
            result?: AnalysisResult;
            error?: string;
          } = await res.json();

          if (data.status === 'complete' && data.result) {
            updateJob(jobId, {
              status: 'complete',
              result: data.result,
              errorMessage: null,
              pollAttempts: attempt + 1,
            });
            clearPollTimer(jobId);
            // Show browser notification if tab is backgrounded
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
              new Notification('Coldbones — Analysis Complete', {
                body: `Your job is ready.`,
                icon: '/favicon.ico',
              });
            }
          } else if (data.status === 'failed') {
            updateJob(jobId, {
              status: 'failed',
              errorMessage: data.error ?? 'Job failed on the server.',
              pollAttempts: attempt + 1,
            });
            clearPollTimer(jobId);
          } else {
            // Still queued or processing — keep polling
            updateJob(jobId, { status: data.status, pollAttempts: attempt + 1 });
            pollJobStatus(jobId, attempt + 1);
          }
        } catch (err) {
          // Network error — retry shortly
          updateJob(jobId, { pollAttempts: attempt + 1 });
          pollJobStatus(jobId, attempt + 1);
        }
      }, POLL_INTERVAL_MS);

      pollTimersRef.current.set(jobId, timer);
    },
    [clearPollTimer, updateJob],
  );

  const submitSlowJob = useCallback(
    async (files: UploadedFile[], lang: Language = 'en') => {
      if (files.length === 0) return;
      setIsSubmitting(true);

      // Request notification permission for background alerts
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }

      for (const file of files) {
        if (file.status === 'error') continue;
        try {
          const res = await (async () => {
            if (file.s3Key) {
              return fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jobId: file.uploadJobId,
                  s3Key: file.s3Key,
                  mode: 'slow',
                  lang,
                  filename: file.name,
                }),
              });
            }

            const formData = new FormData();
            formData.append('file', file.file);
            formData.append('mode', 'slow');
            formData.append('lang', lang);
            return fetch('/api/analyze', { method: 'POST', body: formData });
          })();

          if (!res.ok) {
            const errData = await res.json().catch(() => ({ detail: 'Submission failed' }));
            const fakeJobId = `local-error-${file.id}`;
            setJobs(prev => [
              ...prev,
              {
                jobId: fakeJobId,
                fileName: file.name,
                fileId: file.id,
                status: 'failed',
                result: null,
                estimatedWait: null,
                createdAt: new Date().toISOString(),
                errorMessage: errData.detail ?? `HTTP ${res.status}`,
                pollAttempts: 0,
              },
            ]);
            continue;
          }

          const data = await res.json();

          if (data.job_id || data.jobId) {
            // Real async path — got a jobId, start polling
            const jobId: string = data.job_id ?? data.jobId;
            const newJob: SlowJob = {
              jobId,
              fileName: file.name,
              fileId: file.id,
              status: 'queued',
              result: null,
              estimatedWait: data.estimated_wait ?? null,
              createdAt: new Date().toISOString(),
              errorMessage: null,
              pollAttempts: 0,
            };
            setJobs(prev => [...prev, newJob]);
            pollJobStatus(jobId);
          } else {
            // Local dev fallback — synchronous result returned directly
            const fakeJobId = `local-${file.id}-${Date.now()}`;
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
            setJobs(prev => [
              ...prev,
              {
                jobId: fakeJobId,
                fileName: file.name,
                fileId: file.id,
                status: 'complete',
                result,
                estimatedWait: null,
                createdAt: new Date().toISOString(),
                errorMessage: null,
                pollAttempts: 0,
              },
            ]);
          }
        } catch (err) {
          const fakeJobId = `local-error-${file.id}`;
          setJobs(prev => [
            ...prev,
            {
              jobId: fakeJobId,
              fileName: file.name,
              fileId: file.id,
              status: 'failed',
              result: null,
              estimatedWait: null,
              createdAt: new Date().toISOString(),
              errorMessage: err instanceof Error ? err.message : 'Unknown error',
              pollAttempts: 0,
            },
          ]);
        }
      }

      setIsSubmitting(false);
    },
    [pollJobStatus],
  );

  const clearJobs = useCallback(() => {
    // Cancel all pending polls
    pollTimersRef.current.forEach(timer => clearTimeout(timer));
    pollTimersRef.current.clear();
    setJobs([]);
  }, []);

  return { jobs, isSubmitting, submitSlowJob, applyJobEvent, clearJobs };
}
