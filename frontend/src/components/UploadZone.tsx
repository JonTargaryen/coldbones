import { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { ACCEPT_MAP } from '../utils/validation';
import { useLanguage } from '../contexts/LanguageContext';

interface UploadZoneProps {
  onFilesAdded: (files: File[]) => void;
  disabled?: boolean;
}

export function UploadZone({ onFilesAdded, disabled }: UploadZoneProps) {
  const { t } = useLanguage();

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      onFilesAdded(acceptedFiles);
    }
  }, [onFilesAdded]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPT_MAP,
    disabled,
    multiple: true,
  });

  return (
    <div
      {...getRootProps()}
      className={`upload-zone ${isDragActive ? 'drag-active' : ''} ${disabled ? 'disabled' : ''}`}
      role="button"
      aria-label={isDragActive ? t.uploadTitleDrag : t.uploadTitle}
      tabIndex={0}
    >
      <input {...getInputProps()} aria-label={t.uploadSubtitle} />
      <div className="upload-zone-content">
        <div className="upload-icon" aria-hidden="true">
          {isDragActive ? '📥' : '📁'}
        </div>
        <p className="upload-title">
          {isDragActive ? t.uploadTitleDrag : t.uploadTitle}
        </p>
        <p className="upload-subtitle">
          {t.uploadSubtitle}
        </p>
        <p className="upload-hint">
          {t.uploadHint}
        </p>
      </div>
    </div>
  );
}
