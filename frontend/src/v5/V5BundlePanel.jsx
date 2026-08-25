import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

// The 409 backend/src/routes/v5.js's withBundleLock (and prepareBundle's own
// settled-balance gate) raise when the launcher's on-chain state is not settled
// enough to size a fan-out on. TWO distinct messages match this, deliberately:
//   "…is in progress or unresolved on this launcher — settle it before bundling"
//   (a launch is running or parked-unconfirmed on the SAME wallet this bundle
//   would spend from)
//   "the launcher has N transaction(s) still in flight … wait for them to
//   confirm before bundling" (prepareBundle's own pending-vs-latest-nonce gate)
// Matched on substring rather than status code because api.js only ever
// surfaces `json.error` as the thrown Error's message. Deliberately NOT matched:
// "a v5 bundle fan-out is already in progress for this account" — that is an
// overlapping request on THIS route, not a parked one; it clears itself once
// that request finishes and needs no "wait and retry" notice of its own.
const NOT_SETTLED = /in flight|unresolved/i;

// Token/ETH amounts arrive as decimal strings, the same as everywhere else in
// this console (see components/SellPanel.jsx's own `amount`). Distinct from
// roles.js's eth() on purpose — these are TOKEN amounts, not ETH, and giving
// them their own formatter keeps that distinction from blurring at a glance.
function fmt(v, dp = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

/**
 * Bundle tools — an UNNUMBERED utility, below the numbered flow. The UNTAXED
 * FAN-OUT, and nothing else: the per-wallet buys ride with the launch (step 4's
 * combined "Launch + bundle"), so there is no separate/manual buy here — that
 * would just duplicate it. This panel is the tax-free distribution the combined
 * step does NOT do, and the recovery path when a launch confirmed but its buys
 * were skipped (a USDG launch, an unreadable hook: `bundleSkipped`).
 *
 * THE EDGE: letscash taxes SWAPS (pool interactions) through its hook, but a
 * plain wallet→wallet ERC-20 transfer() never touches the pool, so it is
 * untaxed (see backend/src/v5/bundle.js's own header). This panel does not
 * decide any of that — it only builds the request body the operator's choices
 * describe and shows back exactly what the server is about to move.
 *
 * SAME TWO-ACTION SHAPE as V5LaunchPanel: Preflight (POST /v5/bundle/preflight)
 * signs every transfer against the launcher's pending nonce and returns the
 * plan with every `raw` stripped — broadcasts nothing. Bundle (POST /v5/bundle
 * with confirm:true) repeats that server-side and broadcasts, always behind a
 * confirmation dialog that turns vermilion once the console is live.
 *
 * TOKEN PIN: the backend refuses to fan out a token this account did not
 * launch here, unless `allowUnlistedToken: true` rides along — see
 * assertOwnLaunchedToken in routes/v5.js. This panel defaults the token to
 * `lastLaunch.token` (nothing to override, nothing to check) and only shows
 * the "I'm sure this is my token" checkbox once the operator has actually
 * typed something else into the override field.
 *
 * NOT SETTLED. Unlike the launch step's `parked` state, there is no resolve
 * action here — the guard clears itself the moment the in-flight tx confirms.
 * So this is shown as a plain "wait and try again" notice, not a button.
 */
export default function V5BundlePanel({ step, dev, bundle, lastLaunch, live, explorer, reload, report }) {
  const [tokenOverride, setTokenOverride] = useState('');
  const [allowUnlisted, setAllowUnlisted] = useState(false);
  const [mode, setMode] = useState('equal');
  const [leaveInLauncher, setLeaveInLauncher] = useState('0');
  const [amounts, setAmounts] = useState({}); // walletId -> typed whole-token string
  const [busy, setBusy] = useState('');
  const [plan, setPlan] = useState(null); // the last preflight's plan
  const [result, setResult] = useState(null); // the last fire's response
  const [armed, setArmed] = useState(false);
  const [pendingBody, setPendingBody] = useState(null);
  const [notSettled, setNotSettled] = useState(false);

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');
  const setAmount = (walletId, value) => setAmounts((prev) => ({ ...prev, [walletId]: value }));

  const typed = tokenOverride.trim();
  const token = typed || lastLaunch?.token || '';
  // True the moment the typed override names something other than the pinned
  // launch — including the case where there is no pinned launch at all, which
  // is just as "unlisted" from this account's point of view.
  const differsFromLaunch = Boolean(typed) && typed.toLowerCase() !== String(lastLaunch?.token || '').toLowerCase();
  const symbol = plan?.symbol || (!differsFromLaunch ? lastLaunch?.plan?.params?.symbol : '') || '';

  // The checkbox only makes sense while it is actually being asked for — once
  // the override is cleared or matches the pinned launch again, drop the flag
  // rather than let a stale "yes I'm sure" silently ride along on a later,
  // unrelated request.
  useEffect(() => {
    if (!differsFromLaunch && allowUnlisted) setAllowUnlisted(false);
  }, [differsFromLaunch]);

  // A plan or a result belongs to one token; keeping either across a change of
  // token or mode would show one token's split under another's name, the same
  // guard SellPanel keeps for its own plan/result pair.
  useEffect(() => {
    setPlan(null);
    setResult(null);
    setArmed(false);
    setPendingBody(null);
  }, [token, mode]);

  const noWallets = !dev || bundle.length === 0;

  const namedAmounts = bundle
    .map((w) => ({ walletId: w.walletId, amount: amounts[w.walletId] }))
    .filter((a) => Number(a.amount) > 0);

  function body() {
    const b = { token, mode };
    if (mode === 'equal') {
      b.leaveInLauncher = leaveInLauncher.trim() || '0';
    } else {
      b.amounts = namedAmounts;
    }
    if (differsFromLaunch && allowUnlisted) b.allowUnlistedToken = true;
    return b;
  }

  async function preflight() {
    setBusy('preflight');
    setNotSettled(false);
    try {
      const out = await api('/v5/bundle/preflight', 'POST', body());
      setPlan(out.plan);
      report(out);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (NOT_SETTLED.test(err.message)) setNotSettled(true);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is
  // clicked — same rule Modal.jsx documents (Enter never confirms).
  function fireBundle() {
    setPendingBody(body());
  }

  async function fire() {
    const b = pendingBody;
    setPendingBody(null);
    if (!b) return;

    setBusy('bundle');
    setNotSettled(false);
    try {
      const out = await api('/v5/bundle', 'POST', { ...b, confirm: true });
      report(out);
      setResult(out);
      setArmed(false);
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (NOT_SETTLED.test(err.message)) setNotSettled(true);
    } finally {
      setBusy('');
    }
  }

  const modeReady = mode === 'equal' ? true : namedAmounts.length > 0;
  const tokenReady = Boolean(token) && (!differsFromLaunch || allowUnlisted);
  const ready = tokenReady && modeReady && !noWallets;
  const blocked = live && !armed;

  const results = Array.isArray(result?.transfers) ? result.transfers : [];
  const failedCount = result?.failed ?? results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const pendingCount = result?.pending ?? results.filter((r) => r.status === 'pending').length;

  return (
    <Step {...step}>
      <p className="lede">
        letscash taxes swaps through its hook, but a plain wallet→wallet transfer never touches the
        pool — so fanning the launcher's first-buy position out to the bundle wallets here is
        <b> untaxed, with zero slippage</b>. The launcher makes one big first buy in the launch, and
        the tokens are split out to the bundle wallets by transfer() — no per-wallet buys, nothing to
        revert. Nothing broadcasts until Bundle is armed and confirmed.
      </p>

      <>
      {noWallets && (
        <div className="notice warn">
          <h3>{!dev ? 'No launcher wallet yet' : 'No bundle wallets yet'}</h3>
          <p>Generate {!dev ? 'a launcher wallet in step 1' : 'bundle wallets in step 2'} before bundling anything.</p>
        </div>
      )}

      {notSettled && (
        <div className="notice danger">
          <h3>The launcher is not settled yet</h3>
          <p>
            A launch or a prior bundle still has a transaction unconfirmed on this launcher — its
            balance and nonce cannot be trusted for a new split until that clears. Wait a moment and
            try again; there is nothing to resolve here, it clears on its own.
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
        <p className="hint">No launch this session yet — type the token address below if you're bundling one launched earlier.</p>
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
          I'm sure this is my token — bundle it even though it wasn't launched here
        </label>
      )}
      {!token && (
        <div className="notice warn">
          <h3>No token to bundle</h3>
          <p>Launch a token in step 4 first, or type its address above.</p>
        </div>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Split</h3>
      <div className="grid">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="equal">Equal split</option>
            <option value="amounts">Per-wallet amounts</option>
          </select>
        </label>
        {mode === 'equal' && (
          <label>
            Leave in launcher
            <input
              type="number"
              step="any"
              min="0"
              value={leaveInLauncher}
              onChange={(e) => setLeaveInLauncher(e.target.value)}
            />
            <span className="hint">whole tokens kept back; the rest splits equally across every bundle wallet</span>
          </label>
        )}
      </div>

      {mode === 'amounts' &&
        (bundle.length === 0 ? (
          <p className="hint">No bundle wallets to split across — generate some in step 2.</p>
        ) : (
          <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Balance (ETH)</th>
                  <th className="num">Amount</th>
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
                    <td className="num">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        placeholder="0"
                        value={amounts[w.walletId] ?? ''}
                        onChange={(e) => setAmount(w.walletId, e.target.value)}
                        style={{ width: 120 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {plan && (
        <div className="notice">
          <h3>Preflight result — {plan.symbol}</h3>
          <ul>
            <li>
              launcher balance {fmt(plan.launcherBalance)} {plan.symbol}
            </li>
            <li>
              total out {fmt(plan.totalOut)} {plan.symbol} across {plural(plan.count, 'wallet')}
            </li>
            <li>
              remainder left behind {fmt(Number(plan.launcherBalance) - Number(plan.totalOut))} {plan.symbol}
            </li>
          </ul>
          <div className="table-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {plan.transfers.map((t) => (
                  <tr key={t.walletId}>
                    <td className="addr">
                      <Address value={t.to} plain href={explorerFor(t.to)} />
                    </td>
                    <td className="num">{fmt(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                ? 'check "I\'m sure this is my token" to bundle a token launched elsewhere'
                : !modeReady
                  ? 'enter at least one wallet amount above'
                  : noWallets
                    ? 'generate wallets in steps 1–2 first'
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
          busy={busy === 'bundle'}
          className={live ? 'danger' : ''}
          disabled={!ready || blocked}
          title={
            !ready
              ? 'fill in the token and split above'
              : blocked
                ? 'flip Arm first — this moves the launched supply'
                : ''
          }
          onClick={fireBundle}
        >
          {live ? 'Bundle' : 'Bundle (dry run)'}
        </Busy>
      </div>

      {result && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className={`stat ${failedCount ? 'bad' : 'ok'}`}>
              <span>Sent</span>
              <b>
                {result.sent}
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
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((t, i) => (
                  <tr key={`${t.walletId ?? t.to}-${i}`}>
                    <td className="addr">
                      <Address value={t.to} plain href={explorerFor(t.to)} />
                    </td>
                    <td className="num">{fmt(t.amount)}</td>
                    <td>
                      <span
                        style={{
                          color:
                            t.status === 'confirmed'
                              ? 'var(--jade)'
                              : t.status === 'pending'
                                ? 'var(--dim)'
                                : 'var(--vermilion)',
                        }}
                      >
                        {t.status}
                      </span>
                      {t.error && <div className="hint">{t.error}</div>}
                      {t.hash && (
                        <div className="hint">
                          <a href={explorer ? `${explorer}/tx/${t.hash}` : undefined} target="_blank" rel="noreferrer">
                            {t.hash.slice(0, 18)}…
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
              <h3>Some transfers failed</h3>
              <p>
                {plural(failedCount, 'transfer')} reverted or failed to send — the tokens for those stay
                in the launcher. Re-run with amounts covering just the failed wallets.
              </p>
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(pendingBody)}
        danger={live}
        title={live ? 'LIVE BUNDLE — this moves the launched supply.' : `Dry run bundle of ${symbol || 'this token'}`}
        confirmLabel={live ? 'Bundle' : 'Bundle (dry run)'}
        onConfirm={fire}
        onCancel={() => setPendingBody(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Token" mono>
            {pendingBody?.token || '—'}
          </Fact>
          <Fact label="Mode">{pendingBody?.mode === 'amounts' ? 'per-wallet amounts' : 'equal split'}</Fact>
          {pendingBody?.mode === 'equal' ? (
            <Fact label="Leave in launcher">{pendingBody?.leaveInLauncher || '0'}</Fact>
          ) : (
            <Fact label="Wallets">{plural(pendingBody?.amounts?.length || 0, 'wallet')}</Fact>
          )}
        </div>
      </Modal>
      </>
    </Step>
  );
}
