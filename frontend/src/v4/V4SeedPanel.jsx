import { useState } from 'react';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import V4BackupControls from './V4BackupControls.jsx';
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
  // The wallet a delete is being asked about, or null. The whole record rather
  // than an id, so the dialog can say whether a campaign already funded it —
  // which is what decides whether deleting is tidying up or throwing away three
  // days of aging.
  const [deleting, setDeleting] = useState(null);
  // Ticked ids for a bulk delete, and the frozen list the confirmation is
  // asking about. Frozen at the moment the dialog opens so the count on screen
  // is the count that runs — the table behind it re-polls while it is open.
  const [ticked, setTicked] = useState([]);
  const [bulk, setBulk] = useState(null);
  const [progress, setProgress] = useState('');

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
  // What step 3 will actually work from. `claimed` means some campaign holds
  // the wallet, in any state — so this is the count a batch can still divide.
  const unclaimed = wallets.filter((w) => !w.claimed);
  const funded = wallets.filter((w) => facts[w.id]?.status === 'sent').length;
  // Intersected with what is still on screen, so a wallet deleted or claimed
  // since it was ticked cannot be carried into the next run by a stale id.
  const tickedHere = wallets.filter((w) => ticked.includes(w.id));

  /**
   * Delete the ticked wallets, one request each.
   *
   * ONE AT A TIME AND CARRYING ON PAST FAILURES. The server refuses a wallet a
   * live campaign still owes a transfer to, and that refusal is per wallet —
   * stopping the run on the first one would leave an operator to work out which
   * of ninety-nine were done. Each failure is counted and the first reason is
   * reported, which is the one an operator can act on: they are almost always
   * the same reason.
   *
   * Sequential rather than parallel because every delete rewrites the whole
   * keystore file (see MAX_GENERATE's note in routes/v4.js) — a hundred
   * concurrent writes would be a hundred full rewrites racing each other.
   */
  async function deleteTicked(list) {
    let done = 0;
    const failures = [];
    for (const w of list) {
      setProgress(`deleting ${done + 1} of ${list.length}…`);
      try {
        await api(`/v4/wallets/${w.id}`, 'DELETE');
        done++;
      } catch (err) {
        failures.push(err.message);
      }
    }
    setProgress('');
    setTicked([]);
    const refused = failures.length ? ` ${failures.length} refused: ${failures[0]}` : '';
    return `Archived ${done} seed wallet(s).${refused}`;
  }

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
        {/* One implementation, drawn here and in step 1 beside the funding
            wallets' deletes — see the header of V4BackupControls for why a
            backup belongs wherever a wallet can be deleted. */}
        <V4BackupControls masters={masters} seeds={wallets} report={report} reload={reload} />
        <span className="spacer" />
        <span className="hint">
          {MAX_GENERATE} at a time is the ceiling — the keystore is rewritten in full for every
          wallet added, and a bigger call blocks the server for every other tab. Run it again for
          more.
        </span>
      </div>

      {/* THE FOUR NUMBERS THAT DECIDE THE NEXT ACTION, and the reason they are
          up here rather than left to be counted off the table: how many exist
          is not the number step 3 works from. A campaign takes the UNCLAIMED
          ones, so an operator reading "100 wallets" off a table where sixty are
          already spoken for will size the next batch wrong. Funded is what has
          actually landed; unclaimed is what the next campaign can still use. */}
      {wallets.length > 0 && (
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="hint">
            <b>{wallets.length}</b> seed wallet{wallets.length === 1 ? '' : 's'}
          </span>
          <span className="hint">
            · <b>{wallets.length - unclaimed.length}</b> claimed by a campaign
          </span>
          <span className="hint">
            · <b>{unclaimed.length}</b> free for the next one
          </span>
          <span className="hint">
            · <b>{funded}</b> funded
          </span>
          <span className="spacer" />
          {progress ? (
            <span className="hint">{progress}</span>
          ) : (
            tickedHere.length > 0 && (
              <Busy busy={busy === 'delete'} className="ghost" onClick={() => setBulk(tickedHere)}>
                Delete {tickedHere.length} selected
              </Busy>
            )
          )}
        </div>
      )}

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
                <th style={{ width: 32 }}>
                  {/* All-or-none for the page. Ticking every row by hand across
                      a hundred wallets is not a thing anyone does, and the
                      count beside the button says what it will act on. */}
                  <input
                    type="checkbox"
                    checked={ticked.length > 0 && ticked.length === wallets.length}
                    onChange={(e) => setTicked(e.target.checked ? wallets.map((w) => w.id) : [])}
                  />
                </th>
                <th>Address</th>
                <th className="num">Funded</th>
                <th>Campaign</th>
                <th>Funded at</th>
                <th className="num">Age</th>
                <th>Key</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => {
                const fact = facts[w.id];
                return (
                  <tr key={w.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={ticked.includes(w.id)}
                        onChange={() =>
                          setTicked((cur) =>
                            cur.includes(w.id) ? cur.filter((x) => x !== w.id) : [...cur, w.id]
                          )
                        }
                      />
                    </td>
                    <td>
                      {/* No href. These read as plain text with a copy button:
                          a table of a hundred addresses drawn as a hundred blue
                          links is noise, and the address is a label for a row
                          here rather than somewhere to navigate. The copy
                          button still carries the full value. */}
                      <Address value={w.address} />
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
                    <td className="num">
                      {/* Offered on every row, including claimed ones. The
                          server reads the campaigns and refuses a wallet one
                          still owes a transfer to, naming it — a rule this
                          table cannot evaluate, since `claimed` says a campaign
                          holds the wallet but not whether that campaign is
                          still live. Hiding the link on `claimed` would block
                          deleting wallets from a run that finished weeks ago. */}
                      <button className="link" onClick={() => setDeleting(w)}>
                        delete
                      </button>
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

      {/* A seed wallet is worth something only for having sat untouched since
          it was funded, so the dialog leads with what deleting actually throws
          away — the age, and the ETH already sent to it. The key is archived
          rather than destroyed, which is said plainly for the same reason it is
          in step 1: a dialog that implies irreversibility teaches an operator
          to distrust the one place it really is. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title={`Archive seed wallet ${deleting ? deleting.address.slice(0, 10) : ''}…?`}
        question={
          deleting && facts[deleting.id]?.status === 'sent'
            ? `A campaign already funded this wallet — ${eth(facts[deleting.id].amountEth)} ETH, ${deleting.ageDays} day(s) ago. Archiving throws that aging away; the ETH stays at the address and is reachable only by restoring the key.`
            : 'It has not been funded yet, so nothing is lost but the key itself — which is archived on the server, not destroyed. A campaign that still owes this wallet a transfer will refuse the delete.'
        }
        confirmLabel="Archive wallet"
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          act('delete', async () => {
            const out = await api(`/v4/wallets/${w.id}`, 'DELETE');
            return `Archived ${out.address}. Restore it with: npm run archive:restore ${out.address}`;
          });
        }}
        onCancel={() => setDeleting(null)}
      />

      {/* The bulk version, and the counts it leads with are the ones that
          decide whether this is tidying up or a mistake: how many of the
          selection a campaign already funded, and how much ETH is at those
          addresses. A hundred rows ticked at once is exactly where an
          unfunded-looking selection quietly contains a dozen seasoned wallets. */}
      <Modal
        open={Boolean(bulk)}
        danger
        title={`Archive ${bulk ? bulk.length : 0} seed wallet${bulk && bulk.length === 1 ? '' : 's'}?`}
        question={
          bulk && bulk.some((w) => facts[w.id]?.status === 'sent')
            ? `${bulk.filter((w) => facts[w.id]?.status === 'sent').length} of them have already been funded and have been aging since. Archiving throws that away; the ETH stays at those addresses and is reachable only by restoring the keys.`
            : 'None of them have been funded, so nothing is lost but the keys — which are archived on the server, not destroyed. Any a live campaign still owes a transfer to will be refused and left alone.'
        }
        confirmLabel={`Archive ${bulk ? bulk.length : 0} wallets`}
        onConfirm={() => {
          const list = bulk;
          setBulk(null);
          act('delete', () => deleteTicked(list));
        }}
        onCancel={() => setBulk(null)}
      />
    </Step>
  );
}
