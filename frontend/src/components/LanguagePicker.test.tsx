import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../contexts/LanguageContext';
import { LanguagePicker } from './LanguagePicker';

describe('LanguagePicker', () => {
  it('opens orbit and selects a language', () => {
    render(
      <LanguageProvider>
        <LanguagePicker />
      </LanguageProvider>
    );

    const trigger = screen.getByRole('button', { name: /Language:/i });
    fireEvent.click(trigger);

    const spanish = screen.getByRole('button', { name: /Switch to Spanish/i });
    fireEvent.click(spanish);

    expect(document.documentElement.lang).toBe('es');
  });

  it('closes on Escape key when open', () => {
    render(
      <LanguageProvider>
        <LanguagePicker />
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Language:/i }));
    fireEvent.keyDown(document, { key: 'Escape' });

    const sats = screen.getAllByRole('button').filter((b) => b.className.includes('lang-satellite'));
    sats.forEach((s) => expect(s).toHaveAttribute('tabindex', '-1'));
  });

  it('closes on outside click', () => {
    render(
      <LanguageProvider>
        <div>
          <LanguagePicker />
          <button>outside</button>
        </div>
      </LanguageProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /Language:/i }));
    fireEvent.mouseDown(screen.getByText('outside'));

    const sats = screen.getAllByRole('button').filter((b) => b.className.includes('lang-satellite'));
    sats.forEach((s) => expect(s).toHaveAttribute('tabindex', '-1'));
  });
});
