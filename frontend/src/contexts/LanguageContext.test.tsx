import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider, useLanguage } from './LanguageContext';

function Probe() {
  const { lang, setLang, t } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="subtitle">{t.appSubtitle}</span>
      <button onClick={() => setLang('es')}>es</button>
      <button onClick={() => setLang('en')}>en</button>
      <button onClick={() => setLang('zz' as never)}>invalid</button>
    </div>
  );
}

describe('LanguageContext', () => {
  it('defaults to en and updates html lang', () => {
    localStorage.removeItem('coldbones-lang');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    );
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('hydrates and persists language with fallback to en for invalid values', () => {
    localStorage.setItem('coldbones-lang', 'hi');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>
    );

    expect(screen.getByTestId('lang')).toHaveTextContent('hi');
    fireEvent.click(screen.getByText('es'));
    expect(localStorage.getItem('coldbones-lang')).toBe('es');

    fireEvent.click(screen.getByText('invalid'));
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
  });

  it('throws when hook used outside provider', () => {
    const Broken = () => {
      useLanguage();
      return null;
    };
    expect(() => render(<Broken />)).toThrow(/LanguageProvider/);
  });
});
