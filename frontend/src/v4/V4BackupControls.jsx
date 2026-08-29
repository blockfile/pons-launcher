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
 * THE FULL BACKUP IS THE WHOLE OF V4, funders and seeds, whichever step it was
 * taken from — so the dialog counts both. A FILTERED export (a named seed set, or
 * an age filter) is narrower on purpose: it defaults to SEEDS ONLY and offers a box
 * to add the funders back, so a file taken to move a few seeds elsewhere does not
 * carry every funder's key unless the operator asks for it.
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
  // When set, the age is FIXED and the field is not offered. That is the
  // difference between the two exports: the backup is a safety net and takes
  // everything, so its filter is optional and starts blank; the usable export
  // exists to answer one question — what can I spend today — and a filter an
  // operator has to remember to type is not an answer.
  fixedMinAge = 0,
  // When set, this exports EXACTLY these seed ids (plus the funders the server
  // always adds), not an age filter over every seed on the page. This is the
  // per-section export: "the usable wallets in THIS pool". A withdrawn seed is
  // never in the set, so it can't be re-exported from another section's button.
  exportIds = null,
  // When set, this exports ONLY the funding wallets — no seeds at all. They hold
  // the ETH with no seed phrase behind them, so backing up just that tier (offline,
  // on its own) is its own need. No age filter, no seed selection, no checkbox.
  fundersOnly = false,
  // Optional follow-on run ONLY after a SUCCESSFUL export (after the file downloads
  // and the reload lands). This is what makes the combined "Export & Withdraw" button:
  // withdraw is defined as "keys exported, held out of the pool", so it is safe to set
  // a wallet aside precisely once its key is in a file — never before. A failed export
  // throws first, so afterExport never runs on a wallet whose key was not saved.
  afterExport = null,
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  // Blank means every wallet. A number means only seeds that have been sitting
  // at least that long — see the note beside the field for what it is for.
  const [minAge, setMinAge] = useState('');
  // Whether the funding wallets ride along. They hold the ETH and there is no seed
  // phrase behind them, so the FULL backup always takes them — but a filtered export
  // (a named set, or an age filter) is usually taken to move a few seeds elsewhere and
  // should NOT carry every funder's key unless asked, so it defaults to leaving them out.
  const [includeFunders, setIncludeFunders] = useState(false);

  const selecting = !fundersOnly && Array.isArray(exportIds);
  const exported = fundersOnly ? masters.length : masters.length + seeds.length;
  const age = selecting || fundersOnly ? 0 : fixedMinAge || Math.max(0, Math.round(Number(minAge) || 0));
  const isFiltered = !fundersOnly && (selecting || age > 0);
  // The full (unfiltered) backup always includes the funders; a filtered one obeys the box.
  const funderIn = isFiltered ? includeFunders : true;
  const funderCount = funderIn ? masters.length : 0;
  // Counted from each wallet's OWN funding, which is the only reading that is
  // useful: a wallet funded on the campaign's last day is young on the day the
  // campaign finishes, however old the run is. When a set is named it is exact —
  // those seeds, plus the funders only if the box is ticked.
  const wouldExport = fundersOnly
    ? masters.length
    : selecting
      ? funderCount + exportIds.length
      : age
        ? funderCount + seeds.filter((w) => (w.daysSinceFunded ?? -1) >= age).length
        : exported;

  async function run() {
    setBusy(true);
    try {
      report(
        await downloadV4Backup(
          fundersOnly
            ? { fundersOnly: true }
            : selecting
              ? { walletIds: exportIds, includeFunders: funderIn }
              : { minAgeDays: age || undefined, includeFunders: funderIn }
        )
      );
      // RELOAD, or the gate goes on refusing wallets it now has on record.
      // The server marks each exported wallet backed up as a side effect of
      // this download, so the "N wallets have no key backup" state the console
      // is drawing is stale the moment it succeeds — and the operator's next
      // move is the Start button that reads it.
      if (reload) await reload();
      // Only now, with the keys in a file, run any follow-on (the combined
      // Export & Withdraw). Kept inside the try so a failed export never withdraws.
      if (afterExport) await afterExport();
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
        disabled={selecting ? !wouldExport : !exported}
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
          fundersOnly
            ? `This downloads the PRIVATE KEY of ${masters.length} funding ${masters.length === 1 ? 'wallet' : 'wallets'}.`
            : age || selecting
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
          Anyone who opens that file can spend every one of them. These are V4's wallets only, never
          another tab's keys.{' '}
          {fundersOnly
            ? `It is the ${masters.length} funding ${masters.length === 1 ? 'wallet' : 'wallets'} only — no seeds. These are the wallets that hold the ETH.`
            : isFiltered
              ? funderIn
                ? 'This is a filtered export — the seeds below, plus the funding wallets.'
                : 'This is a filtered export of SEEDS only — no funding wallets are in this file.'
              : `It is all ${masters.length} funding ${masters.length === 1 ? 'wallet' : 'wallets'} and all ${seeds.length} ${seeds.length === 1 ? 'seed' : 'seeds'}.`}
        </p>
        {/* THE FILE'S REAL PROBLEM, NOT A CONVENIENCE. Every seed carries
            fundedAt and daysSinceFunded now, but a hundred keys in one file is
            still how an operator reaches for one funded yesterday believing the
            batch is a week old. Age is per wallet and counted from its own
            funding: in a five-day campaign the last day's wallets are three
            days behind the first day's, forever. Filtering here means the file
            you open on the day contains only what is safe to spend that day. */}
        {!fixedMinAge && !selecting && !fundersOnly && (
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
        )}
        {selecting ? (
          <p className="hint">
            <b>{exportIds.length}</b> seed wallet(s) from this section
            {funderIn
              ? masters.length === 1
                ? ', plus the funding wallet'
                : `, plus all ${masters.length} funding wallets`
              : ' — no funding wallets'}
            . Only these go in the file — nothing from the other sections. Exporting marks these
            wallets backed up.
          </p>
        ) : (
          age > 0 && (
            <p className="hint">
              <b>{wouldExport}</b> of {exported} — {seeds.length - (wouldExport - funderCount)} seed
              wallet(s) are younger than {age} day{age === 1 ? '' : 's'} and will be left out
              {funderIn ? '. Funding wallets are included' : ', and no funding wallets are in this file'}.
              Leaving wallets out does not mark them backed up, so step 3 will still refuse a campaign
              covering them.
            </p>
          )
        )}

        {/* Off by default on a filtered export: that file is usually taken to move a
            few seeds elsewhere, and it should not carry every funder's key unless the
            operator ticks this. The full backup takes them regardless and never shows
            this box. */}
        {isFiltered && (
          <label className="modal-check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
            <input
              type="checkbox"
              checked={includeFunders}
              onChange={(e) => setIncludeFunders(e.target.checked)}
              style={{ width: 'auto', marginTop: 3 }}
            />
            <span>
              Also include the {masters.length} funding {masters.length === 1 ? 'wallet' : 'wallets'} in
              this file. They hold the ETH, so they belong in your full backup — not in every file you
              take a few seeds out in.
            </span>
          </label>
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
