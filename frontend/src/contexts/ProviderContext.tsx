import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { InferenceProvider } from '../types';

interface ProviderContextType {
  provider: InferenceProvider;
  setProvider: (p: InferenceProvider) => void;
}

const ProviderContext = createContext<ProviderContextType | undefined>(undefined);

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [provider, setProviderState] = useState<InferenceProvider>(() => {
    const saved = localStorage.getItem('coldbones-provider');
    return (saved === 'auto' || saved === 'local' || saved === 'cloud' || saved === 'cloud-cmi') ? saved : 'auto';
  });

  const setProvider = (newProvider: InferenceProvider) => {
    setProviderState(newProvider);
    localStorage.setItem('coldbones-provider', newProvider);
  };

  useEffect(() => {
    localStorage.setItem('coldbones-provider', provider);
  }, [provider]);

  return (
    <ProviderContext.Provider value={{ provider, setProvider }}>
      {children}
    </ProviderContext.Provider>
  );
}

export function useProvider() {
  const context = useContext(ProviderContext);
  if (!context) {
    throw new Error('useProvider must be used within a ProviderProvider');
  }
  return context;
}
