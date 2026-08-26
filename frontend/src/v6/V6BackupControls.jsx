import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV6Backup } from './backup.js';

/**
 * "Download backup" — every V6 private key (treasury, main and bundle), in one
 * file, for the operator to keep offline. V6's wallets only, never another tab's.
 *
 * V6 shipped without one, which is how a bundle wallet's key became reachable
 * only by SSH-ing into the keystore file. A backup is what makes a delete
 * survivable and a key recoverable once the shared archive evicts it — so V6
 * gets the same control v1, v2 and v4 already have.
 *
 * The typed confirmation is deliberate: this hands over every key V6 holds, and
 * a mis-click should not be enough to do it.
 */
export default function V6BackupControls({ count, report }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  async function run() {
    setBusy(true);
    try {
      report(await downloadV6Backup());
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
        disabled={!count}
        onClick={() => {
          setTyped('');
          setOpen(true);
        }}
      >
        Download backup
      </Busy>

      <Modal
        open={open}
        danger
        title={`This downloads the PRIVATE KEY of all ${count} V6 wallets.`}
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
          Anyone who opens that file can spend every one of them. It is V6's wallets only — treasury,
          main and bundle — and never another tab's keys.
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
