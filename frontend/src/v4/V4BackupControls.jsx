import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV4Backup } from './backup.js';

/**
 * "Download backup" — every V4 private key, in one file, for the operator to
 * keep offline.
 *
 * ITS OWN COMPONENT BECAUSE IT BELONGS IN MORE THAN ONE PLACE, which is the
 * reason components/BackupControls.jsx exists for the v1 tab and the argument
 * it makes there applies here unchanged:
 *
 *   "A backup is the thing that makes a delete survivable, so it is drawn
 *    wherever a wallet can be deleted."
 *
 * It lived only in step 2, beside the seed wallets, while step 1 grew a delete
 * on every funding wallet — the wallets that actually hold the ETH. An operator
 * standing in front of the row they are about to archive was being told the key
 * is recoverable from the server, with no way from there to the file that makes
 * that true when the archive later evicts it.
 *
 * THE FILE IS THE WHOLE OF V4 EITHER WAY, funders and seeds, whichever step it
 * was taken from — so the dialog counts both rather than letting the step it
 * was opened from imply a smaller scope.
 *
 * The typed confirmation is deliberately not a click-through: this hands over
 * every key V4 holds, and a mis-click should not be enough to do it.
 */
export default function V4BackupControls({
  masters,
  seeds,
  report,
  reload,
  label = 'Download backup',
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const exported = masters.length + seeds.length;

  async function run() {
    setBusy(true);
    try {
      report(await downloadV4Backup());
      // RELOAD, or the gate goes on refusing wallets it now has on record.
      // The server marks each exported wallet backed up as a side effect of
      // this download, so the "N wallets have no key backup" state the console
      // is drawing is stale the moment it succeeds — and the operator's next
      // move is the Start button that reads it.
      if (reload) await reload();
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
        disabled={!exported}
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
        title={`This downloads the PRIVATE KEY of all ${exported} V4 wallets.`}
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
          Anyone who opens that file can spend every one of them. It is V4's wallets only — all{' '}
          {masters.length} funding {masters.length === 1 ? 'wallet' : 'wallets'} and all{' '}
          {seeds.length} {seeds.length === 1 ? 'seed' : 'seeds'} — and never another tab's keys.
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
