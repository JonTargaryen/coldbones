import { useState, useCallback } from 'react';
import type { UploadedFile } from '../types';
import { validateFile, validatePdfPageCount, isPdf } from '../utils/validation';

let fileIdCounter = 0;

export function useUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

  const updateById = useCallback((fileId: string, updates: Partial<UploadedFile>) => {
    setFiles(prev => prev.map(f => (f.id === fileId ? { ...f, ...updates } : f)));
  }, []);

  const requestPresign = useCallback(async (file: File): Promise<{ uploadUrl: string; s3Key: string; jobId?: string } | null> => {
    try {
      const response = await fetch('/api/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
        }),
      });

      // Local backend doesn't expose /api/presign — fallback gracefully
      if (response.status === 404 || response.status === 405) return null;

      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(err.detail || `Failed to get upload URL (${response.status})`);
      }

      const data = await response.json();
      const uploadUrl = data.uploadUrl ?? data.upload_url;
      const s3Key = data.s3Key ?? data.s3_key;
      const jobId = data.jobId ?? data.job_id;

      if (!uploadUrl || !s3Key) {
        throw new Error('Pre-signed upload response missing uploadUrl or s3Key');
      }

      return { uploadUrl, s3Key, jobId };
    } catch (error) {
      // In local dev, keep direct-file flow working
      const host = typeof window !== 'undefined' ? window.location.hostname : '';
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      if (isLocal) return null;
      throw error;
    }
  }, []);

  const uploadToPresignedUrl = useCallback((uploadUrl: string, file: File, onProgress: (percent: number) => void) => {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve();
        } else {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(file);
    });
  }, []);

  const processFileUpload = useCallback(async (uploadedFile: UploadedFile) => {
    if (uploadedFile.status === 'error') return;

    try {
      // Validate PDF page count before uploading to avoid unnecessary transfer
      if (isPdf(uploadedFile.file)) {
        const pageError = await validatePdfPageCount(uploadedFile.file);
        if (pageError) {
          updateById(uploadedFile.id, { status: 'error', error: pageError, progress: 0 });
          return;
        }
      }

      const presign = await requestPresign(uploadedFile.file);
      if (!presign) {
        // Local fallback: mark as uploaded so analyze can send multipart file directly
        updateById(uploadedFile.id, { status: 'uploaded', progress: 100, error: undefined });
        return;
      }

      updateById(uploadedFile.id, {
        status: 'uploading',
        progress: 0,
        error: undefined,
        s3Key: presign.s3Key,
        uploadJobId: presign.jobId,
      });

      await uploadToPresignedUrl(presign.uploadUrl, uploadedFile.file, (percent) => {
        updateById(uploadedFile.id, { status: 'uploading', progress: percent });
      });

      updateById(uploadedFile.id, {
        status: 'uploaded',
        progress: 100,
        s3Key: presign.s3Key,
        uploadJobId: presign.jobId,
        error: undefined,
      });
    } catch (error) {
      updateById(uploadedFile.id, {
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : 'Upload failed',
      });
    }
  }, [requestPresign, updateById, uploadToPresignedUrl]);

  const addFiles = useCallback((newFiles: File[]) => {
    const uploadedFiles: UploadedFile[] = [];

    for (const file of newFiles) {
      const error = validateFile(file);
      const id = `file-${++fileIdCounter}`;

      uploadedFiles.push({
        id,
        file,
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: URL.createObjectURL(file),
        status: error ? 'error' : 'pending',
        progress: 0,
        error: error ?? undefined,
      });
    }

    setFiles(prev => [...prev, ...uploadedFiles]);

    for (const uploadedFile of uploadedFiles) {
      void processFileUpload(uploadedFile);
    }

    return uploadedFiles;
  }, [processFileUpload]);

  const removeFile = useCallback((fileId: string) => {
    setFiles(prev => {
      const file = prev.find(f => f.id === fileId);
      if (file) URL.revokeObjectURL(file.previewUrl);
      return prev.filter(f => f.id !== fileId);
    });
  }, []);

  const clearFiles = useCallback(() => {
    setFiles(prev => {
      prev.forEach(f => URL.revokeObjectURL(f.previewUrl));
      return [];
    });
  }, []);

  const updateFile = useCallback((fileId: string, updates: Partial<UploadedFile>) => {
    setFiles(prev => prev.map(f => f.id === fileId ? { ...f, ...updates } : f));
  }, []);

  return { files, addFiles, removeFile, clearFiles, updateFile, setFiles };
}
