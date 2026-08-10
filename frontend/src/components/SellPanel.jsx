import { useEffect, useState } from 'react';
import { LuTriangleAlert } from 'react-icons/lu';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';

/**
 * Step 6 — exit a launched token from every bundle wallet at once.
 *
 * It used to be a collapsed disclosure below the Result, on the reasoning that
 * selling is not part of the launch. That reasoning had a cost: the last thing
 * an operator does, and the only other thing in this console that is both
 * irreversible and unpriced, was the one panel a first-time user never found.
 * It is a numbered step in the order of work, at the end, where it belongs.
 *
 * Opening it up also puts the missing-slippage-floor warning permanently on
 * screen instead of behind a summary nobody expands.
 *
 * The candidate list is chosen by the backend as launched-by-dev INTERSECT
 * held-by-bundle. Never by balance alone: a dusted wallet would otherwise offer
 * an unknown contract for approval by every funded wallet at once.
 */

// Token and ETH amounts arrive as decimal strings, like balanceEth elsewhere.
function amount(v, dp = 4) {
  const x = Number(v);
  if (!Number.isFinite(x)) return String(v ?? '—');
  return x.toLocaleString(undefined, { maximumFractionDigits: dp });
}

// Fills are ETH per token — small enough that fixed decimals round them to zero.
function price(v) {
  const x = Number(v);
  if (!Number.isFinite(x) || x === 0) return '—';
  return x < 0.0001 ? x.toExponential(3) : x.toFixed(8);
}

// The picker's wallet field is a count; tolerate a list in case it is one.
const walletCount = (t) => (Array.isArray(t?.wallets) ? t.wallets.length : Number(t?.wallets || 0));

// Where a row's sell will actually go. The backend decides this — the operator
// never picks — so this only names the decision it already made.
function routeLabel(t) {
  if (t?.route === 'swap-router') return 'v1 pool — sells through the swap router';
  if (t?.graduated) return 'graduated — sells into the Uniswap pool';
  return 'bonding — sells back to the curve';
}

export default function SellPanel({ step, explorer, credential, live, reload, report, onState }) {
  const [list, setList] = useState(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState('');
  // What the confirmation is asking about, frozen at the moment it opened, so
  // the figures on screen are the ones the sell is built from. Null means no
  // dialog is open — and no dialog open means no sell can be sent.
  const [pending, setPending] = useState(null);

  async function load() {
    try {
      setList(await api('/sellable'));
      setError('');
      setMissing(false);
    } catch (err) {
      // The route may simply not exist in this build. That is not an error the
      // operator can act on, so the whole panel goes away instead.
      if (/\b404\b/.test(err.message)) setMissing(true);
      setError(err.message);
    }
  }

  // Re-read when the credential changes, not just on mount: it decides whether
  // this route may be read at all, and the panel mounts before a key is pasted.
  // A key restored from sessionStorage is there on the first render already.
  useEffect(() => {
    const t = setTimeout(load, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential]);

  const rows = Array.isArray(list) ? list : [];
  const selected = rows.find((r) => r.token === token) || null;

  // The sequence at the top of the page needs to say whether there is anything
  // left to sell. It comes from the fetch this panel already made — the step
  // does not get its own request.
  useEffect(() => {
    onState?.(list);
  }, [list]);

  // A token that has been sold out drops off the list; the selection has to
  // drop with it or the buttons would fire at something no wallet holds.
  useEffect(() => {
    if (!rows.length) {
      if (token) setToken('');
      return;
    }
    if (!rows.some((r) => r.token === token)) setToken(rows[0].token);
  }, [list]);

  // The plan and the result belong to one token; keeping either across a change
  // of selection would show last token's wallets under this token's name.
  useEffect(() => {
    setPlan(null);
    setResult(null);
    setArmed(false);
    // A dialog left open across a change of selection would be asking about
    // the previous token under the new token's name.
    setPending(null);
  }, [token]);

  async function act(name, fn) {
    setBusy(name);
    try {
      const res = await fn();
      report(res);
      return res;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      return null;
    } finally {
      setBusy('');
    }
  }

  function preflight() {
    act('preflight', async () => {
      const res = await api('/sell/preflight', 'POST', { token });
      setPlan(res);
      setResult(null);
      return res;
    });
  }

  // Opens the confirmation. Nothing is sent from here; only the dialog's
  // confirm button reaches fire().
  function sell() {
    if (!token) return;
    setPending({
      token,
      symbol: selected?.symbol || plan?.symbol || 'this token',
      count: plan ? plan.wallets.length : walletCount(selected),
    });
  }

  function fire() {
    const p = pending;
    setPending(null);
    if (!p) return;

    act('sell', async () => {
      const res = await api('/sell', 'POST', { token: p.token, confirm: true });
      setResult(res);
      // Re-lock the guard: one arming, one sell.
      setArmed(false);
      // The list shrinks and the wallets gain ETH — both only after the sells
      // land, so give them a moment before re-reading either.
      setTimeout(() => {
        load();
        reload?.();
      }, 3000);
      return res;
    });
  }

  // The step keeps its place in the sequence whatever the answer is: a numbered
  // run that ends at 5 because a route 404s teaches the operator that there are
  // five steps. Before a key is entered the header already says so, so that case
  // stays quiet rather than repeating the complaint next to every other panel.
  if (missing)
    return (
      <Step {...step}>
        <p className="hint">This build does not serve the sell routes.</p>
      </Step>
    );
  if (error)
    return (
      <Step {...step}>{credential ? <p className="hint">sell unavailable — {error}</p> : null}</Step>
    );
  if (!list)
    return (
      <Step {...step}>
        <p className="hint">reading what your bundle still holds…</p>
      </Step>
    );

  const results = Array.isArray(result?.results) ? result.results : [];
  const sold = results.filter((r) => r.status === 'confirmed').length;
  const blocked = !token || (live && !armed);

  return (
    <Step {...step} className="sell-panel">
      <p className="lede">
        Sells 100% of one launched token from every bundle wallet holding it, all broadcast at once.
        Only tokens this dev wallet launched are listed — a token that merely turned up in a wallet
        is never offered, because selling one means approving a contract nobody chose. The proceeds
        stay in the wallet that sold; use <b>Sweep back to dev</b> in step 4 to consolidate them.
      </p>

      {rows.length === 0 && (
        <p className="hint">
          Nothing to sell. A launch appears here while any bundle wallet still holds it and drops off
          on its own once the balance is gone.
        </p>
      )}

      {rows.length > 0 && (
        <table className="sell-list">
          <thead>
            <tr>
              <th />
              <th>Token</th>
              <th>Held by bundle</th>
              <th>Wallets</th>
              <th>Route</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.token}>
                <td>
                  <input
                    type="radio"
                    name="sell-token"
                    checked={token === t.token}
                    onChange={() => setToken(t.token)}
                  />
                </td>
                <td>
                  <b>{t.symbol || '—'}</b>
                  <div className="hint">
                    <a href={`${explorer}/address/${t.token}`} target="_blank" rel="noreferrer">
                      {t.token}
                    </a>
                  </div>
                </td>
                <td>{amount(t.totalTokens, 2)}</td>
                <td>{walletCount(t)}</td>
                <td className="hint">{routeLabel(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {plan && (
        <div className="notice">
          <h3>
            Plan — {plan.symbol || 'token'}, {plan.wallets.length} wallet
            {plan.wallets.length === 1 ? '' : 's'}, {amount(plan.totalTokens, 2)} tokens
          </h3>
          <ul>
            {plan.wallets.map((w) => (
              <li key={w.walletId}>
                {w.address} — {amount(w.tokens, 2)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className="notice danger">
          <h3>
            <LuTriangleAlert aria-hidden="true" />
            No slippage floor
          </h3>
          <ul>
            <li>
              Every wallet sells at whatever price it gets. This was chosen deliberately: nothing is
              left holding tokens. A sell into a drained curve, or behind someone faster, can return
              close to nothing and still succeed.
            </li>
            <li>
              All wallets broadcast together, so the tail fills worse than the head. The spread is
              reported below rather than hidden.
            </li>
            <li>This empties every wallet's position in one action and cannot be undone.</li>
          </ul>
        </div>
      )}

      {rows.length > 0 && (
        <div className={`arm ${live ? 'is-live' : ''}`}>
          <Busy
            busy={busy === 'preflight'}
            className="ghost"
            disabled={!token}
            title={token ? 'reads balances and builds the sells, broadcasts nothing' : 'pick a token'}
            onClick={preflight}
          >
            Preflight — signs, sends nothing
          </Busy>

          {live && (
            <label className={`switch ${armed ? 'armed' : ''}`}>
              <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
              Arm
            </label>
          )}

          <Busy
            busy={busy === 'sell'}
            className={live ? 'danger' : ''}
            disabled={blocked}
            title={
              !token
                ? 'pick a token'
                : blocked
                  ? 'flip Arm first — this is irreversible'
                  : 'sells every bundle wallet out of this token'
            }
            onClick={sell}
          >
            {live ? 'Sell all' : 'Sell all (dry run)'}
          </Busy>

          <div className="cost">
            <b>
              {selected ? walletCount(selected) : 0} wallet
              {(selected ? walletCount(selected) : 0) === 1 ? '' : 's'} selling
            </b>
            {selected ? `${amount(selected.totalTokens, 2)} ${selected.symbol || ''}` : 'pick a token'}
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="stats">
            <div className="stat ok">
              <span>ETH received</span>
              <b>{amount(result.totalEth, 6)}</b>
            </div>
            <div className={`stat ${sold === results.length ? 'ok' : 'bad'}`}>
              <span>Wallets sold</span>
              <b>
                {sold}/{results.length}
              </b>
            </div>
            <div className="stat">
              <span>Best fill</span>
              <b>{price(result.bestPrice)}</b>
            </div>
            <div className="stat">
              <span>Worst fill</span>
              <b>{price(result.worstPrice)}</b>
            </div>
          </div>

          <table className="sell-results">
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Tokens sold</th>
                <th>ETH received</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.walletId ?? r.address}-${i}`}>
                  <td className="addr">{r.address}</td>
                  <td>{amount(r.tokensSold, 2)}</td>
                  <td>{amount(r.ethReceived, 6)}</td>
                  <td>
                    <span className={r.status === 'confirmed' ? 'fill-ok' : 'fill-bad'}>
                      {r.status || '—'}
                    </span>
                    {r.error && <div className="hint">{r.error}</div>}
                    {/* Losing the receipts to a render crash is worst exactly
                        here — after something irreversible has happened. */}
                    {(Array.isArray(r.hashes) ? r.hashes : []).map((h) => (
                      <div key={h} className="hint">
                        <a href={`${explorer}/tx/${h}`} target="_blank" rel="noreferrer">
                          {h.slice(0, 18)}…
                        </a>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="hint">
            A wallet that failed still holds its tokens — the others are unaffected, and it can be
            sold again from this panel. The ETH is in the wallets that sold, not the dev wallet.
          </p>
        </>
      )}

      {/* The live dialog restates the missing slippage floor rather than
          relying on the notice above: by the time this opens, that notice has
          been scrolled past and read as furniture. The dry-run dialog says
          instead that nothing is broadcast, so the two can never be confused
          for one another. */}
      <Modal
        open={Boolean(pending)}
        danger={live}
        title={
          live
            ? 'SELL ALL — irreversible, and it spends real funds.'
            : `Dry run sell of ${pending?.symbol || ''} from ${pending?.count ?? 0} wallet${
                pending?.count === 1 ? '' : 's'
              }`
        }
        confirmLabel={live ? 'Sell all' : 'Sell all (dry run)'}
        onConfirm={fire}
        onCancel={() => setPending(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Symbol">{pending?.symbol || '—'}</Fact>
          <Fact label="Token" mono>
            {pending?.token || '—'}
          </Fact>
          <Fact label="Wallets">
            {pending?.count ?? 0} wallet{pending?.count === 1 ? '' : 's'} sell their entire balance
          </Fact>
        </div>
        {live && (
          <div className="notice danger">
            <h3>
              <LuTriangleAlert aria-hidden="true" />
              No slippage floor
            </h3>
            <ul>
              <li>
                There is no slippage floor. Every wallet takes whatever price it gets, including a
                bad one.
              </li>
            </ul>
          </div>
        )}
      </Modal>
    </Step>
  );
}
