import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { ProcessingMode } from '../types';

interface ModeContextType {
  mode: ProcessingMode;
  setMode: (mode: ProcessingMode) => void;
}

const ModeContext = createContext<ModeContextType | undefined>(undefined);

/** Provides the current processing mode (fast/slow) with localStorage persistence. */
export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ProcessingMode>(() => {
    const saved = localStorage.getItem('coldbones-mode');
    return (saved === 'fast' || saved === 'slow') ? saved : 'fast';
  });

  const setMode = (newMode: ProcessingMode) => {
    setModeState(newMode);
    localStorage.setItem('coldbones-mode', newMode);
  };

  useEffect(() => {
    localStorage.setItem('coldbones-mode', mode);
  }, [mode]);

  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

/** Returns the current processing mode and its setter from ModeContext. */
export function useMode() {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error('useMode must be used within a ModeProvider');
  }
  return context;
}
