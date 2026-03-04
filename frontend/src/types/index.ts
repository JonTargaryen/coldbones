export type ProcessingMode = 'fast' | 'slow';

export interface UploadedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  previewUrl: string;
  status: 'pending' | 'uploading' | 'uploaded' | 'analyzing' | 'complete' | 'error';
  progress: number;
  error?: string;
}

export interface AnalysisResult {
  fileId: string;
  summary: string;
  keyObservations: string[];
  contentClassification: string;
  extractedText: string;
  reasoning: string;
  reasoningTokenCount: number;
  finishReason: string;
  processingTimeMs: number;
  mode: ProcessingMode;
}

export interface JobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  result?: AnalysisResult;
  estimatedWait?: number;
  createdAt: string;
}

export interface AnalyzeRequest {
  mode: ProcessingMode;
  fileId: string;
  filename: string;
}

export interface AnalyzeResponse {
  success: boolean;
  result?: AnalysisResult;
  jobId?: string;
  error?: string;
}

export interface HealthResponse {
  status: string;
  model_loaded: boolean;
  lm_studio_url: string;
}
