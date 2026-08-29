import { useState } from 'react';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import { downloadV5Backup } from './backup.js';

/**
 * "Download backup" / "Export selected" — V5's private keys (the v5dev launcher
 * and its v5bundle wallets), in one file, for the operator to keep offline. V5's
 * wallets only, never another tab's.
 *
 * V5 shipped reaching for the shared BackupControls, which exports the WHOLE
 * keystore — every tab's keys in one file. This replaces that with V5's own
 * scoped export, the same control v3 and v4 already have, and adds the thing the
 * shared one cannot: an "export selected" that writes only the wallets ticked in
 * the list (see V5WalletsPanel's checkbox column).
 *
 * The typed confirmation is deliberate: this hands over live keys, and a
 * mis-click should not be enough to do it. Copied from V3BackupControls.
 *
 *   count       how many v5 wallets exist — the full backup's count and its gate.
 *   selectedIds the walletIds ticked in the list — the "export selected" set.
 */
export default function V5BackupControls({ count, selectedIds = [], report }) {
  const [busy, setBusy] = useState(false);
  // 'all' | 'selected' while the typed confirmation is open, '' otherwise, plus
  // whatever has been typed into it so far.
  const [asking, setAsking] = useState('');
  const [typed, setTyped] = useState('');

  const selectedCount = selectedIds.length;

  // Opens the typed confirmation. Nothing is exported from here.
  function ask(which) {
    setTyped('');
    setAsking(which);
  }

  async function run(which) {
    setBusy(true);
    try {
      // A selected export passes the ticked ids; a full export passes nothing, so
      // the backend writes every v5 wallet.
      report(await downloadV5Backup(which === 'selected' ? selectedIds : undefined));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const selected = asking === 'selected';

  return (
    <>
      <Busy busy={busy} className="ghost" disabled={!count} onClick={() => ask('all')}>
        Download backup
      </Busy>
      <button className="link" disabled={!selectedCount} onClick={() => ask('selected')}>
        Export selected{selectedCount ? ` (${selectedCount})` : ''}
      </button>

      <Modal
        open={Boolean(asking)}
        danger
        title={
          selected
            ? `This downloads the PRIVATE KEY of ${selectedCount} selected V5 wallet${selectedCount === 1 ? '' : 's'}.`
            : `This downloads the PRIVATE KEY of all ${count} V5 wallet${count === 1 ? '' : 's'}.`
        }
        question={null}
        confirmLabel={selected ? 'Download selected' : 'Download'}
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          const which = asking;
          setAsking('');
          run(which);
        }}
        onCancel={() => setAsking('')}
      >
        <p>
          Anyone who opens that file can spend every one of them. It is V5's wallets only — the
          launcher and its bundle — and never another tab's keys.
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
