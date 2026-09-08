import { useState } from 'react';
import { downloadBackup } from '../api.js';
import { Busy } from './Section.jsx';
import Modal from './Modal.jsx';
import { resolveBackupScope, tierWord } from './backupScope.js';

/**
 * "Download backup" — the v1/v2 tab's private keys, in one file, for the
 * operator to keep offline. THIS TAB'S WALLETS ONLY, never another tab's.
 *
 * It used to write the WHOLE KEYSTORE. The route it posts to answered with
 * `ks.exportAll()`, so a backup taken beside the v1 bundle carried the keys to
 * V3, V4, V5, V6, V7 and V8 as well — a file taken to move one bundle held
 * everything this launcher has ever held. Every other tab hit exactly this and
 * scoped its own export (V3BackupControls, V4BackupControls, V5BackupControls);
 * this is v1/v2 finally doing the same, against a route that is scoped now too.
 *
 * ITS OWN COMPONENT BECAUSE IT BELONGS IN MORE THAN ONE PLACE, which is why it
 * existed before this and is unchanged: a backup is the thing that makes a
 * delete survivable, so it is drawn wherever a wallet can be deleted — step 1
 * for the dev wallet, step 3 for the bundle. What HAS changed is that each of
 * those places now takes the keys it is standing in front of.
 *
 * THREE SHAPES, ONE DIALOG — the same three /api/wallets/backup accepts:
 *   default        — the whole tab: its dev wallet and its bundle wallets.
 *   { role }       — one tier only (the dev wallet, or the bundle wallets).
 *   { walletIds }  — exactly the rows ticked in step 3's table.
 * The dialog states the exact count and the exact tier every time, because the
 * count is the only thing that tells an operator which file they are holding.
 *
 * CSV MOVED INSIDE THE DIALOG. It used to be a second trigger ("as CSV") beside
 * the button; with three scopes drawn per panel that would be six controls in a
 * row for one action. It is a box in a dialog the operator has to read anyway.
 *
 * The typed confirmation is deliberately not a click-through: this hands over
 * live private keys, and a mis-click should not be enough to do it.
 *
 *   wallets    the console's full list — this filters it to the tab itself, so
 *              the call sites do not each have to remember to.
 *   variant    'v1' | 'v2' — which tab's wallets these are.
 *   role       one tier only (roles.dev or roles.bundle).
 *   walletIds  exactly these ids (step 3's ticked rows). Wins over role.
 */
export default function BackupControls({
  wallets,
  report,
  variant = 'v1',
  role = null,
  walletIds = null,
  label = 'Download backup',
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [csv, setCsv] = useState(false);

  const { kind, wallets: covered, tabCount } = resolveBackupScope(wallets, {
    variant,
    role,
    walletIds,
  });
  const count = covered.length;
  const tab = variant.toUpperCase();
  const word = tierWord(role, variant);
  const plural = count === 1 ? '' : 's';

  async function run(format) {
    setBusy(true);
    try {
      report(await downloadBackup({ variant, role, walletIds, format }));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  const title =
    kind === 'selected'
      ? `This downloads the PRIVATE KEY of ${count} selected ${tab} wallet${plural}.`
      : kind === 'role'
        ? `This downloads the PRIVATE KEY of ${count} ${tab} ${word} wallet${plural}.`
        : `This downloads the PRIVATE KEY of all ${count} ${tab} wallet${plural}.`;

  // Exactly which keys are in the file, said in the file's own terms. Every
  // branch ends on the same promise, because it is the one the old control
  // broke: no other tab's keys.
  const scope =
    kind === 'selected'
      ? `It is only the ${count} wallet${plural} you ticked — ${tabCount - count} other ${tab} wallet(s) are NOT in this file, and never another tab's keys.`
      : kind === 'role'
        ? word === 'dev'
          ? `It is ${tab}'s dev wallet only — no bundle wallets, and never another tab's keys.`
          : `It is ${tab}'s bundle wallets only — the dev wallet is not in this file, and never another tab's keys.`
        : `It is ${tab}'s wallets only — its dev wallet and its bundle wallets — and never another tab's keys. V3–V8 keys are not in this file.`;

  return (
    <>
      {/* .ghost, never .spend: an export moves no money. It is the most
          dangerous button on the panel and still not a spending one — the
          vermilion is spent in the dialog, where the consequence is. */}
      <Busy
        busy={busy}
        className="ghost"
        disabled={!count}
        onClick={() => {
          setTyped('');
          setCsv(false);
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
        confirmLabel={csv ? 'Download CSV' : 'Download'}
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          const format = csv ? 'csv' : 'json';
          setOpen(false);
          run(format);
        }}
        onCancel={() => setOpen(false)}
      >
        <p>Anyone who opens that file can spend every one of them. {scope}</p>
        <label className="modal-check">
          <input type="checkbox" checked={csv} onChange={(e) => setCsv(e.target.checked)} />
          <span>
            Write it as CSV instead of JSON — one row per wallet, for checking a column of addresses
            in a spreadsheet. The keys are in it either way.
          </span>
        </label>
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
