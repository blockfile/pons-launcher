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
import '@fontsource-variable/space-grotesk';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import App from './App.jsx';
import './styles.css';
import './shell.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
