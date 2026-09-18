import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted, latin subset only — the CSP (default-src 'self') allows no font CDN.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import App from './ui/App.jsx';
import './ui/dapp.css';

// The visitor's explicit theme choice (Task 8's contract: localStorage 'tp.theme',
// 'light' | 'dark'), applied before React paints. Without one, dapp.css follows the
// OS (prefers-color-scheme). Storage can throw (private window, blocked site
// data): the page then simply follows the OS.
try {
  const saved = localStorage.getItem('tp.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // no stored choice
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
