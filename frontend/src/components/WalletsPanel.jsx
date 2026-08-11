import { useEffect, useRef, useState } from 'react';
import { api, downloadBackup } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';
import Share, { pct, tokens } from './Share.jsx';

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
 */
export default function WalletsPanel({ step, wallets, rows, setRow, share, reload, report }) {
  const [count, setCount] = useState(5);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [importRole, setImportRole] = useState('bundle');
  const [busy, setBusy] = useState('');
  // 'json' | 'csv' while the export confirmation is open, '' otherwise, plus
  // whatever has been typed into it so far.
  const [exporting, setExporting] = useState('');
  const [typed, setTyped] = useState('');
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

  // A whitelist, not "everything that is not the dev wallet": a role this
  // console does not know about is never swept into a bulk delete either.
  const bundle = wallets.filter((w) => w.role === 'bundle');

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
      const live = new Set(wallets.filter((w) => w.role === 'bundle').map((w) => w.id));
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

  // Opens the typed confirmation. Nothing is exported from here.
  function backup(format) {
    setTyped('');
    setExporting(format);
  }

  // The share figures, keyed by wallet so a row can find its own. Order is
  // firing order and on a v2 curve the order IS the price, so this is a lookup
  // into a sequence, never a per-row calculation.
  const legs = new Map((share?.buys || []).map((l) => [l.key, l]));
  // Rows the operator asked to spend the whole balance on. Their real amount is
  // resolved server-side after gas, so the figures for them are ceilings on top
  // of a ceiling — said once, under the table, rather than on every row.
  const allMode = wallets.filter((w) => w.role !== 'dev' && rows[w.id]?.mode === 'all').length;
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

      <div className="row">
        <Busy
          busy={busy === 'bundle'}
          className="ghost"
          onClick={() =>
            act('bundle', () =>
              api('/wallets/generate', 'POST', {
                count: Number(count) || 1,
                role: 'bundle',
                label: 'bundle',
              })
            )
          }
        >
          Generate bundle wallets
        </Busy>
        <input
          type="number"
          min="1"
          max="100"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          title="how many"
        />
        <button className="ghost" onClick={() => setShowImport((v) => !v)}>
          Import keys
        </button>
        <Busy
          busy={busy === 'reload'}
          className="ghost"
          onClick={() => act('reload', async () => 'balances refreshed')}
        >
          Refresh balances
        </Busy>

        <span className="spacer" />

        <Busy
          busy={busy === 'backup'}
          className="ghost"
          disabled={!wallets.length}
          onClick={() => backup('json')}
        >
          Download backup
        </Busy>
        <button className="link" disabled={!wallets.length} onClick={() => backup('csv')}>
          as CSV
        </button>
      </div>

      {showImport && (
        <div className="row">
          <textarea
            rows="3"
            placeholder="private keys, one per line"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
          <select value={importRole} onChange={(e) => setImportRole(e.target.value)}>
            <option value="bundle">bundle</option>
            <option value="dev">dev</option>
          </select>
          <Busy
            busy={busy === 'import'}
            onClick={() =>
              act('import', async () => {
                const made = await api('/wallets/import', 'POST', {
                  privateKeys: keys.split('\n'),
                  role: importRole,
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
          {wallets.length === 0 && (
            <tr>
              <td colSpan="9" className="empty">
                No wallets yet. Generate the bundle wallets above — the dev wallet from step 1
                appears here too.
              </td>
            </tr>
          )}
          {wallets.map((w) => {
            const row = rows[w.id] || {};
            const isDev = w.role === 'dev';
            const bal = Number(w.balanceEth);
            return (
              <tr key={w.id}>
                <td>
                  {/* No checkbox on the dev wallet — not a disabled one, none.
                      It signs the launch and holds the funds, and the bulk
                      delete must have no path to it, accidental or otherwise. */}
                  {w.role === 'bundle' && (
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
                <td className="addr">{w.address}</td>
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
          </h3>
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
            {outcome.every((r) => r.ok) && <li>Their keys are gone from the keystore.</li>}
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

      {/* Typed confirmation, not a click-through: this hands over every key the
          console holds, and a mis-click should not be enough to do it. */}
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
          act('backup', () => downloadBackup(format));
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

      {/* Deleting a wallet erases its key, so it carries the vermilion: there
          is no undo and no second copy unless a backup was taken. One dialog
          for one wallet and for twelve — a funded wallet is burned just as
          completely either way, and one warning is one thing to keep right. */}
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

        <p>
          {one ? 'Its private key is' : 'Their private keys are'} destroyed — erased from the
          keystore, which holds raw keys and no mnemonic, so nothing here can regenerate{' '}
          {one ? 'it' : 'them'}. Afterwards {one ? 'this wallet is' : 'these wallets are'}{' '}
          recoverable only from a backup already downloaded.
        </p>

        {/* The balance is the part that is not merely inconvenient. A key that
            no longer exists is a wallet nobody can ever spend from, so whatever
            sits in it is burned — not returned to the dev wallet, not reachable
            by re-importing anything. Sweep is one step below and takes seconds,
            so the dialog names it rather than leaving the operator to remember
            it after the fact. */}
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
              {/* Two words carry this dialog: how much, and that it does not
                  come back. Everything around them is procedure — where the
                  ETH does not go, what to run instead — and procedure read at
                  the same weight as the amount is how an operator confirms a
                  funded delete having seen only the shape of a warning. */}
              <li>
                <b className="crux">{eth(pendingEth)} ETH</b> goes with the keys and is{' '}
                <b className="crux">burned permanently</b>.
                {one?.role !== 'dev' && ' Deleting does not return it to the dev wallet.'}
              </li>
              {/* Sweep pulls funds INTO the dev wallet, so it is no answer for
                  the dev wallet itself — and that is the one row where the
                  balance is usually largest. */}
              {one?.role === 'dev' ? (
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
            "0.000000 ETH" be read as "empty". */}
        <p className="hint">
          Token balances are not in this table and are not counted above. If{' '}
          {one ? 'this wallet' : 'any of these'} still holds a launched token, sell it in step 6
          first.
        </p>
      </Modal>
    </Step>
  );
}
