import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV3Backup } from './backup.js';

// A v3 role → the word the dialog uses for it.
const ROLE_WORD = { v3dev: 'treasury', v3main: 'main', v3bundle: 'bundle' };

/**
 * "Download backup" — V3 private keys, in one file, for the operator to keep
 * offline. V3's wallets only, never another tab's.
 *
 * V3 shipped without one, which is how a bundle wallet's key became reachable
 * only by SSH-ing into the keystore file. A backup is what makes a delete
 * survivable and a key recoverable once the shared archive evicts it — so V3
 * gets the same control v1, v2 and v4 already have.
 *
 * THREE SHAPES, ONE DIALOG:
 *   default        — every V3 key (treasury, main and bundle), the full backup.
 *   { role }       — one panel's wallets only (the per-panel export).
 *   { walletIds }  — exactly the wallets named (the bundle table's "export
 *                    selected"); the button greys out when nothing is selected.
 *
 * The typed confirmation guards all three: this hands over live keys, and a
 * mis-click should not be enough to do it.
 */
export default function V3BackupControls({
  count,
  report,
  role = null,
  walletIds = null,
  label = 'Download backup',
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const selecting = Array.isArray(walletIds);
  const roleWord = role ? ROLE_WORD[role] || role : null;

  async function run() {
    setBusy(true);
    try {
      report(await downloadV3Backup(selecting ? { walletIds } : role ? { role } : {}));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const title = selecting
    ? `This downloads the PRIVATE KEY of ${count} selected V3 wallet${count === 1 ? '' : 's'}.`
    : role
      ? `This downloads the PRIVATE KEY of ${count} V3 ${roleWord} wallet${count === 1 ? '' : 's'}.`
      : `This downloads the PRIVATE KEY of all ${count} V3 wallets.`;

  const scope = selecting
    ? 'It is only the wallets you selected — no other V3 wallet is in this file.'
    : role
      ? `It is V3's ${roleWord} wallet${count === 1 ? '' : 's'} only — no other V3 wallet, and never another tab's keys.`
      : "It is V3's wallets only — treasury, main and bundle — and never another tab's keys.";

  return (
    <>
      <Busy
        busy={busy}
        className="ghost"
        disabled={!count}
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
        title={title}
        question={null}
        confirmLabel="Download"
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          setOpen(false);
          run();
        }}
        onCancel={() => setOpen(false)}
      >
        <p>Anyone who opens that file can spend every one of them. {scope}</p>
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
