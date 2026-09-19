import { useEffect, useState } from 'react';

/**
 * The latest mark for a small display component, re-rendering it at most once
 * per `everyMs`. Only the component that calls this re-renders — the price in
 * the token bar, the value line in the sell panel — never App or the panel.
 */
export function useLiveMark(hub, getMark, everyMs = 1000) {
  const [mark, setMark] = useState(() => getMark());
  useEffect(() => {
    let last = 0;
    let timer = 0;
    const update = () => {
      timer = 0;
      last = Date.now();
      setMark(getMark());
    };
    const onAny = () => {
      if (timer) return;
      timer = setTimeout(update, Math.max(0, everyMs - (Date.now() - last)));
    };
    const offs = [hub.on('mark', onAny), hub.on('snapshot', onAny)];
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [hub, getMark, everyMs]);
  return mark;
}

/** prefers-reduced-motion, live. */
export function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The stream's latest 'stats' (the token header's 5 m / 1 h / 24 h change and
 * 24 h volume, Task 35) — from a 'stats' event or a snapshot carrying `stats` —
 * re-rendering the caller at most once per `everyMs`. Raw: the caller cleans it
 * (tokenFacts.normalizeStats). null until the stream has sent any.
 */
export function useLiveStats(hub, everyMs = 1000) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let latest = null;
    let last = 0;
    let timer = 0;
    const update = () => {
      timer = 0;
      last = Date.now();
      setStats(latest);
    };
    const take = (s) => {
      if (!s || typeof s !== 'object') return;
      latest = s;
      if (timer) return;
      timer = setTimeout(update, Math.max(0, everyMs - (Date.now() - last)));
    };
    const offs = [hub.on('stats', take), hub.on('snapshot', (d) => take(d && d.stats))];
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [hub, everyMs]);
  return stats;
}
