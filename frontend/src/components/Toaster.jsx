import { useEffect, useState } from 'react';
import { LuCircleAlert, LuCircleCheck, LuInfo, LuX } from 'react-icons/lu';

/**
 * The notice rail — instrument tickets that slide in when an action is refused
 * or completed, so nothing fails silently into a panel elsewhere on the page.
 *
 * It listens for the one 'pons:notice' event every blocked action raises (see
 * api.js), colours by kind — vermilion for a refusal, jade for a completion,
 * amber for a plain note — and auto-clears after a few seconds. Errors linger
 * longer than confirmations, because a refusal is a thing to read and act on.
 *
 * Presentation only: it invents no behaviour, it just shows what already
 * happened where the operator is looking.
 */
let seq = 0;

export default function Toaster() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    function onNotice(e) {
      const { message, kind = 'info' } = e.detail || {};
      if (!message) return;
      const id = ++seq;
      setToasts((t) => [...t.slice(-3), { id, message, kind }]);
      const ttl = kind === 'error' ? 8000 : 4500;
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
    }
    window.addEventListener('pons:notice', onNotice);
    return () => window.removeEventListener('pons:notice', onNotice);
  }, []);

  function dismiss(id) {
    setToasts((t) => t.filter((x) => x.id !== id));
  }

  const label = { error: 'blocked', ok: 'done', info: 'note' };
  const Icon = { error: LuCircleAlert, ok: LuCircleCheck, info: LuInfo };

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Glyph = Icon[t.kind] || LuInfo;
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Glyph className="toast-icon" aria-hidden="true" />
            <span className="toast-body">
              <span className="toast-tag">{label[t.kind] || 'note'}</span>
              <span className="toast-msg">{t.message.replace(/^ERROR:\s*/i, '')}</span>
            </span>
            <button className="toast-x" title="dismiss" onClick={() => dismiss(t.id)}>
              <LuX aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
