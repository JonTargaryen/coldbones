import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { type Language, type Translations, TRANSLATION_MAP } from '../i18n/translations';

interface LanguageContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Translations;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/** Provides the current UI language and translation strings to the component tree. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => {
    const saved = localStorage.getItem('coldbones-lang');
    if (saved) {
      const key = saved.toLowerCase();
      if (key === 'en' || key === 'hi' || key === 'es' || key === 'bn') return key as Language;
    }
    return 'en';
  });

  useEffect(() => {
    localStorage.setItem('coldbones-lang', lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = (newLang: Language) => {
    const key = String(newLang).toLowerCase();
    if (TRANSLATION_MAP[key as Language]) setLangState(key as Language);
    else setLangState('en');
  };

  const t = TRANSLATION_MAP[lang] ?? TRANSLATION_MAP.en;

  return (
    <LanguageContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

/** Returns the current language, setter, and translation record from LanguageContext. */
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider');
  return ctx;
}
