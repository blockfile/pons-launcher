import { useEffect, useRef, useState } from 'react';
import { api, notify } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Address from './Address.jsx';
import Modal, { Fact } from './Modal.jsx';
import Share, { pct, tokens } from './Share.jsx';
import BackupControls from './BackupControls.jsx';
import { rolesFor } from '../variant.js';

// Balances arrive as decimal strings. Six places everywhere, so the column and
// the dialog show the same number.
const eth = (v) => Number(v || 0).toFixed(6);

/**
 * Step 3 — the bundle wallets, and the table every later step reads.
 *
 * Generating the dev wallet is step 1 and lives in its own panel; this one keeps
 * the whole wallet inventory, because the table is where the bundle is SIZED and
 * a bundle is sized against the dev buy sitting at the top of it. The dev row is
 * therefore still here, read-only apart from its delete.
 *
 * Per-row fund / buy-mode / buy-amount inputs live in `rows`, owned by App,
 * because the Fund (step 4) and Launch (step 5) panels both read them — which is
 * also why this table sits above both of them.
 *
 * `share` is what those amounts would buy, computed by App from the live
 * factory configs — see shared/bundleShare.js. It is drawn next to the input
 * that produced it: sizing a bundle used to mean typing a number, launching,
 * and finding out afterwards.
 *
 * Importing here is bundle keys and only bundle keys. It used to carry a role
 * dropdown with `dev` in it, which put "replace the dev key" inside a panel
 * titled for bundle wallets — a step away from the dev wallet it was replacing,
 * and a step away from the delete that made room for it. Both halves of that
 * rotation are in step 1 now.
 */
// A market cap in USD from its native-ETH figure and a hand-entered ETH price.
// The ETH figure is the exact one the curve fixes; the dollar figure is only as
// good as the price typed beside it, which is why the price is editable and the
// ETH is always shown next to the dollars.
function usdMc(ethStr, price) {
  const v = Number(ethStr || 0) * Number(price || 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

export default function WalletsPanel({ step, wallets, rows, setRow, share, reload, report, variant = 'v1' }) {
  const roles = rolesFor(variant);
  const [count, setCount] = useState(5);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState('');
  // V4's seasoned seed wallets ready to hand off into this bundle. V1 only —
  // v2 has no claim endpoint, because re-roling a wallet into v2's bundle role
  // would spend a seasoned wallet on the wrong launcher with no way back.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(5);
  // The native token's USD price, for showing a predicted market cap the way an
  // operator reads it ("15k MC"). Fetched live from the backend (which asks an
  // exchange server-side); auto-filled but editable. `manualRef` records that
  // the operator overrode it, so the next live tick does not clobber the value
  // they typed.
  const [ethPrice, setEthPrice] = useState(1888);
  const [priceLive, setPriceLive] = useState(null); // { usd, source, stale }
  const manualRef = useRef(false);
  // "Distribute a total across the bundle" — the amount typed at the top of the
  // table, and the live gas cost of a buy/sell so the fund reserve is exact.
  const [totalBuy, setTotalBuy] = useState('');
  const [gas, setGas] = useState(null); // { buyGasEth, sellGasEth }

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const p = await api('/eth-price');
        if (!alive) return;
        setPriceLive(p);
        if (!manualRef.current) setEthPrice(Number(p.usd).toFixed(2));
      } catch {
        // Price source down — keep whatever is in the field. The dollar figure
        // is advisory; a launch never depends on it.
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The current cost of a buy and a sell, used only to size the fund reserve.
  useEffect(() => {
    let alive = true;
    api('/gas')
      .then((g) => alive && setGas(g))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // How many V4-seasoned seed wallets are ready to claim into this bundle.
  // Read-only background poll of a small figure, same shape as the eth-price
  // and gas reads above; guarded quietly for the same reason — V4 may be
  // unreachable or disabled and this control should just read 0, not error.
  useEffect(() => {
    if (variant !== 'v1') return;
    let alive = true;
    api('/v4/seasoned')
      .then((s) => alive && setSeasoned(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [variant]);
  // Ticked wallet ids. Only ever bundle wallets reach a delete — see `chosen`.
  const [picked, setPicked] = useState(() => new Set());
  // The wallets the delete confirmation is asking about, frozen at the moment
  // it opened so the figures on screen are the ones the delete runs on. Null
  // means no dialog is open, and no dialog open means nothing is deleted.
  const [deleting, setDeleting] = useState(null);
  // The wallet the current delete run is working on, so its own row says so.
  const [now, setNow] = useState('');
  // What the last delete run did, per wallet. Shown under the table because
  // the Result panel is a page away and a partial failure must not be silent.
  const [outcome, setOutcome] = useState(null);

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /**
   * Hand N seasoned V4 seed wallets over into this bundle. The backend
   * re-roles them v4seed → bundle and this is the only place that happens for
   * v1 — see the guard on the control below for why v2 never reaches this.
   */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/wallets/claim-seasoned', 'POST', { count: n });
      report(
        out.shortfall > 0
          ? `claimed ${out.claimed.length} seasoned wallet(s), ${out.shortfall} short — only ${out.available} were ready`
          : `claimed ${out.claimed.length} seasoned wallet(s)`
      );
      await reload();
      // The pool just shrank by what was claimed — re-read it rather than
      // subtracting locally, since another tab or another operator may have
      // claimed from it too.
      try {
        setSeasoned(await api('/v4/seasoned'));
      } catch {
        // Background read — see the mount-time fetch above for why this stays quiet.
      }
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // A whitelist, not "everything that is not the dev wallet": a role this
  // console does not know about is never swept into a bulk delete either.
  const bundle = wallets.filter((w) => w.role === roles.bundle);

  // What this table may draw AT ALL: the two roles belonging to the launcher
  // on screen, and nothing else.
  //
  // The keystore is one file holding both launchers, so /wallets returns every
  // wallet the user owns and the filtering is this console's job. Mapping the
  // raw list — which this table did — put v2's dev and bundle wallets in the
  // v1 table, each with a live delete and a Fund field wired to v1's run. The
  // separation is worth nothing if the screen still shows both sets, and a
  // funded wallet listed under the wrong launcher is a wallet somebody deletes
  // believing it is idle.
  const visible = wallets.filter((w) => w.role === roles.dev || w.role === roles.bundle);

  // How many sells each wallet keeps gas for, deliberately generous — a wallet
  // stuck holding tokens it cannot sell is worse than a slightly larger fund.
  const SELL_RESERVE = 10;

  // The most bundle wallets a launch can exempt: the forwarder appends its own
  // buy recipient, so the factory's 32 leaves room for 31 of ours. A 32nd is the
  // ExemptionListTooLong revert that stranded a bundle — so the count is capped
  // here too, not only refused at launch.
  const MAX_BUNDLE = 31;
  const bundleRoom = Math.max(0, MAX_BUNDLE - bundle.length);
  // How many bundle wallets actually hold ETH — the summary tiles state it so
  // "generated" and "funded" are not read as the same thing.
  const fundedBundle = bundle.filter((w) => Number(w.balanceEth) > 0).length;

  // What the dev wallet must hold to fund every buy: the total buy plus each
  // wallet's gas reserve. Shown live so a shortfall is a number seen up front
  // rather than a third of the bundle silently skipped at preflight for lack of
  // funds. The dev buy and the launch fee are on top of this and set elsewhere.
  const reservePerWallet = Number(gas?.buyGasEth || 0) + SELL_RESERVE * Number(gas?.sellGasEth || 0);
  const fundNeeded = Number(totalBuy) > 0 ? Number(totalBuy) + bundle.length * reservePerWallet : 0;

  // Split the typed total across the bundle wallets into a random, jittered
  // spread — no two the same, so the buys read as organic rather than a pattern
  // — and fill each row's Buy and Fund. Moves NO ETH: it only writes the table
  // fields the operator was going to type by hand. Both fields stay editable.
  async function distribute() {
    const total = Number(totalBuy);
    if (!(total > 0)) return notify('Enter a total buy amount first.', 'error');
    if (!bundle.length) return notify('Generate bundle wallets before distributing.', 'error');

    // Sizing the fund needs the gas cost; fetch it now if the initial load
    // failed, and only fall back to no reserve if the chain is unreachable.
    let g = gas;
    if (!g) {
      try {
        g = await api('/gas');
        setGas(g);
      } catch {
        g = { buyGasEth: '0', sellGasEth: '0' };
      }
    }
    const reserve = Number(g.buyGasEth || 0) + SELL_RESERVE * Number(g.sellGasEth || 0);

    // ±30% jitter around equal, normalised to the exact total; the rounding
    // drift is pushed onto the last wallet so the sum is exactly what was typed.
    const weights = bundle.map(() => 1 + (Math.random() - 0.5) * 0.6);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const amounts = bundle.map((_, i) => Math.round((weights[i] / wsum) * total * 1e6) / 1e6);
    const drift = Math.round((total - amounts.reduce((a, b) => a + b, 0)) * 1e6) / 1e6;
    amounts[amounts.length - 1] = Math.round((amounts[amounts.length - 1] + drift) * 1e6) / 1e6;

    bundle.forEach((w, i) => {
      const buy = amounts[i];
      setRow(w.id, { mode: 'fixed', buy: String(buy), fund: (buy + reserve).toFixed(6) });
    });
    report(
      `distributed ${total} ETH across ${bundle.length} wallets — each funded for its buy plus gas for ` +
        `${SELL_RESERVE} sells. Nothing was sent; edit any row, then Fund and launch as usual.`
    );
    notify(`Filled ${bundle.length} wallets for ${total} ETH. No ETH moved — edit, then Fund.`, 'ok');
  }

  // The delete list is derived from the bundle wallets and intersected with the
  // ticks, never read out of the tick set directly. The dev wallet signs every
  // launch and holds the funds, so it is kept out of the bulk path by
  // construction rather than by remembering to check: it is given no checkbox,
  // select-all only ever adds bundle ids, and an id that reached the set some
  // other way still cannot survive this filter.
  const chosen = bundle.filter((w) => picked.has(w.id));
  const chosenEth = chosen.reduce((s, w) => s + Number(w.balanceEth || 0), 0);
  const chosenFunded = chosen.filter((w) => Number(w.balanceEth) > 0);

  const allPicked = bundle.length > 0 && chosen.length === bundle.length;
  const somePicked = chosen.length > 0 && !allPicked;

  // indeterminate is a property, not an attribute — JSX cannot set it.
  const allBox = useRef(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = somePicked;
  }, [somePicked]);

  // A wallet that has gone — deleted here, or from another tab — must not stay
  // ticked. The set feeds a delete loop, so an id that is no longer a bundle
  // wallet has no business in it.
  useEffect(() => {
    setPicked((prev) => {
      if (!prev.size) return prev;
      const live = new Set(wallets.filter((w) => w.role === roles.bundle).map((w) => w.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [wallets]);

  function tick(id, on) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Delete wallets one at a time.
   *
   * There is no bulk endpoint, and these are deliberately not fired at once:
   * every DELETE rewrites the whole keystore file, and a failure has to be
   * attributable to one wallet rather than to "the batch". The list is
   * refreshed once at the end instead of after each one.
   */
  async function runDeletes(list) {
    setBusy('delete');
    setOutcome(null);
    const results = [];
    for (const w of list) {
      setNow(w.id);
      try {
        await api(`/wallets/${w.id}`, 'DELETE');
        results.push({ id: w.id, address: w.address, ok: true });
      } catch (err) {
        results.push({ id: w.id, address: w.address, ok: false, error: err.message });
      }
    }
    setNow('');
    setPicked(new Set());
    setOutcome(results);

    const failed = results.filter((r) => !r.ok);
    // Recorded in the readout like everything else. Nothing pulls the page down
    // to it — the operator deletes several in a row and the table is where the
    // next click is — and the same counts are drawn under this table anyway.
    report({
      deleted: results.length - failed.length,
      failed: failed.length,
      wallets: results.map((r) => ({
        address: r.address,
        status: r.ok ? 'deleted' : 'failed',
        ...(r.error ? { error: r.error } : {}),
      })),
    });

    // The deletes have already happened and are already reported; a refresh
    // that fails must not leave the panel stuck on "working…".
    await reload().catch(() => {});
    setBusy('');
  }

  // The share figures, keyed by wallet so a row can find its own. Order is
  // firing order and on a v2 curve the order IS the price, so this is a lookup
  // into a sequence, never a per-row calculation.
  const legs = new Map((share?.buys || []).map((l) => [l.key, l]));
  // Rows the operator asked to spend the whole balance on. Their real amount is
  // resolved server-side after gas, so the figures for them are ceilings on top
  // of a ceiling — said once, under the table, rather than on every row.
  // Whitelist, for the reason given above `bundle` — and now literally: the V2
  // roles exist, and "not the dev wallet" would count them here.
  const allMode = wallets.filter((w) => w.role === roles.bundle && rows[w.id]?.mode === 'all').length;
  // Wallets with something to buy. A zero-amount leg is kept in the sequence —
  // it moves nothing, so dropping it would change nothing — but it is not a
  // wallet that is buying, and counting it as one would misstate the bundle.
  const buyingCount = (share?.buys || []).filter((b) => b.estBps > 0).length;

  // What the delete dialog is asking about, and the figures it has to state.
  const pending = deleting || [];
  const pendingEth = pending.reduce((s, w) => s + Number(w.balanceEth || 0), 0);
  const pendingFunded = pending.filter((w) => Number(w.balanceEth) > 0);
  const one = pending.length === 1 ? pending[0] : null;

  return (
    <Step {...step}>
      <p className="lede">
        Each bundle wallet buys behind the dev buy, and each is capped at 5% of supply inside the
        restriction window. More wallets is how a bundle gets bigger without any one of them
        breaching that cap. The table below is where the whole run is sized: what each wallet is
        funded with in step 4, what it buys in step 5, and what that comes to as a share of supply.
      </p>

      {/* The run at a glance, across the top of the step: the two counts and the
          two figures the bundle is judged by, lifted out of the table and the
          breakdown notice so the shape of it reads before the detail does. The
          grid stretches the tiles the full width of the card, so the summary is
          also what fills the head of the panel. Read-only — every value here is
          already computed below; nothing new is fetched or decided. */}
      <div className="stats">
        <div className="stat">
          <span>Bundle wallets</span>
          <b>
            {bundle.length} <span className="stat-of">/ {MAX_BUNDLE}</span>
          </b>
        </div>
        <div className="stat">
          <span>Funded</span>
          <b>
            {fundedBundle} <span className="stat-of">of {bundle.length}</span>
          </b>
        </div>
        <div className="stat">
          <span>Bundle buy</span>
          <b>{share && Number(share.bundle.eth) > 0 ? `${share.bundle.eth} ETH` : '—'}</b>
        </div>
        <div
          className={`stat ${
            share?.marketCap && Number(share.marketCap.finalEth) > 0 ? 'ok' : ''
          }`}
        >
          <span>Predicted MC</span>
          <b>
            {share?.marketCap && Number(share.marketCap.finalEth) > 0
              ? usdMc(share.marketCap.finalEth, ethPrice) ||
                `${Number(share.marketCap.finalEth).toFixed(3)} ETH`
              : '—'}
          </b>
        </div>
      </div>

      <div className="row">
        {/* Amber, for the same reason step 1's generate is: this is the forward
            action of step 3, and it sat grey among four other grey controls. */}
        <Busy
          className="btn-primary"
          busy={busy === 'bundle'}
          disabled={bundleRoom === 0}
          title={bundleRoom === 0 ? `at the ${MAX_BUNDLE}-wallet limit — delete some to add more` : ''}
          onClick={() =>
            act('bundle', () =>
              api('/wallets/generate', 'POST', {
                count: Math.min(Number(count) || 1, bundleRoom),
                role: roles.bundle,
                label: roles.bundle,
              })
            )
          }
        >
          Generate bundle wallets
        </Busy>
        <input
          type="number"
          min="1"
          max={bundleRoom || 1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          title="how many"
        />
        <span className="hint">
          {bundle.length}/{MAX_BUNDLE} bundle wallets{bundleRoom > 0 ? ` · room for ${bundleRoom} more` : ' · full'}
        </span>
        <button className="ghost" onClick={() => setShowImport((v) => !v)}>
          Import bundle keys
        </button>
        {/* .quiet: a pure re-read. It changes nothing on chain, on disk or in
            the keystore, so it should not look like the two controls beside it
            that generate and import keys. */}
        <Busy
          busy={busy === 'reload'}
          className="quiet"
          onClick={() => act('reload', async () => 'balances refreshed')}
        >
          Refresh balances
        </Busy>

        {/* V1 ONLY. V2 has no claim-seasoned endpoint — re-roling a V4 seed
            into v2's bundle role would use the wrong role and there is no way
            back short of the keystore archive. See the mount-time fetch above. */}
        {variant === 'v1' && (
          <>
            <input
              type="number"
              min="1"
              max={seasoned.count || 1}
              value={seasonedCount}
              onChange={(e) => setSeasonedCount(e.target.value)}
              title="how many seasoned wallets to claim"
              style={{ width: 70 }}
            />
            <Busy
              busy={busy === 'claim-seasoned'}
              className="ghost"
              disabled={!seasoned.count}
              title={seasoned.count ? '' : 'no seasoned wallets ready yet'}
              onClick={claimSeasoned}
            >
              Use {seasonedCount} seasoned wallets
            </Busy>
            <span className="hint">{seasoned.count} seasoned ready</span>
          </>
        )}

        <span className="spacer" />

        {/* The same control, and the same typed confirmation, as the one beside
            the dev wallet's delete in step 1 — one component, drawn in both
            places, because both delete dialogs name a backup as the thing that
            makes the delete survivable. */}
        <BackupControls wallets={wallets} report={report} />
      </div>

      {/* No role here. These are bundle keys: the dev key is imported in step 1,
          beside the dev wallet it replaces and the delete that made room. */}
      {showImport && (
        <div className="row">
          <textarea
            rows="3"
            placeholder="bundle wallet private keys, one per line"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
          <Busy
            busy={busy === 'import'}
            onClick={() =>
              act('import', async () => {
                const made = await api('/wallets/import', 'POST', {
                  privateKeys: keys.split('\n'),
                  role: roles.bundle,
                });
                setKeys('');
                return made;
              })
            }
          >
            Import
          </Busy>
        </div>
      )}

      {bundle.length > 0 && (
        <div className="distribute">
          <b className="distribute-title">Auto-fill buys</b>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            Total buy
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.5"
              value={totalBuy}
              onChange={(e) => setTotalBuy(e.target.value)}
              style={{ width: 90 }}
            />
            ETH
          </label>
          {/* Deliberately NOT the amber default: amber in this console means a
              spend, and this only writes fields. Ghost, like Generate/Import. */}
          <Busy className="ghost" disabled={!(Number(totalBuy) > 0)} onClick={distribute}>
            Distribute across {bundle.length} wallet{bundle.length === 1 ? '' : 's'}
          </Busy>
          <span className="hint">
            random split · each funded for its buy + gas for {SELL_RESERVE} sells · fields stay editable ·
            moves no ETH
          </span>
          {fundNeeded > 0 && (
            <div className="distribute-fund">
              Dev wallet needs ≈ <b>{fundNeeded.toFixed(4)} ETH</b> to fund all {bundle.length} buys
              <span className="hint">
                {' '}
                ({Number(totalBuy).toFixed(4)} buys + {(bundle.length * reservePerWallet).toFixed(4)} gas
                reserve) — your dev buy and the launch fee are on top. Underfunded wallets are skipped.
              </span>
            </div>
          )}
        </div>
      )}

      <div className="table-scroll">
        <table className="wallet-list">
          <thead>
            <tr>
              <th>
                {/* Selects the bundle wallets and only ever the bundle wallets;
                    the dev wallet is not in this list at all. */}
                <input
                  ref={allBox}
                  type="checkbox"
                  checked={allPicked}
                  disabled={!bundle.length || busy === 'delete'}
                  title="select every bundle wallet"
                  onChange={(e) =>
                    setPicked(e.target.checked ? new Set(bundle.map((b) => b.id)) : new Set())
                  }
                />
              </th>
              <th>Role</th>
              <th>Address</th>
              <th>Balance</th>
              <th>Fund (ETH)</th>
              <th>Buy mode</th>
              <th>Buy (ETH)</th>
              {/* Not "Est. share": on v2 it is not an estimate. The ~ on each
                  figure is what says which one this is. */}
              <th>Supply share</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan="9" className="empty">
                  No wallets yet. Generate the bundle wallets above — the dev wallet from step 1
                  appears here too.
                </td>
              </tr>
            )}
            {visible.map((w) => {
              const row = rows[w.id] || {};
              const isDev = w.role === roles.dev;
              const bal = Number(w.balanceEth);
              return (
                <tr key={w.id}>
                  <td>
                    {/* No checkbox on the dev wallet — not a disabled one, none.
                        It signs the launch and holds the funds, and the bulk
                        delete must have no path to it, accidental or otherwise. */}
                    {w.role === roles.bundle && (
                      <input
                        type="checkbox"
                        checked={picked.has(w.id)}
                        disabled={busy === 'delete'}
                        title="select for bulk delete"
                        onChange={(e) => tick(w.id, e.target.checked)}
                      />
                    )}
                  </td>
                  <td>
                    <span className={`role ${w.role}`}>{w.role}</span>
                  </td>
                  {/* Shortened, with the full address on hover and on the copy
                      button beside it. This column was 326px of unbreakable hex
                      — a third of the table, and the reason the delete column
                      was painted outside the card. The row's × still opens a
                      dialog that states the whole address, and the delete is
                      keyed by w.id, so nothing here is decided from the
                      shortened text. */}
                  <td className="addr">
                    <Address value={w.address} />
                  </td>
                  <td>
                    <span className={`bal ${bal === 0 ? 'zero' : ''}`}>{bal.toFixed(6)}</span>
                  </td>
                  <td>
                    {!isDev && (
                      <input
                        type="number"
                        step="0.0001"
                        placeholder="0.0"
                        value={row.fund ?? ''}
                        onChange={(e) => setRow(w.id, { fund: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {!isDev && (
                      <select
                        value={row.mode ?? 'fixed'}
                        onChange={(e) => setRow(w.id, { mode: e.target.value })}
                      >
                        <option value="fixed">fixed</option>
                        <option value="all">all − gas</option>
                      </select>
                    )}
                  </td>
                  <td>
                    {!isDev && (
                      <input
                        type="number"
                        step="0.0001"
                        placeholder="0.0"
                        // "all − gas" is resolved server-side from the live
                        // balance, so an amount here would be meaningless.
                        disabled={row.mode === 'all'}
                        value={row.mode === 'all' ? '' : row.buy ?? ''}
                        onChange={(e) => setRow(w.id, { buy: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {/* The dev row shows the dev buy, which is not typed here at
                        all — it is set in step 5 and it executes FIRST, inside
                        the launch transaction. On a curve that matters: it moves
                        the price every bundle wallet then pays. */}
                    {isDev ? (
                      <Share
                        leg={share?.dev}
                        exact={share?.exact}
                        title={`the dev buy, made inside the launch itself and before every bundle buy — ≈${tokens(
                          share?.dev?.estTokens
                        )} tokens`}
                      />
                    ) : (
                      <Share leg={legs.get(w.id)} exact={share?.exact} />
                    )}
                    {/* The market cap this row's buy walks the curve to, landing
                        in order behind the dev buy. Updates as the amount is
                        typed. */}
                    {(() => {
                      const mcEth = isDev ? share?.dev?.mcEth : legs.get(w.id)?.mcEth;
                      if (!(Number(mcEth) > 0)) return null;
                      const dollars = usdMc(mcEth, ethPrice);
                      return (
                        <div className="mc-row hint" title={`predicted market cap after this buy — ${mcEth} ETH`}>
                          MC {dollars ? `${dollars} · ` : ''}
                          {Number(mcEth).toFixed(3)} ETH
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    <Busy
                      busy={now === w.id}
                      className="ghost"
                      disabled={busy === 'delete'}
                      title="delete this wallet"
                      onClick={() => setDeleting([w])}
                    >
                      ×
                    </Busy>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The bundle total, next to the amounts that make it, and honest about
          how much it can be trusted. This is the question the operator has been
          answering by launching and looking afterwards. */}
      {share && (share.bundle.bps > 0 || share.dev) && (
        <div className={`notice ${share.over.length || share.graduation?.crosses ? 'danger' : ''}`}>
          {/* The figure the whole run is sized against, and until now one
              silkscreen label among the several in this box. It is given size
              and weight rather than a colour: every colour in this console
              names a state, and "this is the one that decides the launch" is
              not a state. The dev buy stays at label size beside it — it is
              context for this number, not a second headline.

              Wrapped in one span because this h3 is a flex row: an element
              child of it becomes a flex item, and the figure would be laid out
              beside the words rather than inside the sentence. */}
          <h3>
            <span>
              bundle takes{' '}
              <b className="tally">
                {share.exact ? '' : '≈'}
                {pct(share.bundle.bps)}
              </b>{' '}
              of supply
              {share.dev ? ` · dev buy ${share.exact ? '' : '≈'}${pct(share.dev.estBps)} first` : ''}
            </span>
            {/* The predicted market cap the whole bundle reaches — the figure
                the launch is really being sized for. Live: it moves with every
                amount typed above. Dollars for reading, ETH for the exact
                number the curve fixes. */}
            {share.marketCap && Number(share.marketCap.finalEth) > 0 && (
              <span className="mc-headline">
                predicted MC{' '}
                <b className="tally">
                  {usdMc(share.marketCap.finalEth, ethPrice) || `${Number(share.marketCap.finalEth).toFixed(3)} ETH`}
                </b>
                <span className="hint">
                  {Number(share.marketCap.finalEth).toFixed(3)} ETH · opens{' '}
                  {usdMc(share.marketCap.openingEth, ethPrice) ||
                    `${Number(share.marketCap.openingEth).toFixed(3)} ETH`}
                </span>
              </span>
            )}
          </h3>

          {share.marketCap && (
            <label className="hint mc-price" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              1 ETH = $
              <input
                type="number"
                value={ethPrice}
                min="0"
                step="1"
                onChange={(e) => {
                  manualRef.current = true;
                  setEthPrice(e.target.value);
                }}
                style={{ width: 90 }}
              />
              {priceLive ? (
                manualRef.current && Number(ethPrice).toFixed(2) !== Number(priceLive.usd).toFixed(2) ? (
                  <button
                    type="button"
                    className="link"
                    title={`live ${priceLive.source}${priceLive.stale ? ' (stale)' : ''} price`}
                    onClick={() => {
                      manualRef.current = false;
                      setEthPrice(Number(priceLive.usd).toFixed(2));
                    }}
                  >
                    ↻ use live ${Number(priceLive.usd).toFixed(2)}
                  </button>
                ) : (
                  <span title={`from ${priceLive.source}, refreshes each minute`}>
                    {priceLive.stale ? 'last known' : 'live'} · {priceLive.source}
                  </span>
                )
              ) : (
                <span>— sets the dollar figures; the ETH figures are exact</span>
              )}
            </label>
          )}
          <ul>
            <li>
              {buyingCount} wallet{buyingCount === 1 ? '' : 's'} · {share.bundle.eth} ETH · ≈
              {tokens(share.bundle.tokens)} tokens
              {share.dev
                ? ` · ${share.total.eth} ETH and ${share.exact ? '' : '≈'}${pct(
                    share.total.bps
                  )} counting the dev buy`
                : ''}
            </li>

            {/* The total is one figure and the rows are ranges, and the
                difference between those two is not a hedge — it is the only
                thing about a bundle that is genuinely unknown before it is
                fired. Say it once, here, rather than per row. */}
            <li>
              The total does not depend on the order they land in: the same ETH across more
              wallets buys the same tokens between them. What the order decides is the SPLIT, so
              each row is a range — landing first, behind only the dev buy, to landing last,
              behind the whole rest of the bundle. They are broadcast together and the sequencer
              picks.
            </li>

            {/* v1 and v2 are not equally knowable and the panel must not
                pretend otherwise. One is arithmetic, the other is the best
                reading available before a pool exists. */}
            {share.exact ? (
              <li>
                Exact — the curve is a constant product against the config's phantom reserve, both
                fixed before the launch is sent, and the dev buy is taken off it first.
              </li>
            ) : (
              <li>
                Estimate — there is no pool until the launch runs, so this walks the pool the
                config opens: the whole supply at its initial tick. The bundle's own price impact
                is in these figures; the pool's 1% fee is not, and a real v3 position is not quite
                a constant product, so they still read a little HIGH.
              </li>
            )}

            {allMode > 0 && (
              <li>
                {allMode} wallet{allMode === 1 ? '' : 's'} on “all − gas” — counted at the whole
                balance, because the amount is only resolved after gas at preflight.
              </li>
            )}

            {/* A buy over the launch-window cap does not clamp: it reverts,
                spends its gas and buys nothing. */}
            {share.over.length > 0 && (
              <li>
                {share.over.length} wallet{share.over.length === 1 ? '' : 's'} over the{' '}
                {share.caps.maxWalletBps / 100}% wallet cap or {share.caps.maxTxBps / 100}% per-buy
                cap — {share.over.length === 1 ? 'that buy REVERTS' : 'those buys REVERT'} inside the
                restriction window and{' '}
                {share.over.length === 1 ? 'wastes its gas' : 'waste their gas'}:{' '}
                {share.over
                  .slice(0, 4)
                  .map((id) => wallets.find((w) => w.id === id)?.address || id)
                  .join(', ')}
                {share.over.length > 4 ? ` …and ${share.over.length - 4} more` : ''}. Measured at
                the pool's opening price — above the range beside it, and the same yardstick
                preflight uses. A cap breach reverts, so this one errs early on purpose.
              </li>
            )}

            {share.graduation?.crosses && (
              <li>
                {share.graduation.raisedEth} ETH into the curve reaches the{' '}
                {share.graduation.thresholdEth} ETH graduation threshold — this bundle graduates the
                curve on the way in, and a graduated launch cannot be exited through the curve.
              </li>
            )}
          </ul>
        </div>
      )}

      {chosen.length > 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          <Busy busy={busy === 'delete'} className="danger" onClick={() => setDeleting(chosen)}>
            Delete {chosen.length} wallet{chosen.length === 1 ? '' : 's'}
          </Busy>
          <button
            className="link"
            disabled={busy === 'delete'}
            onClick={() => setPicked(new Set())}
          >
            clear selection
          </button>
          {/* The balance is on the bar as well as in the dialog: an operator
              who ticks a funded wallet should see it before the click, not
              only in the thing they are about to dismiss. */}
          <span className="hint">
            {eth(chosenEth)} ETH selected
            {chosenFunded.length > 0 &&
              ` · ${chosenFunded.length} of ${chosen.length} hold${
                chosenFunded.length === 1 ? 's' : ''
              } ETH — sweep first`}
          </span>
        </div>
      )}

      {/* The outcome of the last delete, in the panel that ran it. The Result
          panel has it too, but it is a page down and this action no longer
          scrolls there. */}
      {outcome && (
        <div className={`notice ${outcome.some((r) => !r.ok) ? 'danger' : ''}`}>
          <h3>
            {outcome.filter((r) => r.ok).length} of {outcome.length} deleted
            {outcome.some((r) => !r.ok) ? ` · ${outcome.filter((r) => !r.ok).length} failed` : ''}
          </h3>
          <ul>
            {outcome.every((r) => r.ok) && (
              <li>
                Out of the keystore, and their keys are in the archive on the server — if any of
                that was a mistake, <code>npm run archive:restore</code> there is the way back.
              </li>
            )}
            {outcome
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.id}>
                  {r.address} — {r.error}. Still in the keystore; try again.
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Still vermilion, though the keys survive in the archive. What this
          dialog warns about has not changed: funded wallets go out of reach of
          everything in this console until somebody deliberately puts them back,
          and twelve of them go at once. "A second click could undo it" is the
          test for dropping the colour, and the way back is now a shell command
          on the server — the opposite of a second click. One dialog for one
          wallet and for twelve. */}
      <Modal
        open={pending.length > 0}
        danger
        title={one ? 'Delete this wallet?' : `Delete ${pending.length} bundle wallets?`}
        question={null}
        confirmLabel={`Delete ${pending.length} wallet${pending.length === 1 ? '' : 's'}`}
        onConfirm={() => {
          const list = pending;
          setDeleting(null);
          if (list.length) runDeletes(list);
        }}
        onCancel={() => setDeleting(null)}
      >
        <div className="modal-facts">
          {one ? (
            <>
              <Fact label="Address" mono>
                {one.address}
              </Fact>
              <Fact label="Role">{one.role}</Fact>
              <Fact label="Balance">{eth(one.balanceEth)} ETH</Fact>
            </>
          ) : (
            <>
              <Fact label="Wallets">{pending.length} bundle wallets</Fact>
              <Fact label="Total balance">{eth(pendingEth)} ETH</Fact>
              <Fact label="Holding ETH">
                {pendingFunded.length} of {pending.length}
              </Fact>
            </>
          )}
        </div>

        {/* Said plainly, because the alternative is a surprise in the wrong
            direction: an operator deleting an exposed key expects it gone, and
            it is not. It is archived — encrypted exactly as the keystore is,
            under the same passphrase.

            The archive is not on this console and not on the API at all, so
            this dialog cannot offer the way back; it names it instead. Pointing
            at an affordance that is not there would be worse than saying
            nothing. The cap is stated for the same reason the archiving is: the
            operator is owed the true version of what a delete does, and at 100
            deletions the oldest key is destroyed to make room. */}
        <p>
          {one ? 'The key is' : 'The keys are'} <b>archived, not destroyed</b>.{' '}
          {one ? 'This wallet leaves' : 'These wallets leave'} the keystore and{' '}
          {one ? 'its key moves' : 'their keys move'} to an archive beside it, encrypted the same
          way under the same passphrase. Nothing in this console can reach{' '}
          {one ? 'it' : 'them'}: restoring is <code>npm run archive:restore</code> on the server,
          and <code>npm run archive:purge</code> there is what erases a key for good.
        </p>
        <p className="hint">
          The archive keeps the last 100 deletions per user. Past that, each delete destroys the
          oldest archived key — the activity log records it by address.
        </p>

        {/* The balance is the part that is not merely inconvenient. An archived
            wallet is one nothing in this console can sign for — funding,
            launching and sell-all all read the live keystore — so the balance is
            out of reach until it is restored, and gone for good if it is purged.
            Sweep is one step below and takes seconds, so the dialog names it
            rather than leaving the operator to remember it after the fact. */}
        {pendingFunded.length > 0 && (
          <div className="notice danger">
            <h3>
              {pendingFunded.length === 1
                ? one
                  ? 'This wallet holds ETH'
                  : '1 of these wallets holds ETH'
                : `${pendingFunded.length} of these wallets hold ETH`}
            </h3>
            <ul>
              {/* Two words carry this dialog: how much, and that it stops being
                  spendable. Everything around them is procedure — where the ETH
                  does not go, what to run instead — and procedure read at the
                  same weight as the amount is how an operator confirms a funded
                  delete having seen only the shape of a warning. */}
              <li>
                <b className="crux">{eth(pendingEth)} ETH</b> becomes{' '}
                <b className="crux">unspendable</b> the moment{' '}
                {one ? 'this wallet is' : 'these wallets are'} archived, and stays that way until{' '}
                {one ? 'it is' : 'they are'} restored from the server. Purging the archived{' '}
                {one ? 'key' : 'keys'} there burns it permanently.
                {one?.role !== 'dev' && ' Deleting does not return it to the dev wallet.'}
              </li>
              {/* Sweep pulls funds INTO the dev wallet, so it is no answer for
                  the dev wallet itself — and that is the one row where the
                  balance is usually largest. */}
              {one?.role === roles.dev ? (
                <li>
                  This is the dev wallet. Sweep moves funds into it, not out, so nothing in this
                  console can rescue this balance — send it somewhere you control first.
                </li>
              ) : (
                <li>
                  Cancel, run <b>Sweep back to dev</b> in step 4, then delete — it empties{' '}
                  {one ? 'the wallet' : 'these wallets'} into the dev wallet first.
                </li>
              )}
              {!one &&
                pendingFunded.slice(0, 6).map((w) => (
                  <li key={w.id}>
                    {w.address} — {eth(w.balanceEth)} ETH
                  </li>
                ))}
              {!one && pendingFunded.length > 6 && (
                <li>…and {pendingFunded.length - 6} more with a balance.</li>
              )}
            </ul>
          </div>
        )}

        {/* The wallet list carries a native balance and nothing else, so this
            dialog can only ever speak for ETH. It says so rather than letting
            "0.000000 ETH" be read as "empty".

            Step 6 is only an answer for a BUNDLE wallet. findSellable is called
            with ks.bundleWallets(), filtered to role === 'bundle', so sell-all
            has never touched the dev wallet and never will — telling an operator
            about to delete it to "sell it in step 6 first" sent them to a panel
            that would list nothing of theirs. The dev row's × opens this same
            dialog, so the branch has to be here. */}
        {one?.role === roles.dev ? (
          <p className="hint">
            Token balances are not in this table and are not counted above. Step 6 sells what the
            bundle wallets hold and never touches this one — a launched token sitting here has to be
            moved out the same way as the ETH.
          </p>
        ) : (
          <p className="hint">
            Token balances are not in this table and are not counted above. If{' '}
            {one ? 'this wallet' : 'any of these'} still holds a launched token, sell it in step 6
            first.
          </p>
        )}
      </Modal>
    </Step>
  );
}
