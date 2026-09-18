import { useEffect, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from 'react-icons/lu';

let seq = 0;
const ICON = { error: LuCircleAlert, ok: LuCircleCheck, info: LuInfo };

/**
 * Toasts listen on the hub ('toast' {message, kind}) and hold their own state,
 * so a toast never re-renders App or the sell panel. Motion is framer-motion's
 * `m` under App's LazyMotion; MotionConfig reducedMotion="user" drops it for
 * visitors who asked for less motion.
 */
export default function Toasts({ hub }) {
  const [list, setList] = useState([]);
  useEffect(
    () =>
      hub.on('toast', (t) => {
        if (!t || !t.message) return;
        const id = ++seq;
        const kind = t.kind || 'info';
        setList((l) => [...l.slice(-3), { id, kind, message: String(t.message) }]);
        setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
      }),
    [hub]
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {list.map((t) => {
          const Glyph = ICON[t.kind] || LuInfo;
          return (
            <m.div
              key={t.id}
              className={`toast t-${t.kind}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            >
              <Glyph className="toast-icon" aria-hidden="true" />
              <span className="toast-msg">{t.message}</span>
              <button type="button" className="icon quiet" aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>
                <LuX aria-hidden="true" />
              </button>
            </m.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
