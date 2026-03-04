import { useState } from 'react';
import type { SlowJob } from '../hooks/useSlowAnalysis';
import { AnalysisPanel } from './AnalysisPanel';

interface JobTrackerProps {
  jobs: SlowJob[];
}

export function JobTracker({ jobs }: JobTrackerProps) {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  if (jobs.length === 0) {
    return (
      <div className="job-tracker empty-state">
        <p className="job-tracker-empty">
          Submit files in 🐢 Slow mode to queue them for processing.
          Results will appear here when complete.
        </p>
        <div className="job-tracker-info">
          <p>🐢 <strong>Slow mode</strong> uses Spot GPU instances — up to 90% cheaper than Fast mode.</p>
          <p>Typical wait: 2–10 minutes (includes GPU spin-up if needed).</p>
        </div>
      </div>
    );
  }

  const completedCount = jobs.filter(j => j.status === 'complete').length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  const pendingCount = jobs.filter(j => j.status === 'queued' || j.status === 'processing').length;

  return (
    <div className="job-tracker">
      <div className="job-tracker-header">
        <h3 className="job-tracker-title">Job Queue</h3>
        <div className="job-tracker-counts">
          {completedCount > 0 && <span className="jt-count complete">{completedCount} done</span>}
          {pendingCount > 0 && <span className="jt-count pending">{pendingCount} pending</span>}
          {failedCount > 0 && <span className="jt-count failed">{failedCount} failed</span>}
        </div>
      </div>

      <div className="job-list">
        {jobs.map(job => (
          <div key={job.jobId} className={`job-item status-${job.status}`}>
            <div
              className="job-item-header"
              onClick={() => setExpandedJobId(expandedJobId === job.jobId ? null : job.jobId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedJobId(expandedJobId === job.jobId ? null : job.jobId); }}
              aria-expanded={expandedJobId === job.jobId}
            >
              <span className="job-status-icon" aria-label={`Status: ${job.status}`}>
                {statusIcon(job.status)}
              </span>
              <span className="job-filename" title={job.fileName}>{job.fileName}</span>
              <div className="job-meta">
                <StatusBadge status={job.status} />
                {job.estimatedWait !== null && job.status === 'queued' && (
                  <span className="job-eta">~{Math.ceil(job.estimatedWait / 60)}m wait</span>
                )}
                {job.status === 'complete' && job.result && (
                  <span className="job-expand-hint">{expandedJobId === job.jobId ? '▲ hide' : '▼ view'}</span>
                )}
              </div>
            </div>

            {job.status === 'processing' && (
              <div className="job-progress-bar" role="progressbar" aria-label="Processing">
                <div className="job-progress-fill indeterminate" />
              </div>
            )}

            {job.status === 'failed' && job.errorMessage && (
              <div className="job-error">{job.errorMessage}</div>
            )}

            {job.status === 'complete' && job.result && expandedJobId === job.jobId && (
              <div className="job-result-panel">
                <AnalysisPanel
                  result={job.result}
                  isAnalyzing={false}
                  currentFileName={job.fileName}
                  error={null}
                  elapsedMs={0}
                />
              </div>
            )}

            <div className="job-id-row">
              <span className="job-id" title={job.jobId}>
                ID: {job.jobId.slice(0, 16)}{job.jobId.length > 16 ? '…' : ''}
              </span>
              <button
                className="job-copy-btn"
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(job.jobId).catch(() => {}); }}
                title="Copy job ID"
                aria-label="Copy job ID"
              >
                📋
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function statusIcon(status: SlowJob['status']): string {
  switch (status) {
    case 'queued': return '⏳';
    case 'processing': return '🔄';
    case 'complete': return '✅';
    case 'failed': return '❌';
    default: return '•';
  }
}

function StatusBadge({ status }: { status: SlowJob['status'] }) {
  const labels: Record<SlowJob['status'], string> = {
    queued: 'Queued',
    processing: 'Processing',
    complete: 'Complete',
    failed: 'Failed',
  };
  return (
    <span className={`job-badge job-badge-${status}`}>{labels[status]}</span>
  );
}
