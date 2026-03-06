// Shared TypeScript types for ColdBones frontend

export type ProcessingMode = 'fast' | 'slow';

/** Inference provider selection */
export type InferenceProvider = 'auto' | 'local' | 'cloud' | 'cloud-cmi';

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
  /** Partial model output streamed during analysis (raw text before parsing) */
  partialText?: string;
  // Cloud upload fields (set after S3 presigned PUT)
  s3Key?: string;
  uploadJobId?: string;
}

/** Result returned by the analysis API — camelCase to match component expectations */
export interface AnalysisResult {
  /** Full chain-of-thought reasoning from the model (markdown) */
  chainOfThought: string;
  /** Concise summary of the analysis */
  summary: string;
  /** Detailed description of what's in the image (markdown) */
  description: string;
  /** Analytical insights and deeper interpretations */
  insights: string[];
  /** Specific, factual observations about the image */
  observations: string[];
  /** Transcribed text from the image (OCR), copy-pastable */
  ocrText: string;
  /** Content classification (photograph, screenshot, etc.) */
  contentClassification: string;
  /** Legacy: key observations (same as observations for backward compat) */
  keyObservations: string[];
  /** Legacy: extracted text (same as ocrText for backward compat) */
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
  /** Token usage stats from Bedrock */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface HealthResponse {
  status: string;
  model: string;
  provider: string;
  model_loaded: boolean;
  providers?: {
    local: { name: string; status: string };
    cloud: { name: string; status: string };
  };
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
  chain_of_thought?: string;
  summary: string;
  description?: string;
  insights?: string[];
  observations?: string[];
  ocr_text?: string;
  content_classification: string;
  /** Legacy fields */
  key_observations: string[];
  extracted_text: string;
  reasoning?: string;
  reasoning_token_count?: number;
  finish_reason?: string;
  processing_time_ms?: number;
  mode?: string;
  model?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
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
  uploadMethod?: 'PUT' | 'POST';
  uploadFields?: Record<string, string>;
  s3Key: string;
  expiresIn: number;
  maxSizeBytes?: number;
}

export interface Language {
  code: string;
  label: string;
  flag: string;
}
