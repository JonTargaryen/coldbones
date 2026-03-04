import { useState, useEffect, useRef } from 'react';
import './App.css';
import { UploadZone } from './components/UploadZone';
import { FilePreview } from './components/FilePreview';
import { AnalysisPanel } from './components/AnalysisPanel';
import { JobTracker } from './components/JobTracker';
import { ModeToggle } from './components/ModeToggle';
import { LanguagePicker } from './components/LanguagePicker';
import { useUpload } from './hooks/useUpload';
import { useAnalysis } from './hooks/useAnalysis';
import { useSlowAnalysis } from './hooks/useSlowAnalysis';
import { useMode } from './contexts/ModeContext';
import { useLanguage } from './contexts/LanguageContext';
import type { HealthResponse } from './types';

const API = import.meta.env.VITE_API_BASE_URL ?? '';

export default function App() {
  const { mode } = useMode();
  const { lang, t } = useLanguage();

  const { files, setFiles, addFiles, removeFile, clearAll } = useUpload();
  const { analyze } = useAnalysis(setFiles);
  const { slowJobs, enqueue } = useSlowAnalysis(setFiles);

  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Health check ─────────────────────────────────────────────────────────────────
  // The upload zone is disabled (grayed out) until health.status === 'ok' &&
  // health.model_loaded === true.  This prevents the user from uploading a file
  // when the backend isn't ready, which would result in a confusing 'Analysis
  // failed' error after a successful S3 upload.
  //
  // Why not rely on the analyze request failing instead?
  //   The presign/upload cycle succeeds regardless of backend state (it's
  //   just S3).  Gating on health means the user gets immediate feedback
  //   ("Server offline") instead of a 30 s wait followed by an error.
  //
  // 30 s poll: keeps the indicator fresh if the desktop goes offline mid-
  // session, but doesn't burn unnecessary API Gateway requests.
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${API}/api/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: HealthResponse = await res.json();
        setHealth(data);
        setHealthError(null);
      } catch (err) {
        setHealthError(err instanceof Error ? err.message : 'Unreachable');
        setHealth(null);
      }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  // Auto-select first file when none selected
  useEffect(() => {
    if (!selectedFileId && files.length > 0) {
      setSelectedFileId(files[0].id);
    }
    if (selectedFileId && !files.find((f) => f.id === selectedFileId)) {
      setSelectedFileId(files.length > 0 ? files[0].id : null);
    }
  }, [files, selectedFileId]);

  // Elapsed ms timer while analyzing
  useEffect(() => {
    const selectedFile = files.find((f) => f.id === selectedFileId);
    const isAnalyzing = selectedFile?.status === 'analyzing';

    if (isAnalyzing && !timerRef.current) {
      const start = Date.now();
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - start), 100);
    } else if (!isAnalyzing && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
      if (selectedFile?.status === 'complete' && selectedFile.result?.processingTimeMs) {
        setElapsedMs(selectedFile.result.processingTimeMs);
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [files, selectedFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;
  // isReady gates the upload zone AND the analyse button.
  // Both conditions must be true:
  //   1. health !== null  — health check resolved (API is reachable)
  //   2. health.status === 'ok'  — the mock endpoint returned its sentinel value
  // model_loaded is checked in the header indicator but not here; the /api/health
  // mock always returns model_loaded:true because the actual LM Studio check
  // is deferred to the analyze_router Lambda at submission time.
  const isReady = health?.status === 'ok';
  const isUploading = selectedFile?.status === 'uploading';
  const isAnalyzing = selectedFile?.status === 'analyzing';
  // isBusy prevents concurrent operations on the same file.
  const isBusy = isUploading || isAnalyzing;

  // canAnalyze: all three gates must pass before the Analyse button is active.
  //   'uploaded'  — the file has been PUT to S3 and we have an s3Key
  //   isReady     — the backend health check passed
  //   !isBusy     — no other operation is in flight for this file
  const canAnalyze = selectedFile?.status === 'uploaded' && isReady && !isBusy;

  const handleAnalyze = async () => {
    if (!selectedFile?.s3Key) return;
    setElapsedMs(0);
    if (mode === 'slow') {
      await enqueue(selectedFile.id, selectedFile.s3Key, selectedFile.file.name, lang);
    } else {
      await analyze(selectedFile.id, selectedFile.s3Key, selectedFile.file.name, lang);
    }
  };

  // Count files ready to analyze
  const uploadedCount = files.filter((f) => f.status === 'uploaded').length;

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">ColdBones</h1>
          <span className="app-subtitle">{t.appSubtitle}</span>
        </div>
        <div className="header-right">
          <LanguagePicker />
          <ModeToggle disabled={isBusy} />
          <div className="health-indicator">
            {health?.model_loaded ? (
              <span
                className="health-ok"
                title={`${health.provider} · ${health.model}`}
              >
                ● {health.provider}
              </span>
            ) : health ? (
              <span
                className="health-err"
                title="GPU server unreachable"
              >
                ● Server offline
              </span>
            ) : (
              <span
                className="health-err"
                title={healthError ?? 'Checking…'}
              >
                ● {healthError ? 'Offline' : 'Connecting…'}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main layout */}
      <main className="app-main">
        {/* Left: upload + file list */}
        <section className="sidebar">
          <UploadZone onFilesAdded={addFiles} disabled={!isReady || isBusy} />

          {files.length > 0 && (
            <>
              <FilePreview
                file={selectedFile}
                files={files}
                onSelect={setSelectedFileId}
                onRemove={removeFile}
              />
              <div className="action-row">
                <button
                  className="btn-analyze"
                  disabled={!canAnalyze}
                  onClick={handleAnalyze}
                >
                  {isAnalyzing
                    ? t.analyzing()
                    : t.analyzeBtn(uploadedCount > 0 ? uploadedCount : 1)}
                </button>
                <button
                  className="btn-clear"
                  onClick={clearAll}
                  disabled={isBusy}
                >
                  {t.clearAll}
                </button>
              </div>
            </>
          )}
        </section>

        {/* Right: analysis result */}
        <section className="result-panel">
          <AnalysisPanel
            result={selectedFile?.result ?? null}
            isAnalyzing={isAnalyzing}
            currentFileName={selectedFile?.file.name}
            error={selectedFile?.error ?? null}
            elapsedMs={elapsedMs}
          />
        </section>
      </main>

      {/* Slow-mode job tracker */}
      {slowJobs.length > 0 && (
        <aside className="job-sidebar">
          <JobTracker jobs={slowJobs} />
        </aside>
      )}
    </div>
  );
}
