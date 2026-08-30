import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted so the type renders identically offline and behind a firewall —
// a launcher console cannot depend on the browser reaching fonts.googleapis.com.
// Latin subset only: the console is English, so every other subset is dead
// weight in the bundle.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import App from './App.jsx';
import './styles.css';
import './shell.css';

// Apply the saved theme BEFORE React paints, so a light-mode operator does not
// get a dark flash on every load. Dark is the default — it is what the console
// has always been and what a long arming session wants. Presentation only:
// this sets an attribute the stylesheet reads, nothing else.
try {
  const saved = localStorage.getItem('pons-launcher.theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // Storage can be disabled; the console just stays on the default theme.
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
