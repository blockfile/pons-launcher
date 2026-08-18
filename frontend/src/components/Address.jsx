import { useEffect, useRef, useState } from 'react';
import { LuCheck, LuCopy } from 'react-icons/lu';
import { notify } from '../api.js';
import { shortAddress } from '../format.js';

/**
 * Put `text` on the clipboard. Resolves TRUE only if it actually landed.
 *
 * The return value is the point of this function. `navigator.clipboard` is not
 * merely non-functional outside a secure context, it is absent — open this
 * console over a LAN http:// address and an unguarded writeText throws rather
 * than fails — and even where it exists it rejects on a denied permission or an
 * unfocused document. A handler that fired its "copied" toast without awaiting
 * and checking would tell the operator the address was copied while the
 * clipboard still held the PREVIOUS one, which is the shape of this feature
 * that loses money: the wrong address pasted into a withdrawal.
 */
export async function copyToClipboard(text) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {
    // Permission denied, or the document was not focused. Try the old path.
  }

  // execCommand('copy') is deprecated but is the only thing that works on an
  // insecure origin, and it copies the current SELECTION — so the value has to
  // be in a real, selectable node. Off-screen via opacity, not display:none or
  // visibility:hidden: an unrendered field cannot be selected and the copy
  // silently does nothing. setSelectionRange as well as select() because iOS
  // Safari ignores select() on its own.
  try {
    const prev = document.activeElement;
    const field = document.createElement('textarea');
    field.value = String(text);
    field.readOnly = true;
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, String(text).length);
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    if (prev && typeof prev.focus === 'function') prev.focus();
    return ok === true;
  } catch {
    return false;
  }
}

/**
 * An address in a scanning table: shortened text, plus a copy button that
 * copies the whole thing.
 *
 * Used where a row is READ — the wallet table, the sell receipts, the disperser
 * list, activity's contract links. Never inside a confirmation dialog and never
 * beside "send ETH to this address": those are verification moments, and a
 * shortened address is exactly the check a poisoned lookalike is built to pass.
 * See shortAddress in format.js.
 *
 * `value` is the full address and every affordance here is fed from it — the
 * title, the accessible name and the clipboard write all take the prop. Nothing
 * reads textContent, which is the classic way this component ends up copying
 * "0x89F6bE…9De281", ellipsis included, into a withdrawal form.
 *
 * `href` turns the text into an explorer link; the href always carries the full
 * address, only the link TEXT is shortened.
 */
/**
 * `plain` keeps the href and drops the link styling — see a.addr-text.is-plain
 * in styles.css. For tables where every row carries an address: the blue
 * underline on a hundred rows is noise, and the address is a label for the row
 * rather than the thing a reader came to click. Hovering still shows it.
 */
export default function Address({
  value,
  href,
  lead,
  tail,
  full = false,
  plain = false,
  className = '',
}) {
  // A brief tick on the button itself. The toast is the confirmation of record
  // — it restates the full address, so the copy is confirmed by a second read
  // of the whole string — and this is just the acknowledgement at the point of
  // the click, where the eye already is.
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  if (!value) return null;

  async function copy() {
    const ok = await copyToClipboard(value);
    if (!ok) {
      // Never swallowed: an operator who thinks they copied an address and did
      // not is worse off than one who is told to select it by hand.
      notify('Could not copy — select the address and press Ctrl+C', 'error');
      return;
    }
    notify(`Address copied — ${value}`, 'ok');
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }

  // `full` is for the addresses an operator SENDS TO rather than scans past —
  // the dev wallet being the one this console cannot fund itself, so its address
  // is read off the screen and pasted into an exchange. Those keep all forty-two
  // characters, for the reason every Modal does: a shortened address is the
  // exact check a poisoned lookalike is mined to pass. The copy button is the
  // point of using this component there.
  const text = full ? value : shortAddress(value, lead, tail);

  return (
    <span className={`addr-cell ${className}`.trim()}>
      {href ? (
        <a
          className={`addr-text ${plain ? 'is-plain' : ''}`.trim()}
          href={href}
          target="_blank"
          rel="noreferrer"
          title={value}
        >
          {text}
        </a>
      ) : (
        <span className="addr-text" title={value}>
          {text}
        </span>
      )}
      {/* The hover title is a convenience and not the reachability guarantee —
          it does not exist on touch and does not open on keyboard focus. What
          makes the truncation safe is this button and the full address in the
          confirmation dialogs. */}
      <button
        type="button"
        className={`addr-copy ${copied ? 'is-copied' : ''}`}
        title={`copy ${value}`}
        aria-label={`copy address ${value}`}
        onClick={copy}
      >
        {copied ? <LuCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
      </button>
    </span>
  );
}
