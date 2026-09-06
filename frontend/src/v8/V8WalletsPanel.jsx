import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import V8BackupControls from './V8BackupControls.jsx';
import { MAX_GENERATE, ROLES, ageDays, eth, plural } from './roles.js';

// A column header that also acts as a sort control, drawn to read as the plain
// header text it replaces — the table gains sorting without gaining a row of
// buttons. A real <button> rather than a click handler on the <th> so the
// ordering is reachable from the keyboard. Inline rather than a stylesheet class
// for the same reason V4SeedPanel keeps its copy inline: the change stays inside
// this tab's own file.
const sortHeaderStyle = {
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

/**
 * Step 2 — the destination wallets.
 *
 * THREE WAYS IN, and they are three different provenances rather than three
 * buttons doing the same thing: generate fresh keys, import keys the operator
 * already holds, or claim aged wallets out of the V4 seasoning pool. A seasoned
 * wallet has been sitting since it was funded weeks ago, so it reads as organic
 * where a batch generated this afternoon reads as a batch.
 *
 * THERE IS NO 31-WALLET CAP HERE, unlike v1 and v2. That number is the length
 * of the pons factory's snipe-tax exemption list and binds only at a launch.
 * V8 never launches — it is a mover, not a launcher — so the only ceiling is
 * MAX_GENERATE, which is how many keys ONE request may make, not how many
 * wallets this tab may hold. Press it again for more.
 *
 * NOTHING HERE SPENDS, so nothing here is amber. Wallets cost nothing until
 * step 3 pays them.
 */
export default function V8WalletsPanel({ step, wallets, explorer, reload, report, locked, backupCount }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(20);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [importLabel, setImportLabel] = useState('');
  // The wallet a delete is being asked about, or null — the whole record rather
  // than an id, so the dialog can state the balance that decides whether this is
  // tidying up or throwing ETH away.
  const [deleting, setDeleting] = useState(null);
  // Ticked ids for a bulk delete or a selection export, and the frozen list the
  // confirmation asks about — frozen when the dialog opens so the count on
  // screen is the count that runs even as the table re-polls behind it.
  const [ticked, setTicked] = useState([]);
  const [bulk, setBulk] = useState(null);
  const [progress, setProgress] = useState('');
  // Free-text filter over the table. It narrows what is DRAWN only: the counts
  // above still describe the whole set, and a selection made before a search was
  // typed survives it.
  const [search, setSearch] = useState('');
  // How the rows are ordered. null = the order the backend returned, so an
  // untouched table is exactly what it was before this control existed.
  // Otherwise { key: 'created' | 'age', dir: 'asc' | 'desc' }.
  const [sort, setSort] = useState(null);
  // V4's seasoned seed wallets ready to be handed over to this tab.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(20);

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

  // Read-only background poll of the V4 pool. Quiet on failure: an unreachable
  // or empty V4 should leave this at 0, not raise an error in a panel that has
  // nothing to do with it.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api('/v4/seasoned')
        // Defaulted rather than trusted: this reads a field off whatever comes
        // back, on a timer, and a null body would throw in the render rather
        // than here — where it would be a status line taking the tab down.
        .then((s) => alive && setSeasoned(s || { count: 0 }))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  /** Hand N seasoned V4 seed wallets over to this tab (re-roled server-side to v8bundle). */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/v8/wallets/claim-seasoned', 'POST', { count: n });
      const claimed = out.claimed?.length ?? 0;
      report(
        out.available === 0
          ? 'claimed 0 — none available, season some in the V4 tab first'
          : out.shortfall > 0
            ? `claimed ${plural(claimed, 'seasoned wallet')}, ${out.shortfall} short — only ${out.available} were ready`
            : `claimed ${plural(claimed, 'seasoned wallet')}`
      );
      await reload();
      try {
        setSeasoned((await api('/v4/seasoned')) || { count: 0 });
      } catch {
        // Background read — see the mount-time poll above for why this is quiet.
      }
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /**
   * Delete the ticked wallets, one request each, carrying on past failures.
   *
   * Sequential rather than parallel because every delete rewrites the whole
   * keystore file — a hundred concurrent writes would be a hundred full
   * rewrites racing each other. A refusal is per wallet, so stopping on the
   * first one would leave an operator to work out which of ninety-nine were
   * done; each failure is counted and the first reason reported, which is the
   * one they can act on.
   */
  async function deleteTicked(list) {
    let done = 0;
    const failures = [];
    for (const w of list) {
      setProgress(`deleting ${done + 1} of ${list.length}…`);
      try {
        await api(`/v8/wallets/${w.id}`, 'DELETE');
        done += 1;
      } catch (err) {
        failures.push(err.message);
      }
    }
    setProgress('');
    setTicked([]);
    const refused = failures.length ? ` ${failures.length} refused: ${failures[0]}` : '';
    return `Deleted ${done} destination wallet(s).${refused}`;
  }

  // Clamped where it is typed, not where it is sent: the field must never offer
  // a number the server has already decided to refuse.
  const wanted = Math.min(MAX_GENERATE, Math.max(1, Math.round(Number(count) || 0)));

  // Ticked ids intersected with what is still on screen, so a wallet deleted
  // since it was ticked cannot be carried in on a stale id.
  const tickedHere = wallets.filter((w) => ticked.includes(w.id));
  const funded = wallets.filter((w) => Number(w.balanceEth) > 0).length;

  // Case-insensitive substring match on the address — a pasted address, or the
  // first few characters of one, narrows the table to the wallet it names.
  const q = search.trim().toLowerCase();

  /**
   * The rows AS DRAWN — filtered, then ordered for display only. The `wallets`
   * prop the run is sized from is never reordered, and selection tracks ids, so
   * a re-sort never disturbs what is ticked.
   *
   * Created and Age order on the SAME timestamp, in opposite senses: ascending
   * created is oldest-first, ascending age is youngest-first. They are two
   * columns because that is how the choice is actually made ("newest first" vs
   * "oldest first"), not because there are two facts. A wallet with no readable
   * createdAt sorts to the end in either direction, so a missing timestamp is
   * never read as the oldest or the newest wallet.
   */
  const rows = useMemo(() => {
    const list = q ? wallets.filter((w) => String(w.address || '').toLowerCase().includes(q)) : wallets;
    if (!sort) return list;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const sense = sort.key === 'age' ? -1 : 1;
    const at = (w) => {
      const t = Date.parse(w?.createdAt || '');
      return Number.isFinite(t) ? t : null;
    };
    return [...list].sort((a, b) => {
      const va = at(a);
      const vb = at(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir * sense;
    });
  }, [wallets, q, sort]);

  // The select-all box speaks for the rows ON SCREEN, so it is checked only when
  // every one of them is ticked — a filtered table must never claim a selection
  // it is not showing.
  const shownTicked = rows.filter((w) => ticked.includes(w.id));
  const allShownTicked = rows.length > 0 && shownTicked.length === rows.length;

  // Cycle a sortable column: unsorted → ascending → descending → unsorted. The
  // return to unsorted is the way back to the backend's natural order without a
  // separate control on every header.
  function cycleSort(key) {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' };
      if (cur.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }
  const sortArrow = (key) => (sort?.key !== key ? '↕' : sort.dir === 'asc' ? '↑' : '↓');

  return (
    <Step {...step}>
      <p className="lede">
        Where the ETH is going. Generate fresh wallets, import keys you already hold, or claim aged
        ones out of the V4 seasoning pool — a seasoned wallet has been sitting since it was funded
        and reads as organic, where a batch made this afternoon reads as a batch.
      </p>

      {/* CREATE — the count and its one action, so the row reads as "make N
          wallets" and nothing else. Indigo, not amber: this spends nothing. */}
      <div className="row">
        <span className="ctl-label">Create</span>
        <input
          type="number"
          min="1"
          max={MAX_GENERATE}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 90 }}
        />
        <Busy
          className="btn-primary"
          busy={busy === 'generate'}
          onClick={() =>
            act('generate', () =>
              api('/v8/wallets/generate', 'POST', {
                count: wanted,
                role: ROLES.bundle,
                label: 'v8 bundle',
              })
            )
          }
        >
          Generate wallets
        </Busy>
        <button className="ghost" onClick={() => setShowImport(true)}>
          import keys
        </button>
      </div>
      <p className="hint" style={{ margin: '8px 0 12px' }}>
        <b>There is no 31-wallet cap on this tab.</b> That limit is the pons factory's snipe-tax
        exemption list and it binds only at a launch; V8 never launches, so hold as many wallets as
        the run wants. {MAX_GENERATE} is only how many one press may make — the keystore is
        rewritten in full for every wallet added, and a bigger call blocks the server for every
        other tab. Press it again for more.
      </p>

      {/* SEASONED — aged wallets out of the V4 pool, claimed most-aged first. */}
      <div className="row">
        <span className="ctl-label">Seasoned</span>
        <input
          type="number"
          min="1"
          max={seasoned.count || 1}
          value={seasonedCount}
          onChange={(e) => setSeasonedCount(e.target.value)}
          title="how many seasoned wallets to claim"
          style={{ width: 90 }}
        />
        <Busy
          busy={busy === 'claim-seasoned'}
          className="ghost"
          disabled={!seasoned.count}
          title={seasoned.count ? '' : 'no seasoned wallets ready yet'}
          onClick={claimSeasoned}
        >
          Claim seasoned
        </Busy>
        <span className="hint">{seasoned.count} seasoned ready in V4</span>
      </div>
      <p className="hint" style={{ margin: '8px 0 12px' }}>
        Claiming re-roles the wallet out of the V4 pool and into this tab — it leaves the seeding
        table in the same breath, and V4's hand-off record is what says where it went. If none are
        ready, season some there first.
      </p>

      {/* BACKUP — separate from create, because these take keys OUT rather than
          make them. Every one carries the typed-EXPORT confirmation. */}
      <div className="row">
        <span className="ctl-label">Keys</span>
        <V8BackupControls count={backupCount} report={report} />
        <V8BackupControls
          count={wallets.length}
          report={report}
          role={ROLES.bundle}
          roleLabel="destination"
          label={`Export ${wallets.length} destinations`}
        />
        {tickedHere.length > 0 && (
          <>
            <V8BackupControls
              count={tickedHere.length}
              report={report}
              walletIds={tickedHere.map((w) => w.id)}
              label={`Export ${tickedHere.length} selected`}
            />
            <Busy
              busy={busy === 'delete'}
              className="ghost danger"
              disabled={locked}
              title={locked ? 'a timed run is going — stop it first' : ''}
              onClick={() => setBulk(tickedHere)}
            >
              Delete {tickedHere.length} selected
            </Busy>
          </>
        )}
        <span className="spacer" />
        {progress ? (
          <span className="hint">{progress}</span>
        ) : (
          wallets.length > 0 && (
            <span className="hint">
              {plural(wallets.length, 'wallet')} · {funded} holding ETH
              {tickedHere.length > 0 ? ` · ${tickedHere.length} selected` : ''}
            </span>
          )
        )}
      </div>

      {wallets.length === 0 ? (
        <div className="notice">
          <h3>No destination wallets yet</h3>
          <p>
            These are the wallets the source pays in step 3. Generate however many the run wants,
            back their keys up, and set each one's amount there — nothing moves until then.
          </p>
        </div>
      ) : (
        <>
          {/* Filter to a pasted address, or a prefix of one. A quiet way back
              from each control that has been used, and nothing else in the row. */}
          <div className="row" style={{ margin: '12px 0' }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by address — paste a wallet address"
              aria-label="Filter destination wallets by address"
              autoComplete="off"
              spellCheck="false"
              style={{ flex: '1 1 320px', maxWidth: 460 }}
            />
            {search && (
              <button type="button" className="quiet" onClick={() => setSearch('')}>
                Clear filter
              </button>
            )}
            {sort && (
              <button type="button" className="quiet" onClick={() => setSort(null)}>
                Clear sort ({sort.key} {sort.dir === 'asc' ? '↑' : '↓'})
              </button>
            )}
          </div>

          {q && rows.length === 0 ? (
            <div className="notice">
              <h3>No wallet matches that</h3>
              <p>
                Nothing in this table has an address containing “{search.trim()}”. Clear the filter
                to see every wallet again.
              </p>
            </div>
          ) : (
            <div className="table-card" style={{ maxHeight: 460 }}>
              <table className="wallet-list">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>
                      {/* Speaks for the rows the FILTER is showing, never for the
                          whole set — a box must not select wallets that are not on
                          screen to be looked at. */}
                      <input
                        type="checkbox"
                        checked={allShownTicked}
                        ref={(el) => {
                          if (el) el.indeterminate = shownTicked.length > 0 && !allShownTicked;
                        }}
                        onChange={(e) => {
                          const ids = rows.map((w) => w.id);
                          setTicked((cur) =>
                            e.target.checked
                              ? Array.from(new Set([...cur, ...ids]))
                              : cur.filter((x) => !ids.includes(x))
                          );
                        }}
                        aria-label="Select every wallet shown"
                      />
                    </th>
                    <th className="num">No.</th>
                    <th>Address</th>
                    <th>Label</th>
                    {/* Sortable: click cycles asc → desc → off. Both order on
                        createdAt — see the `rows` note for why they are two
                        columns and not one. */}
                    <th>
                      <button type="button" style={sortHeaderStyle} onClick={() => cycleSort('created')}>
                        Created{' '}
                        <span className="hint" aria-hidden="true" style={{ fontSize: '0.85em' }}>
                          {sortArrow('created')}
                        </span>
                      </button>
                    </th>
                    <th className="num">
                      <button type="button" style={sortHeaderStyle} onClick={() => cycleSort('age')}>
                        Age{' '}
                        <span className="hint" aria-hidden="true" style={{ fontSize: '0.85em' }}>
                          {sortArrow('age')}
                        </span>
                      </button>
                    </th>
                    <th className="num">Balance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w, i) => {
                    const days = ageDays(w.createdAt);
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
                            aria-label={`Select wallet ${w.address}`}
                          />
                        </td>
                        <td className="num hint">{i + 1}</td>
                        <td>
                          {/* `plain` drops only the decoration — a hundred blue
                              underlined rows is noise, and the address is a label
                              for the row rather than the thing a reader came to
                              click. The copy button still copies it whole. */}
                          <Address
                            value={w.address}
                            plain
                            href={explorer ? `${explorer}/address/${w.address}` : ''}
                          />
                        </td>
                        <td className="hint">{w.label || '—'}</td>
                        <td
                          className="hint"
                          title={w.createdAt ? new Date(w.createdAt).toLocaleString() : ''}
                        >
                          {w.createdAt ? new Date(w.createdAt).toISOString().slice(0, 10) : '—'}
                        </td>
                        <td className="num">{days == null ? '—' : plural(days, 'day')}</td>
                        <td className="num">
                          <span className={`bal ${Number(w.balanceEth) === 0 ? 'zero' : ''}`}>
                            {eth(w.balanceEth)}
                          </span>
                        </td>
                        <td className="num">
                          <button
                            className="link danger"
                            onClick={() => setDeleting(w)}
                            disabled={locked}
                            title={locked ? 'a timed run is going — stop it first' : 'delete this wallet'}
                            aria-label={`Delete wallet ${w.address}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="hint">
            Age counts from the wallet's createdAt — for a claimed seasoned wallet that is the day
            V4 made it, which is the number that decides whether it still reads as fresh. Balance is
            read back off chain: a wallet already holding ETH is not skipped by step 3, it is topped
            up by whatever amount you type against it.
          </p>
        </>
      )}

      <Modal
        open={showImport}
        title="Import destination keys"
        onCancel={() => setShowImport(false)}
        confirmLabel="Import"
        onConfirm={async () => {
          await act('import', () =>
            api('/v8/wallets/import', 'POST', {
              // Split HERE, into an array, rather than posting the raw blob: the
              // backends that take a list wrap a bare string in a one-element
              // array, and a hundred keys pasted as one string would then import
              // as a single unreadable "key". An array is understood by every
              // shape of this route in the console.
              privateKeys: keys.split(/[\s,]+/).filter(Boolean),
              role: ROLES.bundle,
              label: importLabel.trim() || 'v8 bundle',
            })
          );
          setKeys('');
          setImportLabel('');
          setShowImport(false);
        }}
      >
        <p>
          One key per line, or comma-separated — paste as many as you like. There is no 31-wallet
          cap on this tab: that limit belongs to a launch, and nothing here launches. Each key is
          encrypted straight into this account's keystore and never logged or shown again.
        </p>
        <textarea
          rows={6}
          value={keys}
          onChange={(e) => setKeys(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
        />
        <input
          placeholder="label (optional)"
          value={importLabel}
          onChange={(e) => setImportLabel(e.target.value)}
        />
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title="Delete this destination wallet?"
        danger
        onCancel={() => setDeleting(null)}
        confirmLabel="Delete it"
        onConfirm={async () => {
          const w = deleting;
          setDeleting(null);
          await act('delete', () => api(`/v8/wallets/${w.id}`, 'DELETE'));
        }}
      >
        <p>
          Its key is archived on the server, not destroyed — but nothing in this console will send
          from it again. If it holds ETH, sweep in step 4 first: deleting does not move it.
        </p>
        {deleting && (
          <>
            <Fact label="Address" mono>
              {deleting.address}
            </Fact>
            <Fact label="Balance">{eth(deleting.balanceEth)} ETH</Fact>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(bulk)}
        title={`Delete ${bulk ? bulk.length : 0} destination wallet${bulk && bulk.length === 1 ? '' : 's'}?`}
        danger
        onCancel={() => setBulk(null)}
        confirmLabel={`Delete ${bulk ? bulk.length : 0} wallets`}
        onConfirm={async () => {
          const list = bulk;
          setBulk(null);
          await act('delete', () => deleteTicked(list));
        }}
      >
        <p>
          Their keys are archived, not destroyed. They go one at a time, and any the server refuses
          are counted and left alone rather than stopping the rest.
        </p>
        {bulk && bulk.some((w) => Number(w.balanceEth) > 0) && (
          <p className="modal-warn">
            {bulk.filter((w) => Number(w.balanceEth) > 0).length} of them still hold ETH. Deleting
            leaves that ETH at those addresses, reachable only by restoring the keys — sweep in step
            4 first.
          </p>
        )}
      </Modal>
    </Step>
  );
}
