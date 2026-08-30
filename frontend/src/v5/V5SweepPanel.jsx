import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

/**
 * Step 6, last on the spine — collect what is left back to the launcher.
 *
 * REUSES THE SHARED /sweep ROUTE, the same one components/FundPanel.jsx calls
 * for v1/v2 — this is not a v5-specific endpoint. `variant: 'v5'` MUST be sent
 * on every call: backend/src/wallets/variants.js maps 'v5' -> { dev: 'v5dev',
 * bundle: 'v5bundle' }, so /sweep sources the v5bundle wallets and sends to
 * the v5dev launcher. Omitting it would default to v1 and sweep v1's wallets
 * instead — the same misdirection-of-funds risk V5FundPanel documents for
 * /fund, and for the same reason it is always named explicitly here.
 *
 * A STRAIGHT TRANSFER, deliberately. Unlike V3SweepPanel this does not route
 * through Relay — v3's own header explains why IT needs that indirection (the
 * wallets bought through a strategy Relay is protecting the link on); v5's
 * bundle wallets carry no such requirement, so the shared spine's plain
 * wallet-to-wallet sweep is exactly the right tool and nothing is layered on
 * top of it.
 *
 * NO PREFLIGHT ROUTE EXISTS for /sweep — there is nothing to sign ahead of
 * time the way a launch, a bundle fan-out or a sell has. This still moves real
 * ETH, so it sits behind the same live/arm/confirm gate as every other money
 * action here: an Arm switch once the console is live, and a confirmation
 * dialog that turns vermilion to match.
 *
 * THE RESULT SHAPE IS THE SAME ONE /fund RETURNS (wallets/funding.js's own
 * sweep()): `{ to, results: [{ walletId, address, eth?, tokens?, skipped?,
 * error? }] }`, each of `eth`/`tokens` an `{ amountEth|amount, hash, simulated?
 * }` object. Rendered flexibly, row by row, the same way FundPanel treats its
 * own transfer summaries — token amounts arrive in raw base units here (the
 * sweep route never resolves decimals), so they are shown as-is rather than
 * guessed into a token count that could be wrong.
 */
export default function V5SweepPanel({ step, dev, bundle, lastLaunch, live, explorer, reload, report }) {
  const [includeTokens, setIncludeTokens] = useState(false);
  const [tokenAddress, setTokenAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  // Prefills from the last launch exactly once, the moment the checkbox is
  // switched on with nothing typed yet — an editable default, not a value the
  // field silently keeps in sync with a launch that happens later.
  function toggleIncludeTokens(checked) {
    setIncludeTokens(checked);
    if (checked && !tokenAddress.trim() && lastLaunch?.token) setTokenAddress(lastLaunch.token);
  }

  function body() {
    const b = { variant: 'v5', includeTokens };
    if (includeTokens && tokenAddress.trim()) b.tokenAddress = tokenAddress.trim();
    return b;
  }

  async function fire() {
    setConfirming(false);
    setBusy('sweep');
    try {
      const out = await api('/sweep', 'POST', body());
      report(out);
      setResult(out);
      setArmed(false);
      // Give the transfers a moment to land before re-reading balances — same
      // pause V5FundPanel gives itself.
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const noWallets = !dev || bundle.length === 0;
  const blocked = live && !armed;

  const results = Array.isArray(result?.results) ? result.results : [];
  const sentCount = results.filter((r) => r.eth?.hash || r.tokens?.hash || r.eth?.simulated || r.tokens?.simulated).length;
  const failedCount = results.filter((r) => r.error).length;
  const skippedCount = results.filter((r) => r.skipped).length;

  return (
    <Step {...step}>
      <p className="lede">
        Sweep the bundle wallets back to the launcher. Every v5bundle wallet sends its ETH straight to
        v5dev — one transfer each, no relay, no batching — leaving the bundle wallets empty and ready
        for the next run.
      </p>

      {/* Said plainly, because a sweep that "worked" leaves the operator with
          a wallet they think is empty and money they think is loose — it is
          neither. Everything landed HERE, and the Launcher tools section at
          the end of the console is the only console path that moves it on
          from here. */}
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Swept ETH, USDG and token land in the launcher and stay there — nothing here sends them
        further. Withdraw them from <b>Launcher tools</b>, below, or export the key.
      </p>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        The token sweep moves <b>one token per run</b>. A bundle wallet holding both the launched
        token and USDG proceeds needs two sweeps — one with each token's address typed below.
      </p>

      {noWallets && (
        <div className="notice warn">
          <h3>{!dev ? 'No launcher wallet yet' : 'No bundle wallets yet'}</h3>
          <p>Generate {!dev ? 'a launcher wallet in step 1' : 'bundle wallets in step 2'} before sweeping anything.</p>
        </div>
      )}

      <h3 style={{ margin: '0 0 8px' }}>Destination — launcher wallet</h3>
      {!dev ? (
        <p className="hint">No launcher wallet yet — this is where every sweep below would land.</p>
      ) : (
        <div className="row">
          <Address value={dev.address} full href={explorerFor(dev.address)} />
          <span className="hint">{eth(dev.balanceEth)} ETH</span>
        </div>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Sources — bundle wallets</h3>
      {bundle.length === 0 ? (
        <p className="hint">No bundle wallets yet — generate them in step 2.</p>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Address</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {bundle.map((w) => (
                <tr key={w.walletId}>
                  <td className="addr">
                    <Address value={w.address} plain href={explorerFor(w.address)} />
                  </td>
                  <td className="num">
                    {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <label className="hint" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={includeTokens} onChange={(e) => toggleIncludeTokens(e.target.checked)} />
          also sweep leftover tokens
        </label>
        {includeTokens && (
          <input
            placeholder={lastLaunch?.token || 'token address'}
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
            style={{ minWidth: 340 }}
          />
        )}
      </div>

      <div className={`arm ${live ? 'is-live' : ''}`} style={{ marginTop: 12 }}>
        {live && (
          <label className={`switch ${armed ? 'armed' : ''}`}>
            <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
            Arm
          </label>
        )}

        <Busy
          busy={busy === 'sweep'}
          className={live ? 'danger' : ''}
          disabled={noWallets || blocked}
          title={
            noWallets
              ? 'generate the launcher and bundle wallets in steps 1–2 first'
              : blocked
                ? 'flip Arm first — this moves ETH out of every bundle wallet'
                : ''
          }
          onClick={() => setConfirming(true)}
        >
          {live ? 'Sweep to the launcher' : 'Sweep to the launcher (dry run)'}
        </Busy>
      </div>

      {result && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className={`stat ${failedCount ? 'bad' : 'ok'}`}>
              <span>Sent</span>
              <b>
                {sentCount}
                <span className="stat-of">/{results.length}</span>
              </b>
            </div>
            <div className={`stat ${failedCount ? 'bad' : ''}`}>
              <span>Failed</span>
              <b>{failedCount}</b>
            </div>
            <div className="stat">
              <span>Skipped</span>
              <b>{skippedCount}</b>
            </div>
          </div>

          <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th className="num">ETH</th>
                  <th className="num">Tokens</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={`${r.walletId ?? r.address}-${i}`}>
                    <td className="addr">
                      <Address value={r.address} plain href={explorerFor(r.address)} />
                    </td>
                    <td className="num">
                      {r.eth ? (
                        <>
                          {eth(r.eth.amountEth)}
                          {r.eth.simulated && <div className="hint">simulated</div>}
                          {r.eth.hash && (
                            <div className="hint">
                              <a href={explorer ? `${explorer}/tx/${r.eth.hash}` : undefined} target="_blank" rel="noreferrer">
                                {r.eth.hash.slice(0, 18)}…
                              </a>
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="hint">—</span>
                      )}
                    </td>
                    <td className="num">
                      {r.tokens ? (
                        <>
                          {r.tokens.amount}
                          <div className="hint">raw units{r.tokens.simulated ? ' · simulated' : ''}</div>
                          {r.tokens.hash && (
                            <div className="hint">
                              <a href={explorer ? `${explorer}/tx/${r.tokens.hash}` : undefined} target="_blank" rel="noreferrer">
                                {r.tokens.hash.slice(0, 18)}…
                              </a>
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="hint">—</span>
                      )}
                    </td>
                    <td>
                      {r.error ? (
                        <span style={{ color: 'var(--vermilion)' }}>{r.error}</span>
                      ) : r.skipped ? (
                        <span className="hint">skipped — {r.skipped}</span>
                      ) : (
                        <span style={{ color: 'var(--jade)' }}>sent</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <Modal
        open={confirming}
        danger={live}
        title={live ? 'LIVE SWEEP — moves ETH out of every bundle wallet.' : 'Dry run sweep of the bundle wallets'}
        confirmLabel={live ? 'Sweep' : 'Sweep (dry run)'}
        onConfirm={fire}
        onCancel={() => setConfirming(false)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="To" mono>
            {dev?.address || '—'}
          </Fact>
          <Fact label="From">{plural(bundle.length, 'bundle wallet')}</Fact>
          <Fact label="Also sweep tokens">{includeTokens ? tokenAddress.trim() || 'yes' : 'no'}</Fact>
        </div>
      </Modal>
    </Step>
  );
}
