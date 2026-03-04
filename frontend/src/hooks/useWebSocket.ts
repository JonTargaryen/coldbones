/**
 * useWebSocket — connects to an optional WebSocket endpoint for push notifications.
 *
 * Features:
 *  - Automatic reconnect with exponential backoff (capped at 30s)
 *  - Graceful no-op when WS_URL is not configured (local dev)
 *  - Dispatches job completion events to registered handlers
 */

import { useEffect, useRef, useCallback, useState } from 'react';

export type WsMessage = {
  type: 'job_complete' | 'job_failed' | 'ping';
  jobId?: string;
  result?: unknown;
  error?: string;
};

type MessageHandler = (msg: WsMessage) => void;

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'disabled';

interface UseWebSocketOptions {
  /** Full wss:// URL from environment. If blank, WebSocket is disabled. */
  url?: string;
  onMessage?: MessageHandler;
}

const WS_URL = import.meta.env.VITE_WS_URL as string | undefined;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 20;

export function useWebSocket({ url = WS_URL, onMessage }: UseWebSocketOptions = {}) {
  const [status, setStatus] = useState<WsStatus>(url ? 'connecting' : 'disabled');
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onMessageRef = useRef<MessageHandler | undefined>(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    if (!url || !mountedRef.current) return;
    if (retryCountRef.current >= MAX_RETRIES) {
      setStatus('disconnected');
      return;
    }

    setStatus('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      retryCountRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const msg: WsMessage = JSON.parse(evt.data as string);
        onMessageRef.current?.(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      // onclose will fire next — handled there
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setStatus('disconnected');
      wsRef.current = null;

      // Exponential backoff reconnect
      const delay = Math.min(BASE_DELAY_MS * 2 ** retryCountRef.current, MAX_DELAY_MS);
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    };
  }, [url]);

  // Mount / unmount lifecycle
  useEffect(() => {
    mountedRef.current = true;
    if (url) connect();

    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, [url, connect]);

  /** Manually send a message (fire-and-forget) */
  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { status, send };
}
