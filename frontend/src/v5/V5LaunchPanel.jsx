import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import LogoField from '../components/LogoField.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth } from './roles.js';

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
// thrown Error's message — the 409 itself, and the `pending`/`resolve` fields
// beside it, do not survive the throw. This phrase is the one thing that does.
// The OTHER 409 this route can return ("a v5 launch is already in progress")
// is a different guard — an overlapping request, not a parked one — and is
// deliberately NOT matched here: it clears itself once that request finishes,
// and offering "resolve" for it would be the wrong control.
const NEVER_CONFIRMED = /never confirmed/i;

/**
 * Step 3 — the letscash launch and its atomic first buy.
 *
 * TWO ACTIONS, mirroring the pons preflight -> fire pattern (components/
 * LaunchForm.jsx):
 *
 *   Preflight   POST /v5/launch/preflight. Signs the launch against the
 *               launcher's pending nonce and proves — via a static simulate —
 *               that it will not revert. Broadcasts nothing. Shown here so an
 *               operator can read the predicted token, pool, value, fee, gas
 *               and any warnings before spending anything.
 *   Launch      POST /v5/launch with { confirm: true }. Repeats the same
 *               preflight server-side, then broadcasts. This is the money
 *               path — it always goes through a confirmation dialog, and the
 *               dialog is vermilion whenever the console is live.
 *
 * THE PARKED CASE. A launch whose receipt never arrives comes back from the
 * server as `status: 'pending'` (still HTTP 200 — the request itself
 * succeeded) and PARKS the launcher wallet: every further launch is refused
 * with 409 ("...never confirmed...") until POST /v5/launch/resolve re-checks
 * the hash against the chain. This panel tracks that locally as `parked` —
 * set the moment either a launch response or a launch attempt says so — and
 * offers a "Resolve pending launch" button for exactly that state. There is
 * nothing else this panel can do while parked: launching again would sign at
 * the next nonce and spend a second fee + first buy alongside the one still
 * in flight, which is the whole reason the server refuses it.
 *
 * The atomic first buy is the bundler's whole edge here — letscash has no
 * snipe-tax exemption list the way pons v2 does, so there is nothing to
 * declare. The first buy runs INSIDE the launch, after the pool is seeded and
 * before anyone else can trade it, which is what makes it unfront-runnable.
 * The fan-out to the bundle wallets is the NEXT step (untaxed token transfers
 * on letscash) and is not part of this one.
 */
export default function V5LaunchPanel({ step, dev, launchConfigs, live, explorer, reload, report, onLaunched }) {
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [plan, setPlan] = useState(null); // the last preflight's { plan, simulate }
  const [armed, setArmed] = useState(false);
  const [pendingBody, setPendingBody] = useState(null); // the body a confirm dialog is about to fire
  const [parked, setParked] = useState(false);
  // The launcher's USDG balance + its allowance to the factory (GET /v5/launch/
  // quote-allowance), read whenever a non-native config is selected — an ETH
  // config needs neither, so this stays null for one.
  const [quoteInfo, setQuoteInfo] = useState(null);
  const [quoteInfoBusy, setQuoteInfoBusy] = useState(false);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const setLogo = (logo) => setF((prev) => ({ ...prev, logo }));

  const enabledConfigs = (launchConfigs?.configs || []).filter((c) => c.enabled);
  const cfg = enabledConfigs.find((c) => c.configId === Number(f.configId)) || null;
  const launchesPaused = launchConfigs != null && !launchConfigs.launchEnabled;

  // Default to the first enabled config once the menu loads, the same way
  // LaunchForm resets its own selection when its config list arrives.
  useEffect(() => {
    if (f.configId || !enabledConfigs.length) return;
    setF((prev) => ({ ...prev, configId: String(enabledConfigs[0].configId) }));
  }, [launchConfigs]);

  // A non-native (USDG) config's first buy is PULLED from the launcher by the
  // factory's allowance, not ridden in msg.value — so the console needs to know
  // that allowance (and the launcher's USDG balance) to gate Preflight/Launch
  // and to offer the Approve button. Re-read it whenever the selected config
  // changes to (or stays) a USDG one; an ETH config needs none of this.
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
      // Approve exactly this first buy, not MAX: the launcher is a hot wallet and
      // the factory is an upgradeable proxy, so a bounded, per-launch allowance
      // keeps a compromised upgrade from ever pulling more than one first buy. The
      // gate below re-shows this button if the amount is later raised.
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
    // A USDG-quoted config's first buy is pulled by allowance, denominated in
    // USDG units — sent as `firstBuy`, which the backend reads ahead of the
    // legacy `firstBuyEth` alias (input.firstBuy ?? input.firstBuyEth). An
    // ETH-quoted config keeps sending `firstBuyEth`, unchanged.
    if (cfg && !cfg.quoteIsNative) {
      out.firstBuy = f.firstBuyAmount || '0';
    } else {
      out.firstBuyEth = f.firstBuyAmount || '0';
    }
    return out;
  }

  async function preflight() {
    setBusy('preflight');
    try {
      const out = await api('/v5/launch/preflight', 'POST', body());
      setPlan(out);
      report(out);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (NEVER_CONFIRMED.test(err.message)) setParked(true);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is
  // clicked — same rule Modal.jsx documents (Enter never confirms).
  function launch() {
    setPendingBody(body());
  }

  async function fire() {
    const b = pendingBody;
    setPendingBody(null);
    if (!b) return;

    setBusy('launch');
    try {
      const out = await api('/v5/launch', 'POST', { ...b, confirm: true });
      report(out);
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
      // `resolved: true` is a definitive outcome, cleared and recorded server-
      // side. `pending: null` means the server was not holding a parked launch
      // at all (an in-memory guard lost to a restart, say) — either way there
      // is nothing left for this button to do.
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
    Number(launchConfigs?.launchFeeWei || 0) / 1e18 + (cfg && !cfg.quoteIsNative ? 0 : Number(f.firstBuyAmount || 0));
  const devBalance = Number(dev?.balanceEth || 0);
  const underfunded = Boolean(dev) && needed > 0 && devBalance < needed;

  // A USDG-quoted config with a nonzero typed first buy needs both a big-enough
  // launcher balance and a big-enough factory allowance — read from quoteInfo,
  // fetched above. While quoteInfo has not loaded (or failed to), treat the
  // allowance as NOT proven sufficient: the backend will refuse an under-
  // approved launch anyway, so guiding the operator to Approve first (or to
  // wait for the read) is better than letting Preflight/Launch fail loudly.
  const usdgQuoted = Boolean(cfg) && !cfg.quoteIsNative;
  const usdgFirstBuy = usdgQuoted ? Number(f.firstBuyAmount || 0) : 0;
  const usdgUnderfunded = usdgQuoted && usdgFirstBuy > 0 && quoteInfo != null && Number(quoteInfo.balance) < usdgFirstBuy;
  const usdgAllowanceShort =
    usdgQuoted && usdgFirstBuy > 0 && (quoteInfo == null || Number(quoteInfo.allowance) < usdgFirstBuy);

  const ready = Boolean(f.name.trim() && f.symbol.trim() && f.logo && f.configId) && !uploading;
  const blocked = live && !armed;

  const p = plan?.plan;
  const pendingCfg = pendingBody ? enabledConfigs.find((c) => c.configId === pendingBody.configId) : null;
  const pendingQuoteSymbol = pendingCfg?.quoteSymbol || 'ETH';

  return (
    <Step {...step}>
      <p className="lede">
        The launch fires once: it deploys the token, opens the letscash pool and makes the launcher's{' '}
        <b>first buy inside the same transaction</b> — after the pool is seeded and before anyone else
        can trade it, so nothing can front-run or sandwich it. Fanning that first-buy supply out to the
        bundle wallets is the next step.
      </p>

      {!dev && (
        <div className="notice warn">
          <h3>No launcher wallet yet</h3>
          <p>Generate one in step 1 — it is the only wallet that can sign this.</p>
        </div>
      )}

      {launchesPaused && (
        <div className="notice danger">
          <h3>Launches are paused</h3>
          <p>The letscash factory has launchEnabled = false right now. Nothing here can broadcast until it is flipped back on — Preflight and Launch stay disabled.</p>
        </div>
      )}

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
          <input
            type="number"
            step="0.0001"
            value={f.firstBuyAmount}
            onChange={set('firstBuyAmount')}
          />
          <span className="hint">
            {cfg && !cfg.quoteIsNative
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
            <li>no restriction window and no exemption list — letscash's only edge is the atomic first buy above</li>
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
          {live ? 'Launch' : 'Launch (dry run)'}
        </Busy>
      </div>

      <Modal
        open={Boolean(pendingBody)}
        danger={live}
        title={live ? 'LIVE LAUNCH — this spends real funds.' : `Dry run launch of ${pendingBody?.params.symbol || ''}`}
        confirmLabel={live ? 'Launch' : 'Launch (dry run)'}
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
        </div>
      </Modal>
    </Step>
  );
}
