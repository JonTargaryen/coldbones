import { useState, useEffect, useRef, useCallback } from 'react';
import { ModeProvider, useMode } from './contexts/ModeContext';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';
import { useUpload } from './hooks/useUpload';
import { useAnalysis } from './hooks/useAnalysis';
import { useSlowAnalysis } from './hooks/useSlowAnalysis';
import { UploadZone } from './components/UploadZone';
import { FilePreview } from './components/FilePreview';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ModeToggle } from './components/ModeToggle';
import { JobTracker } from './components/JobTracker';
import { LanguagePicker } from './components/LanguagePicker';
import './App.css';

type HealthStatus = 'checking' | 'online' | 'model-missing' | 'offline';

interface HealthState {
  status: HealthStatus;
  latencyMs: number | null;
  modelName: string;
  lastChecked: number;
  consecutiveFailures: number;
}

function useHealthCheck() {
  const [health, setHealth] = useState<HealthState>({
    status: 'checking',
    latencyMs: null,
    modelName: '',
    lastChecked: 0,
    consecutiveFailures: 0,
  });

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const checkHealth = async () => {
      const start = performance.now();
      try {
        const controller = new AbortController();
        const abortTimeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch('/api/health', { signal: controller.signal });
        clearTimeout(abortTimeout);
        const elapsed = Math.round(performance.now() - start);

        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setHealth({
              status: data.model_loaded ? 'online' : 'model-missing',
              latencyMs: elapsed,
              modelName: data.model_name || '',
              lastChecked: Date.now(),
              consecutiveFailures: 0,
            });
          }
        } else {
          if (!cancelled) {
            setHealth(prev => ({
              ...prev,
              status: 'offline',
              latencyMs: null,
              lastChecked: Date.now(),
              consecutiveFailures: prev.consecutiveFailures + 1,
            }));
          }
        }
      } catch {
        if (!cancelled) {
          setHealth(prev => ({
            ...prev,
            status: 'offline',
            latencyMs: null,
            lastChecked: Date.now(),
            consecutiveFailures: prev.consecutiveFailures + 1,
          }));
        }
      }

      if (!cancelled) {
        const nextInterval = health.status === 'offline' ? 2000 : 5000;
        timeoutId = setTimeout(checkHealth, nextInterval);
      }
    };

    checkHealth();
    return () => { cancelled = true; clearTimeout(timeoutId); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return health;
}

function AppContent() {
  const { mode } = useMode();
  const { lang, t } = useLanguage();
  const { files, addFiles, removeFile, clearFiles, updateFile } = useUpload();
  const { results, isAnalyzing, currentFileId, error, analyzeAll, clearResults } = useAnalysis();
  const { jobs, isSubmitting, submitSlowJob, clearJobs } = useSlowAnalysis();
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const health = useHealthCheck();

  useEffect(() => {
    if (isAnalyzing) {
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        setElapsedMs(prev => prev + 100);
      }, 100);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isAnalyzing]);

  useEffect(() => {
    if (files.length > 0 && !selectedFileId) {
      setSelectedFileId(files[0].id);
    }
    if (files.length === 0) {
      setSelectedFileId(null);
    }
  }, [files, selectedFileId]);

  const handleFilesAdded = useCallback((newFiles: File[]) => {
    const added = addFiles(newFiles);
    if (added.length > 0 && !selectedFileId) {
      setSelectedFileId(added[0].id);
    }
  }, [addFiles, selectedFileId]);

  const handleRemove = useCallback((fileId: string) => {
    removeFile(fileId);
    if (selectedFileId === fileId) {
      const remaining = files.filter(f => f.id !== fileId);
      setSelectedFileId(remaining.length > 0 ? remaining[0].id : null);
    }
  }, [removeFile, selectedFileId, files]);

  const handleAnalyze = useCallback(async () => {
    const validFiles = files.filter(f => f.status !== 'error');
    if (validFiles.length === 0) return;

    if (mode === 'slow') {
      await submitSlowJob(validFiles, lang);
    } else {
      await analyzeAll(validFiles, mode, (fileId, status) => {
        updateFile(fileId, { status });
      }, lang);
    }
  }, [files, mode, analyzeAll, updateFile, lang, submitSlowJob]);

  const handleClear = useCallback(() => {
    clearFiles();
    clearResults();
    clearJobs();
    setSelectedFileId(null);
  }, [clearFiles, clearResults, clearJobs]);

  const selectedFile = files.find(f => f.id === selectedFileId) ?? null;
  const selectedResult = selectedFileId ? results.get(selectedFileId) ?? null : null;
  const currentFile = currentFileId ? files.find(f => f.id === currentFileId) : null;
  const validFileCount = files.filter(f => f.status !== 'error').length;
  const isBusy = isAnalyzing || isSubmitting;

  return (
    <div className="app" role="application" aria-label="Coldbones AI Vision Analysis">
      <a className="skip-link" href="#main-content">Skip to main content</a>

      <header className="app-header" role="banner">
        <div className="header-left">
          <h1 className="app-title">coldbones</h1>
          <span className="app-subtitle" aria-label={t.appSubtitle}>{t.appSubtitle}</span>
        </div>
        <div className="header-center">
          <ModeToggle disabled={isBusy} />
        </div>
        <div className="header-right">
          <LanguagePicker />
          <StatusIndicator health={health} />
        </div>
      </header>

      <main className="app-main" id="main-content" role="main">
        <div className="left-panel">
          <UploadZone onFilesAdded={handleFilesAdded} disabled={isBusy} />

          {files.length > 0 && (
            <div className="action-bar" role="toolbar" aria-label="File actions">
              <button
                className="btn btn-primary"
                onClick={handleAnalyze}
                disabled={isBusy || validFileCount === 0 || health.status !== 'online'}
                aria-busy={isBusy}
              >
                {isBusy
                  ? (mode === 'slow' ? t.submittingBtn : t.analyzingBtn)
                  : t.analyzeBtn(validFileCount)}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleClear}
                disabled={isBusy}
              >
                {t.clearAll}
              </button>
            </div>
          )}

          <FilePreview
            file={selectedFile}
            files={files}
            onSelect={setSelectedFileId}
            onRemove={handleRemove}
          />
        </div>

        <div className="right-panel">
          {mode === 'slow' ? (
            <JobTracker jobs={jobs} />
          ) : (
            <AnalysisPanel
              result={selectedResult}
              isAnalyzing={isAnalyzing && currentFileId === selectedFileId}
              currentFileName={currentFile?.name}
              error={error}
              elapsedMs={elapsedMs}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function StatusIndicator({ health }: { health: HealthState }) {
  const { t } = useLanguage();

  const config: Record<HealthStatus, { label: string; detail?: string }> = {
    checking: { label: t.statusConnecting },
    online: {
      label: t.statusReady,
      detail: health.latencyMs !== null ? `${health.latencyMs}ms` : undefined,
    },
    'model-missing': {
      label: t.statusNoModel,
      detail: t.statusLoadModel,
    },
    offline: {
      label: t.statusOffline,
      detail: health.consecutiveFailures > 1
        ? t.failedChecks(health.consecutiveFailures)
        : undefined,
    },
  };

  const { label, detail } = config[health.status];

  return (
    <div
      className={`status-indicator status-${health.status}`}
      role="status"
      aria-live="polite"
      aria-label={`${label}${detail ? ` — ${detail}` : ''}`}
    >
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{label}</span>
      {detail && <span className="status-detail">{detail}</span>}
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <ModeProvider>
        <AppContent />
      </ModeProvider>
    </LanguageProvider>
  );
}
