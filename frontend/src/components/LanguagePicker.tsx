import { useLanguage } from '../contexts/LanguageContext';
import type { Language } from '../i18n/translations';

const OPTIONS: { code: Language; label: string; flag: string }[] = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'es', label: 'Spanish', flag: '🇪🇸' },
  { code: 'hi', label: 'Hindi',   flag: '🇮🇳' },
  { code: 'bn', label: 'Bengali', flag: '🇧🇩' },
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
            {o.flag} {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
