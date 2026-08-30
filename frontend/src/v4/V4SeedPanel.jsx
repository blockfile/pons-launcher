import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Modal from '../components/Modal.jsx';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import { LuTrash2, LuUndo2 } from 'react-icons/lu';
import IconButton from './IconButton.jsx';
import V4BackupControls from './V4BackupControls.jsx';
import { MAX_GENERATE, ROLES, clock, eth } from './roles.js';

// A column header that also acts as a sort control. Styled to read as the plain
// header text it replaces — no button chrome — so the table gains sorting without
// gaining a row of obtrusive buttons. Inline rather than a stylesheet class so the
// change stays inside this V4 file. `inherit` for font and colour keeps it matching
// whatever the surrounding <th> is given; the flex row aligns the direction arrow
// beside the label (and the right-aligned `.num` header still pushes both to the
// right, since an inline-flex box obeys the cell's text-align).
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
  // Free-text filter over the visible seed table. When set, every section shows
  // ONLY the wallets whose address contains this (case-insensitive, prefix or
  // substring) — pasting a CA narrows a thousand-row table to the one wallet.
  // It filters what is DRAWN only: the stat line above still counts the whole
  // pool, and `ticked` keeps a selection made before a search was typed.
  const [search, setSearch] = useState('');
  // How the rows WITHIN each section are ordered. null = the natural order the
  // backend returned, so an untouched table is byte-for-byte what it was before
  // this control existed. Otherwise { key: 'funded' | 'age', dir: 'asc' | 'desc' }
  // — a clickable column header cycles asc → desc → off.
  const [sort, setSort] = useState(null);
  // The hand-off record's own filter and sort, kept apart from the seed table's
  // two above. They are separate states rather than a shared one because the two
  // tables answer different questions off different data — the seed sort's keys
  // ('funded' | 'age') do not exist on a hand-off row at all — and because an
  // operator narrowing the audit record must not have the live pool vanish out
  // from under them at the same time. See the derivations further down for why
  // the SEARCH is separate too.
  const [handoffSearch, setHandoffSearch] = useState('');
  // null = the order the backend returned, which is newest first. Otherwise
  // { key: 'at' | 'tab', dir: 'asc' | 'desc' } — the same asc → desc → off cycle
  // the seed headers use.
  const [handoffSort, setHandoffSort] = useState(null);
  // How many seed wallets are aged past the gate right now, which of them have
  // already been handed off to V1/V3, and which the operator has pulled back out
  // of the claimable pool by hand — read-only, drawn beside the generate row so
  // an operator sees where a wallet went without switching tabs. Polled the same
  // way loadWallets is in V4Console: on mount and every 60s, quietly on failure.
  //
  // `withdrawn` is the reversible "set this seed aside" mark: a wallet whose key
  // has been exported to spend elsewhere stays here and stays backed up, but
  // `count` already excludes it so a V1/V3 claim never grabs it.
  const [seasoned, setSeasoned] = useState({ count: 0, graduated: [], withdrawn: [] });

  useEffect(() => {
    let alive = true;
    const load = () => api('/v4/seasoned').then((s) => alive && setSeasoned(s)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Which seed rows are currently held out of the claimable pool, looked up by
  // wallet id. Defaulted so an older backend that has not started returning the
  // field yet just shows nothing withdrawn rather than throwing.
  const withdrawnIds = new Set((seasoned.withdrawn || []).map((w) => w.id));

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
   * How long a wallet has to sit before it is worth spending, and which ones
   * have.
   *
   * COUNTED PER WALLET, FROM ITS OWN FUNDING. The campaign's age is not the
   * wallet's: in a five-day run the last day's wallets are four days behind the
   * first day's and stay that way, so "the batch is old enough" is never true
   * of the batch — only of the part of it that was fed first.
   *
   * Three days is the default because it clears the "fresh wallet" filters this
   * whole feature exists to get past, and it is a field rather than a constant
   * because how long is long enough is a judgement about whoever is looking.
   */
  // Seasoned = at least this many days since a wallet was funded. Fixed at 1: a
  // one-day-old wallet is old enough for this pool, and leaving it editable only let an
  // operator set a threshold that then hid usable wallets from step 3.
  const season = 1;
  // Withdrawn seeds are set aside (key already exported, held out of the claim
  // pool), so they count as neither "usable" nor "aging" in the overall tally —
  // the same way the backend's available() drops them. Keeps the stat line honest
  // with the per-section export, which also never includes a withdrawn seed.
  const usable = wallets.filter((w) => !withdrawnIds.has(w.id) && (w.daysSinceFunded ?? -1) >= season);
  const waiting = wallets.filter(
    (w) => !withdrawnIds.has(w.id) && w.daysSinceFunded != null && w.daysSinceFunded < season
  );

  /**
   * Split the seed table into "seasoned pool" (earlier runs) and "new campaign"
   * (the batch being seasoned now, plus any freshly generated wallet not yet in a
   * campaign).
   *
   * THE BOUNDARY IS WHICH RUN A WALLET BELONGS TO, NOT WHETHER IT HAS SEASONED
   * YET — so a wallet never hops from "new" to "done" the day it seasons, and last
   * run's still-aging wallets stay with last run. A seed carries the createdAt of
   * the campaign that claimed it (null until one does).
   *
   * A RUN IS NOT ALWAYS ONE CAMPAIGN. "Start on all N funders" fans a single
   * action out into N sibling campaigns (e.g. 20 funders × 5 wallets = 100),
   * created within moments of each other. Keying "new" off the SINGLE latest
   * createdAt would show only one funder's 5 wallets and scatter the other 95 into
   * the pool — so cluster every campaign created within a short window of the
   * newest as ONE new batch. A genuinely earlier run (the previous seasoning,
   * hours or days back) falls outside the window and stays in the pool.
   *
   * With only one run there is nothing older to be the pool, so every wallet is
   * the current batch and the seasoned-pool section is empty — it appears the
   * instant a later run gives the first one somewhere to go.
   */
  const NEW_BATCH_WINDOW_MS = 15 * 60 * 1000; // a fan-out starts in well under this; separate runs are days apart
  const newestCampaignAt = wallets.reduce(
    (max, w) => (w.campaignCreatedAt && (!max || w.campaignCreatedAt > max) ? w.campaignCreatedAt : max),
    null
  );
  const newBatchCutoff = newestCampaignAt ? Date.parse(newestCampaignAt) - NEW_BATCH_WINDOW_MS : null;
  const inNewBatch = (w) =>
    !w.campaignId ||
    (newBatchCutoff != null && w.campaignCreatedAt && Date.parse(w.campaignCreatedAt) >= newBatchCutoff);
  // Case-insensitive substring match on the address — a pasted CA, or the first
  // few characters of one, narrows the table to the wallet(s) it names. An empty
  // search matches everything, so the default is the full list restored.
  const q = search.trim().toLowerCase();
  const matchesSearch = (w) => !q || w.address.toLowerCase().includes(q);

  // Order one section's rows by the chosen column. Sorting is PER SECTION (the
  // "No." is a within-section ordinal), and a wallet with no value for the key —
  // an unfunded seed has neither a funded date nor an age — always sorts to the
  // end regardless of direction, so the rows carrying the data being sorted on
  // are never buried under the ones that don't.
  function sortSeeds(list) {
    if (!sort) return list;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (w) => (sort.key === 'age' ? w.daysSinceFunded : w.fundedAt ? Date.parse(w.fundedAt) : null);
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }

  // Filter then sort — the transform every section list goes through before it
  // is drawn. With no search and no sort this is the identity, so the existing
  // grouping, counts and order are untouched until a control is used.
  const arrange = (list) => sortSeeds(list.filter(matchesSearch));

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

  // Withdrawn seeds — keys exported to spend elsewhere, held out of the V1/V3
  // claim pool — get their OWN section so they don't clutter the two active
  // groups (and can't be swept into a bulk delete meant for live ones). A wallet
  // is in exactly one of the three: withdrawn first, then split the rest by
  // campaign. `withdrawnIds` is derived above from /v4/seasoned. `arrange` applies
  // the search filter and sort — the identity until either is used.
  const withdrawnList = arrange(wallets.filter((w) => withdrawnIds.has(w.id)));
  const active = wallets.filter((w) => !withdrawnIds.has(w.id));
  const newBatch = arrange(active.filter(inNewBatch));
  const seasonedPool = arrange(active.filter((w) => !inNewBatch(w)));

  // Per-group figures for the section headers — the same derivations as the
  // overall stat line, scoped to one group.
  const groupStats = (list) => ({
    total: list.length,
    funded: list.filter((w) => facts[w.id]?.status === 'sent').length,
    usable: list.filter((w) => (w.daysSinceFunded ?? -1) >= season).length,
    aging: list.filter((w) => w.daysSinceFunded != null && w.daysSinceFunded < season).length,
    fresh: list.filter((w) => !w.campaignId).length,
  });

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

  // Re-read the seasoned pool after a change of our own, rather than editing the
  // local copy. Another tab or operator may have claimed, withdrawn or restored
  // from it since the last poll — the same reason claimSeasoned re-reads in
  // WalletsPanel. Quiet on failure: the 60s poll will catch up regardless.
  async function refreshSeasoned() {
    try {
      setSeasoned(await api('/v4/seasoned'));
    } catch {
      // Background read — see the mount-time fetch above for why this stays quiet.
    }
  }

  /**
   * Pull the ticked seed wallets out of the claimable pool. One request for the
   * whole set — unlike the deletes, this rewrites no keystore, it only sets a
   * mark, so there is no per-wallet file rewrite to serialise. The wallets stay
   * here and stay backed up; `count` on the pool simply stops counting them, so
   * a V1/V3 claim can never grab a seed whose key is already in use elsewhere.
   * Reversible with Restore.
   */
  async function withdrawTicked(list) {
    setBusy('withdraw');
    try {
      const out = await api('/v4/seasoned/withdraw', 'POST', { ids: list.map((w) => w.id) });
      report(`Withdrew ${list.length} seed wallet(s) from seasoning — ${out.count} still claimable. Reversible with Restore.`);
      setTicked([]);
      await reload();
      await refreshSeasoned();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Put withdrawn seeds back into the claimable pool. Per-row from the badge, so
  // the id list is almost always one — but written to take a list so a future
  // "restore ticked" can share it.
  async function restoreWallets(ids) {
    setBusy('restore');
    try {
      const out = await api('/v4/seasoned/restore', 'POST', { ids });
      report(`Restored ${ids.length} seed wallet(s) to seasoning — ${out.count} claimable.`);
      await reload();
      await refreshSeasoned();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // The rows for one group. The "No." is a within-section ordinal (restarts at 1
  // per section), a label for the row rather than a global index.
  function seedRows(list) {
    return list.map((w, i) => {
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
          <td className="num hint">{i + 1}</td>
          <td>
            {/* Still a link — `plain` drops only the decoration. A hundred blue
                underlined rows is noise; the address is a label for the row rather
                than the thing a reader came to click. Hover reveals it. */}
            <Address
              value={w.address}
              plain
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
          {/* Days since it was FUNDED, not since the key was made. Generating a
              key touches nothing on chain, so a wallet's visible life starts at
              the transfer — and this is the number that decides whether it is safe
              to spend. An unfunded wallet has no age at all, a different fact from
              "zero days old". */}
          <td className="num">
            {w.daysSinceFunded == null ? (
              <span className="hint">—</span>
            ) : (
              `${w.daysSinceFunded}d`
            )}
          </td>
          <td>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className={`fund-state ${w.backedUp ? 'is-in' : 'is-part'}`}>
                {w.backedUp ? 'backed up' : 'no backup'}
              </span>
              {/* A neutral grey pill: withdrawn is a state the operator chose, not
                  a shortfall (amber) or a good outcome (jade). The Restore beside
                  it is the whole way back — reversible, so it sits on the row it
                  undoes. */}
              {withdrawnIds.has(w.id) && (
                <>
                  <span className="fund-state" title="held out of the V1/V3 claim pool — reversible">
                    withdrawn
                  </span>
                  <IconButton
                    icon={LuUndo2}
                    label={`Restore ${w.address} to the claim pool`}
                    disabled={busy === 'restore'}
                    onClick={() => restoreWallets([w.id])}
                  />
                </>
              )}
            </span>
          </td>
          <td className="num">
            {/* Offered on every row, including claimed ones. The server reads the
                campaigns and refuses a wallet one still owes a transfer to, naming
                it — a rule this table cannot evaluate, since `claimed` says a
                campaign holds the wallet but not whether that campaign is still
                live. Hiding the link on `claimed` would block deleting wallets from
                a run that finished weeks ago. */}
            <IconButton
              icon={LuTrash2}
              danger
              label={`Archive seed wallet ${w.address}`}
              onClick={() => setDeleting(w)}
            />
          </td>
        </tr>
      );
    });
  }

  // One titled, scrollable section for a group of seeds. The header checkbox is
  // scoped to THIS section — ticking it selects (or clears) only this group's
  // wallets within the shared `ticked` set, so a select-all in the seasoned pool
  // never sweeps the new batch into a bulk delete. Renders nothing for an empty
  // group so a section only exists when it has wallets.
  //
  // `accent` is a CSS colour var ('jade' | 'sky' | 'grey') that highlights the
  // header so the three groups are told apart at a glance.
  //
  // EVERY section gets a "Back up N" of ALL its wallets — no age gate — because a
  // backup is a SAFETY net, and the wallets that most need one are the fresh,
  // unfunded batch you are about to send real ETH to (step 3 refuses to start a
  // campaign until they are backed up). `showUsable` adds a second "Export usable
  // N" for the aged subset (the file you open on the day you spend), but only when
  // it is a real subset — no point offering it when every wallet already qualifies.
  function seedSection(title, hint, list, { accent = 'grey', showUsable = false } = {}) {
    if (!list.length) return null;
    const ids = list.map((w) => w.id);
    const allInSection = ids.every((id) => ticked.includes(id));
    const usableSeeds = showUsable
      ? list.filter((w) => (w.daysSinceFunded ?? -1) >= season)
      : [];
    return (
      <div style={{ marginBottom: 18 }}>
        <div
          className="seed-group-head"
          style={{ '--group-accent': `var(--${accent})`, '--group-tint': `var(--tint-${accent})` }}
        >
          <b>{title}</b>
          <span className="hint">{hint}</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            {/* All of this section's keys — the pre-funding safety backup, and
                what gives the fresh batch a backup button at all. */}
            <V4BackupControls
              masters={masters}
              seeds={list}
              report={report}
              reload={reload}
              exportIds={ids}
              label={`Back up ${list.length}`}
            />
            {/* Only the aged ones — the "safe to spend today" file — and only when
                that is fewer than the whole section, else it just repeats Back up. */}
            {usableSeeds.length > 0 && usableSeeds.length < list.length && (
              <V4BackupControls
                masters={masters}
                seeds={list}
                report={report}
                reload={reload}
                exportIds={usableSeeds.map((w) => w.id)}
                label={`Export usable ${usableSeeds.length}`}
              />
            )}
          </span>
        </div>
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allInSection}
                    onChange={(e) =>
                      setTicked((cur) =>
                        e.target.checked
                          ? Array.from(new Set([...cur, ...ids]))
                          : cur.filter((x) => !ids.includes(x))
                      )
                    }
                  />
                </th>
                <th className="num">No.</th>
                <th>Address</th>
                <th className="num">Funded</th>
                <th>Campaign</th>
                {/* Sortable: click cycles asc → desc → off. Funded-at sorts on the
                    transfer time, Age on daysSinceFunded — the two orderings an
                    operator reaches for when a section runs to hundreds of rows. */}
                <th>
                  <button type="button" style={sortHeaderStyle} onClick={() => cycleSort('funded')}>
                    Funded at{' '}
                    <span className="hint" aria-hidden="true" style={{ fontSize: '0.85em' }}>
                      {sortArrow('funded')}
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
                <th>Key</th>
                <th />
              </tr>
            </thead>
            <tbody>{seedRows(list)}</tbody>
          </table>
        </div>
      </div>
    );
  }

  const poolStats = groupStats(seasonedPool);
  const newStats = groupStats(newBatch);
  const poolHint = `${poolStats.total} wallet${poolStats.total === 1 ? '' : 's'} · ${poolStats.usable} usable · ${poolStats.aging} aging`;
  // "New campaign" only reads right when there is an older pool to be new relative
  // to; with a single batch it is simply the current one.
  const newTitle = seasonedPool.length ? 'New campaign' : 'Current campaign';
  // The new batch may be ONE campaign or a fan-out of many (Start on all N
  // funders) — say which so 100 wallets across 20 campaigns don't read as a
  // 5-wallet campaign. One campaign → its name; several → "across N campaigns".
  const newCampaignCount = new Set(newBatch.map((w) => w.campaignId).filter(Boolean)).size;
  const newCampaignLabel =
    newCampaignCount > 1
      ? `across ${newCampaignCount} campaigns · `
      : newBatch.find((w) => w.campaignName)
        ? `${newBatch.find((w) => w.campaignName).campaignName} · `
        : '';
  const newHint =
    newCampaignLabel +
    `${newStats.total} wallet${newStats.total === 1 ? '' : 's'}` +
    (newStats.funded ? ` · ${newStats.funded} funded` : '') +
    (newStats.aging ? ` · ${newStats.aging} aging` : '') +
    (newStats.fresh ? ` · ${newStats.fresh} not yet in a campaign` : '');
  const withdrawnHint = `${withdrawnList.length} wallet${withdrawnList.length === 1 ? '' : 's'} · keys exported, held out of the claim pool · Restore on any row to return it`;

  /* ── THE HAND-OFF RECORD ───────────────────────────────────────────────────
     Wallets V1 or V3 claimed out of the seasoned pool. A claim RE-ROLES the
     wallet (v4seed → v3bundle) and it leaves the seed table in the same breath,
     so /v4/seasoned's `graduated` is the only surviving statement of where it
     went — which makes this an audit record, and an audit record that shows the
     first twenty of thirty-nine rows is not one. Everything below is a view over
     data already in state: no request, no handler, nothing spent.

     Defaulted, like `withdrawn` above, so a backend that has not started
     returning the field draws an empty section rather than throwing on .length. */
  const graduated = seasoned.graduated || [];

  /* ITS OWN SEARCH BOX, not a share of the seed filter above, and the reasons
     are about the ANSWER being wrong rather than the convenience:

     — A handed-off wallet is not a seed. The seed filter's "No wallet matches"
       notice would be telling an operator an address is nowhere in this tab at
       the very moment this record holds the row saying where it went.
     — The seed filter only exists inside the `wallets.length > 0` branch. Hand
       every seed away and the box disappears along with the pool, taking the
       only way to search the record of where they all went with it.
     — It matches the DESTINATION TAB as well as the address, which is the
       operator's actual question. Typing `v3` answers "I used 35 wallets on V3,
       where did they go?" in one action: the rows, and the count on the button
       beside them. An address is hex and can never contain a `v`, so the two
       kinds of match cannot collide. */
  const gq = handoffSearch.trim().toLowerCase();
  const handoffMatches = (g) =>
    !gq ||
    String(g.address || '').toLowerCase().includes(gq) ||
    String(g.toTab || '').toLowerCase().includes(gq);

  // A hand-off time that will not parse sorts to the end the way an unfunded
  // seed does in sortSeeds — the rows carrying the data being sorted on are
  // never buried under the ones that don't.
  const handoffAt = (g) => {
    const t = Date.parse(g.at || '');
    return Number.isFinite(t) ? t : null;
  };

  // Order the record. Sorting by tab leans on Array.sort being stable: rows
  // sharing a tab keep the order they arrived in (newest first), so grouping by
  // destination never scrambles the chronology inside a group.
  function sortHandoffs(list) {
    if (!handoffSort) return list;
    const dir = handoffSort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (handoffSort.key === 'tab') {
        return String(a.toTab || '').localeCompare(String(b.toTab || '')) * dir;
      }
      const va = handoffAt(a);
      const vb = handoffAt(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
  }
  const handoffRows = sortHandoffs(graduated.filter(handoffMatches));

  function cycleHandoffSort(key) {
    setHandoffSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' };
      if (cur.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  }
  const handoffArrow = (key) =>
    handoffSort?.key !== key ? '↕' : handoffSort.dir === 'asc' ? '↑' : '↓';

  /* "39 handed off — 35 to v3, 4 to v1". Counted off the WHOLE record and never
     the filtered view: this is the figure a run is reconciled against, and a
     total that moved every time a filter was typed would be worthless for
     exactly that. Biggest destination first, so the tab that took the most is
     the one read first. */
  const handoffByTab = new Map();
  for (const g of graduated) {
    const tab = g.toTab || 'unknown';
    handoffByTab.set(tab, (handoffByTab.get(tab) || 0) + 1);
  }
  const handoffTally = [...handoffByTab.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tab, n]) => `${n} to ${tab}`)
    .join(', ');

  /**
   * Download the hand-off record.
   *
   * PLAIN PUBLIC DATA: an address, the tab that took it, and when. No key, no
   * secret, nothing the chain does not already publish — which is why this
   * carries NONE of the typed-EXPORT confirmation the key backups do. That
   * confirmation exists so a mis-click cannot hand over private keys, and
   * spending it on a list of public addresses is how an operator learns to type
   * EXPORT without reading the dialog.
   *
   * Built here from `graduated`, already in state: no request, and nothing on
   * the server is asked for a second copy of what the browser is holding.
   *
   * It writes WHAT IS ON SCREEN — the filtered, sorted rows — so a file and the
   * view it came from always agree. The row count is on the button and the
   * filter is recorded in the FILENAME, the same way v4/backup.js tags its key
   * files: a partial export that looks complete a month later is the one way
   * this record could mislead the audit it exists for.
   */
  function exportHandoffs(rows) {
    // RFC4180 quoting. The three fields are hex, a short tab name and an ISO
    // timestamp, so nothing should ever need it — which is precisely why it is
    // here rather than trusted to stay true.
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // `toTab || 'unknown'` mirrors what the table and the tally already draw for a
    // row missing its destination, so the file and the view cannot disagree on the
    // same row — which is the whole promise this export makes.
    const body = ['address,tab,handed_off_at']
      .concat(rows.map((g) => [g.address, g.toTab || 'unknown', g.at].map(cell).join(',')))
      .join('\n');
    // The QUERY goes in the name, not a generic "-filtered": exporting v3 and then
    // v1 would otherwise write the same filename twice, the browser would silently
    // rename the second, and a month later the two partials are indistinguishable
    // without opening them — exactly the mislead the tag exists to prevent.
    const tag = gq ? `-${gq.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}` : '';
    const name = `pons-v4-handoffs${tag}-${new Date().toISOString().slice(0, 10)}.csv`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    report(`Wrote ${rows.length} hand-off row(s) to ${name} — addresses, tabs and times only, no keys.`);
  }

  return (
    <Step {...step}>
      <p className="lede">
        Fresh wallets, one transfer each. Generate however many the strategy wants — they cost
        nothing until a campaign starts feeding them, and the campaign is what takes weeks.
      </p>

      {/* Create — the count and its one action alone, so the row reads as "make
          N seed wallets" and nothing else. */}
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
          className="btn-primary"
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
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        {MAX_GENERATE} at a time is the ceiling — the keystore is rewritten in full for every wallet
        added, and a bigger call blocks the server for every other tab. Run it again for more.
      </p>

      {/* Backup / export — separate from create: these take wallets OUT, they do
          not make them. One implementation, drawn here and in step 1 beside the
          funding wallets' deletes (see V4BackupControls' header). */}
      <div className="row">
        {/* Just the whole-tab safety backup here. The "usable" export is now PER
            SECTION — each pool exports only its own usable seeds (see seedSection),
            so it never bundles another section's wallets, and a withdrawn seed
            (its key already exported) is never swept into a pool's file. */}
        <V4BackupControls masters={masters} seeds={wallets} report={report} reload={reload} />
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
          {/* Held out of the claimable pool by hand. Counted here beside the
              other pool figures because it is the fifth thing that decides the
              next action: these seeds exist and are backed up, but a claim will
              pass over every one of them. */}
          {withdrawnIds.size > 0 && (
            <span className="hint">
              · <b>{withdrawnIds.size}</b> withdrawn from seasoning
            </span>
          )}
          {/* The two numbers an operator actually acts on once funding starts:
              what can be spent, and what is still sitting. Drawn only after
              something has been funded, because before that they are both zero
              and say nothing. */}
          {funded > 0 && (
            <>
              <span className="hint">
                · <b>{usable.length}</b> usable
              </span>
              {waiting.length > 0 && (
                <span className="hint">
                  · <b>{waiting.length}</b> still aging
                </span>
              )}
            </>
          )}
          <span className="spacer" />
          {progress ? (
            <span className="hint">{progress}</span>
          ) : (
            tickedHere.length > 0 && (
              <>
                {/* Export exactly the ticked set — the same per-section backup
                    component the group headers use, so it carries the typed-EXPORT
                    confirm and the "add the funders?" box unchanged, and sends
                    { walletIds: [...selected] } to /v4/wallets/backup. `seeds` is
                    the full list only for the "of N" figure; `exportIds` is what
                    actually goes in the file. A withdrawn seed can be in the set
                    (it is a normal wallet to export), unlike the pool exports that
                    deliberately never re-export one. */}
                <V4BackupControls
                  masters={masters}
                  seeds={wallets}
                  report={report}
                  reload={reload}
                  exportIds={tickedHere.map((w) => w.id)}
                  label={`Export ${tickedHere.length} selected`}
                />
                {/* ONE PRESS: export the keys, THEN withdraw the same set from
                    seasoning. afterExport runs only after the file has downloaded
                    (V4BackupControls keeps it inside the successful path), so a wallet
                    is never set aside before its key is saved — which is exactly what
                    "withdrawn" (keys exported, held out of the pool) means. */}
                <V4BackupControls
                  masters={masters}
                  seeds={wallets}
                  report={report}
                  reload={reload}
                  exportIds={tickedHere.map((w) => w.id)}
                  label={`Export & withdraw ${tickedHere.length} selected`}
                  afterExport={() => withdrawTicked(tickedHere)}
                />
                {/* Set aside, not thrown away — the same ticked set as the
                    delete, but nothing is archived and the wallets stay in the
                    table. Ghost, without the danger tint: this is reversible and
                    moves no keys, the opposite of the delete beside it. */}
                <Busy
                  busy={busy === 'withdraw'}
                  className="ghost"
                  onClick={() => withdrawTicked(tickedHere)}
                >
                  Withdraw {tickedHere.length} from seasoning
                </Busy>
                {/* Vermilion, matching the per-row deletes beside it. This one
                    archives a hundred keys in a press, so it is the last control
                    in this panel that should read as ordinary. */}
                <Busy
                  busy={busy === 'delete'}
                  className="ghost danger"
                  onClick={() => setBulk(tickedHere)}
                >
                  Delete {tickedHere.length} selected
                </Busy>
              </>
            )
          )}
        </div>
      )}

      {/* What Withdraw is for, said once beside the action rather than left to be
          inferred from a badge. Drawn whenever there are seeds so the affordance
          is discoverable before an operator needs it. */}
      {wallets.length > 0 && (
        <p className="hint" style={{ margin: '0 0 12px' }}>
          Withdraw seeds whose keys you've exported to use elsewhere — they stay here and stay
          backed up, but a V1/V3 claim will never grab them. Reversible.
        </p>
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
        // TWO SECTIONS, split on the campaign a wallet belongs to (see the
        // newCampaign / seasonedPool derivation): the earlier campaigns' wallets
        // (the seasoned pool) and the newest campaign's + freshly generated ones
        // (the batch being seasoned now). Each is its own scrolling table so an
        // earlier run's still-aging wallets never sit in the same list as a fresh
        // batch — the confusion this split exists to remove. A single campaign
        // has no older pool, so only the "current campaign" section shows until a
        // second campaign gives the first somewhere to go.
        <>
          {/* Filter the whole table down to a pasted address (or a prefix of
              one). It narrows what is DRAWN across all three sections — the stat
              line above still counts the full pool, and a selection already
              ticked survives a search. Clear restores the full list. The sort is
              driven from the column headers; a "Clear sort" appears here only once
              a header has been clicked, as the plain-language way back to the
              natural order. */}
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by address — paste a wallet address"
              aria-label="Filter seed wallets by address"
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
                Clear sort ({sort.key === 'age' ? 'age' : 'funded'} {sort.dir === 'asc' ? '↑' : '↓'})
              </button>
            )}
          </div>

          {/* Every section filtered to nothing — say so, rather than leave the
              tables to vanish with no explanation. */}
          {q && withdrawnList.length + newBatch.length + seasonedPool.length === 0 && (
            <div className="notice">
              <h3>No wallet matches “{search.trim()}”</h3>
              <p>
                Nothing in the seed table has an address containing that. Clear the filter to see
                every wallet again.
              </p>
            </div>
          )}

          {seedSection('Seasoned pool — earlier campaigns', poolHint, seasonedPool, {
            accent: 'jade',
            showUsable: true,
          })}
          {seedSection(newTitle, newHint, newBatch, { accent: 'sky', showUsable: true })}
          {/* Set aside, drawn last: keys already exported, held out of the claim
              pool. Its own section so a live-batch select-all never reaches them
              and they don't pad the seasoned-pool counts. Each row keeps its
              Restore; "Back up N" re-downloads exactly these set-aside keys. */}
          {seedSection('Withdrawn — set aside', withdrawnHint, withdrawnList, { accent: 'grey' })}

          {/* Said once, under the tables, because the column heading cannot carry
              it: "Funded" is the amount the PLAN sent, not a balance read back
              off chain. A seed wallet receives one transfer and then sits, so for
              an untouched wallet the two are the same figure — and reading several
              hundred balances back on every poll would buy nothing for hundreds of
              RPC calls a minute. Age is counted from the transfer that funded each
              wallet, which is what "how long has this wallet existed" means to
              anything looking at it from the chain. */}
          <p className="hint">
            Funded is what the campaign sent, not a balance read back — these wallets receive once
            and are not spent from here. Age counts from the transfer that funded each wallet, not
            from when its key was made: generating a key touches nothing on chain, so a wallet's
            visible life starts when a solver pays it. In a five-day campaign the last day's
            wallets stay four days younger than the first day's, permanently.
          </p>
        </>
      )}

      {/* ── HANDED OFF ─────────────────────────────────────────────────────
          The audit record, and it is drawn LAST on purpose. These wallets are
          not in the pool above — the claiming tab (V1, V3, V5, V6 or V7 — they all
          call seasoned.claim into this same record) re-roled every one of them out
          of it — so this is history, not a working surface, and history does not
          belong above the four numbers that decide the next action. Below the
          tables it is still one scroll away from the operator who needs it and
          out of the way of the one who doesn't.

          Outside the wallets.length ternary as well: hand every seed away and
          the pool goes empty while this record is at its most interesting. It
          renders whenever there is something to show, and nothing when there
          isn't — the same as the list it replaces.

          Grey throughout: no amber (the panel's one spend is Generate wallets,
          and nothing here spends), no vermilion (nothing here is irreversible —
          it is a record OF something irreversible, which is not the same claim).
          The header takes .seed-group-head with no --group-accent set, so it
          falls back to the plain rule-strong bar and stays visibly quieter than
          the three tinted seed groups above it. */}
      {graduated.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="seed-group-head">
            <b>Handed off to another tab</b>
            {/* The reconciliation line: the total, then the split per destination.
                "39 handed off — 35 to v3, 4 to v1" is the whole answer to "I used
                35 wallets on V3, where did they go?" without counting a row. */}
            <span className="hint">
              {graduated.length} wallet{graduated.length === 1 ? '' : 's'}
              {handoffTally ? ` — ${handoffTally}` : ''}
            </span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
              {/* .quiet, the reads-or-retreats tier: this downloads a list of
                  public addresses and moves nothing. The count is in the label so
                  the button always states exactly how many rows it will write —
                  which, with a filter typed, is fewer than the record holds. */}
              {/* Disabled on an empty match: a header-only CSV is the one artefact
                  an audit record should never emit, and the 0 in the label reads as
                  the reason the control is off. */}
              <button
                type="button"
                className="quiet"
                disabled={handoffRows.length === 0}
                onClick={() => exportHandoffs(handoffRows)}
              >
                Download {handoffRows.length} as CSV
              </button>
            </span>
          </div>

          {/* Same shape as the seed filter row above: the box, then a quiet way
              back from each control that has been used. */}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              type="search"
              value={handoffSearch}
              onChange={(e) => setHandoffSearch(e.target.value)}
              placeholder="Filter by address, or type a tab like v3"
              aria-label="Filter handed-off wallets by address or destination tab"
              autoComplete="off"
              spellCheck="false"
              style={{ flex: '1 1 320px', maxWidth: 460 }}
            />
            {handoffSearch && (
              <button type="button" className="quiet" onClick={() => setHandoffSearch('')}>
                Clear filter
              </button>
            )}
            {handoffSort && (
              <button type="button" className="quiet" onClick={() => setHandoffSort(null)}>
                Clear sort ({handoffSort.key === 'tab' ? 'tab' : 'date'}{' '}
                {handoffSort.dir === 'asc' ? '↑' : '↓'})
              </button>
            )}
          </div>

          {handoffRows.length === 0 ? (
            // Filtered to nothing. Said plainly, and said carefully: this record
            // covers hand-offs out of THIS pool, so "not here" is not the same
            // claim as "this address was never used".
            <p className="hint" style={{ marginTop: 8 }}>
              No hand-off matches “{handoffSearch.trim()}”. Nothing claimed out of this seed pool
              has an address or a destination tab containing that — clear the filter to see the
              whole record.
            </p>
          ) : (
            /* EVERY row, in a capped scroller — no slice, no "…and N more".
               .table-card rather than the seed tables' .table-scroll because it
               is the wrapper that also pins the header row while a long record
               scrolls under it, and its 300px cap keeps a record of any length
               shorter on the page than the live pool above. */
            <div className="table-card" style={{ maxHeight: 300 }}>
              <table>
                <thead>
                  <tr>
                    <th className="num">No.</th>
                    <th>Address</th>
                    {/* Sortable, same cycle as the seed headers: asc → desc → off. */}
                    <th>
                      <button
                        type="button"
                        style={sortHeaderStyle}
                        onClick={() => cycleHandoffSort('tab')}
                      >
                        Tab{' '}
                        <span className="hint" aria-hidden="true" style={{ fontSize: '0.85em' }}>
                          {handoffArrow('tab')}
                        </span>
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        style={sortHeaderStyle}
                        onClick={() => cycleHandoffSort('at')}
                      >
                        Handed off{' '}
                        <span className="hint" aria-hidden="true" style={{ fontSize: '0.85em' }}>
                          {handoffArrow('at')}
                        </span>
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {handoffRows.map((g, i) => (
                    // Keyed on the id AND the time: an id is unique in practice
                    // (a re-roled wallet cannot be claimed out of this pool a
                    // second time), and the pair costs nothing to be sure of it.
                    <tr key={`${g.id}-${g.at}`}>
                      {/* A position in the list as drawn, like the seed tables'
                          ordinal — so "35 to v3" can be counted down the column
                          after filtering to v3. */}
                      <td className="num hint">{i + 1}</td>
                      <td>
                        {/* The same Address the seed table uses: shortened text,
                            plain link to the explorer, and the copy button that
                            puts the FULL address on the clipboard — which is what
                            makes this a record you can act on rather than read. */}
                        <Address
                          value={g.address}
                          plain
                          href={explorer ? `${explorer}/address/${g.address}` : ''}
                        />
                      </td>
                      <td>
                        {/* A neutral grey pill, the same one the withdrawn rows
                            wear. Which tab took it is a fact, not a state to be
                            worried about. */}
                        <span className="fund-state">{g.toTab || 'unknown'}</span>
                      </td>
                      {/* clock() drops the date for anything handed off today, so
                          the exact instant rides in the title for the audit. */}
                      <td title={g.at || ''}>{clock(g.at) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Said once, under the table, because it is the thing this record is
              most likely to be misread as offering. */}
          <p className="hint" style={{ marginTop: 8 }}>
            A handed-off wallet is no longer a seed — the tab that claimed it (V1, V3, V5, V6 or V7)
            re-roled it, and it is spent from there now, so there is no Restore for one and this pool
            cannot take it back. Withdraw, on the rows above, is the reversible one. The CSV holds
            addresses, tabs and times only — no keys.
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
