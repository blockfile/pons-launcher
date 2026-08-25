import { useEffect, useState } from 'react';
import { api, notify } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import LogoField from '../components/LogoField.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

const BLANK = {
  name: '',
  symbol: '',
  logo: '',
  description: '',
  telegram: '',
  twitter: '',
  discord: '',
  website: '',
  extra: '',
  firstBuyAmount: '0',
  configId: '',
};

// The 409 routes/v5.js raises for a launch that was broadcast but never got a
// receipt (see the pendingLaunches guard). Matched on this substring rather
// than the status code because api.js only ever surfaces `json.error` as the
// thrown Error's message. The OTHER 409 this route can return ("a v5 launch is
// already in progress") is a different guard — an overlapping request, not a
// parked one — and is deliberately NOT matched here.
const NEVER_CONFIRMED = /never confirmed/i;

// Token amounts (the bundle's expected output) arrive as decimal strings.
function fmt(v, dp = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '—');
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

/**
 * Step 3 — the COMBINED "Launch + bundle", uniform with the pons v1 Launcher
 * tab. ONE armed action fires the launch (with the launcher's atomic first buy
 * inside it) and, the instant it confirms, every bundle wallet's buy against
 * the freshly-created pool. This is the v1 mechanic — one form, one button —
 * brought to letscash, replacing the old split of a Launch step and a separate
 * Bundle step.
 *
 * TWO ACTIONS, the same preflight -> fire shape as every other v5 money path:
 *
 *   Preflight   POST /v5/launch-bundle/preflight. Signs + simulates the LAUNCH
 *               (the only part that can revert and burn a fee), broadcasts
 *               nothing, and echoes how many bundle wallets are set to buy. The
 *               per-wallet buy cannot be quoted until the pool exists, so its
 *               real quote + the flat tax it pays are built at FIRE time.
 *   Launch      POST /v5/launch-bundle with { confirm: true }. Fires the launch,
 *               then the bundle buys. The money path — vermilion confirm dialog
 *               whenever the console is live.
 *
 * THE BUNDLE PAYS THE FLAT TAX. Unlike pons, letscash gives bundle wallets no
 * tax exemption, so each bundle buy pays the pool's base tier (1/3/5/10%). It
 * fires right after launch either way — the tax changes the cost, not the flow.
 *
 * NEVER LOSES THE LAUNCH. If the launch confirms but the bundle cannot run (an
 * unreadable receipt hook, a USDG-quoted launch — per-wallet buys are ETH-only
 * — or the buys could not be prepared), the launch success is kept and the
 * response carries `bundleSkipped`; fire the bundle from the Bundle tools
 * utility below the sequence. See backend/src/v5/launchBundle.js.
 *
 * THE PARKED CASE is unchanged from the standalone launch: a launch whose
 * receipt never arrives comes back `status: 'pending'` and PARKS the launcher
 * (every further launch 409s "...never confirmed...") until POST
 * /v5/launch/resolve re-checks it. Tracked here as `parked`, with its own
 * Resolve button.
 */
export default function V5LaunchPanel({ step, dev, bundle = [], launchConfigs, live, explorer, reload, report, onLaunched }) {
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [plan, setPlan] = useState(null); // the last preflight's { plan, simulate, bundle }
  const [result, setResult] = useState(null); // the last combined fire response
  const [armed, setArmed] = useState(false);
  const [pendingBody, setPendingBody] = useState(null); // the body a confirm dialog is about to fire
  const [parked, setParked] = useState(false);
  const [quoteInfo, setQuoteInfo] = useState(null);
  const [quoteInfoBusy, setQuoteInfoBusy] = useState(false);

  // The bundle half: a per-wallet ETH buy table, plus a "distribute a total"
  // auto-fill — the same controls the old standalone buy panel carried, folded
  // in here so the launch and its bundle are armed and fired together.
  const [amounts, setAmounts] = useState({}); // walletId -> typed ETH string
  const [totalBuy, setTotalBuy] = useState('');
  const [slippageBps, setSlippageBps] = useState('');

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const setLogo = (logo) => setF((prev) => ({ ...prev, logo }));
  const setAmount = (walletId, value) => setAmounts((prev) => ({ ...prev, [walletId]: value }));

  const enabledConfigs = (launchConfigs?.configs || []).filter((c) => c.enabled);
  const cfg = enabledConfigs.find((c) => c.configId === Number(f.configId)) || null;
  const launchesPaused = launchConfigs != null && !launchConfigs.launchEnabled;

  // Default to the first enabled config once the menu loads.
  useEffect(() => {
    if (f.configId || !enabledConfigs.length) return;
    setF((prev) => ({ ...prev, configId: String(enabledConfigs[0].configId) }));
  }, [launchConfigs]);

  // A preflight card and a fire result belong to the token/config that produced
  // them — once the operator changes what would be launched, drop both so a new
  // token's form can never show the PREVIOUS launch's success (or a stale
  // preflight). The sibling money panels keep the same guard. `parked` is
  // deliberately NOT cleared here: it is a server-side condition (a launcher with
  // an unconfirmed launch in flight) that editing the form does not undo — only
  // resolving it does.
  useEffect(() => {
    setPlan(null);
    setResult(null);
  }, [f.configId, f.name, f.symbol]);

  // A non-native (USDG) config's first buy is PULLED from the launcher by the
  // factory's allowance — read that allowance (and the launcher's USDG balance)
  // to gate Preflight/Launch and to offer the Approve button. ETH configs need none.
  useEffect(() => {
    if (!cfg || cfg.quoteIsNative) {
      setQuoteInfo(null);
      setQuoteInfoBusy(false);
      return undefined;
    }
    let cancelled = false;
    setQuoteInfoBusy(true);
    (async () => {
      try {
        const out = await api('/v5/launch/quote-allowance?quote=usdg');
        if (!cancelled) setQuoteInfo(out);
      } catch (err) {
        if (!cancelled) {
          setQuoteInfo(null);
          report(`ERROR: ${err.message}`);
        }
      } finally {
        if (!cancelled) setQuoteInfoBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg?.configId, cfg?.quoteIsNative]);

  async function approveUsdg() {
    setBusy('approve');
    try {
      const amount = f.firstBuyAmount && Number(f.firstBuyAmount) > 0 ? String(f.firstBuyAmount) : undefined;
      const out = await api('/v5/launch/approve', 'POST', amount ? { amount } : {});
      report(out);
      const refreshed = await api('/v5/launch/quote-allowance?quote=usdg');
      setQuoteInfo(refreshed);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const usdgQuoted = Boolean(cfg) && !cfg.quoteIsNative;

  const namedBuys = bundle
    .map((w) => ({ walletId: w.walletId, amountEth: amounts[w.walletId] }))
    .filter((b) => Number(b.amountEth) > 0);

  function body() {
    const out = {
      params: {
        name: f.name.trim(),
        symbol: f.symbol.trim(),
        logo: f.logo.trim(),
        description: f.description.trim(),
        socials: {
          telegram: f.telegram.trim(),
          twitter: f.twitter.trim(),
          discord: f.discord.trim(),
          website: f.website.trim(),
          extra: f.extra.trim(),
        },
      },
      configId: Number(f.configId),
    };
    // A USDG-quoted config's first buy rides the allowance (firstBuy, USDG units);
    // an ETH config sends firstBuyEth. Unchanged from the standalone launch.
    if (usdgQuoted) out.firstBuy = f.firstBuyAmount || '0';
    else out.firstBuyEth = f.firstBuyAmount || '0';

    // The bundle: each named wallet's ETH buy, plus an optional shared slippage
    // floor. Omitted entirely when nobody is set to buy — then this is a plain
    // launch through the same endpoint. Also omitted for a USDG-quoted launch:
    // the per-wallet buys are ETH-only, so sending them would only be skipped
    // server-side — dropping them here keeps the confirm dialog and button
    // honest ("launch only"), while the in-form warning explains why.
    if (!usdgQuoted && namedBuys.length) out.buys = namedBuys;
    const bps = Number(slippageBps);
    if (slippageBps.trim() && bps > 0) out.slippageBps = bps;
    return out;
  }

  // Split a typed total across the bundle wallets into a jittered spread — the
  // v1 model. Moves NO ETH; only fills the buy inputs the operator would type.
  function distribute() {
    const total = Number(totalBuy);
    if (!(total > 0)) return notify('Enter a total buy amount first.', 'error');
    if (!bundle.length) return notify('No bundle wallets to distribute across.', 'error');

    const weights = bundle.map(() => 1 + (Math.random() - 0.5) * 0.6); // ±30% jitter
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
    notify(`Filled ${bundle.length} wallets for ${total} ETH. No ETH moved — edit, then Preflight.`, 'ok');
  }

  async function preflight() {
    setBusy('preflight');
    // Drop any prior fire result and preflight card up front, so a preflight that
    // then fails cannot leave an earlier run's success on screen (the same-form
    // re-run case the change-effect above does not cover).
    setResult(null);
    setPlan(null);
    try {
      const out = await api('/v5/launch-bundle/preflight', 'POST', body());
      setPlan(out);
      report(out);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (NEVER_CONFIRMED.test(err.message)) setParked(true);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is clicked.
  function launch() {
    setPendingBody(body());
  }

  async function fire() {
    const b = pendingBody;
    setPendingBody(null);
    if (!b) return;

    setBusy('launch');
    // Clear the previous run's result before this one, so a fire that throws
    // (500 / 409 / network) never leaves the prior launch's success card up as
    // if it were this attempt's outcome.
    setResult(null);
    try {
      const out = await api('/v5/launch-bundle', 'POST', { ...b, confirm: true });
      report(out);
      setResult(out);
      setArmed(false);
      // A pending receipt parks the launcher server-side; everything else —
      // confirmed or reverted — is a definitive outcome for this run.
      if (out?.launch?.status === 'pending' || out?.pending) {
        setParked(true);
      } else {
        setParked(false);
        onLaunched?.(out);
      }
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (NEVER_CONFIRMED.test(err.message)) setParked(true);
    } finally {
      setBusy('');
    }
  }

  async function resolvePending() {
    setBusy('resolve');
    try {
      const out = await api('/v5/launch/resolve', 'POST');
      report(out);
      if (out?.resolved === true || out?.pending === null) {
        setParked(false);
        if (out?.resolved) onLaunched?.(out);
      }
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const needed =
    Number(launchConfigs?.launchFeeWei || 0) / 1e18 + (usdgQuoted ? 0 : Number(f.firstBuyAmount || 0));
  const devBalance = Number(dev?.balanceEth || 0);
  const underfunded = Boolean(dev) && needed > 0 && devBalance < needed;

  const usdgFirstBuy = usdgQuoted ? Number(f.firstBuyAmount || 0) : 0;
  const usdgUnderfunded = usdgQuoted && usdgFirstBuy > 0 && quoteInfo != null && Number(quoteInfo.balance) < usdgFirstBuy;
  const usdgAllowanceShort =
    usdgQuoted && usdgFirstBuy > 0 && (quoteInfo == null || Number(quoteInfo.allowance) < usdgFirstBuy);

  const ready = Boolean(f.name.trim() && f.symbol.trim() && f.logo && f.configId) && !uploading;
  const blocked = live && !armed;
  // Whether the bundle buys actually ride with this launch. A USDG launch skips
  // them (ETH-only), so it is a plain launch even with the buy table filled —
  // the button label and confirm dialog follow this, not the raw row count.
  const bundleWillFire = !usdgQuoted && namedBuys.length > 0;

  const p = plan?.plan;
  const pendingCfg = pendingBody ? enabledConfigs.find((c) => c.configId === pendingBody.configId) : null;
  const pendingQuoteSymbol = pendingCfg?.quoteSymbol || 'ETH';
  const pendingBuyTotal = (pendingBody?.buys || []).reduce((s, b) => s + Number(b.amountEth || 0), 0);

  // The combined fire result's bundle half, for the readout below.
  const bundleRes = result?.bundle || null;
  const bundleBuys = Array.isArray(bundleRes?.buys) ? bundleRes.buys : [];
  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  return (
    <Step {...step}>
      <p className="lede">
        One action does both: it deploys the token, opens the letscash pool and makes the launcher's{' '}
        <b>first buy inside the same transaction</b> — and the moment that confirms, every bundle wallet
        below <b>buys the pool with its own ETH</b>. The launch's first buy can't be front-run; the
        bundle buys pay the pool's flat base tax. Fill the launch, set each wallet's buy, arm, and fire.
      </p>

      {!dev && (
        <div className="notice warn">
          <h3>No launcher wallet yet</h3>
          <p>Generate one in step 1 — it is the only wallet that can sign the launch.</p>
        </div>
      )}

      {launchesPaused && (
        <div className="notice danger">
          <h3>Launches are paused</h3>
          <p>The letscash factory has launchEnabled = false right now. Nothing here can broadcast until it is flipped back on — Preflight and Launch stay disabled.</p>
        </div>
      )}

      <h3 style={{ margin: '0 0 8px' }}>The launch</h3>
      <div className="grid">
        <label>
          Launch config
          <select value={f.configId} onChange={set('configId')} disabled={!enabledConfigs.length}>
            {!enabledConfigs.length && <option value="">no enabled configs</option>}
            {enabledConfigs.map((c) => (
              <option key={c.configId} value={c.configId}>
                #{c.configId} — {c.taxLabel} tax · {c.quoteSymbol} · {c.mode}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input value={f.name} onChange={set('name')} placeholder="Token name" />
        </label>
        <label>
          Symbol
          <input value={f.symbol} onChange={set('symbol')} placeholder="Symbol" />
        </label>
        <label className="half">
          Website
          <input value={f.website} onChange={set('website')} placeholder="https://…" />
        </label>

        <LogoField value={f.logo} onChange={setLogo} onUploading={setUploading} />

        <label>
          Twitter
          <input value={f.twitter} onChange={set('twitter')} placeholder="https://x.com/…" />
        </label>
        <label>
          Telegram
          <input value={f.telegram} onChange={set('telegram')} placeholder="https://t.me/…" />
        </label>
        <label>
          Discord
          <input value={f.discord} onChange={set('discord')} />
        </label>
        <label>
          Other
          <input value={f.extra} onChange={set('extra')} placeholder="any other link" />
        </label>

        <label className="wide">
          Description
          <textarea rows="2" value={f.description} onChange={set('description')} />
        </label>

        <label className="half">
          First buy ({cfg?.quoteSymbol || 'ETH'})
          <input type="number" step="0.0001" value={f.firstBuyAmount} onChange={set('firstBuyAmount')} />
          <span className="hint">
            {usdgQuoted
              ? `pulled from the launcher's ${cfg.quoteSymbol} balance by allowance — approve the factory below before launching`
              : 'the guaranteed-first buy, made inside the launch itself — nothing can get ahead of it'}
          </span>
        </label>
      </div>

      {cfg && (
        <div className="notice">
          <h3>What config #{cfg.configId} enforces</h3>
          <ul>
            <li>
              launch fee {Number(launchConfigs.launchFeeWei) / 1e18} ETH · supply{' '}
              {(Number(cfg.supply) / 1e18).toLocaleString()} · tax {cfg.taxLabel}
            </li>
            <li>
              quoted in <b>{cfg.quoteSymbol}</b>
              {cfg.quoteIsNative ? ' (native)' : ` — ${cfg.quoteAsset.slice(0, 6)}…${cfg.quoteAsset.slice(-4)}`}
            </li>
            <li>
              {cfg.mode === 'selfburn'
                ? 'self-burn mode — the creator fee share is burned rather than paid out'
                : `creator mode — ${cfg.creatorFeeBps / 100}% of trading fees route to the launcher`}
            </li>
            <li>no restriction window and no exemption list — the bundle buys below pay this same base tax</li>
          </ul>
        </div>
      )}

      {dev && (
        <div className="row">
          <span className="hint">
            launcher holds {eth(dev.balanceEth)} ETH
            {needed > 0 ? ` · needs ≈${needed.toFixed(4)} ETH (fee + first buy, gas on top)` : ''}
          </span>
        </div>
      )}
      {underfunded && (
        <div className="notice danger">
          <h3>The launcher cannot cover this</h3>
          <p>
            It holds {eth(dev.balanceEth)} ETH but this launch needs ≈{needed.toFixed(4)} ETH before
            gas — fund it in step 2 first.
          </p>
        </div>
      )}

      {usdgQuoted && (
        <div className="row">
          <span className="hint">
            {quoteInfo
              ? `launcher holds ${eth(quoteInfo.balance)} ${cfg.quoteSymbol} · allowance to the factory ${eth(quoteInfo.allowance)} ${cfg.quoteSymbol}`
              : quoteInfoBusy
                ? `reading the launcher's ${cfg.quoteSymbol} balance and allowance…`
                : `could not read the launcher's ${cfg.quoteSymbol} balance — try reselecting the config`}
          </span>
        </div>
      )}
      {usdgUnderfunded && (
        <div className="notice danger">
          <h3>The launcher cannot cover this in {cfg.quoteSymbol}</h3>
          <p>
            It holds {eth(quoteInfo.balance)} {cfg.quoteSymbol} but this first buy needs {f.firstBuyAmount}{' '}
            {cfg.quoteSymbol} — fund the launcher with {cfg.quoteSymbol} first.
          </p>
        </div>
      )}
      {usdgAllowanceShort && !usdgUnderfunded && (
        <div className="notice warn">
          <h3>Approve {cfg.quoteSymbol} first</h3>
          <p>
            The factory needs allowance to pull {f.firstBuyAmount} {cfg.quoteSymbol} from the launcher
            for the atomic first buy.
            {quoteInfo ? ` It currently allows ${eth(quoteInfo.allowance)} ${cfg.quoteSymbol}.` : ''}
          </p>
          <div className="row">
            <Busy busy={busy === 'approve'} className="btn-primary" onClick={approveUsdg}>
              Approve {cfg.quoteSymbol}
            </Busy>
          </div>
        </div>
      )}

      {/* The bundle half — a per-wallet ETH buy table, fired the instant the
          launch confirms. Optional: leave every row blank to launch only. */}
      <h3 style={{ margin: '18px 0 8px' }}>The bundle — each wallet's buy</h3>
      {bundle.length === 0 ? (
        <div className="notice warn">
          <h3>No bundle wallets yet</h3>
          <p>Generate them in step 1. You can still launch on its own — the bundle just needs wallets to buy with.</p>
        </div>
      ) : (
        <>
          <p className="hint" style={{ margin: '0 0 8px' }}>
            Each bundle wallet buys the token with its own ETH right after launch, paying the pool's flat
            base tax ({cfg?.taxLabel || 'the config tier'}). Fund these wallets in step 2 first; a wallet
            short of ETH is skipped, not failed.
          </p>
          {usdgQuoted && namedBuys.length > 0 && (
            <div className="notice warn">
              <h3>This launch is USDG-quoted — the bundle buys can't ride along</h3>
              <p>
                Per-wallet buys are ETH-only for now, so with a USDG config the launch fires on its own
                and the buys are skipped (you'll see that in the result). Buy them afterward from the
                Bundle tools below (untaxed fan-out), or pick an ETH-quoted config.
              </p>
            </div>
          )}

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

          <div className="grid" style={{ marginTop: 8 }}>
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
              <span className="hint">empty = 1% default — the tax is already in the quote; this is only headroom</span>
            </label>
          </div>

          <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto', marginTop: 8 }}>
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
          {namedBuys.length > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {plural(namedBuys.length, 'wallet')} set to buy ·{' '}
              {namedBuys.reduce((s, b) => s + Number(b.amountEth || 0), 0).toFixed(6)} ETH total
            </p>
          )}
        </>
      )}

      {parked && (
        <div className="notice danger">
          <h3>A previous launch never confirmed</h3>
          <p>
            It was broadcast but no receipt arrived before the timeout. The launcher is parked — every
            new launch is refused — until this is resolved against the chain.
          </p>
          <div className="row">
            <Busy busy={busy === 'resolve'} className="btn-primary" onClick={resolvePending}>
              Resolve pending launch
            </Busy>
          </div>
        </div>
      )}

      {p && (
        <div className="notice">
          <h3>Preflight result</h3>
          <ul>
            <li>
              token <Address value={p.token} plain href={explorer ? `${explorer}/address/${p.token}` : ''} />
            </li>
            <li>pool {p.poolId ? `${p.poolId.slice(0, 10)}…${p.poolId.slice(-6)}` : '—'}</li>
            <li>
              value {p.launch?.valueEth} ETH · fee {p.launchFeeEth} ETH · first buy {p.firstBuyAmount}{' '}
              {p.quoteSymbol} · gas {p.launch?.gas}
            </li>
            <li>
              bundle: {plural(plan?.bundle?.walletCount || 0, 'wallet')} set to buy — fired against the pool
              the instant the launch confirms
            </li>
          </ul>
          {p.warnings?.length > 0 && (
            <ul>
              {p.warnings.map((w, i) => (
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
          disabled={!ready || !dev || launchesPaused || usdgAllowanceShort}
          title={
            !dev
              ? 'generate a launcher wallet first'
              : usdgAllowanceShort
                ? `approve ${cfg.quoteSymbol} first — the factory needs allowance to pull the first buy`
                : ready
                  ? 'signs everything, broadcasts nothing'
                  : 'fill in the config, name, symbol and a logo'
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
          busy={busy === 'launch'}
          className={live ? 'danger' : ''}
          disabled={!ready || !dev || launchesPaused || blocked || parked || usdgAllowanceShort}
          title={
            !dev
              ? 'generate a launcher wallet first'
              : !ready
                ? 'fill in the config, name, symbol and a logo'
                : parked
                  ? 'resolve the pending launch above first'
                  : usdgAllowanceShort
                    ? `approve ${cfg.quoteSymbol} first — the factory needs allowance to pull the first buy`
                    : blocked
                      ? 'flip Arm first — this spends real funds'
                      : ''
          }
          onClick={launch}
        >
          {(() => {
            const verb = bundleWillFire ? 'Launch + bundle' : 'Launch';
            return live ? verb : `${verb} (dry run)`;
          })()}
        </Busy>
      </div>

      {/* The combined result — the launch outcome, then the bundle buys that
          fired after it (or why they didn't). */}
      {result && (
        <div style={{ marginTop: 14 }}>
          <div className="notice">
            <h3>
              Launch {result.launch?.status || (result.pending ? 'pending' : '—')}
              {result.token ? ` — ${result.plan?.params?.symbol || ''}` : ''}
            </h3>
            {result.token && (
              <p>
                token <Address value={result.token} plain href={explorerFor(result.token)} />
              </p>
            )}
          </div>

          {result.bundleSkipped && (
            <div className="notice warn">
              <h3>The bundle did not fire</h3>
              <p>{result.bundleSkipped}</p>
            </div>
          )}

          {bundleRes && (
            <>
              <div className="stats" style={{ marginTop: 12 }}>
                <div className={`stat ${bundleRes.failed ? 'bad' : 'ok'}`}>
                  <span>Bought</span>
                  <b>
                    {bundleRes.bought}
                    <span className="stat-of">/{bundleBuys.length}</span>
                  </b>
                </div>
                <div className={`stat ${bundleRes.failed ? 'bad' : ''}`}>
                  <span>Failed</span>
                  <b>{bundleRes.failed}</b>
                </div>
                <div className="stat">
                  <span>Pending</span>
                  <b>{bundleRes.pending}</b>
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
                    {bundleBuys.map((r, i) => (
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
            </>
          )}
        </div>
      )}

      <Modal
        open={Boolean(pendingBody)}
        danger={live}
        title={
          live
            ? `LIVE — this launches ${pendingBody?.params.symbol || ''}${
                pendingBody?.buys?.length ? ' and buys from every funded bundle wallet' : ''
              }, spending real funds.`
            : `Dry run launch of ${pendingBody?.params.symbol || ''}`
        }
        confirmLabel={live ? (pendingBody?.buys?.length ? 'Launch + bundle' : 'Launch') : 'Launch (dry run)'}
        onConfirm={fire}
        onCancel={() => setPendingBody(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Symbol">{pendingBody?.params.symbol || '—'}</Fact>
          <Fact label="Config">#{pendingBody?.configId}</Fact>
          <Fact label="First buy">
            {pendingBody?.firstBuy ?? pendingBody?.firstBuyEth ?? 0} {pendingQuoteSymbol}
          </Fact>
          <Fact label="Bundle">
            {pendingBody?.buys?.length
              ? `${plural(pendingBody.buys.length, 'wallet')} · ${pendingBuyTotal.toFixed(6)} ETH`
              : 'none — launch only'}
          </Fact>
        </div>
      </Modal>
    </Step>
  );
}
