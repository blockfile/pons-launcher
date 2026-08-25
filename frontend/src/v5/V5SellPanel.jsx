import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

// The 409 routes/v5.js's withSellLock raises when a bundle fan-out is still
// landing tokens INTO the bundle wallets — exiting now would sell a balance
// that has not settled yet. Matched on substring rather than status code
// because api.js only ever surfaces `json.error` as the thrown Error's
// message. Deliberately NOT matched: "a v5 sell is already in progress for
// this account" — that is an overlapping request on THIS route, not a parked
// one, and clears itself once that request finishes.
const BUNDLE_LANDING = /bundle is still landing/i;

// Token amounts arrive as decimal strings, the same as everywhere else in this
// console (see V5BundlePanel's own `fmt`). Distinct from roles.js's eth() on
// purpose — these are TOKEN amounts, not ETH.
function fmt(v, dp = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

/**
 * Step 5 — unwind the bundle's position back to ETH.
 *
 * SAME TWO-ACTION SHAPE as V5LaunchPanel/V5BundlePanel: Preflight (POST
 * /v5/sell/preflight) signs every wallet's two Permit2 approvals + its V4 sell
 * and returns the public plan with every `raw` stripped — broadcasts nothing.
 * It also verifies the pool exists before signing a single approval. Sell
 * (POST /v5/sell with confirm:true) repeats that server-side and broadcasts,
 * behind a confirmation dialog that turns vermilion once the console is live.
 *
 * NO SLIPPAGE FLOOR BY DEFAULT — mirrors the pons sell (components/
 * SellPanel.jsx) exactly: the point of an exit is that nothing is left holding
 * tokens, so every wallet sells at whatever price it gets unless the operator
 * deliberately asks for a floor via the optional slippageBps field. That is
 * the intended behaviour, not a footgun to warn someone off — the note here
 * says so plainly, once, rather than trying to talk anyone out of it.
 *
 * TOKEN PIN: same pattern as V5BundlePanel — the backend refuses to sell a
 * token this account did not launch here unless `allowUnlistedToken: true`
 * rides along (assertOwnLaunchedToken in routes/v5.js). Defaults to
 * `lastLaunch.token`; the "I'm sure this is my token" checkbox only appears
 * once the operator has typed something else into the override field.
 *
 * BUNDLE STILL LANDING. Unlike the launch step's `parked` state, there is no
 * resolve action here — the guard clears itself the moment the bundle
 * fan-out finishes. So this is a plain "wait and try again" notice, not a
 * button, the same shape V5BundlePanel uses for its own not-settled case.
 */
export default function V5SellPanel({ step, dev, bundle, lastLaunch, live, explorer, reload, report }) {
  const [tokenOverride, setTokenOverride] = useState('');
  const [allowUnlisted, setAllowUnlisted] = useState(false);
  const [hookOverride, setHookOverride] = useState('');
  const [slippageBps, setSlippageBps] = useState('');
  const [busy, setBusy] = useState('');
  const [plan, setPlan] = useState(null); // the last preflight's response
  const [result, setResult] = useState(null); // the last fire's response
  const [armed, setArmed] = useState(false);
  const [pendingBody, setPendingBody] = useState(null);
  const [notSettled, setNotSettled] = useState(false);

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  const typed = tokenOverride.trim();
  const token = typed || lastLaunch?.token || '';
  // True the moment the typed override names something other than the pinned
  // launch — including the case where there is no pinned launch at all, which
  // is just as "unlisted" from this account's point of view.
  const differsFromLaunch = Boolean(typed) && typed.toLowerCase() !== String(lastLaunch?.token || '').toLowerCase();
  const symbol = plan?.symbol || (!differsFromLaunch ? lastLaunch?.plan?.params?.symbol : '') || '';

  // The checkbox only makes sense while it is actually being asked for.
  useEffect(() => {
    if (!differsFromLaunch && allowUnlisted) setAllowUnlisted(false);
  }, [differsFromLaunch]);

  // A plan or a result belongs to one token at one floor; keeping either
  // across a change of either would show one exit's figures under a different
  // request's name — same guard V5BundlePanel keeps for its own plan/result.
  useEffect(() => {
    setPlan(null);
    setResult(null);
    setArmed(false);
    setPendingBody(null);
  }, [token, slippageBps]);

  // No bundle wallets means there is nothing to hold a position to exit — the
  // launcher (`dev`) is never spent from here, only read for its own step-1
  // gate elsewhere, so it plays no part in this panel's readiness.
  const noWallets = bundle.length === 0;

  function body() {
    const b = { token };
    const bps = Number(slippageBps);
    if (slippageBps.trim() && bps > 0) b.slippageBps = bps;
    if (differsFromLaunch && allowUnlisted) {
      b.allowUnlistedToken = true;
      // An unlisted token has no recorded launch hook for the server to pin, so
      // the exact pool hook must be supplied here — the server refuses the sell
      // without it (a probed hook could be a seeded decoy pool at minOut 0).
      if (hookOverride.trim()) b.hook = hookOverride.trim();
    }
    return b;
  }

  async function preflight() {
    setBusy('preflight');
    setNotSettled(false);
    try {
      const out = await api('/v5/sell/preflight', 'POST', body());
      setPlan(out);
      report(out);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (BUNDLE_LANDING.test(err.message)) setNotSettled(true);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is
  // clicked — same rule Modal.jsx documents (Enter never confirms).
  function sell() {
    setPendingBody(body());
  }

  async function fire() {
    const b = pendingBody;
    setPendingBody(null);
    if (!b) return;

    setBusy('sell');
    setNotSettled(false);
    try {
      const out = await api('/v5/sell', 'POST', { ...b, confirm: true });
      report(out);
      setResult(out);
      setArmed(false);
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (BUNDLE_LANDING.test(err.message)) setNotSettled(true);
    } finally {
      setBusy('');
    }
  }

  // For an unlisted token the operator must also supply the pool hook — the exit
  // refuses without it, so keep the buttons disabled until it is given.
  const tokenReady =
    Boolean(token) && (!differsFromLaunch || (allowUnlisted && Boolean(hookOverride.trim())));
  const ready = tokenReady && !noWallets;
  const blocked = live && !armed;

  // The quote a preflight's plan actually sold into — ETH by default before one
  // has run, since the console has no signal of a token's quote asset before
  // then (the exit auto-detects it via the pool). estEthOut / estEthOutTotal on
  // the plan are already denominated in this unit, whatever it is; only the
  // label here needs to say so honestly instead of assuming ETH.
  const quoteSymbol = plan?.quoteSymbol || 'ETH';

  const results = Array.isArray(result?.wallets) ? result.wallets : [];
  const failedCount = result?.failed ?? results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const pendingCount = result?.pending ?? results.filter((r) => r.status === 'pending').length;

  return (
    <Step {...step}>
      <p className="lede">
        Exits every bundle wallet holding the launched token back to ETH, all in one action, through
        the letscash pool's V4 sell. <b>No slippage floor by default</b> — every wallet sells at
        whatever price it gets, which is the guaranteed exit; a floor below trades that guarantee for
        the chance of a stuck position. Nothing broadcasts until Sell is armed and confirmed.
      </p>

      {noWallets && (
        <div className="notice warn">
          <h3>No bundle wallets yet</h3>
          <p>Generate them in step 1 — there is nothing to exit until a wallet holds a position.</p>
        </div>
      )}

      {notSettled && (
        <div className="notice danger">
          <h3>The bundle is still landing</h3>
          <p>
            A bundle fan-out is still sending tokens into the bundle wallets — exiting now would sell a
            half-settled balance. Wait a moment and try again; there is nothing to resolve here, it
            clears on its own.
          </p>
        </div>
      )}

      <h3 style={{ margin: '0 0 8px' }}>Token</h3>
      {lastLaunch?.token ? (
        <div className="row">
          <span className="hint">from your last launch —</span>
          <b>{lastLaunch.plan?.params?.symbol || ''}</b>
          <Address value={lastLaunch.token} plain href={explorerFor(lastLaunch.token)} />
        </div>
      ) : (
        <p className="hint">
          No launch this session yet — type the token address below if you're exiting one launched
          earlier.
        </p>
      )}
      <div className="grid" style={{ marginTop: 8 }}>
        <label className="wide">
          Override token (optional)
          <input
            value={tokenOverride}
            onChange={(e) => setTokenOverride(e.target.value)}
            placeholder={lastLaunch?.token || '0x…'}
          />
        </label>
      </div>
      {differsFromLaunch && (
        <label className="row" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={allowUnlisted} onChange={(e) => setAllowUnlisted(e.target.checked)} />
          I'm sure this is my token — sell it even though it wasn't launched here
        </label>
      )}
      {differsFromLaunch && allowUnlisted && (
        <div className="grid" style={{ marginTop: 8 }}>
          <label className="wide">
            Pool hook (required for an unlisted token)
            <input
              value={hookOverride}
              onChange={(e) => setHookOverride(e.target.value)}
              placeholder="0x… — the pool hook from this token's launch receipt"
            />
            <span className="hint">
              An unlisted token has no recorded launch here, so the exact pool hook must be given — the
              exit refuses without it, because a probed hook could hit a decoy pool and drain at no floor.
            </span>
          </label>
        </div>
      )}
      {!token && (
        <div className="notice warn">
          <h3>No token to sell</h3>
          <p>Launch a token in step 3 first, or type its address above.</p>
        </div>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Exit</h3>
      <div className="grid">
        <label>
          Slippage floor (bps, optional)
          <input
            type="number"
            step="1"
            min="0"
            placeholder="0"
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
          />
          <span className="hint">
            empty or 0 = <b>no floor</b> — the guaranteed exit, every wallet sells at whatever price it
            gets
          </span>
        </label>
      </div>

      {plan && (
        <div className="notice">
          <h3>Preflight result — {plan.symbol}</h3>
          <ul>
            <li>
              {plural(plan.walletCount, 'wallet')} exiting · {fmt(plan.totalTokens)} {plan.symbol}
            </li>
            <li>
              est. {quoteSymbol} out{' '}
              {plan.estEthOutTotal != null ? `${eth(plan.estEthOutTotal)} ${quoteSymbol}` : 'unknown until it lands'}
            </li>
            <li>minimum-out floor: {plan.minOutFloor}</li>
          </ul>
          <div className="table-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Tokens</th>
                  <th className="num">Est. {quoteSymbol} out</th>
                </tr>
              </thead>
              <tbody>
                {plan.wallets.map((w) => (
                  <tr key={w.walletId}>
                    <td className="addr">
                      <Address value={w.address} plain href={explorerFor(w.address)} />
                    </td>
                    <td className="num">{fmt(w.tokens)}</td>
                    <td className="num">{w.estEthOut == null ? <span className="hint">unknown</span> : eth(w.estEthOut)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.skipped?.length > 0 && (
            <ul>
              {plan.skipped.map((s, i) => (
                <li key={i} className="hint">
                  {s.address} skipped — {s.reason}
                </li>
              ))}
            </ul>
          )}
          {plan.warnings?.length > 0 && (
            <ul>
              {plan.warnings.map((w, i) => (
                <li key={i} className="hint">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={`arm ${live ? 'is-live' : ''}`}>
        <Busy
          busy={busy === 'preflight'}
          className="btn-primary"
          disabled={!ready}
          title={
            !token
              ? 'pick or launch a token first'
              : differsFromLaunch && !allowUnlisted
                ? 'check "I\'m sure this is my token" to sell a token launched elsewhere'
                : noWallets
                  ? 'generate bundle wallets in step 1 first'
                  : 'signs everything, broadcasts nothing'
          }
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
          disabled={!ready || blocked}
          title={
            !ready
              ? 'pick a token and generate bundle wallets first'
              : blocked
                ? 'flip Arm first — this exits every holding wallet, irreversibly'
                : ''
          }
          onClick={sell}
        >
          {live ? 'Sell all' : 'Sell all (dry run)'}
        </Busy>
      </div>

      {result && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className={`stat ${failedCount ? 'bad' : 'ok'}`}>
              <span>Sold</span>
              <b>
                {result.sold}
                <span className="stat-of">/{results.length}</span>
              </b>
            </div>
            <div className={`stat ${failedCount ? 'bad' : ''}`}>
              <span>Failed</span>
              <b>{failedCount}</b>
            </div>
            <div className="stat">
              <span>Pending</span>
              <b>{pendingCount}</b>
            </div>
          </div>

          <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Wallet</th>
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
                    <td className="num">{fmt(r.tokens)}</td>
                    <td>
                      <span
                        style={{
                          color:
                            r.status === 'confirmed'
                              ? 'var(--jade)'
                              : r.status === 'pending'
                                ? 'var(--dim)'
                                : 'var(--vermilion)',
                        }}
                      >
                        {r.status}
                      </span>
                      {r.error && <div className="hint">{r.error}</div>}
                      {r.sellHash && (
                        <div className="hint">
                          <a href={explorer ? `${explorer}/tx/${r.sellHash}` : undefined} target="_blank" rel="noreferrer">
                            {r.sellHash.slice(0, 18)}…
                          </a>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {failedCount > 0 && (
            <div className="notice danger">
              <h3>Some sells failed</h3>
              <p>
                {plural(failedCount, 'wallet')} reverted or failed to send — it still holds its tokens.
                Re-run Sell to try again; the others are unaffected.
              </p>
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(pendingBody)}
        danger={live}
        title={live ? 'LIVE SELL — exits every holding wallet, irreversible.' : `Dry run sell of ${symbol || 'this token'}`}
        confirmLabel={live ? 'Sell all' : 'Sell all (dry run)'}
        onConfirm={fire}
        onCancel={() => setPendingBody(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Token" mono>
            {pendingBody?.token || '—'}
          </Fact>
          <Fact label="Slippage floor">
            {pendingBody?.slippageBps ? `${pendingBody.slippageBps} bps` : 'none — guaranteed exit'}
          </Fact>
        </div>
        {live && (
          <div className="notice danger">
            <h3>No slippage floor</h3>
            <ul>
              <li>Every wallet sells at whatever price it gets, including a bad one — that is the point.</li>
            </ul>
          </div>
        )}
      </Modal>
    </Step>
  );
}
