import { useState, useCallback, useRef } from 'react';

export type ToastLevel = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: string;
  message: string;
  level: ToastLevel;
}

const DEFAULT_DURATION_MS = 4000;

/**
 * Simple toast notification system.
 *
 * Returns { toasts, addToast } — render the `toasts` array in a
 * fixed-position container, call `addToast` from anywhere in the app.
 */
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const addToast = useCallback((message: string, level: ToastLevel = 'info', durationMs = DEFAULT_DURATION_MS) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, level }]);
    const timer = setTimeout(() => dismiss(id), durationMs);
    timers.current.set(id, timer);
    return id;
  }, [dismiss]);

  return { toasts, addToast, dismiss };
}
