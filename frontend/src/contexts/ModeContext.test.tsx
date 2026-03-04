import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModeProvider, useMode } from './ModeContext';

function Probe() {
  const { mode, setMode } = useMode();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <button onClick={() => setMode('slow')}>slow</button>
      <button onClick={() => setMode('fast')}>fast</button>
    </div>
  );
}

describe('ModeContext', () => {
  it('uses default fast mode when localStorage missing', () => {
    localStorage.removeItem('coldbones-mode');
    render(
      <ModeProvider>
        <Probe />
      </ModeProvider>
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('fast');
  });

  it('hydrates mode from localStorage and updates persistence', () => {
    localStorage.setItem('coldbones-mode', 'slow');
    render(
      <ModeProvider>
        <Probe />
      </ModeProvider>
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('slow');
    fireEvent.click(screen.getByText('fast'));
    expect(localStorage.getItem('coldbones-mode')).toBe('fast');
  });

  it('throws when hook used outside provider', () => {
    const Broken = () => {
      useMode();
      return null;
    };
    expect(() => render(<Broken />)).toThrow(/ModeProvider/);
  });
});
