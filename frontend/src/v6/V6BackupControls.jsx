import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV6Backup } from './backup.js';

/**
 * "Download backup" — V6 private keys in one file, for the operator to keep
 * offline. V6's wallets only, never another tab's.
 *
 * V6 shipped without one, which is how a bundle wallet's key became reachable
 * only by SSH-ing into the keystore file. A backup is what makes a delete
 * survivable and a key recoverable once the shared archive evicts it — so V6
 * gets the same control v1, v2 and v4 already have.
 *
 * THREE SHAPES, one typed-EXPORT confirmation for all of them:
 *   - the FULL backup (default): every V6 key — treasury, main and bundle.
 *   - a PER-PANEL backup (role set): only that panel's wallets, so the treasury
 *     or the bundle can be kept offline on its own.
 *   - a SELECTION backup (walletIds set): exactly the bundle rows that are
 *     ticked, and nothing else.
 *
 * The typed confirmation is deliberate: this hands over real keys, and a
 * mis-click should not be enough to do it.
 */
export default function V6BackupControls({
  count,
  report,
  label = 'Download backup',
  // When set, export only this V6 role. roleLabel is the human word for it, used
  // in the filename and the messages so a file opened months later says what it is.
  role = null,
  roleLabel = '',
  // When set (an array), export EXACTLY these wallet ids — the current selection.
  walletIds = null,
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const selecting = Array.isArray(walletIds);
  const exportCount = selecting ? walletIds.length : count;
  const scope = selecting
    ? `${exportCount} selected V6 ${exportCount === 1 ? 'wallet' : 'wallets'}`
    : roleLabel
      ? `${count} V6 ${roleLabel} ${count === 1 ? 'wallet' : 'wallets'}`
      : `all ${count} V6 wallets`;

  async function run() {
    setBusy(true);
    try {
      report(await downloadV6Backup({ role, roleLabel, walletIds: selecting ? walletIds : null }));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Busy
        busy={busy}
        className="ghost"
        disabled={!exportCount}
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
      >
        {label}
      </Busy>

      <Modal
        open={open}
        danger
        title={`This downloads the PRIVATE KEY of ${scope}.`}
        question={null}
        confirmLabel="Download"
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          setOpen(false);
          run();
        }}
        onCancel={() => setOpen(false)}
      >
        <p>
          Anyone who opens that file can spend every one of them. It is V6's wallets only
          {selecting
            ? ' — just the ones you selected — '
            : roleLabel
              ? ` — just the ${roleLabel} — `
              : ' — treasury, main and bundle — '}
          and never another tab's keys.
        </p>
        <label className="modal-type">
          Type EXPORT to continue.
          <input
            data-autofocus
            value={typed}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </Modal>
    </>
  );
}
