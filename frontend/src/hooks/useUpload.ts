import { useState, useCallback } from 'react';
import type { UploadedFile, PresignResponse } from '../types';

// When VITE_API_BASE_URL is empty the browser uses the same origin it loaded
// the page from (i.e. the CloudFront distribution).  CloudFront then routes
// /api/* to API Gateway via the dedicated behavior added in StorageStack.
// This is the correct production config.  In local dev, set this to
// http://localhost:8000 in frontend/.env so the browser hits the FastAPI server.
const API = import.meta.env.VITE_API_BASE_URL ?? '';

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'application/pdf',
]);
// 20 MB — matches the Lambda orchestrator's practical limit for base64 encoding
// (a 20 MB file becomes ~27 MB in base64, which is within LM Studio's context).
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Convert snake_case API result to camelCase AnalysisResult */
export function useUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

  // addFiles: validate then kick off the S3 upload pipeline for each file.
  // Files are added to state immediately (as 'pending') so the UI shows them
  // right away.  The actual upload happens asynchronously in _uploadToS3.
  const addFiles = useCallback(async (newFiles: File[]) => {
    const validated = newFiles.filter((f) => {
      if (!ALLOWED_TYPES.has(f.type)) return false;
      if (f.size > MAX_FILE_SIZE) return false;
      return true;
    });

    const entries: UploadedFile[] = validated.map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      name: f.name,
      size: f.size,
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      status: 'pending',
      progress: 0,
    }));

    setFiles((prev) => [...prev, ...entries]);

    for (const entry of entries) {
      await _uploadToS3(entry, setFiles);
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const f = prev.find((x) => x.id === id);
      if (f?.previewUrl) URL.revokeObjectURL(f.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
      return [];
    });
  }, []);

  return { files, setFiles, addFiles, removeFile, clearAll };
}

async function _uploadToS3(
  entry: UploadedFile,
  setFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>,
): Promise<void> {
  // Helper: merge a partial patch into this file's state entry without
  // touching other files in the list.
  const update = (patch: Partial<UploadedFile>) =>
    setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, ...patch } : f)));

  update({ status: 'uploading', progress: 0 });

  try {
    // Step 1: Ask our API for a presigned PUT URL.  The Lambda generates
    // a short-lived S3 URL scoped to the exact key and content-type.
    const presignRes = await fetch(`${API}/api/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: entry.file.name,
        contentType: entry.file.type,
      }),
    });

    if (!presignRes.ok) {
      const err = await presignRes.json().catch(() => ({}));
      throw new Error((err as Record<string, string>).detail ?? `Presign failed: ${presignRes.status}`);
    }

    const { uploadUrl, s3Key }: PresignResponse = await presignRes.json();

    // Step 2: PUT the file bytes directly to S3 using the presigned URL.
    // We use XMLHttpRequest instead of fetch() because XHR exposes
    // upload.onprogress, which lets us show a live progress bar.
    // fetch() does not expose upload progress in any standard way.
    const xhr = new XMLHttpRequest();
    await new Promise<void>((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          update({ progress: Math.round((e.loaded / e.total) * 100) });
        }
      });
      xhr.addEventListener('load', () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`S3 upload failed: ${xhr.status}`)),
      );
      xhr.addEventListener('error', () => reject(new Error('S3 upload network error')));
      xhr.open('PUT', uploadUrl);
      // S3 presigned PUT URLs require the Content-Type header to match the
      // one used when signing, otherwise S3 returns 403 SignatureDoesNotMatch.
      xhr.setRequestHeader('Content-Type', entry.file.type);
      xhr.send(entry.file);
    });

    // Step 3: Record the s3Key on the file entry so the analyse button can
    // pass it to POST /api/analyze.
    update({ status: 'uploaded', progress: 100, s3Key });
  } catch (err) {
    update({
      status: 'error',
      error: err instanceof Error ? err.message : 'Upload failed',
    });
  }
}
