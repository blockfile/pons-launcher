import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * The console's own confirmation dialog, replacing window.confirm/prompt.
 *
 * A browser dialog is the wrong instrument for this app. It cannot be styled,
 * so nothing about it says "live" or "dry run"; it collapses a summary into one
 * unformatted paragraph, so the amount and the wallet count read as prose
 * rather than as figures to be checked; it is dismissed by reflex; and several
 * browsers let a page suppress it outright, which for a button that spends real
 * funds is a hazard rather than an inconvenience.
 *
 * Three deliberate refusals here:
 *
 *   Enter never confirms. It is the key an operator presses without reading,
 *   and this dialog exists to be read. Focus lands on the dialog itself, not on
 *   a button, so a keystroke already in flight hits nothing.
 *
 *   Escape and a click on the backdrop cancel. The easy, reflexive gestures all
 *   resolve to "no"; only a deliberate click on the confirm button is "yes".
 *
 *   `danger` is not decoration. Vermilion means irreversible everywhere in this
 *   console, so the variant is for actions that cannot be taken back — never
 *   for anything a second click could undo.
 */
export default function Modal({
  open,
  danger = false,
  title,
  question = 'Proceed?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}) {
  const panel = useRef(null);
  const restore = useRef(null);
  // Kept in a ref so the Escape listener below never goes stale against a
  // re-rendered handler while the dialog is open.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    if (!open) return undefined;

    restore.current = document.activeElement;
    // Focus the panel, not a control: see the note about Enter above. The
    // exception is a dialog that asks the operator to type something, which
    // marks its own field with data-autofocus.
    const first = panel.current?.querySelector('[data-autofocus]');
    (first || panel.current)?.focus();

    // The page behind must not scroll away under the dialog.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Escape is handled on the window as well as on the dialog: if focus ever
    // ends up somewhere unexpected, the way out must still work.
    const onEscape = (e) => {
      if (e.key === 'Escape') cancel.current?.();
    };
    window.addEventListener('keydown', onEscape);

    return () => {
      window.removeEventListener('keydown', onEscape);
      document.body.style.overflow = previous;
      // Put the caret back where it was, so cancelling costs the operator
      // nothing but the click. preventScroll because focus() otherwise scrolls
      // its target into view: the button that opened the dialog may be mid-way
      // through being removed by whatever was just confirmed, and closing a
      // dialog must never move the page under the next click.
      if (restore.current instanceof HTMLElement) restore.current.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel?.();
      return;
    }

    if (e.key === 'Enter') {
      // Only a button the operator has deliberately moved to may act on Enter,
      // and the focused button is never the confirm button unless they put it
      // there. Everything else swallows the keystroke.
      if (!(e.target instanceof HTMLButtonElement)) e.preventDefault();
      return;
    }

    if (e.key !== 'Tab') return;

    // Hold focus inside the dialog. Tabbing out and hitting Enter on whatever
    // was behind is exactly the accident this component exists to prevent.
    const items = Array.from(
      panel.current?.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'
      ) || []
    );
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const here = document.activeElement;
    if (e.shiftKey && (here === firstItem || here === panel.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && here === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      // mousedown rather than click: a click fires on the common ancestor, so a
      // text selection dragged out of the dialog would otherwise dismiss it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel?.();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className={`modal ${danger ? 'is-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        ref={panel}
      >
        <h2 className="modal-title" id="modal-title">
          {title}
        </h2>

        <div className="modal-body">{children}</div>

        {question && <p className="modal-question">{question}</p>}

        <div className="modal-foot">
          {/* Cancel first in the tab order and in reading order: the way out
              should be the thing found first. */}
          <button type="button" className="ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'danger' : ''}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/**
 * One labelled figure inside a dialog — the token, the amount, the count. These
 * are what the operator is meant to check, so they are laid out in a column and
 * given the tabular numerals every other number in this console gets, rather
 * than being run together into a sentence.
 */
export function Fact({ label, mono = false, children }) {
  return (
    <div className="modal-fact">
      <span>{label}</span>
      <b className={mono ? 'addr' : ''}>{children}</b>
    </div>
  );
}
