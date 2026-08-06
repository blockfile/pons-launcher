import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Busy } from './Section.jsx';

/**
 * Exit a launched token from every bundle wallet at once.
 *
 * A disclosure rather than a numbered step: selling is not part of the launch
 * sequence, and an open panel above the Result would suggest there is something
 * left to do after a launch. It disappears entirely when there is nothing to
 * sell — and when the backend does not serve these routes at all, which is the
 * 404 case below.
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

export default function SellPanel({ explorer, apiKey, live, reload, report }) {
  const [list, setList] = useState(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState('');

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

  // Re-read when the key changes, not just on mount: the key decides whether
  // this route may be read at all, and the panel mounts before it is pasted.
  useEffect(() => {
    const t = setTimeout(load, apiKey ? 400 : 0);
    return () => clearTimeout(t);
  }, [apiKey]);

  const rows = Array.isArray(list) ? list : [];
  const selected = rows.find((r) => r.token === token) || null;

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

  function sell() {
    const symbol = selected?.symbol || plan?.symbol || 'this token';
    const count = plan ? plan.wallets.length : walletCount(selected);
    const msg = live
      ? `SELL ALL — irreversible, and it spends real funds.\n\n` +
        `${symbol}\n${token}\n${count} wallet${count === 1 ? '' : 's'} sell their entire balance\n\n` +
        `There is no slippage floor. Every wallet takes whatever price it gets, ` +
        `including a bad one.\n\nProceed?`
      : `Dry run sell of ${symbol} from ${count} wallet${count === 1 ? '' : 's'}. ` +
        `Nothing will be broadcast. Proceed?`;
    if (!confirm(msg)) return;

    act('sell', async () => {
      const res = await api('/sell', 'POST', { token, confirm: true });
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

  // Nothing to say when the routes are not there. Before a key is entered the
  // header already says so; repeating it next to every other panel is noise.
  if (missing) return null;
  if (error) return apiKey ? <p className="hint">sell unavailable — {error}</p> : null;
  if (!list) return null;

  const results = Array.isArray(result?.results) ? result.results : [];
  const sold = results.filter((r) => r.status === 'confirmed').length;
  const blocked = !token || (live && !armed);

  return (
    <details className="disperse-panel sell-panel">
      <summary>
        Sell everything
        <span className="hint" style={{ marginLeft: 8 }}>
          {rows.length
            ? `${rows.length} token${rows.length === 1 ? '' : 's'} your bundle still holds`
            : 'nothing your bundle holds is sellable'}
        </span>
      </summary>

      <p className="lede">
        Sells 100% of one launched token from every bundle wallet holding it, all broadcast at once.
        Only tokens this dev wallet launched are listed — a token that merely turned up in a wallet
        is never offered, because selling one means approving a contract nobody chose. The proceeds
        stay in the wallet that sold; use <b>Sweep back to dev</b> in step 2 to consolidate them.
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
              <th>Curve</th>
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
                <td className="hint">
                  {t.graduated ? 'graduated — sells into the Uniswap pool' : 'bonding — sells back to the curve'}
                </td>
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
          <h3>No slippage floor</h3>
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
    </details>
  );
}
