import { useState, useCallback, useRef } from 'react';
import type {
  SlowJob,
  SlowJobStatus,
  UploadedFile,
  AnalysisResult,
  ApiAnalysisResult,
  JobStatusResponse,
  InferenceProvider,
} from '../types';

// Re-export SlowJob so components that do:
//   import type { SlowJob } from '../hooks/useSlowAnalysis'
// continue to work without needing to know its canonical location (types/index.ts).
export type { SlowJob } from '../types';

import { API_BASE_URL as API, SLOW_POLL_INTERVAL_MS as POLL_INTERVAL_MS, SLOW_POLL_TIMEOUT_MS as POLL_TIMEOUT_MS } from '../config';

const NO_TEXT_SENTINEL = 'No text detected.';

function mapResult(raw: ApiAnalysisResult): AnalysisResult {
  const extractedText = raw.extracted_text ?? raw.ocr_text ?? '';
  const ocrText = raw.ocr_text ?? raw.extracted_text ?? '';
  return {
    chainOfThought: raw.chain_of_thought ?? '',
    summary: raw.summary ?? '',
    description: raw.description ?? '',
    insights: raw.insights ?? [],
    observations: raw.observations ?? raw.key_observations ?? [],
    ocrText: ocrText === NO_TEXT_SENTINEL ? '' : ocrText,
    contentClassification: raw.content_classification ?? '',
    keyObservations: raw.key_observations ?? raw.observations ?? [],
    extractedText: extractedText === NO_TEXT_SENTINEL ? '' : extractedText,
    reasoning: raw.reasoning ?? '',
    reasoningTokenCount: raw.reasoning_token_count ?? 0,
    finishReason: raw.finish_reason ?? 'stop',
    processingTimeMs: raw.processing_time_ms ?? 0,
    mode: (raw.mode as 'fast' | 'slow') ?? 'slow',
    model: raw.model,
    provider: raw.provider,
    usage: raw.usage ? {
      inputTokens: raw.usage.input_tokens ?? 0,
      outputTokens: raw.usage.output_tokens ?? 0,
    } : undefined,
  };
}

/** Hook that enqueues files for slow-mode (Spot GPU) analysis and polls for completion. */
export function useSlowAnalysis(
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
) {
  const [slowJobs, setSlowJobs] = useState<SlowJob[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  const enqueue = useCallback(async (
    fileId: string,
    s3Key: string,
    filename: string,
    lang: string,
    provider: InferenceProvider = 'auto',
  ) => {
    const update = (patch: Partial<UploadedFile>) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, ...patch } : f)));

    update({ status: 'analyzing' });

    try {
      const res = await fetch(`${API}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key, filename, lang, mode: 'slow', provider }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, string>;
        throw new Error(err.detail ?? `Queue failed: ${res.status}`);
      }

      const data = await res.json();
      const body = data.body ? JSON.parse(data.body) : data;
      const jobId: string = body.jobId;

      const newJob: SlowJob = {
        jobId,
        fileId,
        fileName: filename,
        status: 'queued',
        estimatedWait: null,
      };
      setSlowJobs((prev) => [...prev, newJob]);
      _startPolling(jobId, fileId, filename, update, setSlowJobs, timers);
    } catch (err) {
      update({
        status: 'error',
        error: err instanceof Error ? err.message : 'Queue failed',
      });
    }
  }, [setFiles]);

  return { slowJobs, enqueue };
}

function _startPolling(
  jobId: string,
  _fileId: string,
  _fileName: string,
  update: (patch: Partial<UploadedFile>) => void,
  setSlowJobs: React.Dispatch<React.SetStateAction<SlowJob[]>>,
  timers: React.MutableRefObject<Map<string, ReturnType<typeof setInterval>>>,
): void {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  const stop = (status: SlowJobStatus, extra?: Partial<SlowJob>) => {
    const t = timers.current.get(jobId);
    if (t !== undefined) clearInterval(t);
    timers.current.delete(jobId);
    setSlowJobs((prev) =>
      prev.map((j) => (j.jobId === jobId ? { ...j, status, ...extra } : j)),
    );
  };

  const timer = setInterval(async () => {
    if (Date.now() > deadline) {
      stop('failed', { errorMessage: 'Job timed out after 15 minutes' });
      update({ status: 'error', error: 'Job timed out after 15 minutes' });
      return;
    }

    try {
      const res = await fetch(`${API}/api/status/${jobId}`);
      if (!res.ok) return;

      const jobStatus: JobStatusResponse = await res.json();

      if (jobStatus.status === 'PROCESSING') {
        setSlowJobs((prev) =>
          prev.map((j) => (j.jobId === jobId ? { ...j, status: 'processing' } : j)),
        );
      } else if (jobStatus.status === 'COMPLETED' && jobStatus.result) {
        const result = mapResult(jobStatus.result);
        stop('complete', { result });
        update({ status: 'complete', result });
      } else if (jobStatus.status === 'FAILED') {
        const msg = jobStatus.error ?? 'Job failed';
        stop('failed', { errorMessage: msg });
        update({ status: 'error', error: msg });
      }
    } catch {
      // network error — keep polling
    }
  }, POLL_INTERVAL_MS);

  timers.current.set(jobId, timer);
}
