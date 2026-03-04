import { useState, useCallback } from 'react';
import type { UploadedFile } from '../types';
import { validateFile, validatePdfPageCount, isPdf } from '../utils/validation';

let fileIdCounter = 0;

export function useUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);

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

    // Async PDF page count validation — runs after files are added to state
    const pdfFiles = uploadedFiles.filter(f => isPdf(f.file) && f.status !== 'error');
    if (pdfFiles.length > 0) {
      for (const uploadedFile of pdfFiles) {
        validatePdfPageCount(uploadedFile.file).then(pageError => {
          if (pageError) {
            setFiles(prev =>
              prev.map(f =>
                f.id === uploadedFile.id ? { ...f, status: 'error', error: pageError } : f,
              ),
            );
          }
        });
      }
    }

    return uploadedFiles;
  }, []);

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
