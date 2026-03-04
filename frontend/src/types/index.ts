// Shared TypeScript types for ColdBones frontend

export type ProcessingMode = 'fast' | 'slow';

/** Status values used on UploadedFile and displayed in UI components */
export type FileStatus =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'analyzing'
  | 'complete'
  | 'error';

export interface UploadedFile {
  id: string;
  file: File;
  /** Convenience alias for file.name — used directly by FilePreview */
  name: string;
  /** Convenience alias for file.size — used directly by FilePreview */
  size: number;
  /** Object URL for image preview (blob URL) */
  previewUrl?: string;
  status: FileStatus;
  progress: number;
  error?: string;
  result?: AnalysisResult;
  // Cloud upload fields (set after S3 presigned PUT)
  s3Key?: string;
  uploadJobId?: string;
}

/** Result returned by the analysis API — camelCase to match component expectations */
export interface AnalysisResult {
  summary: string;
  keyObservations: string[];
  contentClassification: string;
  extractedText: string;
  /** Only present in legacy/test data — kept for backward compat */
  fileId?: string;
  /** Always empty string for Bedrock (not a thinking model) */
  reasoning?: string;
  reasoningTokenCount?: number;
  finishReason?: string;
  processingTimeMs?: number;
  mode?: 'fast' | 'slow';
  model?: string;
  provider?: string;
}

export interface HealthResponse {
  status: string;
  model: string;
  provider: string;
  lm_studio_url?: string;
  model_loaded: boolean;
}

/** DynamoDB / API status — uppercase, used for polling responses */
export type DynamoJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/** GET /api/status/{jobId} response */
export interface JobStatusResponse {
  jobId: string;
  status: DynamoJobStatus;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  result?: ApiAnalysisResult;
  error?: string;
}

/** Raw snake_case payload from Lambda/Bedrock (before camelCase conversion) */
export interface ApiAnalysisResult {
  summary: string;
  key_observations: string[];
  content_classification: string;
  extracted_text: string;
  reasoning?: string;
  reasoning_token_count?: number;
  finish_reason?: string;
  processing_time_ms?: number;
  mode?: string;
  model?: string;
  provider?: string;
}

/** UI-facing SlowJob status — lowercase for CSS class names */
export type SlowJobStatus = 'queued' | 'processing' | 'complete' | 'failed';

/** Slow-mode job tracked in the frontend */
export interface SlowJob {
  jobId: string;
  fileId: string;
  fileName: string;
  status: SlowJobStatus;
  estimatedWait: number | null;
  errorMessage?: string;
  result?: AnalysisResult;
}

export interface PresignResponse {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}

export interface Language {
  code: string;
  label: string;
  flag: string;
}
