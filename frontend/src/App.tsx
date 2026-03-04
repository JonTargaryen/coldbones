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

  // Health check on mount and every 30s
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
  const isReady = health?.model_loaded === true;
  const isUploading = selectedFile?.status === 'uploading';
  const isAnalyzing = selectedFile?.status === 'analyzing';
  const isBusy = isUploading || isAnalyzing;

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
