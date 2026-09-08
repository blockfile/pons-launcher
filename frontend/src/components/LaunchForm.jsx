import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import LogoField from './LogoField.jsx';
import Modal, { Fact } from './Modal.jsx';
import { pct } from './Share.jsx';
import { rolesFor } from '../variant.js';
import { NATIVE_PAIR, isNativePair, pairOptions, selectedPair, bodyPairToken } from '../pairAssets.js';
// Which of the two buttons may run and why not, and which buying wallets the
// preflight would drop for not holding the quote asset yet. Pure and tested.
import { launchGate, shortOfPair } from './quoteAsset.js';

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
  // THE QUOTE ASSET, READ AND NOT OWNED.
  //
  // This form used to hold the selection AND the /v2/configs read it is resolved
  // against, which put the launch's first decision inside its last step: the
  // operator jumped here to pick an asset and walked back up to size, fund and
  // swap the bundle in it. Both now live in App — `configV2` is the factory
  // read, `quoteOptions` the approved list, `pairToken` the selection and `pair`
  // the resolved asset (null on native).
  //
  // The picker below stays: this is where the launch is priced, and an operator
  // at the bottom of the page must be able to see what it is priced in and
  // change their mind. It writes through `onPairToken`, which is App's GUARDED
  // setter — it states what a change costs before it strands anything.
  configV2 = null,
  quoteOptions = null,
  pairToken = NATIVE_PAIR,
  pair: resolvedPair = null,
  onPairToken = () => {},
  // The one unguarded write, and it is not the operator's: switching protocol
  // puts a pons-v1 launch back on native, and an effect must never raise a
  // dialog.
  onPairReset = () => {},
  // Does this launcher have a quote-asset station of its own? v2 does, so the
  // picker here says where the decision lives; v1 does not, so it reads as the
  // place it is made.
  ownsPair = true,
  // Step key -> live number, for naming another station.
  nums = {},
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
  // The v2 factory read, handed down rather than fetched here — see the note on
  // the props above. Named `v2` so every expression below reads as it did.
  const v2 = configV2;
  const [launchConfigId, setLaunchConfigId] = useState(0);
  // Native ETH (the zero-address sentinel) by default, which is byte-for-byte the
  // backend's own default — a native launch is unchanged.
  const setPairToken = onPairToken;
  const [dexId, setDexId] = useState(0);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [armed, setArmed] = useState(false);
  // The request body as it stood when the dialog opened. Held rather than
  // rebuilt on confirm so that what was read is exactly what is broadcast —
  // and null whenever no dialog is open, which is the only state in which a
  // launch can be fired at all.
  const [pending, setPending] = useState(null);
  // The asset the frozen dev buy above is denominated in, captured with it. "ETH"
  // on a native launch, which is what the dialog has always said.
  const [pendingUnit, setPendingUnit] = useState('ETH');

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
  //
  // Both come from App now, which owns the factory read — the list because the
  // station at the front of the plan needs it too, and the resolved selection
  // because the wallet table two steps up prices against its CURVE CONSTANTS.
  // The local fallbacks keep this form standing on its own if it is ever handed
  // neither.
  const pairTokens = quoteOptions || pairOptions(v2);
  const pair = selectedPair(v2, pairToken);
  const nativePair = isNativePair(pair.address);
  // On a pons v1 launch there is no quote asset at all — the pool is priced in
  // ETH — so a selection carried over from v2 must not colour this form.
  const paired = Boolean(isV2 && resolvedPair);

  // Config ids are per-factory; carrying v1's selection into v2 would silently
  // pick a different set of terms. The quote asset resets the same way, so
  // toggling v2→v1→v2 always returns to native rather than a stale RWA pick.
  // Through the UNGUARDED setter: a dialog raised by an effect is a dialog
  // nobody asked for.
  useEffect(() => {
    setLaunchConfigId(0);
    onPairReset(NATIVE_PAIR);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
   * it up rather than App reaching down for it. `launchGate` below is these
   * three plus "no upload still in flight", which is this panel's business and
   * not the header's.
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
    // Kept beside `pending` rather than inside it: `pending` IS the request body
    // and nothing that is not a field of the API goes in it.
    setPendingUnit(pair.symbol);
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
  const exemptionLimit = hasDevBuy
    ? active?.maxExemptionsWithDevBuy ?? MAX_EXEMPTIONS - 1
    : active?.maxExemptions ?? MAX_EXEMPTIONS;
  const overExempt = isV2 && buying > exemptionLimit;

  // WHY EITHER BUTTON IS DEAD, in words, on the page. Both refusals were only
  // ever `title` attributes — invisible without a mouse and invisible on the
  // step's own header — and they refuse for overlapping but different reasons:
  // preflight signs nothing, so neither the arm switch nor the exemption cap
  // stops it. The expression is pure and pinned by a test; see quoteAsset.js.
  const draftMissing = [
    f.name.trim() ? null : 'a name',
    f.symbol.trim() ? null : 'a symbol',
    f.logo ? null : 'a logo',
  ].filter(Boolean);
  const gate = launchGate({
    draftMissing,
    uploading,
    overExempt: overExempt ? buying - exemptionLimit : 0,
    live,
    armed,
  });

  // WHICH BUYING WALLETS PREFLIGHT WOULD DROP, asked at the moment of arming.
  //
  // On a paired launch every bundle buy is signed in the quote asset before the
  // token exists, so a wallet that is not already holding it is skipped and the
  // bundle fires that much smaller. That is knowable here, from the pair column
  // the listing already carries, and it used to be discovered only in the
  // preflight report — which an operator is allowed to skip. Null on a native
  // launch, where a wallet buys with the ETH it was funded with.
  const pairShort = paired
    ? shortOfPair(
        wallets.filter((w) => w.role === roles.bundle),
        rows
      )
    : null;

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
            Priced in
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
            {/* IT SAYS WHERE THE DECISION LIVES. The picker is here so an
                operator at the point of arming can see what the launch is priced
                in — but the choice belongs at the front of the plan, because
                everything between there and here is denominated in it. Changing
                it from this field is allowed and states its cost first: the
                onChange goes through the same guarded setter the first station
                uses, which asks before it strands a wallet holding the old
                asset. */}
            <span className="hint">
              What the curve is priced in.{' '}
              {ownsPair ? (
                <>
                  <b>ETH (native)</b> keeps today's behaviour; any other asset means the dev buy and
                  every bundle buy are spent in that token.
                </>
              ) : (
                <>
                  Chosen in <b>step {nums.quote ?? 1}</b> — everything between there and here is
                  denominated in it. Changing it now says what it costs first: the amounts above are
                  re-stated in the new asset and any wallet already holding{' '}
                  {nativePair ? 'the old one' : pair.symbol} keeps it.
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
          {/* NAMED FOR THE ASSET IT ACTUALLY SPENDS. This said "(ETH)" on every launch, but a
              paired launch denominates the dev buy in the PAIR token — so the field read ETH
              while the preflight refused with "holds 0.0 NVDA but the dev buy needs 0.05 NVDA".
              pair.symbol is "ETH" on a native launch, so the native case is unchanged. */}
          Dev buy ({pair.symbol})
          <input type="number" step="0.0001" value={f.devBuyEth} onChange={set('devBuyEth')} />
          <span className="hint">
            Bought inside the launch itself — nothing can get ahead of it, and no cap applies.
            {!nativePair && (
              <>
                {' '}
                <b>Spent in {pair.symbol}, not ETH</b> — the dev wallet needs its own{' '}
                {pair.symbol} balance. This console funds BUNDLE wallets into {pair.symbol} (step{' '}
                {nums.swap ?? 5}); it has no path that buys {pair.symbol} for the dev wallet.
              </>
            )}
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
              {hasDevBuy ? ', one lower because of the dev buy' : ''})
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

      {/* THE WALLETS THIS LAUNCH WOULD FIRE WITHOUT, named before the arm rather
          than in a report afterwards. A paired bundle's buys are signed in the
          quote asset before the token exists, so a wallet that is not already
          holding it is dropped by preflight and the bundle lands that much
          smaller. Grey: this is not a spend and not irreversible, and this panel
          already has its one amber. Absent on a native launch and absent the
          moment every buying wallet holds enough. */}
      {pairShort && pairShort.short > 0 && (
        <div className="notice">
          <h3>
            {pairShort.short} of {pairShort.buying} buying wallet
            {pairShort.buying === 1 ? '' : 's'} {pairShort.short === 1 ? 'does' : 'do'} not hold{' '}
            {pair.symbol} yet
          </h3>
          <ul>
            <li>
              preflight <b className="crux">drops a wallet that holds less than its Buy amount</b> —
              the buy is signed in {pair.symbol} before the token exists, so there is nothing to
              spend
            </li>
            <li>
              buy it in step {nums.swap ?? 5} — <b>Buy {pair.symbol} for the bundle</b> — where each
              wallet buys its own {pair.symbol} with its own ETH, out of the ETH it was funded with.
              Run it before arming.
            </li>
          </ul>
        </div>
      )}

      <div className={`arm ${live ? 'is-live' : ''}`}>
        <Busy
          busy={busy === 'preflight'}
          className="btn-primary"
          disabled={!gate.preflight.enabled}
          title={gate.preflight.why || 'signs everything, broadcasts nothing'}
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
          disabled={!gate.fire.enabled}
          title={gate.fire.why || ''}
          onClick={launch}
        >
          {live ? 'Launch + bundle' : 'Launch + bundle (dry run)'}
        </Busy>

        {/* THE REFUSAL, ON THE PAGE. It was a `title` on a disabled button —
            unreadable without a mouse, and unreadable at all on the header the
            operator is actually looking at. It says the same thing the step's
            own line says, in the place the click was aimed. */}
        {gate.fire.why && <span className="hint">{gate.fire.why}</span>}

        <div className="cost">
          <b>
            {buying} wallet{buying === 1 ? '' : 's'} buying
          </b>
          {/* NAMED FOR THE ASSET IT ACTUALLY SPENDS, like the field above it. The
              input has said "Dev buy (NVDA)" since be9a6b1; this line and the
              dialog's Fact still said ETH, and this is the last figure read
              before the arm. pair.symbol is "ETH" on a native launch. */}
          dev buy {f.devBuyEth || 0} {pair.symbol}
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
          {/* FROZEN WITH THE BODY. The dialog states what is about to be
              broadcast, so the unit has to be the one the body's pairToken names
              — not whatever the picker says by the time it is read. */}
          <Fact label="Dev buy">
            {pending?.devBuyEth || 0} {pendingUnit}
          </Fact>
          <Fact label="Bundle wallets">{pending?.wallets.length ?? 0}</Fact>
          {share && (
            <Fact label={share.exact ? 'Bundle share' : 'Bundle share (est)'}>
              {share.exact ? '' : '≈'}
              {pct(share.bundle.bps)} of supply
            </Fact>
          )}
          {/* The market cap is in the LAUNCH'S QUOTE ASSET, which is ETH only on a
              native launch. share.pairSymbol is what bundleShare walked the curve
              in, so it cannot disagree with the figure beside it. */}
          {share?.marketCap && (
            <Fact label="Predicted MC">
              {Number(share.marketCap.finalEth).toFixed(3)} {share.pairSymbol || 'ETH'}
            </Fact>
          )}
        </div>
        {/* The one condition that changes what this launch IS, surfaced at the
            moment of the decision rather than only in a preflight report the
            operator may have skipped. A graduated launch cannot be exited
            through the curve. */}
        {share?.graduation?.crosses && (
          <p className="modal-warn">
            ⚠ This bundle puts {share.graduation.raisedEth} {share.pairSymbol || 'ETH'} into the curve,
            at or over the {share.graduation.thresholdEth} {share.pairSymbol || 'ETH'} graduation
            threshold. The curve <b>graduates on the way in</b>,
            and a graduated launch can only be exited through the Uniswap v4 pool — not the curve. Size down
            if you did not intend this.
          </p>
        )}
      </Modal>
    </Step>
  );
}
