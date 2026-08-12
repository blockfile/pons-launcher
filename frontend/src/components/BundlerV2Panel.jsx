import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Busy } from './Section.jsx';

/**
 * The v2 bundler — launch quiet, wait, then buy once through a contract.
 *
 * WHY IT IS A SEPARATE TAB AND NOT A TOGGLE ON THE V1 SEQUENCE. The two are
 * different strategies, not two settings of one. V1 arms a bundle before the
 * launch and fires it at the moment trading opens; this one launches with no
 * dev buy at all, waits for the snipers to take a position and give it back,
 * and then buys once. Their steps do not line up, their timings are opposite,
 * and the mistake that ruins each is different. Putting them in one sequence
 * would mean a control that is right in one mode and dangerous in the other.
 *
 * THE ONE THING THE OPERATOR CAN GET WRONG HERE is triggering too early, and
 * the panel is built around saying so: nothing sends without a quote first,
 * and a quote taken inside the restriction window comes back refusing, with
 * the reason spelled out rather than the raw "TF" the pool actually returns.
 */
export default function BundlerV2Panel({ explorer, credential, report }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('1.0');
  const [quote, setQuote] = useState(null);

  async function load() {
    try {
      setState(await api('/distributor'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  // Re-read when the credential arrives, not only on mount — the panel mounts
  // before a key is pasted, and one restored from sessionStorage is already
  // present on the first render. Debounced to match App, which fires on every
  // keystroke of a paste.
  useEffect(() => {
    const t = setTimeout(load, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential]);

  async function act(name, fn) {
    setBusy(name);
    try {
      const out = await fn();
      report(out);
      await load();
      return out;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      return null;
    } finally {
      setBusy('');
    }
  }

  if (error)
    return credential ? <p className="hint">v2 bundler unavailable — {error}</p> : null;
  if (!state) return null;

  const { distributor, quote: deployQuote } = state;

  return (
    <div className="disperse-panel">
      <p className="lede">
        A v1 pool opens with about 1.36 ETH of depth against the whole supply, so a bot spending
        0.05 ETH takes 4–5% of it — and it exits by selling into whatever buys next. A bundle
        racing for the pool at the open is that exit. This path declines the race: launch with no
        dev buy, let them take a position into a pool with nothing behind it, wait for them to sell
        it back, then buy once and split it here.
      </p>

      <div className="notice warn">
        <h3>the order matters more than the amounts</h3>
        <ul>
          <li>
            Launch with <strong>no dev buy</strong> — the launch fee only. Nothing else at launch.
          </li>
          <li>
            Wait past the restriction window (~30s). Before it lifts this buy is capped at ~5% of
            supply and reverts over it.
          </li>
          <li>
            Wait for the snipers to sell back. Every measured hold is under 68 seconds, so ~90s
            after trading opens clears them.
          </li>
          <li>Then trigger, once.</li>
        </ul>
      </div>

      {!distributor ? (
        <div className="row">
          <span className="hint">
            {deployQuote?.error
              ? `cannot price a deploy — ${deployQuote.error}`
              : `one contract, paid by the dev wallet. Balance ${Number(
                  deployQuote?.balanceEth || 0
                ).toFixed(6)} ETH`}
          </span>
          <span className="spacer" />
          <Busy
            busy={busy === 'deploy'}
            className="ghost"
            onClick={() =>
              act('deploy', () => api('/distributor/deploy', 'POST', { confirm: true }))
            }
          >
            {deployQuote?.costEth
              ? `Deploy the distributor for ~${Number(deployQuote.costEth).toFixed(6)} ETH`
              : 'Deploy the distributor'}
          </Busy>
        </div>
      ) : (
        <>
          <table className="disperser-list">
            <tbody>
              <tr>
                <td>
                  <a
                    href={`${explorer}/address/${distributor.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {distributor.address}
                  </a>
                </td>
                <td className="hint">
                  {distributor.deployedAt
                    ? new Date(distributor.deployedAt).toLocaleDateString()
                    : ''}
                </td>
                <td>
                  <Busy
                    busy={busy === 'forget'}
                    className="ghost"
                    title="stop using this contract — it stays on chain"
                    onClick={() => act('forget', () => api('/distributor', 'DELETE'))}
                  >
                    forget
                  </Busy>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="row">
            <label className="hint">
              token
              <input
                value={token}
                onChange={(e) => {
                  setToken(e.target.value.trim());
                  setQuote(null);
                }}
                placeholder="0x… the token you just launched"
                style={{ width: 380, marginLeft: 6 }}
              />
            </label>
          </div>

          <div className="row">
            <label className="hint">
              spend
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setQuote(null);
                }}
                style={{ width: 90, marginLeft: 6 }}
              />
              {' ETH'}
            </label>

            <span className="spacer" />

            {/* Quote is not optional and not a convenience. It is a real
                eth_call against the live pool, and it is what catches a
                trigger sent inside the restriction window — where the pool
                answers "TF" and tells you nothing. */}
            <Busy
              busy={busy === 'quote'}
              className="ghost"
              disabled={!token || !(Number(amount) > 0)}
              onClick={() =>
                act('quote', async () => {
                  const q = await api('/distributor/quote', 'POST', {
                    token,
                    amountEth: Number(amount),
                  });
                  setQuote(q);
                  return q.ok
                    ? `quote: ${Number(q.amountOut) / 1e18} tokens across ${q.wallets.length} wallets`
                    : `NOT READY — ${q.reason}`;
                })
              }
            >
              Quote it
            </Busy>
          </div>

          {quote && (
            <div className={`notice ${quote.ok ? '' : 'warn'}`}>
              {quote.ok ? (
                <>
                  <h3>
                    {(Number(quote.amountOut) / 1e18).toLocaleString()} tokens across{' '}
                    {quote.wallets.length} wallets
                  </h3>
                  <ul>
                    <li>
                      about {((Number(quote.amountOut) / 1e18 / 1e9) * 100).toFixed(2)}% of a 1e9
                      supply, roughly{' '}
                      {(((Number(quote.amountOut) / 1e18 / 1e9) * 100) / quote.wallets.length).toFixed(
                        2
                      )}
                      % each
                    </li>
                    <li>the floor sent with the buy is 15% under this — it reverts rather than fill worse</li>
                  </ul>
                </>
              ) : (
                <>
                  <h3>not ready</h3>
                  <ul>
                    <li>{quote.reason}</li>
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="row">
            <span className="hint">
              {quote?.ok
                ? 'sends one transaction: buy, then split, or the whole thing reverts'
                : 'quote first — the trigger will not send without one'}
            </span>
            <span className="spacer" />
            <Busy
              busy={busy === 'trigger'}
              disabled={!quote?.ok}
              onClick={() =>
                act('trigger', async () => {
                  const out = await api('/distributor/trigger', 'POST', {
                    token,
                    amountEth: Number(amount),
                    confirm: true,
                  });
                  setQuote(null);
                  return out.status === 1
                    ? `FILLED ${Number(out.amountOut) / 1e18} tokens in block ${out.blockNumber} — ${out.hash}`
                    : `reverted — ${out.hash}`;
                })
              }
            >
              Trigger the buy
            </Busy>
          </div>
        </>
      )}
    </div>
  );
}
