import { useProvider } from '../contexts/ProviderContext';
import type { InferenceProvider, HealthResponse } from '../types';

interface ProviderPickerProps {
  disabled?: boolean;
  health?: HealthResponse | null;
}

const PROVIDERS: { value: InferenceProvider; label: string; title: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    title: 'Auto: cloud-primary — Bedrock On-Demand (pay-per-token, scale-to-zero)',
  },
  {
    value: 'local',
    label: 'Local',
    title: 'Local: RTX 5090 via LM Studio (queues if offline)',
  },
  {
    value: 'cloud',
    label: 'Cloud',
    title: 'Cloud: Bedrock On-Demand (Nova Lite, pay-per-token)',
  },
];

/** Button group for selecting the inference provider (Auto, Local, or Cloud). */
export function ProviderPicker({ disabled = false, health }: ProviderPickerProps) {
  const { provider, setProvider } = useProvider();

  const getStatusClass = (value: InferenceProvider): string => {
    if (value === 'auto') return '';
    const providerStatus = health?.providers?.[value as 'local' | 'cloud'];
    if (!providerStatus) return 'unknown';
    if (providerStatus.status === 'configured') return 'online';
    if (providerStatus.status === 'unknown') return 'unknown';
    return 'offline';
  };

  return (
    <div
      className={`provider-picker ${disabled ? 'disabled' : ''}`}
      role="group"
      aria-label="Inference provider"
    >
      {PROVIDERS.map((p) => (
        <button
          key={p.value}
          className={`provider-btn ${provider === p.value ? 'active' : ''}`}
          onClick={() => !disabled && setProvider(p.value)}
          disabled={disabled}
          title={p.title}
          aria-pressed={provider === p.value}
        >
          <span className="provider-icon">
            {p.value === 'local' ? (
              /* GPU icon */
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path d="M3 5a2 2 0 012-2h10a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V5zm2 0v6h10V5H5zm1 8h2v2H6v-2zm3 0h2v2H9v-2zm3 0h2v2h-2v-2z" />
              </svg>
            ) : p.value === 'cloud' ? (
              /* Cloud icon */
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path d="M5.5 16a3.5 3.5 0 01-.369-6.98 4 4 0 117.753-1.977A4.5 4.5 0 1113.5 16h-8z" />
              </svg>
            ) : (
              /* Auto/smart icon */
              <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14" aria-hidden="true">
                <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
              </svg>
            )}
          </span>
          <span className="provider-label">{p.label}</span>
          {p.value !== 'auto' && (
            <span className={`provider-status-dot ${getStatusClass(p.value)}`} aria-label={`${p.label} ${getStatusClass(p.value)}`} />
          )}
        </button>
      ))}
    </div>
  );
}
