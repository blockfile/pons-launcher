import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { downloadV4Backup } from './backup.js';
import { MAX_GENERATE, ROLES, clock, eth } from './roles.js';

/**
 * Step 2 — the seed wallets, and the backup that has to exist before any of
 * them is worth funding.
 *
 * A seed wallet receives exactly one transfer and then sits. That is the whole
 * of its job: what makes it useful is the funding edge NOT looking like four
 * hundred wallets filled from one address on one afternoon, so generating them
 * costs nothing and only the campaign in step 3 is slow.
 *
 * THE BACKUP IS NOT PAPERWORK. These keys have no mnemonic behind them — they
 * are random keys in one encrypted file on one machine, and a campaign is about
 * to send real ETH to every one of them over three weeks. Lose the file before
 * the keys have been exported and every wei is gone with it, so the backend
 * refuses to start a campaign until each wallet in the plan is on record. This
 * panel is where that record is made, which is why it sits beside the generate
 * button and not on some settings page.
 *
 * The typed confirmation is copied from BackupControls, and for the same
 * reason: this hands over every key the tab holds, and a mis-click must not be
 * enough to do it.
 */
export default function V4SeedPanel({ step, wallets, masters, facts, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(50);
  // Whatever has been typed into the export confirmation, and whether it is
  // open. Nothing is downloaded until the word matches.
  const [exporting, setExporting] = useState(false);
  const [typed, setTyped] = useState('');

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Clamped where it is typed, not where it is sent: the field must never offer
  // a number the server has already decided to refuse.
  const wanted = Math.min(MAX_GENERATE, Math.max(1, Math.round(Number(count) || 0)));
  const unprotected = wallets.filter((w) => !w.backedUp);

  /**
   * How many keys the download actually contains: BOTH of V4's roles.
   *
   * The route exports onlyV4Wallets(exportAll()), and isV4Role accepts v4master
   * as well as v4seed — so the file carries the funding wallets too, and this
   * panel's own `wallets` prop is only the seeds. Counting the slice this step
   * happens to draw is the exact mistake BackupControls documents having
   * already made once: the dialog has to count what the file will hold, or the
   * number in the title is a smaller promise than the file keeps.
   *
   * It is also what the button is enabled on. An operator who has created a
   * funding wallet and no seeds yet must still be able to back that key up —
   * it is the one holding the ETH, and the route would export it happily.
   */
  const exported = masters.length + wallets.length;

  return (
    <Step {...step}>
      <p className="lede">
        Fresh wallets, one transfer each. Generate however many the strategy wants — they cost
        nothing until a campaign starts feeding them, and the campaign is what takes weeks.
      </p>

      <div className="row">
        <input
          type="number"
          min="1"
          max={MAX_GENERATE}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 90 }}
        />
        <Busy
          busy={busy === 'generate'}
          onClick={() =>
            act('generate', () =>
              api('/v4/wallets/generate', 'POST', {
                count: wanted,
                role: ROLES.seed,
                label: 'v4 seed',
              })
            )
          }
        >
          Generate wallets
        </Busy>
        <Busy
          busy={busy === 'backup'}
          className="ghost"
          disabled={!exported}
          onClick={() => {
            setTyped('');
            setExporting(true);
          }}
        >
          Download backup
        </Busy>
        <span className="spacer" />
        <span className="hint">
          {MAX_GENERATE} at a time is the ceiling — the keystore is rewritten in full for every
          wallet added, and a bigger call blocks the server for every other tab. Run it again for
          more.
        </span>
      </div>

      {/* The gate, stated before it is hit rather than only as a refusal. Step 3
          will not start a campaign while this count is above zero. */}
      {unprotected.length > 0 && (
        <div className="notice warn">
          <h3>
            <span className="tally">{unprotected.length}</span> of {wallets.length} have no key
            backup on record
          </h3>
          <p>
            <span className="crux">
              There is no seed phrase behind these keys — they exist in one encrypted file and
              nowhere else.
            </span>{' '}
            A campaign will not start until every wallet in its plan has been exported at least
            once. Download the backup above and keep it offline.
          </p>
        </div>
      )}

      {wallets.length === 0 ? (
        <div className="notice">
          <h3>No seed wallets yet</h3>
          <p>
            These are the wallets a campaign funds. Generate them first, back their keys up, and
            step 3 will plan a schedule across all of them.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th className="num">Funded</th>
                <th>Campaign</th>
                <th>Funded at</th>
                <th className="num">Age</th>
                <th>Key</th>
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => {
                const fact = facts[w.id];
                return (
                  <tr key={w.id}>
                    <td>
                      <Address
                        value={w.address}
                        href={explorer ? `${explorer}/address/${w.address}` : ''}
                      />
                    </td>
                    <td className="num">
                      {!fact ? (
                        '—'
                      ) : fact.status === 'sent' ? (
                        eth(fact.amountEth)
                      ) : fact.status === 'abandoned' ? (
                        <span className="bal short">abandoned</span>
                      ) : (
                        <span className="hint">{eth(fact.amountEth)} due</span>
                      )}
                    </td>
                    <td>
                      {fact ? (
                        <>
                          {fact.campaign} <span className="hint">· day {fact.day}</span>
                        </>
                      ) : w.claimed ? (
                        <span className="hint">claimed</span>
                      ) : (
                        <span className="hint">unclaimed</span>
                      )}
                    </td>
                    <td>
                      {fact?.sentAt ? (
                        clock(fact.sentAt)
                      ) : fact?.dueAt ? (
                        <span className="hint">due {clock(new Date(fact.dueAt).toISOString())}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{w.ageDays}d</td>
                    <td>
                      <span className={`fund-state ${w.backedUp ? 'is-in' : 'is-part'}`}>
                        {w.backedUp ? 'backed up' : 'no backup'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Said once, under the table, because the column heading cannot carry
              it: "Funded" is the amount the PLAN sent, not a balance read back
              off chain. A seed wallet receives one transfer and then sits, so
              for an untouched wallet the two are the same figure — and reading
              several hundred balances back on every poll would buy nothing for
              hundreds of RPC calls a minute. Age is counted from the moment the
              key was created, which is what "how long has this wallet existed"
              means to anything looking at it from outside. */}
          <p className="hint">
            Funded is what the campaign sent, not a balance read back — these wallets receive once
            and are not spent from here. Age counts from when the key was made.
          </p>
        </div>
      )}

      <Modal
        open={exporting}
        danger
        title={`This downloads the PRIVATE KEY of all ${exported} V4 wallets.`}
        question={null}
        confirmLabel="Download"
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          setExporting(false);
          act('backup', downloadV4Backup);
        }}
        onCancel={() => setExporting(false)}
      >
        <p>
          Anyone who opens that file can spend every one of them. It is V4's wallets only — all{' '}
          {masters.length} funding {masters.length === 1 ? 'wallet' : 'wallets'} and all{' '}
          {wallets.length} {wallets.length === 1 ? 'seed' : 'seeds'} — and never another tab's keys.
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
    </Step>
  );
}
