import { useState } from 'react';
import { downloadBackup } from '../api.js';
import { Busy } from './Section.jsx';
import Modal from './Modal.jsx';

/**
 * "Download backup" / "as CSV" — every private key the console holds, written
 * to one file for the operator to keep offline.
 *
 * Its own component because it belongs in more than one place. It used to sit
 * only in step 3, beside the bundle wallets, while BOTH delete dialogs told the
 * operator the wallet was "recoverable only from a backup already downloaded" —
 * naming, at the moment of deciding, a control that was not where they were
 * standing. A backup is the thing that makes a delete survivable, so it is
 * drawn wherever a wallet can be deleted: step 1 for the dev wallet, step 3 for
 * the bundle.
 *
 * The file is the WHOLE keystore either way, the dev wallet included, whichever
 * step it was taken from — the dialog counts the wallets so that is not a
 * surprise. `wallets` is therefore the full list, not the step's own slice.
 *
 * The typed confirmation is deliberately not a click-through: this hands over
 * every key the console holds, and a mis-click should not be enough to do it.
 */
export default function BackupControls({ wallets, report }) {
  const [busy, setBusy] = useState(false);
  // 'json' | 'csv' while the export confirmation is open, '' otherwise, plus
  // whatever has been typed into it so far.
  const [exporting, setExporting] = useState('');
  const [typed, setTyped] = useState('');

  // Opens the typed confirmation. Nothing is exported from here.
  function ask(format) {
    setTyped('');
    setExporting(format);
  }

  async function run(format) {
    setBusy(true);
    try {
      report(await downloadBackup(format));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Busy busy={busy} className="ghost" disabled={!wallets.length} onClick={() => ask('json')}>
        Download backup
      </Busy>
      <button className="link" disabled={!wallets.length} onClick={() => ask('csv')}>
        as CSV
      </button>

      <Modal
        open={Boolean(exporting)}
        danger
        title={`This downloads the PRIVATE KEY of all ${wallets.length} wallets.`}
        question={null}
        confirmLabel={exporting === 'csv' ? 'Download CSV' : 'Download'}
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          const format = exporting;
          setExporting('');
          run(format);
        }}
        onCancel={() => setExporting('')}
      >
        <p>Anyone who opens that file can spend every one of them.</p>
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
