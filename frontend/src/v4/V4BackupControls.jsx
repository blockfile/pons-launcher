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
  // Blank means every wallet. A number means only seeds that have been sitting
  // at least that long — see the note beside the field for what it is for.
  const [minAge, setMinAge] = useState('');

  const exported = masters.length + seeds.length;
  const age = Math.max(0, Math.round(Number(minAge) || 0));
  // Counted from each wallet's OWN funding, which is the only reading that is
  // useful: a wallet funded on the campaign's last day is young on the day the
  // campaign finishes, however old the run is.
  const wouldExport = age
    ? masters.length + seeds.filter((w) => (w.daysSinceFunded ?? -1) >= age).length
    : exported;

  async function run() {
    setBusy(true);
    try {
      report(await downloadV4Backup(age || undefined));
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
        title={
          age
            ? `This downloads the PRIVATE KEY of ${wouldExport} V4 wallets.`
            : `This downloads the PRIVATE KEY of all ${exported} V4 wallets.`
        }
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
        {/* THE FILE'S REAL PROBLEM, NOT A CONVENIENCE. Every seed carries
            fundedAt and daysSinceFunded now, but a hundred keys in one file is
            still how an operator reaches for one funded yesterday believing the
            batch is a week old. Age is per wallet and counted from its own
            funding: in a five-day campaign the last day's wallets are three
            days behind the first day's, forever. Filtering here means the file
            you open on the day contains only what is safe to spend that day. */}
        <label className="modal-type">
          Only seed wallets funded at least this many days ago — blank for all
          <input
            type="number"
            min="0"
            placeholder="all"
            value={minAge}
            onChange={(e) => setMinAge(e.target.value)}
          />
        </label>
        {age > 0 && (
          <p className="hint">
            <b>{wouldExport}</b> of {exported} — {seeds.length - (wouldExport - masters.length)} seed
            wallet(s) are younger than {age} day{age === 1 ? '' : 's'} and will be left out. Funding
            wallets are always included; they are plumbing, not aged. Leaving wallets out does not
            mark them backed up, so step 3 will still refuse a campaign covering them.
          </p>
        )}

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
