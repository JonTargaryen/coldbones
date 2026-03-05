/**
 * Centralized application configuration.
 *
 * All environment variables are read here so the rest of the codebase
 * imports typed constants instead of reaching into `import.meta.env`.
 *
 * In production VITE_API_BASE_URL is empty — the browser uses same-origin
 * routing through CloudFront (/api/* → API Gateway).
 * In local dev set it to http://localhost:8000 in frontend/.env.
 */

// ── API ─────────────────────────────────────────────────────────────────────
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';

// ── Upload limits ───────────────────────────────────────────────────────────
export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'application/pdf',
]);

// ── Polling ─────────────────────────────────────────────────────────────────
export const FAST_POLL_INTERVAL_MS = 3_000;
export const FAST_POLL_TIMEOUT_MS  = 10 * 60 * 1_000; // 10 min

export const SLOW_POLL_INTERVAL_MS = 4_000;
export const SLOW_POLL_TIMEOUT_MS  = 15 * 60 * 1_000; // 15 min

// ── Feature flags ───────────────────────────────────────────────────────────
export const HISTORY_MAX_ITEMS = 50;
