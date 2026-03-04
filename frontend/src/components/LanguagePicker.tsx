import { useState, useRef, useEffect, useCallback } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import { LANGUAGES, type Language } from '../i18n/translations';

/**
 * Circular language picker — a floating ring of language options
 * that orbits around a central button when opened.
 */
export function LanguagePicker() {
  const { lang, setLang } = useLanguage();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find(l => l.code === lang) ?? LANGUAGES[0];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = useCallback((code: Language) => {
    setLang(code);
    setOpen(false);
  }, [setLang]);

  // Render all languages as satellites so English is always selectable.
  const items = LANGUAGES;
  const RADIUS = 48; // px from center to satellite (smaller)

  return (
    <div className="lang-picker" ref={containerRef}>
      {/* Orbiting items */}
      <div className={`lang-orbit ${open ? 'open' : ''}`}>
        {items.map((l, i) => {
          const angle = -90 + (i * (360 / items.length)); // start from top
          const rad = (angle * Math.PI) / 180;
          const x = Math.cos(rad) * RADIUS;
          const y = Math.sin(rad) * RADIUS;

          const isCurrent = l.code === current.code;

          return (
            <button
              key={l.code}
              className={`lang-satellite ${isCurrent ? 'current' : ''}`}
              style={{
                '--sat-x': `${x}px`,
                '--sat-y': `${y}px`,
                '--sat-delay': `${i * 30}ms`,
              } as React.CSSProperties}
              onClick={() => handleSelect(l.code)}
              aria-label={`Switch to ${l.labelEn}`}
              title={`${l.label} (${l.labelEn})`}
              tabIndex={open ? 0 : -1}
            >
              <div className="lang-sat-label" aria-hidden="true">{l.label}</div>
              <span className="lang-sat-flag" aria-hidden="true">{l.flag}</span>
              <span className="lang-sat-code">{l.code.toUpperCase()}</span>
            </button>
          );
        })}
      </div>

      {/* Center trigger */}
      <button
        className="lang-trigger"
        onClick={() => setOpen(o => !o)}
        aria-label={`Language: ${current.labelEn}. Click to change.`}
        aria-expanded={open}
        aria-haspopup="true"
        title={`${current.label} (${current.labelEn})`}
      >
        <span className="lang-trigger-flag" aria-hidden="true">{current.flag}</span>
        <span className="lang-trigger-code">{current.code.toUpperCase()}</span>
      </button>
    </div>
  );
}
