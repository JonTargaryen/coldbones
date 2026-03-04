import { useCallback } from 'react';
import type { UploadedFile, AnalysisResult, ApiAnalysisResult } from '../types';

// Same-origin routing via CloudFront in prod; override to localhost:8000 for
// local dev via frontend/.env (VITE_API_BASE_URL=http://localhost:8000).
const API = import.meta.env.VITE_API_BASE_URL ?? '';

// How long to wait between status polls.  3 s is a good balance:
// short enough that the user sees results within a few seconds of completion,
// long enough to avoid hammering API Gateway (which charges per request).
const POLL_INTERVAL_MS = 3000;
// Give up after 10 minutes.  A 35B model on a single GPU should finish a
// single image in under 2 minutes; 10 min is a very conservative ceiling.
const POLL_TIMEOUT_MS  = 10 * 60 * 1000;

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
      // POST to /api/analyze — this always returns 202 immediately.
      // analyze_router either:
      //   a) Fires analyze_orchestrator async and returns 202 + jobId (fast mode)
      //   b) Enqueues to SQS and returns 202 + jobId (desktop offline / slow mode)
      // In both cases, the browser polls GET /api/status/{jobId} to get the result.
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
      // API Gateway wraps the Lambda response body as a JSON string inside
      // a `body` field when the Lambda returns the standard proxy response
      // format.  Unwrap it so the rest of the code works regardless of
      // whether the response came through API GW or directly from the Lambda.
      const raw: ApiAnalysisResult & { jobId?: string; status?: string } =
        data.body ? JSON.parse(data.body) : data;

      // 202: orchestrator is running; switch to polling.
      if (res.status === 202 || raw.status === 'processing' || raw.status === 'queued') {
        if (!raw.jobId) throw new Error('Server returned 202 but no jobId');
        await _pollForResult(raw.jobId, update);
        return;
      }

      // Synchronous 200 result (returned only by the local FastAPI dev server;
      // the cloud path is always 202 due to API Gateway's 29 s timeout).
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

/** Poll /api/status/{jobId} until COMPLETED or FAILED (or timeout).
 *
 * Uses setInterval rather than a recursive setTimeout chain so the poll
 * interval is consistent regardless of how long each HTTP request takes.
 * The interval timer is cleared on terminal states to prevent memory leaks.
 *
 * The promise resolves (not rejects) even on FAILED or timeout, because the
 * caller already has the update() function to mark the file as 'error'.  We
 * don't want to throw here and double-handle the error in the calling try/catch.
 */
async function _pollForResult(
  jobId: string,
  update: (patch: Partial<UploadedFile>) => void,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        clearInterval(timer);
        update({ status: 'error', error: 'Analysis timed out after 10 minutes' });
        resolve();
        return;
      }
      try {
        const res = await fetch(`${API}/api/status/${jobId}`);
        const data = await res.json();
        const body = data.body ? JSON.parse(data.body) : data;
        const jobStatus: string = (body.status ?? '').toUpperCase();

        if (jobStatus === 'COMPLETED') {
          clearInterval(timer);
          const raw: ApiAnalysisResult = body.result ?? body;
          update({ status: 'complete', result: mapResult(raw) });
          resolve();
        } else if (jobStatus === 'FAILED') {
          clearInterval(timer);
          update({ status: 'error', error: body.error ?? 'Analysis failed on server' });
          resolve();
        }
        // PROCESSING / QUEUED → keep polling
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  });
}
