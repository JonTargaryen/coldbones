import { useLanguage } from '../contexts/LanguageContext';
import type { Language } from '../i18n/translations';

const OPTIONS: { code: Language; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
];

export function LanguagePicker() {
  const { lang, setLang } = useLanguage();

  return (
    <div className="lang-picker">
      <select
        className="lang-select"
        value={lang}
        onChange={e => setLang(e.target.value as Language)}
        aria-label="Select language"
      >
        {OPTIONS.map(o => (
          <option key={o.code} value={o.code}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
