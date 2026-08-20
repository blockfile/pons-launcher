import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV3Backup } from './backup.js';

/**
 * "Download backup" — every V3 private key (treasury, main and bundle), in one
 * file, for the operator to keep offline. V3's wallets only, never another tab's.
 *
 * V3 shipped without one, which is how a bundle wallet's key became reachable
 * only by SSH-ing into the keystore file. A backup is what makes a delete
 * survivable and a key recoverable once the shared archive evicts it — so V3
 * gets the same control v1, v2 and v4 already have.
 *
 * The typed confirmation is deliberate: this hands over every key V3 holds, and
 * a mis-click should not be enough to do it.
 */
export default function V3BackupControls({ count, report }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  async function run() {
    setBusy(true);
    try {
      report(await downloadV3Backup());
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
        title={`This downloads the PRIVATE KEY of all ${count} V3 wallets.`}
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
          Anyone who opens that file can spend every one of them. It is V3's wallets only — treasury,
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
