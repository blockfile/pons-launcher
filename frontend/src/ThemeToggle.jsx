import { useState } from 'react';
import { LuSun, LuMoon } from 'react-icons/lu';

/**
 * Dark / light switch for the whole console.
 *
 * PRESENTATION ONLY. It sets `data-theme` on <html> — the one attribute the
 * stylesheet's light block reads — and remembers the choice in localStorage.
 * It touches no money path, no api, no app state; the worst it can do is
 * recolour the screen. main.jsx applies the saved value before first paint so
 * there is no flash; this component only flips it live.
 *
 * Dark is the default and the initial render, so the button starts by offering
 * light. It reads the live attribute rather than trusting a prop, so it stays
 * correct even if something else sets the theme.
 */
const KEY = 'pons-launcher.theme';

function current() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(current);

  function flip() {
    const next = current() === 'light' ? 'dark' : 'light';
    if (next === 'dark') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = 'light';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not fatal — the theme still holds for this page view.
    }
    setTheme(next);
  }

  const goingLight = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={flip}
      title={goingLight ? 'Switch to light' : 'Switch to dark'}
      aria-label={goingLight ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      {goingLight ? <LuSun size={15} aria-hidden="true" /> : <LuMoon size={15} aria-hidden="true" />}
      <span>{goingLight ? 'Light' : 'Dark'}</span>
    </button>
  );
}
