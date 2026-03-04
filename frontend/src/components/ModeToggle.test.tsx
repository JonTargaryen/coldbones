import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeProvider } from '../contexts/ModeContext';
import { ModeToggle } from './ModeToggle';

function renderWithProvider(disabled = false) {
  return render(
    <ModeProvider>
      <ModeToggle disabled={disabled} />
    </ModeProvider>
  );
}

describe('ModeToggle', () => {
  it('renders and toggles modes', () => {
    localStorage.removeItem('coldbones-mode');
    renderWithProvider(false);

    const fastBtn = screen.getByRole('button', { name: /fast/i });
    const slowBtn = screen.getByRole('button', { name: /slow/i });

    expect(fastBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(slowBtn);
    expect(slowBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not toggle when disabled', () => {
    localStorage.removeItem('coldbones-mode');
    renderWithProvider(true);

    const fastBtn = screen.getByRole('button', { name: /fast/i });
    const slowBtn = screen.getByRole('button', { name: /slow/i });

    fireEvent.click(slowBtn);
    expect(fastBtn).toHaveAttribute('aria-pressed', 'true');
    expect(slowBtn).toHaveAttribute('aria-pressed', 'false');
  });
});
