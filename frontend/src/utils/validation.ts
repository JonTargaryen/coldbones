const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

const ACCEPTED_PDF_TYPE = 'application/pdf';

const MAX_FILE_SIZE_MB = 20;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_BATCH_SIZE_FAST = 10;
const MAX_BATCH_SIZE_SLOW = 50;
export const MAX_PDF_PAGES = 50;

export interface ValidationError {
  file: File;
  message: string;
}

export function isAcceptedType(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type) || file.type === ACCEPTED_PDF_TYPE;
}

export function isImage(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

export function isPdf(file: File): boolean {
  return file.type === ACCEPTED_PDF_TYPE;
}

export function validateFile(file: File): string | null {
  if (!isAcceptedType(file)) {
    return `Unsupported file type "${file.type || 'unknown'}". Accepted: JPEG, PNG, WebP, GIF, BMP, TIFF, PDF.`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File exceeds ${MAX_FILE_SIZE_MB} MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB).`;
  }
  return null;
}

/**
 * Async validation for PDF files — checks page count using pdfjs-dist.
 * Returns null if valid, or an error string.
 */
export async function validatePdfPageCount(file: File): Promise<string | null> {
  if (!isPdf(file)) return null;
  try {
    // Dynamically import to avoid loading pdfjs for non-PDF files
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).href;

    const arrayBuffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = doc.numPages;
    doc.destroy();

    if (numPages > MAX_PDF_PAGES) {
      return `PDF has ${numPages} pages. Maximum allowed: ${MAX_PDF_PAGES} pages.`;
    }
    return null;
  } catch {
    // If pdfjs fails, fall through — let the server reject it if needed
    return null;
  }
}

export function validateBatch(files: File[], mode: 'fast' | 'slow'): ValidationError[] {
  const maxBatch = mode === 'fast' ? MAX_BATCH_SIZE_FAST : MAX_BATCH_SIZE_SLOW;
  const errors: ValidationError[] = [];

  if (files.length > maxBatch) {
    errors.push({
      file: files[0],
      message: `Maximum ${maxBatch} files per batch in ${mode} mode.`,
    });
  }

  for (const file of files) {
    const error = validateFile(file);
    if (error) {
      errors.push({ file, message: error });
    }
  }

  return errors;
}

export function validateBatchSize(count: number, mode: 'fast' | 'slow'): string | null {
  const maxBatch = mode === 'fast' ? MAX_BATCH_SIZE_FAST : MAX_BATCH_SIZE_SLOW;
  if (count > maxBatch) {
    return `Maximum ${maxBatch} files per batch in ${mode} mode.`;
  }
  return null;
}

export const ACCEPT_MAP: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/bmp': ['.bmp'],
  'image/tiff': ['.tif', '.tiff'],
  'application/pdf': ['.pdf'],
};
