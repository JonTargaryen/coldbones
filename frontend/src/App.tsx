import { useState, useEffect, useRef } from 'react';
import './App.css';
import { UploadZone } from './components/UploadZone';
import { FilePreview } from './components/FilePreview';
import { AnalysisPanel } from './components/AnalysisPanel';
import { JobTracker } from './components/JobTracker';
import { ModeToggle } from './components/ModeToggle';
import { LanguagePicker } from './components/LanguagePicker';
import { ProviderPicker } from './components/ProviderPicker';
import { ToastContainer } from './components/ToastContainer';
import { useUpload } from './hooks/useUpload';
import { useAnalysis } from './hooks/useAnalysis';
import { useSlowAnalysis } from './hooks/useSlowAnalysis';
import { useHistory } from './hooks/useHistory';
import { useToast } from './hooks/useToast';
import { useEstimate } from './hooks/useEstimate';
import { useMode } from './contexts/ModeContext';
import { useLanguage } from './contexts/LanguageContext';
import { useProvider } from './contexts/ProviderContext';
import type { HealthResponse } from './types';

import { API_BASE_URL as API } from './config';

/** Root application component — manages health checks, file uploads, and analysis orchestration. */
export default function App() {
  const { mode } = useMode();
  const { lang, t } = useLanguage();
  const { provider } = useProvider();

  const { files, setFiles, addFiles, removeFile, clearAll, reorderFiles } = useUpload();
  const { analyze } = useAnalysis(setFiles);
  const { slowJobs, enqueue } = useSlowAnalysis(setFiles);
  const { addEntry: addHistoryEntry } = useHistory();
  const { toasts, addToast, dismiss: dismissToast } = useToast();
  const { estimateMs, recordTime } = useEstimate();

  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

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

  // Save completed analyses to history + toast
  const savedIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const f of files) {
      if (f.status === 'complete' && f.result && !savedIdsRef.current.has(f.id)) {
        savedIdsRef.current.add(f.id);
        addHistoryEntry(f.name, f.result);
        addToast(`Analysis complete: ${f.name}`, 'success');
        if (f.result.processingTimeMs) recordTime(f.result.processingTimeMs);
      }
      if (f.status === 'error' && f.error && !savedIdsRef.current.has(f.id)) {
        savedIdsRef.current.add(f.id);
        addToast(`Error: ${f.error}`, 'error');
      }
    }
  }, [files, addHistoryEntry]);

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
    // Auto-scroll to results area on mobile
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    if (mode === 'slow') {
      await enqueue(selectedFile.id, selectedFile.s3Key, selectedFile.file.name, lang, provider);
    } else {
      await analyze(selectedFile.id, selectedFile.s3Key, selectedFile.file.name, lang, provider);
    }
  };

  // Keyboard shortcut: Ctrl/Cmd + Enter to analyze
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canAnalyze) handleAnalyze();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }); // intentionally no deps — uses latest canAnalyze & handleAnalyze

  // Count files ready to analyze
  const uploadedCount = files.filter((f) => f.status === 'uploaded').length;

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">ColdBones</h1>
        </div>
        <div className="header-right">
          <LanguagePicker />
          <ModeToggle disabled={isBusy} />
          <ProviderPicker disabled={isBusy} health={health} />
          <div className="health-indicator">
            {health?.model_loaded ? (
              <span
                className="health-ok"
                title={`${health.provider} · ${health.model}`}
              >
                ● <span className="health-label">{health.provider.split('(')[0].trim()}</span>
              </span>
            ) : health ? (
              <span
                className="health-err"
                title="GPU server unreachable"
              >
                ● <span className="health-label">Server offline</span>
              </span>
            ) : (
              <span
                className="health-err"
                title={healthError ?? 'Checking…'}
              >
                ● <span className="health-label">{healthError ? 'Offline' : 'Connecting…'}</span>
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Main layout */}
      <main className="app-main">

        {/* ── Hero: Visual Analyzer ── */}
        <section className="hero">
          <div className="hero-inner">
            <h2 className="hero-title">Visual Analyzer</h2>

            <UploadZone onFilesAdded={addFiles} disabled={!isReady || isBusy} />

            <div className="hero-cta-row">
              <button
                className="btn-analyze-now"
                disabled={!canAnalyze}
                onClick={handleAnalyze}
                aria-label={
                  isUploading ? 'Uploading file…'
                  : isAnalyzing ? 'Analyzing…'
                  : 'Analyze now'
                }
              >
                {/* scan / sparkle icon */}
                <svg className="btn-analyze-now-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M9.5 6.5v3h-3v-3h3M11 5H5v6h6V5zm-1.5 9.5v3h-3v-3h3M11 13H5v6h6v-6zm6.5-6.5v3h-3v-3h3M19 5h-6v6h6V5zm-6 8h1.5v1.5H13V13zm1.5 1.5H16V16h-1.5v-1.5zM16 13h1.5v1.5H16V13zm-3 3h1.5v1.5H13V16zm1.5 1.5H16V19h-1.5v-1.5zM16 16h1.5v1.5H16V16zm1.5-1.5H19V16h-1.5v-1.5zm0 3H19V19h-1.5v-1.5zM22 7h2v2h-2V7zm0 4h2v2h-2v-2zM2 7H0v2h2V7zm0 4H0v2h2v-2zM7 0v2H9V0H7zm4 0v2h2V0h-2zM7 22v2H9v-2H7zm4 0v2h2v-2h-2z"/>
                </svg>
                {isUploading
                  ? 'Uploading…'
                  : isAnalyzing
                  ? t.analyzing()
                  : 'Analyze Now'}
              </button>

              {files.length > 0 && (
                <button
                  className="btn-clear"
                  onClick={clearAll}
                  disabled={isBusy}
                >
                  {t.clearAll}
                </button>
              )}
            </div>

            {/* Status hint below the button */}
            {files.length > 0 && !isAnalyzing && !isUploading && (
              <p className="hero-hint">
                {uploadedCount > 0
                  ? `${uploadedCount} file${uploadedCount !== 1 ? 's' : ''} ready · select a file and click Analyze Now`
                  : selectedFile?.status === 'complete'
                  ? 'Analysis complete'
                  : null}
              </p>
            )}

            {/* Keyboard shortcut hint */}
            {canAnalyze && (
              <p className="kbd-hint">
                <span className="kbd">⌘</span>+<span className="kbd">↵</span> to analyze
              </p>
            )}

            {/* File size note */}
            <p className="hero-limit-note">{t.uploadHint}</p>
          </div>
        </section>

        {/* ── Results: file preview + analysis panel ── */}
        {files.length > 0 && (
          <section className="results-area" ref={resultsRef} aria-label="Analysis results">
            <div className="results-sidebar">
              <FilePreview
                file={selectedFile}
                files={files}
                onSelect={setSelectedFileId}
                onRemove={removeFile}
                onReorder={reorderFiles}
              />
            </div>
            <div className="result-panel">
              <AnalysisPanel
                result={selectedFile?.result ?? null}
                isAnalyzing={isAnalyzing}
                currentFileName={selectedFile?.file.name}
                error={selectedFile?.error ?? null}
                elapsedMs={elapsedMs}
                estimateMs={estimateMs}
                partialText={selectedFile?.partialText}
              />
            </div>
          </section>
        )}
      </main>

      {/* Slow-mode job tracker */}
      {slowJobs.length > 0 && (
        <aside className="job-sidebar">
          <JobTracker jobs={slowJobs} />
        </aside>
      )}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
