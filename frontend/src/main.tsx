import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ModeProvider } from './contexts/ModeContext';
import { LanguageProvider } from './contexts/LanguageContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModeProvider>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ModeProvider>
  </StrictMode>,
);
