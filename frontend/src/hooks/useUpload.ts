import { useState, useCallback } from 'react';
import type { UploadedFile } from '../types';
import { validateFile, validatePdfPageCount, isPdf } from '../utils/validation';

let fileIdCounter = 0;

export function useUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

  const updateById = useCallback((fileId: string, updates: Partial<UploadedFile>) => {
    setFiles(prev => prev.map(f => (f.id === fileId ? { ...f, ...updates } : f)));
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

      updateById(uploadedFile.id, {
        status: 'uploaded',
        progress: 100,
        error: undefined,
      });
    } catch (error) {
      updateById(uploadedFile.id, {
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : 'Upload failed',
      });
    }
  }, [updateById]);

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
