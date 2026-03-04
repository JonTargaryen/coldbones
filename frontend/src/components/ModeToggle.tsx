import { useMode } from '../contexts/ModeContext';
import type { ProcessingMode } from '../types';

interface ModeToggleProps {
  disabled?: boolean;
}

export function ModeToggle({ disabled = false }: ModeToggleProps) {
  const { mode, setMode } = useMode();

  const handleToggle = (newMode: ProcessingMode) => {
    if (!disabled) setMode(newMode);
  };

  return (
    <div className={`mode-toggle ${disabled ? 'disabled' : ''}`} role="group" aria-label="Processing mode">
      <button
        className={`mode-btn ${mode === 'fast' ? 'active' : ''}`}
        onClick={() => handleToggle('fast')}
        disabled={disabled}
        title="Fast mode: instant results — always-warm GPU, synchronous response"
        aria-pressed={mode === 'fast'}
      >
        <span className="mode-icon" aria-hidden="true">⚡</span>
        <span className="mode-label">Fast</span>
      </button>
      <button
        className={`mode-btn ${mode === 'slow' ? 'active' : ''}`}
        onClick={() => handleToggle('slow')}
        disabled={disabled}
        title="Slow mode: queued processing — best for larger batches and background analysis"
        aria-pressed={mode === 'slow'}
      >
        <span className="mode-icon" aria-hidden="true">🐢</span>
        <span className="mode-label">Slow</span>
      </button>
    </div>
  );
}
