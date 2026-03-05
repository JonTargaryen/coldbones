import { useCallback } from 'react';
import type { UploadedFile, AnalysisResult, ApiAnalysisResult, InferenceProvider } from '../types';
import { API_BASE_URL as API, FAST_POLL_INTERVAL_MS as POLL_INTERVAL_MS, FAST_POLL_TIMEOUT_MS as POLL_TIMEOUT_MS } from '../config';

/** Normalize the sentinel string the Lambda puts in extracted_text when no text is found. */
const NO_TEXT_SENTINEL = 'No text detected.';

/** Convert snake_case API response to camelCase AnalysisResult */
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
    mode: (raw.mode as 'fast' | 'slow') ?? 'fast',
    model: raw.model,
    provider: raw.provider,
    usage: raw.usage ? {
      inputTokens: raw.usage.input_tokens ?? 0,
      outputTokens: raw.usage.output_tokens ?? 0,
    } : undefined,
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
    provider: InferenceProvider = 'auto',
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
        body: JSON.stringify({ s3Key, filename, lang, mode: 'fast', provider }),
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
          update({ status: 'complete', result: mapResult(raw), partialText: undefined });
          resolve();
        } else if (jobStatus === 'FAILED') {
          clearInterval(timer);
          update({ status: 'error', error: body.error ?? 'Analysis failed on server', partialText: undefined });
          resolve();
        } else if (body.partial_text) {
          // Surface live streaming tokens from the model
          update({ partialText: body.partial_text });
        }
        // PROCESSING / QUEUED → keep polling
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);
  });
}
