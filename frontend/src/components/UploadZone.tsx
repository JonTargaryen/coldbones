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
        {/* Material cloud-upload icon */}
        <svg className="upload-icon-svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
        </svg>
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
