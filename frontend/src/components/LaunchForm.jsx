import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import LogoField from './LogoField.jsx';
import Modal, { Fact } from './Modal.jsx';
import { pct } from './Share.jsx';
import { rolesFor } from '../variant.js';
import { NATIVE_PAIR, isNativePair, pairOptions, selectedPair, bodyPairToken } from '../pairAssets.js';

// The chain makes a block every ~100ms, but the restriction window is counted
// in the EVM's own block number, which advances roughly every 16 seconds. So
// "2 blocks" is about half a minute, and every bundle wallet is inside it.
const EVM_BLOCK_SECONDS = 16;

const BLANK = {
  name: '',
  symbol: '',
  logo: '',
  description: '',
  feeWallet: '',
  twitter: '',
  telegram: '',
  discord: '',
  website: '',
  farcaster: '',
  devBuyEth: '0.05',
  // ZERO BY DEFAULT, AND THE COST OF THAT IS PERMANENT. creatorTaxBps is
  // immutable once launched, so a token that goes out at 0 earns its creator
  // nothing from trading for as long as it exists — there is no later edit.
  // This defaulted to 50 (0.5%) for exactly that reason: a field left alone by
  // an operator in a hurry is the one most likely to be wrong, and the wrong
  // value here cannot be corrected.
  //
  // Set to 0 deliberately: the tax is a fee traders pay on top of the config's
  // 1% curve fee, and a launch that does not want to charge one should not have
  // to remember to turn it off. Type a value in the field for any launch that
  // does — it is still there, and it still refuses anything above the factory's
  // maximum.
  creatorTaxBps: '0',
  buybackEnabled: false,
};

// v2's opening tax is charged on the RECIPIENT of a buy, and the factory
// exempts at most this many declared addresses.
const MAX_EXEMPTIONS = 32;

export default function LaunchForm({
  step,
  configs,
  wallets,
  rows,
  live,
  share,
  reload,
  reloadHistory,
  report,
  onDraft,
  onSizing,
  variant = 'v1',
}) {
  const roles = rolesFor(variant);
  const [f, setF] = useState(BLANK);
  // Pons v1 is dead: the factory owner set launchEnabled=false on both v1
  // factories (2026-08-12) and never re-enabled it, and the launcher whitelist
  // is provably empty — nothing can launch on pons v1. So the selector below
  // hides it and the form defaults to v2 (where SPCX/RWA pairing and holder-fee
  // sharing live). Flip SHOW_PONS_V1 back to true if pons ever reopens v1.
  const SHOW_PONS_V1 = false;
  const [protocol, setProtocol] = useState(SHOW_PONS_V1 ? 'v1' : 'v2');
  const [v2, setV2] = useState(null);
  const [launchConfigId, setLaunchConfigId] = useState(0);
  // The v2 quote asset. Native ETH (the zero-address sentinel) by default, which
  // is byte-for-byte the backend's own default — a native launch is unchanged.
  const [pairToken, setPairToken] = useState(NATIVE_PAIR);
  // How the bundle wallets are funded for a NON-native pair:
  //   'pair'   — they hold the pair token, and every buy is pre-signed (today's
  //              behaviour, and the backend default).
  //   'ethZap' — they hold only ETH, and each buy routes ETH → pair → curve.buy
  //              through pons's swap-zap, fetched just-in-time after the launch
  //              confirms. Meaningless for a native pair, where it is ignored.
  const [bundleFunding, setBundleFunding] = useState('pair');
  const [dexId, setDexId] = useState(0);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [armed, setArmed] = useState(false);
  // The request body as it stood when the dialog opened. Held rather than
  // rebuilt on confirm so that what was read is exactly what is broadcast —
  // and null whenever no dialog is open, which is the only state in which a
  // launch can be fired at all.
  const [pending, setPending] = useState(null);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const setLogo = (logo) => setF((prev) => ({ ...prev, logo }));

  const isV2 = protocol === 'v2';
  const active = isV2 ? v2 : configs;
  const lc = active?.launchConfigs.find((c) => c.id === Number(launchConfigId));

  // The approved quote assets, native ETH first. Falls back to native-only when
  // the v2 config never loaded or its pair list failed to resolve, so the picker
  // always has something valid and the form never crashes. The selection is
  // resolved against this same list, so a token un-approved between reads falls
  // back to native rather than pointing at nothing.
  const pairTokens = pairOptions(v2);
  const pair = selectedPair(v2, pairToken);
  const nativePair = isNativePair(pair.address);
  // The funding mode that actually applies: a native pair always funds in ETH the
  // old way, so it collapses to 'pair' (which the backend ignores for native)
  // regardless of what the toggle last held. ethZap only ever means anything for a
  // non-native pair.
  const funding = nativePair ? 'pair' : bundleFunding;
  const zapMode = isV2 && !nativePair && funding === 'ethZap';

  // v2's factory is a different contract with its own configs and its own
  // gating, so they are read separately and only when the operator asks for it.
  useEffect(() => {
    if (!isV2 || v2) return;
    api('/v2/configs')
      .then(setV2)
      .catch((err) => report(`ERROR: v2 configs — ${err.message}`));
  }, [isV2, v2]);

  // Config ids are per-factory; carrying v1's selection into v2 would silently
  // pick a different set of terms. The quote asset resets the same way, so
  // toggling v2→v1→v2 always returns to native rather than a stale RWA pick.
  useEffect(() => {
    setLaunchConfigId(0);
    setPairToken(NATIVE_PAIR);
    setBundleFunding('pair');
  }, [protocol]);

  // The amounts are typed two panels up, but what they BUY is decided here: the
  // protocol, the config's supply and curve, the dev buy that goes first and the
  // creator tax that comes off every buy. Pushed up to App, which owns the rows,
  // so the wallet table can price them as they are typed. `lc` is an element of
  // the fetched configs array, so its identity is stable and this does not fire
  // on every render.
  useEffect(() => {
    onSizing?.({
      protocol,
      launchConfig: lc || null,
      creatorTaxBps: isV2 ? Number(f.creatorTaxBps || 0) : 0,
      devBuyEth: f.devBuyEth,
    });
  }, [protocol, lc, isV2, f.creatorTaxBps, f.devBuyEth]);

  /**
   * The three facts this step cannot be armed without, pushed up to App.
   *
   * They are also the three the sequence header states about step 5, and the
   * only ones a step drawn a page above the form has any way of knowing. It is
   * the same arrangement as onSizing above: the panel that owns a value hands
   * it up rather than App reaching down for it. `ready` below is these three
   * plus "no upload still in flight", which is this panel's business and not
   * the header's.
   */
  useEffect(() => {
    onDraft?.({ name: f.name.trim(), symbol: f.symbol.trim(), logo: f.logo });
  }, [onDraft, f.name, f.symbol, f.logo]);

  // A wallet joins the bundle only if it will actually buy: a fixed amount
  // above zero, or "all" mode with a balance to spend. An empty wallet left in
  // "all" mode used to be sent anyway and took a snipe-tax exemption slot for a
  // buy that never happens — one of the ways a "31 wallet" bundle became 32
  // exemptions and reverted ExemptionListTooLong.
  const willBuy = (w) => {
    const mode = rows[w.id]?.mode ?? 'fixed';
    return mode === 'all' ? Number(w.balanceEth) > 0 : Number(rows[w.id]?.buy) > 0;
  };

  function body() {
    // A WHITELIST, and on this line it decides whose money is spent. The
    // keystore also holds v2dev, v2funding and v2bundle roles; "not the dev
    // wallet" would arm a launch with wallets belonging to a different flow.
    const bundle = wallets
      .filter((w) => w.role === roles.bundle && willBuy(w))
      .map((w) => ({
        walletId: w.id,
        mode: rows[w.id]?.mode ?? 'fixed',
        amountEth: rows[w.id]?.buy,
      }));

    const socials = {
      twitter: f.twitter.trim(),
      telegram: f.telegram.trim(),
      discord: f.discord.trim(),
      website: f.website.trim(),
      farcaster: f.farcaster.trim(),
    };

    if (isV2) {
      return {
        // Which launcher is spending. The backend resolves the signer from
        // this, so omitting it would sign a v2 launch with v1's dev wallet.
        variant,
        params: {
          name: f.name.trim(),
          symbol: f.symbol.trim(),
          logo: f.logo.trim(),
          description: f.description.trim(),
          socials,
          // v2 calls this the creator fee recipient. Same field, same meaning:
          // where the creator's cut of trading fees goes.
          creatorFeeRecipient: f.feeWallet.trim() || undefined,
          creatorTaxBps: Number(f.creatorTaxBps || 0),
          buybackEnabled: Boolean(f.buybackEnabled),
        },
        launchConfigId: Number(launchConfigId),
        // The quote asset the curve is priced in. Native → the zero-address
        // sentinel, which is the backend's own default, so ETH is unchanged; a
        // chosen RWA sends its own address for the factory to price against.
        pairToken: bodyPairToken(pair.address),
        // How the bundle wallets are funded. 'pair' is the backend default (and
        // the only meaningful value for a native pair); 'ethZap' tells the backend
        // to size buys in ETH and zap them in just-in-time after launch.
        bundleFunding: funding,
        devBuyEth: f.devBuyEth || 0,
        wallets: bundle,
      };
    }

    return {
      variant,
      params: {
        name: f.name.trim(),
        symbol: f.symbol.trim(),
        logo: f.logo.trim(),
        description: f.description.trim(),
        socials,
        feeWallet: f.feeWallet.trim(),
      },
      launchConfigId: Number(launchConfigId),
      dexId: Number(dexId),
      devBuyEth: f.devBuyEth || 0,
      wallets: bundle,
    };
  }

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Opens the confirmation. Nothing is sent from here; only the dialog's
  // confirm button reaches fire().
  function launch() {
    setPending(body());
  }

  function fire() {
    const b = pending;
    setPending(null);
    if (!b) return;

    act('launch', async () => {
      const res = await api(isV2 ? '/v2/launch' : '/launch', 'POST', b);
      reloadHistory();
      // Re-lock the guard: one arming, one launch.
      setArmed(false);
      setTimeout(reload, 3000);
      return res;
    });
  }

  const buying = wallets.filter((w) => w.role === roles.bundle && willBuy(w)).length;

  // The exemption limit depends on the path. Any dev buy routes the launch
  // through launchAndBuy on the forwarder, which appends its own buy recipient
  // and so allows one FEWER exemption than the factory's 32. Comparing against a
  // flat 32 let a 32-wallet bundle with a dev buy pass here and revert
  // ExemptionListTooLong on-chain — the failure that stranded a bundle's ETH.
  const hasDevBuy = Number(f.devBuyEth || 0) > 0;
  // Only a dev buy that goes through the FORWARDER (launchAndBuy) costs an
  // exemption slot. In ETH-zap mode the launch is a plain launchToken and the dev
  // buy becomes a post-launch zap buyer, so the forwarder is never used and the
  // full 32-slot cap applies even with a dev buy.
  const forwarderDevBuy = hasDevBuy && !zapMode;
  const exemptionLimit = forwarderDevBuy
    ? active?.maxExemptionsWithDevBuy ?? MAX_EXEMPTIONS - 1
    : active?.maxExemptions ?? MAX_EXEMPTIONS;
  const overExempt = isV2 && buying > exemptionLimit;

  const ready = Boolean(f.name.trim() && f.symbol.trim() && f.logo) && !uploading;
  const blocked = live && !armed;

  return (
    <Step {...step}>
      <div className="protocol">
        {(SHOW_PONS_V1 ? ['v1', 'v2'] : ['v2']).map((p) => (
          <button
            key={p}
            type="button"
            className={protocol === p ? 'on' : 'ghost'}
            onClick={() => setProtocol(p)}
          >
            pons {p}
          </button>
        ))}
        {isV2 && !v2 && <span className="hint">reading the v2 factory…</span>}
        {isV2 && v2 && !v2.launchEnabled && <span className="hint">v2 launching is disabled right now</span>}
      </div>

      <p className="lede">
        {isV2
          ? `A v2 launch creates a bonding curve, not a pool — a Uniswap pool is only built at
             graduation. Opening buys are taxed from ${(v2?.snipeTaxStartBps ?? 9900) / 100}% down to
             zero over ${v2?.snipeTaxSeconds ?? 3}s, and your bundle wallets are declared exempt
             inside the launch itself, so they are the only ones buying untaxed.`
          : `The launch transaction deploys the token, opens the pool and makes your dev buy in one
             call. Every bundle buy is signed in advance and broadcast the instant it lands.`}
      </p>

      <div className="grid">
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
          Farcaster
          <input value={f.farcaster} onChange={set('farcaster')} />
        </label>

        <label className="wide">
          Description
          <textarea rows="2" value={f.description} onChange={set('description')} />
        </label>

        <label className="wide">
          Fee wallet
          <input value={f.feeWallet} onChange={set('feeWallet')} placeholder="0x… (optional)" />
          <span className="hint">
            Receives the creator share of trading fees. Blank uses the dev wallet, which also
            receives the dev buy.
          </span>
        </label>

        <label>
          Launch config
          <select value={launchConfigId} onChange={(e) => setLaunchConfigId(e.target.value)}>
            {active?.launchConfigs.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.enabled}>
                {isV2
                  ? `#${c.id} — ${Number(c.supply) / 1e18} supply / graduates at ${Number(c.graduationThreshold) / 1e18} ETH`
                  : `#${c.id} — ${c.maxWalletBps / 100}% wallet / ${c.restrictionBlocks} blk`}
                {c.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>
        {isV2 && (
          <label>
            Paired asset
            <select value={pair.address} onChange={(e) => setPairToken(e.target.value)}>
              {pairTokens.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                  {isNativePair(t.address)
                    ? ' (native)'
                    : ` — ${t.address.slice(0, 6)}…${t.address.slice(-4)}`}
                </option>
              ))}
            </select>
            <span className="hint">
              What the curve is priced in. <b>ETH (native)</b> keeps today's behaviour; any other
              asset means the dev buy and every bundle buy are spent in that token.
            </span>
          </label>
        )}
        {isV2 && !nativePair && (
          <label>
            Bundle funding
            <select value={bundleFunding} onChange={(e) => setBundleFunding(e.target.value)}>
              <option value="pair">Bundles hold the pair asset (pre-signed)</option>
              <option value="ethZap">Bundles hold ETH (auto-zap via Pons)</option>
            </select>
            <span className="hint">
              {zapMode ? (
                <>
                  <b>ETH-zap:</b> fund every bundle wallet with <b>ETH only</b> — no {pair.symbol}{' '}
                  needed. Each buy routes ETH&nbsp;→&nbsp;{pair.symbol}&nbsp;→&nbsp;curve in one
                  transaction, fetched just-in-time <b>after the launch confirms</b>. The snipe-tax
                  exemption still applies, so the bundle buys untaxed — but because the buys are not
                  atomic with the launch, they are not guaranteed to be first.
                </>
              ) : (
                <>
                  <b>Pre-signed:</b> every bundle wallet must already hold {pair.symbol}; buys are
                  signed up front and fire the instant the launch lands. Switch to ETH-zap to fund
                  the wallets with ETH instead.
                </>
              )}
            </span>
          </label>
        )}
        {isV2 ? (
          <label>
            Creator tax (bps)
            <input
              type="number"
              step="1"
              min="0"
              max={v2?.maxCreatorTaxBps ?? 1000}
              value={f.creatorTaxBps}
              onChange={set('creatorTaxBps')}
            />
            {/* The only number on this page that can never be corrected. It
                was a clause in the middle of the dimmest line in the console,
                which is the wrong place for a decision nothing can revisit —
                so the phrase leads the hint and carries the vermilion, because
                immutable is what irreversible means when it is a figure in a
                text input rather than a button. */}
            <span className="hint">
              <b className="forever">Immutable once launched</b> — your cut of every trade, fixed by
              this launch and never editable again. Max {v2?.maxCreatorTaxBps ?? 1000} bps. A
              non-zero tax is what generates fees at all — the pool of value the operator can later
              choose to share back with holders.
            </span>
          </label>
        ) : (
          <label>
            DEX
            <select value={dexId} onChange={(e) => setDexId(e.target.value)}>
              {configs?.dexConfigs.map((d) => (
                <option key={d.id} value={d.id} disabled={!d.enabled}>
                  #{d.id} — {d.name} ({d.poolFee / 10000}%)
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="half">
          Dev buy (ETH)
          <input type="number" step="0.0001" value={f.devBuyEth} onChange={set('devBuyEth')} />
          <span className="hint">
            Bought inside the launch itself — nothing can get ahead of it, and no cap applies.
          </span>
        </label>
      </div>

      {lc && active && !isV2 && (
        <div className="notice">
          <h3>What config #{launchConfigId} enforces</h3>
          <ul>
            <li>
              launch fee {Number(active.launchFee) / 1e18} ETH · router{' '}
              {lc.routerRequiresDeadline ? 'V3 (deadline)' : 'Router02'}
            </li>
            <li>
              restriction {lc.restrictionBlocks} blocks ≈ {lc.restrictionBlocks * EVM_BLOCK_SECONDS}s
              — every bundle wallet lands inside it
            </li>
            <li>
              during that window: max wallet {lc.maxWalletBps / 100}% · max buy {lc.maxTxBps / 100}%
              — a bundle buy above this reverts
            </li>
          </ul>
        </div>
      )}

      {lc && active && isV2 && (
        <div className="notice">
          <h3>What config #{launchConfigId} enforces</h3>
          <ul>
            <li>
              launch fee {Number(active.launchFee) / 1e18} ETH · supply{' '}
              {(Number(lc.supply) / 1e18).toLocaleString()} · curve fee {lc.curveFeeBps / 100}%
            </li>
            <li>
              graduates to a Uniswap v4 pool at {Number(lc.graduationThreshold) / 1e18} ETH raised
            </li>
            <li>
              opening tax {active.snipeTaxStartBps / 100}% decaying to zero over{' '}
              {active.snipeTaxSeconds}s — charged on the buyer's <b>recipient</b>, so an undeclared
              wallet keeps almost nothing
            </li>
            <li>
              {buying} of your wallets declared exempt (max {exemptionLimit}
              {forwarderDevBuy ? ', one lower because of the dev buy' : ''})
              {overExempt
                ? ` — too many by ${buying - exemptionLimit}, the launch would revert (ExemptionListTooLong)`
                : ' — they buy at the untaxed price'}
            </li>
            <li>no wallet or per-buy cap: v2 has no restriction window</li>
            {nativePair ? (
              <li>
                priced in <b>native ETH</b> — the dev buy and every bundle buy are spent in ETH, as
                today
              </li>
            ) : zapMode ? (
              <li>
                priced in <b>{pair.symbol}</b>, but bundles fund in <b>ETH</b> — each buy auto-zaps
                ETH&nbsp;→&nbsp;{pair.symbol}&nbsp;→&nbsp;curve via Pons, fetched{' '}
                <b>just-in-time after launch</b>. Wallets need only ETH (buy amounts are in ETH). The
                dev buy, if any, is <b>not atomic</b> here — it fires as another post-launch zap, so
                nothing is guaranteed ahead of the bundle, though the exemption still keeps it untaxed
              </li>
            ) : (
              <li>
                priced in <b>{pair.symbol}</b> — the dev buy and every bundle buy are denominated and{' '}
                <b>spent in {pair.symbol}</b>, not ETH, so each buying wallet needs a {pair.symbol}{' '}
                balance (ETH only covers gas). Amounts use {pair.symbol}'s{' '}
                {pair.decimals ?? '?'} decimals
              </li>
            )}
          </ul>
        </div>
      )}

      <div className={`arm ${live ? 'is-live' : ''}`}>
        <Busy
          busy={busy === 'preflight'}
          className="btn-primary"
          disabled={!ready}
          title={ready ? 'signs everything, broadcasts nothing' : 'fill in name, symbol and a logo'}
          onClick={() => act('preflight', () => api(isV2 ? '/v2/preflight' : '/preflight', 'POST', body()))}
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
          // Vermilion means irreversible. A dry run is not, and colouring it
          // the same would teach the operator to ignore the colour that matters.
          className={live ? 'danger' : ''}
          disabled={!ready || blocked || overExempt}
          title={
            !ready
              ? 'fill in name, symbol and a logo'
              : overExempt
                ? `${buying} exempt wallets exceeds the ${exemptionLimit} limit for this path — remove ${buying - exemptionLimit}`
                : blocked
                  ? 'flip Arm first — this spends real funds'
                  : ''
          }
          onClick={launch}
        >
          {live ? 'Launch + bundle' : 'Launch + bundle (dry run)'}
        </Busy>

        <div className="cost">
          <b>
            {buying} wallet{buying === 1 ? '' : 's'} buying
          </b>
          dev buy {f.devBuyEth || 0} ETH
          {/* The same figure the wallet table draws per row, totalled. It is
              here as well as up there because this is where the operator arms:
              the last thing read before the click should be what the bundle
              actually ends up holding. */}
          {share && share.bundle.bps > 0 && (
            <span className="share-total">
              bundle takes{' '}
              <b className="tally">
                {share.exact ? '' : '≈'}
                {pct(share.bundle.bps)}
              </b>{' '}
              of supply
            </span>
          )}
        </div>
      </div>

      {/* The wording changes with DRY_RUN so a live bundle can never be fired
          in the belief that it was a rehearsal — the headline, the colour and
          the button label all differ, not just one of them. */}
      <Modal
        open={Boolean(pending)}
        danger={live}
        title={
          live
            ? 'LIVE LAUNCH — this spends real funds.'
            : `Dry run launch of ${pending?.params.symbol || ''}`
        }
        confirmLabel={live ? 'Launch + bundle' : 'Launch (dry run)'}
        onConfirm={fire}
        onCancel={() => setPending(null)}
      >
        {!live && <p>Nothing will be broadcast.</p>}
        <div className="modal-facts">
          <Fact label="Symbol">{pending?.params.symbol || '—'}</Fact>
          <Fact label="Dev buy">{pending?.devBuyEth || 0} ETH</Fact>
          <Fact label="Bundle wallets">{pending?.wallets.length ?? 0}</Fact>
          {share && (
            <Fact label={share.exact ? 'Bundle share' : 'Bundle share (est)'}>
              {share.exact ? '' : '≈'}
              {pct(share.bundle.bps)} of supply
            </Fact>
          )}
          {share?.marketCap && (
            <Fact label="Predicted MC">{Number(share.marketCap.finalEth).toFixed(3)} ETH</Fact>
          )}
        </div>
        {/* The one condition that changes what this launch IS, surfaced at the
            moment of the decision rather than only in a preflight report the
            operator may have skipped. A graduated launch cannot be exited
            through the curve. */}
        {share?.graduation?.crosses && (
          <p className="modal-warn">
            ⚠ This bundle puts {share.graduation.raisedEth} ETH into the curve, at or over the{' '}
            {share.graduation.thresholdEth} ETH graduation threshold. The curve <b>graduates on the way in</b>,
            and a graduated launch can only be exited through the Uniswap v4 pool — not the curve. Size down
            if you did not intend this.
          </p>
        )}
      </Modal>
    </Step>
  );
}
