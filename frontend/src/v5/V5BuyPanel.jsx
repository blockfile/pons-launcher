import { useEffect, useState } from 'react';
import { api, notify } from '../api.js';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

// The lock refusals routes/v5.js's withBuyLock raises when the bundle wallets
// are already busy with something else — a buy already running, a sell
// already running, or a fan-out still landing tokens into them. All three read
// as "wait a moment, nothing to resolve" rather than an error to fix, so they
// share one notice. Matched on substring, the same reason every other lock
// regex in this tab is: api.js only ever surfaces `json.error` as the thrown
// Error's message.
//   "a v5 bundle buy is already in progress for this account"
//   "a v5 sell is in progress on these wallets — let it finish before buying"
//   "a v5 bundle is still landing into the bundle wallets — let it settle before buying"
const WALLETS_BUSY = /in progress|still landing/i;

// prepareBundleBuys (backend/src/v5/buy.js) refuses outright — before signing
// anything — when the pinned pool quotes in USDG rather than ETH: a per-wallet
// buy only ever carries ETH as msg.value, so a USDG-quoted launch would need
// the same two Permit2 approvals V5SellPanel's exit uses, which this money
// path does not have yet. Surfaced as its own notice rather than the raw error
// line, because "use the fan-out instead" is an actionable next step.
const ETH_ONLY = /ETH-only/i;

// Token amounts arrive as decimal strings, the same as every other v5 panel's
// own `fmt` (see V5BundlePanel, V5SellPanel).
function fmt(v, dp = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

// /v5/pool-fee's currentPct/basePct/launchPct already arrive in percent (5 ==
// 5%) — this only trims the trailing zeroes a plain toFixed leaves behind, so
// the common flat tiers (1/3/5/10) read as whole numbers instead of "5.00".
function pct(v, dp = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(dp).replace(/\.?0+$/, '');
}

// premiumGoneAt is unix seconds; this is only ever read while hasDecay is
// true, i.e. the rare per-config case — see the readout below.
function countdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return [h, m, r].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * The per-wallet BUY half of the Bundle tools utility — every bundle wallet
 * BUYS the token from the pool with its own ETH, instead of the launcher's
 * fan-out transfer(). The PRIMARY per-wallet bundle now rides with the launch
 * (the combined "Launch + bundle" step 3); this is the manual path, for topping
 * up afterward or firing a bundle a combined run skipped. It has no <Step> of
 * its own: V5BundlePanel renders it inside its own shell when the Method toggle
 * there is set to "Each wallet buys" — see that file's `panelMode`.
 *
 * SAME TWO-ACTION SHAPE as every other v5 money path: Preflight (POST
 * /v5/bundle-buy/preflight) signs every wallet's buy against its own pending
 * nonce and returns the plan with every `raw` stripped — broadcasts nothing.
 * Buy (POST /v5/bundle-buy with confirm:true) repeats that server-side and
 * broadcasts, behind a confirmation dialog that turns vermilion once the
 * console is live.
 *
 * NO LAUNCH-BLOCK RACE. Unlike pons v1 — where the bundle buys ride the same
 * block as the launch to front-run public buyers — there is no window to beat
 * here. Reverse-engineering the live CashCat hook showed every real letscash
 * launch is FLAT: the tax sits at the config's base tier (1/3/5/10%) from the
 * moment it launches, with no decaying anti-snipe premium to wait out. So this
 * buy just pays the pool's current tax and can run whenever the operator
 * chooses — the live readout below (GET /v5/pool-fee) shows that rate. The
 * rare pool that DOES set a decay window still surfaces there too, as a
 * countdown to when its premium reaches base; that is the exception, not the
 * rule. The preflight quote reflects whatever the tax happens to be at the
 * moment it runs, which is the whole reason to preflight before buying rather
 * than just firing.
 *
 * TOKEN PIN: same pattern as V5BundlePanel/V5SellPanel — the backend refuses
 * to buy a token this account did not launch here unless
 * `allowUnlistedToken: true` rides along (assertOwnLaunchedToken in
 * routes/v5.js), and the hook is pinned from the launch receipt unless the
 * token is unlisted, in which case the operator must supply it (same
 * decoy-pool guard V5SellPanel's exit has) — and, because a buy only ever
 * quotes in ETH, the quote is always sent as 'eth' alongside it.
 *
 * WALLETS BUSY / ETH-ONLY. Neither has a resolve action here — both clear on
 * their own (the other run finishing, or nothing to do but switch to the
 * fan-out) — so both are plain notices, the same shape V5BundlePanel and
 * V5SellPanel use for their own not-settled cases.
 */
export default function V5BuyPanel({ bundle, lastLaunch, live, explorer, reload, report }) {
  const [tokenOverride, setTokenOverride] = useState('');
  const [allowUnlisted, setAllowUnlisted] = useState(false);
  const [hookOverride, setHookOverride] = useState('');
  const [slippageBps, setSlippageBps] = useState('');
  const [totalBuy, setTotalBuy] = useState('');
  const [amounts, setAmounts] = useState({}); // walletId -> typed ETH string
  const [busy, setBusy] = useState('');
  const [plan, setPlan] = useState(null); // the last preflight's response
  const [result, setResult] = useState(null); // the last fire's response
  const [armed, setArmed] = useState(false);
  const [pendingBody, setPendingBody] = useState(null);
  const [blocked, setBlocked] = useState(false); // WALLETS_BUSY
  const [ethOnly, setEthOnly] = useState(false); // ETH_ONLY
  const [poolFee, setPoolFee] = useState(null); // last GET /v5/pool-fee reading, or null (no reading yet)
  const [now, setNow] = useState(() => Date.now()); // ticks the decay countdown below; see V4CampaignsPanel's own `now`

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');
  const setAmount = (walletId, value) => setAmounts((prev) => ({ ...prev, [walletId]: value }));

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
  // across a change of either would show one run's figures under a different
  // request's name — same guard the sibling panels keep for their own pairs.
  useEffect(() => {
    setPlan(null);
    setResult(null);
    setArmed(false);
    setPendingBody(null);
  }, [token, slippageBps]);

  // Live "pool tax" readout — GET /v5/pool-fee needs a launched pool (it pins
  // the hook from the launch record), so it throws before launch. That is a
  // "no reading yet" state, not an error, so this stays quiet the same way
  // every other background poll in this console does (see api.js's own
  // comment on why only non-GET failures toast). Polled every 15s while a
  // token is known, cleared the moment it changes.
  useEffect(() => {
    setPoolFee(null);
    if (!token) return undefined;
    let alive = true;
    async function load() {
      try {
        const out = await api(`/v5/pool-fee?token=${encodeURIComponent(token)}`);
        if (alive) setPoolFee(out);
      } catch {
        if (alive) setPoolFee(null);
      }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  // Ticks the decay countdown down to the second. Only the rare hasDecay pool
  // needs this — the flat, normal case has nothing to count down.
  useEffect(() => {
    if (!poolFee?.hasDecay) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [poolFee?.hasDecay]);

  // Buys spend the bundle wallets directly — the launcher signs nothing here,
  // unlike the fan-out, so there is no `dev` gate to check.
  const noWallets = bundle.length === 0;

  const namedBuys = bundle
    .map((w) => ({ walletId: w.walletId, amountEth: amounts[w.walletId] }))
    .filter((b) => Number(b.amountEth) > 0);

  function body() {
    const b = { token, buys: namedBuys };
    const bps = Number(slippageBps);
    if (slippageBps.trim() && bps > 0) b.slippageBps = bps;
    if (differsFromLaunch && allowUnlisted) {
      b.allowUnlistedToken = true;
      // An unlisted token has no recorded launch hook for the server to pin,
      // so the exact pool hook must ride along — and the resolver refuses a
      // hook with no quote alongside it, so quote is always 'eth' here: a
      // per-wallet buy never carries anything else (see ETH_ONLY above).
      if (hookOverride.trim()) {
        b.hook = hookOverride.trim();
        b.quote = 'eth';
      }
    }
    return b;
  }

  // Split the typed total across the bundle wallets into a random, jittered
  // spread — mirrors WalletsPanel's own `distribute` (the v1 model this whole
  // panel follows), minus the fund reserve: funding is step 2, not this
  // table, so there is no Fund field to fill alongside the buy amount. Moves
  // NO ETH — it only writes the inputs the operator was going to type by hand.
  function distribute() {
    const total = Number(totalBuy);
    if (!(total > 0)) return notify('Enter a total buy amount first.', 'error');
    if (!bundle.length) return notify('No bundle wallets to distribute across.', 'error');

    // ±30% jitter around equal, normalised to the exact total; the rounding
    // drift is pushed onto the last wallet so the sum is exactly what was typed.
    const weights = bundle.map(() => 1 + (Math.random() - 0.5) * 0.6);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const vals = bundle.map((_, i) => Math.round((weights[i] / wsum) * total * 1e6) / 1e6);
    const drift = Math.round((total - vals.reduce((a, b) => a + b, 0)) * 1e6) / 1e6;
    vals[vals.length - 1] = Math.round((vals[vals.length - 1] + drift) * 1e6) / 1e6;

    setAmounts((prev) => {
      const next = { ...prev };
      bundle.forEach((w, i) => {
        next[w.walletId] = String(vals[i]);
      });
      return next;
    });
    report(
      `distributed ${total} ETH across ${bundle.length} wallets as buy amounts. Nothing was sent; edit ` +
        'any row, then Preflight.'
    );
    notify(`Filled ${bundle.length} wallets for ${total} ETH. No ETH moved — edit, then Preflight.`, 'ok');
  }

  async function preflight() {
    setBusy('preflight');
    setBlocked(false);
    setEthOnly(false);
    try {
      const out = await api('/v5/bundle-buy/preflight', 'POST', body());
      setPlan(out);
      report(out);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (WALLETS_BUSY.test(err.message)) setBlocked(true);
      if (ETH_ONLY.test(err.message)) setEthOnly(true);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is
  // clicked — same rule Modal.jsx documents (Enter never confirms).
  function fireBuy() {
    setPendingBody(body());
  }

  async function fire() {
    const b = pendingBody;
    setPendingBody(null);
    if (!b) return;

    setBusy('buy');
    setBlocked(false);
    setEthOnly(false);
    try {
      const out = await api('/v5/bundle-buy', 'POST', { ...b, confirm: true });
      report(out);
      setResult(out);
      setArmed(false);
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (WALLETS_BUSY.test(err.message)) setBlocked(true);
      if (ETH_ONLY.test(err.message)) setEthOnly(true);
    } finally {
      setBusy('');
    }
  }

  const tokenReady =
    Boolean(token) && (!differsFromLaunch || (allowUnlisted && Boolean(hookOverride.trim())));
  const ready = tokenReady && !noWallets && namedBuys.length > 0;
  const blockedByArm = live && !armed;

  const results = Array.isArray(result?.buys) ? result.buys : [];
  const failedCount = result?.failed ?? results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const pendingCount = result?.pending ?? results.filter((r) => r.status === 'pending').length;

  return (
    <>
      {noWallets && (
        <div className="notice warn">
          <h3>No bundle wallets yet</h3>
          <p>Generate them in step 1 — there is nothing to buy with until a wallet holds ETH.</p>
        </div>
      )}

      {blocked && (
        <div className="notice danger">
          <h3>The bundle wallets are busy</h3>
          <p>
            Another buy or sell is already running on these wallets, or a fan-out is still landing
            tokens into them. Wait a moment and try again; there is nothing to resolve here, it clears
            on its own.
          </p>
        </div>
      )}

      {ethOnly && (
        <div className="notice warn">
          <h3>This launch quotes in USDG, not ETH</h3>
          <p>
            Per-wallet buys only support an ETH-quoted pool right now — a USDG-quoted launch would need
            the same Permit2 approvals the Sell step has, which this path does not carry yet. Use the
            untaxed fan-out instead — flip the Method switch above.
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
          No launch this session yet — type the token address below if you're buying one launched
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
          I'm sure this is my token — buy it even though it wasn't launched here
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
              buy refuses without it, because a probed hook could hit a decoy pool.
            </span>
          </label>
        </div>
      )}
      {!token && (
        <div className="notice warn">
          <h3>No token to buy</h3>
          <p>Launch a token in step 3 first, or type its address above.</p>
        </div>
      )}

      {token && !poolFee?.hasDecay && (
        <p className="hint">
          {poolFee
            ? `Pool tax: ${pct(poolFee.currentPct)}% (flat — no anti-snipe premium; buy any time)`
            : 'Pool tax shows here once the token is launched.'}
        </p>
      )}
      {token && poolFee?.hasDecay && (
        <div className="notice">
          <h3>Anti-snipe premium still decaying</h3>
          <p>
            {poolFee.premiumGoneAt - Math.floor(now / 1000) > 0 ? (
              <>
                Pool tax: {pct(poolFee.currentPct)}% now → {pct(poolFee.basePct)}% base · premium gone in{' '}
                {countdown(poolFee.premiumGoneAt - Math.floor(now / 1000))} (at{' '}
                {new Date(poolFee.premiumGoneAt * 1000).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
                )
              </>
            ) : (
              <>premium settled — now at base {pct(poolFee.basePct)}%</>
            )}
          </p>
        </div>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Buys</h3>
      <div className="grid">
        <label>
          Slippage floor (bps, optional)
          <input
            type="number"
            step="1"
            min="0"
            placeholder="100"
            value={slippageBps}
            onChange={(e) => setSlippageBps(e.target.value)}
          />
          <span className="hint">
            empty = 1% default — the tax is already in the quote below; this is only headroom for
            movement between preflight and broadcast
          </span>
        </label>
      </div>

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
          <Busy className="ghost" disabled={!(Number(totalBuy) > 0)} onClick={distribute}>
            Distribute across {bundle.length} wallet{bundle.length === 1 ? '' : 's'}
          </Busy>
          <span className="hint">random split · sum exact · fields stay editable · moves no ETH</span>
        </div>
      )}

      {bundle.length === 0 ? (
        <p className="hint">No bundle wallets to buy with — generate some in step 1.</p>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Address</th>
                <th className="num">Balance (ETH)</th>
                <th className="num">Buy (ETH)</th>
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
      )}

      {plan && (
        <div className="notice">
          <h3>Preflight result — {plan.symbol}</h3>
          <ul>
            <li>
              {plural(plan.walletCount, 'wallet')} buying · {eth(plan.totalEth)} ETH in · ≈
              {fmt(plan.totalExpectedTokens)} {plan.symbol} expected at the CURRENT tax
            </li>
            <li>slippage floor {plan.slippageBps} bps</li>
          </ul>
          <div className="table-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">ETH in</th>
                  <th className="num">Expected {plan.symbol}</th>
                </tr>
              </thead>
              <tbody>
                {plan.buys.map((b) => (
                  <tr key={b.walletId}>
                    <td className="addr">
                      <Address value={b.address} plain href={explorerFor(b.address)} />
                    </td>
                    <td className="num">{eth(b.ethIn)}</td>
                    <td className="num">{fmt(b.expectedTokens)}</td>
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
                ? 'check "I\'m sure this is my token" to buy a token launched elsewhere'
                : namedBuys.length === 0
                  ? "enter at least one wallet's buy amount above"
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
          busy={busy === 'buy'}
          className={live ? 'danger' : ''}
          disabled={!ready || blockedByArm}
          title={
            !ready
              ? 'fill in the token and at least one wallet amount above'
              : blockedByArm
                ? "flip Arm first — this spends each wallet's ETH"
                : ''
          }
          onClick={fireBuy}
        >
          {live ? 'Buy' : 'Buy (dry run)'}
        </Busy>
      </div>

      {result && (
        <>
          <div className="stats" style={{ marginTop: 14 }}>
            <div className={`stat ${failedCount ? 'bad' : 'ok'}`}>
              <span>Bought</span>
              <b>
                {result.bought}
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
                  <th className="num">ETH in</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={`${r.walletId ?? r.address}-${i}`}>
                    <td className="addr">
                      <Address value={r.address} plain href={explorerFor(r.address)} />
                    </td>
                    <td className="num">{eth(r.ethIn)}</td>
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
                      {r.hash && (
                        <div className="hint">
                          <a href={explorer ? `${explorer}/tx/${r.hash}` : undefined} target="_blank" rel="noreferrer">
                            {r.hash.slice(0, 18)}…
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
              <h3>Some buys failed</h3>
              <p>
                {plural(failedCount, 'wallet')} reverted or failed to send — its ETH stays put and
                nothing was bought for it. Re-run Preflight to try the failed wallets again; the others
                are unaffected.
              </p>
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(pendingBody)}
        danger={live}
        title={live ? "LIVE BUY — spends each wallet's ETH." : `Dry run buy of ${symbol || 'this token'}`}
        confirmLabel={live ? 'Buy' : 'Buy (dry run)'}
        onConfirm={fire}
        onCancel={() => setPendingBody(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Token" mono>
            {pendingBody?.token || '—'}
          </Fact>
          <Fact label="Wallets">{plural(pendingBody?.buys?.length || 0, 'wallet')}</Fact>
          <Fact label="Total ETH">
            {(pendingBody?.buys || []).reduce((s, b) => s + Number(b.amountEth || 0), 0).toFixed(6)}
          </Fact>
          <Fact label="Slippage floor">
            {pendingBody?.slippageBps ? `${pendingBody.slippageBps} bps` : '1% default'}
          </Fact>
        </div>
      </Modal>
    </>
  );
}
