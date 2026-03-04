import { useState, useCallback } from 'react';
import type { UploadedFile, PresignResponse } from '../types';

const API = import.meta.env.VITE_API_BASE_URL ?? '';

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/gif', 'image/bmp', 'image/tiff', 'application/pdf',
]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/** Convert snake_case API result to camelCase AnalysisResult */
export function useUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

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
  const update = (patch: Partial<UploadedFile>) =>
    setFiles((prev) => prev.map((f) => (f.id === entry.id ? { ...f, ...patch } : f)));

  update({ status: 'uploading', progress: 0 });

  try {
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

    // Upload directly to S3
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
      xhr.setRequestHeader('Content-Type', entry.file.type);
      xhr.send(entry.file);
    });

    update({ status: 'uploaded', progress: 100, s3Key });
  } catch (err) {
    update({
      status: 'error',
      error: err instanceof Error ? err.message : 'Upload failed',
    });
  }
}
