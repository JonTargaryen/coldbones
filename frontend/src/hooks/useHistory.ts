import { useState, useCallback, useEffect } from 'react';
import type { AnalysisResult } from '../types';
import { HISTORY_MAX_ITEMS } from '../config';

/** A saved analysis with metadata */
export interface HistoryEntry {
  id: string;
  fileName: string;
  timestamp: number;
  result: AnalysisResult;
}

const STORAGE_KEY = 'coldbones:history';

/** Read history from localStorage (never throws) */
function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write history to localStorage (never throws) */
function saveHistory(entries: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full — silently drop oldest entries and retry
    try {
      const trimmed = entries.slice(0, Math.floor(entries.length / 2));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // give up
    }
  }
}

/**
 * Hook that manages analysis history in localStorage.
 *
 * - Capped at HISTORY_MAX_ITEMS entries (oldest are evicted).
 * - All operations are synchronous from the caller's perspective.
 * - Safely handles corrupted or full localStorage.
 */
export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(loadHistory);

  // Persist whenever entries change
  useEffect(() => { saveHistory(entries); }, [entries]);

  /** Add a completed analysis to history */
  const addEntry = useCallback((fileName: string, result: AnalysisResult) => {
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      fileName,
      timestamp: Date.now(),
      result,
    };
    setEntries((prev) => [entry, ...prev].slice(0, HISTORY_MAX_ITEMS));
  }, []);

  /** Remove a single entry by id */
  const removeEntry = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  /** Clear all history */
  const clearHistory = useCallback(() => {
    setEntries([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }, []);

  return { entries, addEntry, removeEntry, clearHistory };
}
