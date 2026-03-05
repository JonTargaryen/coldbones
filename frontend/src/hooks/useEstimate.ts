import { useCallback, useRef } from 'react';

const STORAGE_KEY = 'coldbones:processingTimes';
const MAX_SAMPLES = 20;

/** Read stored processing times from localStorage (ms) */
function loadTimes(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Save processing times to localStorage */
function saveTimes(times: number[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(times.slice(-MAX_SAMPLES)));
  } catch { /* noop */ }
}

/**
 * Hook that tracks historical processing times to estimate how long
 * an analysis will take.
 *
 * - `recordTime(ms)`: call when an analysis completes
 * - `estimateMs`: median of stored samples, or null if no history
 */
export function useEstimate() {
  const timesRef = useRef(loadTimes());

  const recordTime = useCallback((ms: number) => {
    if (ms <= 0) return;
    timesRef.current = [...timesRef.current, ms].slice(-MAX_SAMPLES);
    saveTimes(timesRef.current);
  }, []);

  const estimateMs = timesRef.current.length > 0
    ? median(timesRef.current)
    : null;

  return { estimateMs, recordTime };
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
