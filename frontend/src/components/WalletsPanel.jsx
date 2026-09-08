import { useEffect, useRef, useState } from 'react';
import { api, notify } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Address from './Address.jsx';
import Modal, { Fact } from './Modal.jsx';
import Share, { pct, tokens } from './Share.jsx';
import BackupControls from './BackupControls.jsx';
import { splitTotal, pairedFunds, pairedReserveEth } from './autoFill.js';
import { pairStatus, pairShortfall, balanceFill, recoverTargets } from './pairBalance.js';
import { rolesFor } from '../variant.js';
// Which curve a paired launch is priced against, and the one place a pair-token
// figure becomes an ETH one — for display, at the very end. See pairCurve.js.
import { ethEquivalent, isNativeLaunch, pairPerEthFrom } from './pairCurve.js';

// Balances arrive as decimal strings. Six places everywhere, so the column and
// the dialog show the same number.
const eth = (v) => Number(v || 0).toFixed(6);

/**
 * Step 3 — the bundle wallets, and the table every later step reads.
 *
 * Generating the dev wallet is step 1 and lives in its own panel; this one keeps
 * the whole wallet inventory, because the table is where the bundle is SIZED and
 * a bundle is sized against the dev buy sitting at the top of it. The dev row is
 * therefore still here, read-only apart from its delete.
 *
 * Per-row fund / buy-mode / buy-amount inputs live in `rows`, owned by App,
 * because the Fund (step 4) and Launch (step 5) panels both read them — which is
 * also why this table sits above both of them.
 *
 * `share` is what those amounts would buy, computed by App from the live
 * factory configs — see shared/bundleShare.js. It is drawn next to the input
 * that produced it: sizing a bundle used to mean typing a number, launching,
 * and finding out afterwards.
 *
 * Importing here is bundle keys and only bundle keys. It used to carry a role
 * dropdown with `dev` in it, which put "replace the dev key" inside a panel
 * titled for bundle wallets — a step away from the dev wallet it was replacing,
 * and a step away from the delete that made room for it. Both halves of that
 * rotation are in step 1 now.
 */
// The probe the ETH<->pair rate is read at, and it is deliberately tiny: 0.001
// ETH, the same size and for the same reason as swaproute's IMPACT_PROBE. A
// market cap wants the NEAR-SPOT rate, not what a trade the size of the market
// cap would fill at — quoting the cap itself would price BUYING that much of the
// pair token, impact and all, which is a different question.
const MC_PROBE_ETH = '0.001';

// A market cap in USD from its ETH figure and a hand-entered ETH price.
//
// UNCHANGED, and deliberately: on a native launch the figure handed to it is the
// exact one the curve fixes. On a PAIRED launch the curve's figure is in the pair
// token, so what reaches this is that figure already converted to ETH at a live
// quote (ethEquivalent) — or NULL, in which case no dollar figure is drawn at all
// and the reason is said under the table. The dollar side is only ever as good as
// the price typed beside it, which is why the price is editable and the launch's
// own unit is always shown next to the dollars.
function usdMc(ethStr, price) {
  const v = Number(ethStr || 0) * Number(price || 0);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${Math.round(v)}`;
}

export default function WalletsPanel({
  step,
  wallets,
  rows,
  setRow,
  share,
  // Why there is no share, when there is a launch config but nothing to price it
  // against: a paired launch whose pairTokenEconomics never reached the console.
  // A sentence, drawn where the figures would have been. See App's `sized`.
  shareBlocked = null,
  reload,
  report,
  // The launch's quote asset, CHOSEN AT THE FRONT OF THE PLAN and read here. It
  // used to be picked in the launch form, which is the last step, so this table
  // — where the bundle is sized IN that asset — had to be filled in after a trip
  // to the bottom of the page and back. NULL on a native launch, and that is the
  // whole visibility rule for the pair funding control below: a native bundle
  // buys with the ETH it already holds.
  pair = null,
  live = false,
  // Step key -> live number, so this panel can name another station without
  // knowing where it sits. The numbering closes by KEY, not by position: this
  // panel is step 3 on one launcher and step 2 on the other.
  nums = {},
  variant = 'v1',
}) {
  const roles = rolesFor(variant);
  const [count, setCount] = useState(5);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [busy, setBusy] = useState('');
  // V4's seasoned seed wallets ready to hand off into THIS tab's bundle role. Claiming is
  // one-way — the backend re-roles v4seed -> the target bundle and there is no un-claim — so
  // the destination is named in the confirm rather than assumed. It was v1-only on the
  // grounds that v2 would be "the wrong launcher with no way back", but v3/v5/v6/v7/v8 all
  // claim under the identical risk, and excluding v2 meant wallets aged for weeks to look
  // unrelated could only go to the launcher that funds them from one visible address.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(5);
  // The native token's USD price, for showing a predicted market cap the way an
  // operator reads it ("15k MC"). Fetched live from the backend (which asks an
  // exchange server-side); auto-filled but editable. `manualRef` records that
  // the operator overrode it, so the next live tick does not clobber the value
  // they typed.
  const [ethPrice, setEthPrice] = useState(1888);
  const [priceLive, setPriceLive] = useState(null); // { usd, source, stale }
  const manualRef = useRef(false);
  // "Distribute a total across the bundle" — the amount typed at the top of the
  // table, and the live gas cost of a buy/sell so the fund reserve is exact.
  const [totalBuy, setTotalBuy] = useState('');
  const [gas, setGas] = useState(null); // { buyGasEth, sellGasEth }
  // What the last auto-fill did on a PAIRED launch — the ETH it priced, and the
  // wallets it could not price. Null on a native launch (where the Fund column is
  // arithmetic, not a quote) and until Distribute has been pressed. It is an
  // account of a fill that has already happened, so it is dropped the moment the
  // total or the quote asset changes and it would be answering a stale question.
  const [fill, setFill] = useState(null);

  // ── PAIRED LAUNCH: the bundle must HOLD the pair token BEFORE the launch ────
  // A paired launch denominates every bundle buy in the pair token, and those buys
  // are signed before the token exists — so a wallet that is not already holding it
  // is dropped by the preflight ("holds 0.0 NVDA, needs 0.029125 NVDA — skipped")
  // and the bundle fires empty. These four hold the priced plan, the last real run,
  // and the dialog between them. All of it is dead weight on a native launch, where
  // `pair` is null and none of it renders.
  const [pairPlan, setPairPlan] = useState(null); // the priced dry run
  const [pairErr, setPairErr] = useState('');
  // The plan the dialog is asking about, FROZEN with the targets it was priced
  // against — so what the operator reads is what is broadcast, even if the Buy
  // column is edited while the dialog is open. Same rule the launch dialog keeps.
  const [pairAsk, setPairAsk] = useState(null);
  const [pairOut, setPairOut] = useState(null); // what the last real run did, per wallet

  // ── AND THE WAY BACK OUT OF IT ──────────────────────────────────────────────
  // Buying the pair token used to be a one-way door: a wallet holding NVDA had no
  // console path back to ETH, so a changed quote asset, an abandoned launch or a
  // mis-sized bundle stranded the token in up to 31 wallets. These four are the
  // mirror of the four above — the priced dry run, its error, the frozen dialog and
  // the last real run — and the whole control is absent unless a bundle wallet is
  // actually holding some of the pair token, which the pair column already knows.
  const [backPlan, setBackPlan] = useState(null); // the priced dry run
  const [backErr, setBackErr] = useState('');
  const [backAsk, setBackAsk] = useState(null); // frozen with the targets it was priced against
  const [backOut, setBackOut] = useState(null); // what the last real sell did, per wallet

  // ── THE CONVERTER ───────────────────────────────────────────────────────────
  // The Total buy field is, and stays, in the pair token: it is the number that
  // becomes the Buy column, which is the number prepareV2 parses and then demands
  // the wallet hold. What was missing is the other half of the operator's own
  // question — "I have 0.5 ETH, how much NVDA is that?" — so this is a second,
  // separately-labelled ETH field whose answer has to be TAKEN before it is
  // written. Two fields, each permanently named with its own unit, and a quote
  // between them that is drawn as a quote. Nothing here writes anything on its
  // own, and no figure on screen is ever computed from the other unit.
  const [ethTotal, setEthTotal] = useState('');
  const [rate, setRate] = useState(null); // the live two-way quote
  const [rateErr, setRateErr] = useState('');

  // ── THE MARKET-CAP RATE ─────────────────────────────────────────────────────
  // A SECOND, standing quote, and not the converter's: that one answers what the
  // operator typed and is null until they type it, while this one has to be there
  // for every market cap on the table from the moment a pair is picked.
  //
  // It exists because on a paired launch NOTHING upstream of it is in ETH. The
  // curve, the market cap and the graduation threshold are all in the pair token
  // — NVDA's curve opens at 16.64 NVDA, not 1.68 ETH — and the dollar figure the
  // operator reads is the last step of pair -> ETH -> USD. Null whenever the
  // quote could not be taken, and null means NO dollar figure and a line saying
  // why: a market cap converted at a guessed rate is indistinguishable on screen
  // from one that is real.
  const [mcRate, setMcRate] = useState(null); // { perEth, quotedAt, symbol }
  const [mcRateErr, setMcRateErr] = useState('');

  // ── "USE THE ETH THE WALLETS ALREADY HOLD" ──────────────────────────────────
  // The priced plan, and it is only ever a PREVIEW: the operator sees what would
  // be spent, what it yields and which wallets are being skipped before a single
  // field is written. Read-only server-side too — it signs nothing and sends
  // nothing. Null until the button is pressed, and dropped again once applied or
  // dismissed, because it is an account of balances read at one moment.
  const [balPlan, setBalPlan] = useState(null);
  const [balErr, setBalErr] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const p = await api('/eth-price');
        if (!alive) return;
        setPriceLive(p);
        if (!manualRef.current) setEthPrice(Number(p.usd).toFixed(2));
      } catch {
        // Price source down — keep whatever is in the field. The dollar figure
        // is advisory; a launch never depends on it.
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The current cost of a buy and a sell, used only to size the fund reserve.
  useEffect(() => {
    let alive = true;
    api('/gas')
      .then((g) => alive && setGas(g))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // A different quote asset makes the last fill's figures the answer to a
  // different question — an ETH total priced against NVDA says nothing about a
  // launch now paired with SPCX, and native has no quote at all. Dropped rather
  // than left on screen reading as current.
  useEffect(() => {
    setFill(null);
    // Same reasoning for the two new readouts: a rate quoted against NVDA says
    // nothing about a launch now paired with SPCX, and a balance plan priced
    // against one pool is not a plan for another.
    setRate(null);
    setRateErr('');
    setBalPlan(null);
    setBalErr('');
    // And the recovery preview: a sell priced against the NVDA pool is not an
    // account of what the SPCX one would pay for anything.
    setBackPlan(null);
    setBackErr('');
    // Same for the market-cap rate. Its effect re-takes it immediately; clearing
    // it here is what stops NVDA's rate from pricing an SPCX cap for one render.
    setMcRate(null);
    setMcRateErr('');
  }, [pair?.address]);

  // THE LIVE RATE. Both directions in one read — whichever fields have something
  // in them — because they are one question asked from two ends and answering
  // them from two calls would let the two halves disagree on screen.
  //
  // Debounced: it is a chain read and both fields are typed into. It is quoted by
  // the same route the funding swap uses (backend bundle/pairQuote.js), and the
  // pair->ETH side is the cost to BUY, sized the way the swap sizes it — the
  // reverse quote would price SELLING and under-fund every wallet.
  //
  // Nothing writes from this. `rate` is displayed and nothing else.
  useEffect(() => {
    if (!pair) return undefined;
    const wantPair = Number(totalBuy) > 0 ? String(totalBuy) : '';
    const wantEth = Number(ethTotal) > 0 ? String(ethTotal) : '';
    if (!wantPair && !wantEth) {
      setRate(null);
      setRateErr('');
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ pairToken: pair.address });
      if (wantEth) q.set('ethIn', wantEth);
      if (wantPair) q.set('pairIn', wantPair);
      try {
        const out = await api(`/wallets/pair-quote?${q.toString()}`);
        if (!alive) return;
        setRate(out);
        setRateErr('');
      } catch (err) {
        if (!alive) return;
        setRate(null);
        setRateErr(err.message);
      }
    }, 900);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, totalBuy, ethTotal]);

  // THE MARKET-CAP RATE, re-taken with the quote asset and once a minute after
  // that — the same cadence as the ETH price it is multiplied by, so the two
  // halves of a dollar figure are never far apart in age.
  //
  // Not debounced and not driven by a field: it is a standing fact about the
  // pair, quoted at a fixed 0.001 ETH probe through the same route the funding
  // swap uses (backend bundle/pairQuote.js). Native launches make no request at
  // all — their figures already are ETH.
  //
  // A failure sets NO rate and keeps the reason. Nothing here falls back to a
  // previous pair's rate, to a default, or to treating the pair figure as ETH,
  // which is the bug this panel is being fixed for.
  useEffect(() => {
    if (isNativeLaunch(pair)) return undefined;
    let alive = true;
    const load = async () => {
      try {
        const q = new URLSearchParams({ pairToken: pair.address, ethIn: MC_PROBE_ETH });
        const out = await api(`/wallets/pair-quote?${q.toString()}`);
        if (!alive) return;
        const perEth = pairPerEthFrom(out, MC_PROBE_ETH);
        if (perEth === null) {
          setMcRate(null);
          setMcRateErr(`the ${pair.symbol} pool quoted nothing for ${MC_PROBE_ETH} ETH`);
          return;
        }
        setMcRate({ perEth, quotedAt: out.quotedAt, symbol: out.pairSymbol || pair.symbol });
        setMcRateErr('');
      } catch (err) {
        if (!alive) return;
        setMcRate(null);
        setMcRateErr(err.message);
      }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, pair?.symbol]);

  // How many V4-seasoned seed wallets are ready to claim into this bundle.
  // Read-only background poll of a small figure, same shape as the eth-price
  // and gas reads above; guarded quietly for the same reason — V4 may be
  // unreachable or disabled and this control should just read 0, not error.
  useEffect(() => {
    if (variant !== 'v1' && variant !== 'v2') return;
    let alive = true;
    api('/v4/seasoned')
      .then((s) => alive && setSeasoned(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [variant]);
  // Ticked wallet ids. Only ever bundle wallets reach a delete — see `chosen`.
  const [picked, setPicked] = useState(() => new Set());
  // The wallets the delete confirmation is asking about, frozen at the moment
  // it opened so the figures on screen are the ones the delete runs on. Null
  // means no dialog is open, and no dialog open means nothing is deleted.
  const [deleting, setDeleting] = useState(null);
  // The wallet the current delete run is working on, so its own row says so.
  const [now, setNow] = useState('');
  // What the last delete run did, per wallet. Shown under the table because
  // the Result panel is a page away and a partial failure must not be silent.
  const [outcome, setOutcome] = useState(null);

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /**
   * Hand N seasoned V4 seed wallets over into THIS tab's bundle. The backend re-roles them
   * v4seed -> the variant's bundle role, which is ONE WAY: there is no un-claim, so a wallet
   * sent to the wrong launcher has spent its aging there. The variant travels with the
   * request so the server never has to guess which bundle the operator meant.
   */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/wallets/claim-seasoned', 'POST', { count: n, variant });
      report(
        out.shortfall > 0
          ? `claimed ${out.claimed.length} seasoned wallet(s), ${out.shortfall} short — only ${out.available} were ready`
          : `claimed ${out.claimed.length} seasoned wallet(s)`
      );
      await reload();
      // The pool just shrank by what was claimed — re-read it rather than
      // subtracting locally, since another tab or another operator may have
      // claimed from it too.
      try {
        setSeasoned(await api('/v4/seasoned'));
      } catch {
        // Background read — see the mount-time fetch above for why this stays quiet.
      }
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // A whitelist, not "everything that is not the dev wallet": a role this
  // console does not know about is never swept into a bulk delete either.
  const bundle = wallets.filter((w) => w.role === roles.bundle);

  // What this table may draw AT ALL: the two roles belonging to the launcher
  // on screen, and nothing else.
  //
  // The keystore is one file holding both launchers, so /wallets returns every
  // wallet the user owns and the filtering is this console's job. Mapping the
  // raw list — which this table did — put v2's dev and bundle wallets in the
  // v1 table, each with a live delete and a Fund field wired to v1's run. The
  // separation is worth nothing if the screen still shows both sets, and a
  // funded wallet listed under the wrong launcher is a wallet somebody deletes
  // believing it is idle.
  const visible = wallets.filter((w) => w.role === roles.dev || w.role === roles.bundle);

  // How many sells each wallet keeps gas for, deliberately generous — a wallet
  // stuck holding tokens it cannot sell is worse than a slightly larger fund.
  const SELL_RESERVE = 10;

  // The most bundle wallets a launch can exempt: the forwarder appends its own
  // buy recipient, so the factory's 32 leaves room for 31 of ours. A 32nd is the
  // ExemptionListTooLong revert that stranded a bundle — so the count is capped
  // here too, not only refused at launch.
  const MAX_BUNDLE = 31;
  const bundleRoom = Math.max(0, MAX_BUNDLE - bundle.length);
  // How many bundle wallets actually hold ETH — the summary tiles state it so
  // "generated" and "funded" are not read as the same thing.
  const fundedBundle = bundle.filter((w) => Number(w.balanceEth) > 0).length;

  // What the dev wallet must hold to fund every buy: the total buy plus each
  // wallet's gas reserve. Shown live so a shortfall is a number seen up front
  // rather than a third of the bundle silently skipped at preflight for lack of
  // funds. The dev buy and the launch fee are on top of this and set elsewhere.
  const reservePerWallet = Number(gas?.buyGasEth || 0) + SELL_RESERVE * Number(gas?.sellGasEth || 0);
  // NATIVE ONLY, and now said so in the code rather than only in the copy: this
  // adds the typed total to a gas figure, and on a paired launch the typed total
  // is in the PAIR TOKEN. The paired readout is below and is built from ETH the
  // swap endpoint priced, never from arithmetic across two currencies.
  const fundNeeded = !pair && Number(totalBuy) > 0 ? Number(totalBuy) + bundle.length * reservePerWallet : 0;

  // THE ASSET THE TYPED TOTAL IS IN. It is the asset the Buy column is in, which
  // is the launch's quote asset: ETH on a native launch, the pair token on a
  // paired one. Named on screen beside the field, because a number with an
  // assumed unit is the bug this control had.
  const buyUnit = pair ? pair.symbol : 'ETH';

  // Split the typed total across the bundle wallets into a random, jittered
  // spread — no two the same, so the buys read as organic rather than a pattern
  // — and fill each row's Buy and Fund. Moves NO ETH: it only writes the table
  // fields the operator was going to type by hand. Both fields stay editable.
  //
  // TWO CURRENCIES, ONE TABLE. Buy is in the launch's quote asset; Fund is ALWAYS
  // ETH. On a native launch those are the same asset and Fund is buy + gas — the
  // arithmetic this control has always done. On a PAIRED launch they are not, and
  // `buy + gas` added NVDA to ETH and wrote the sum into an ETH field. The paired
  // branch below never does that: the Buy amounts stay in the pair token, and the
  // ETH is asked of the endpoint that will actually spend it.
  async function distribute() {
    const total = Number(totalBuy);
    if (!(total > 0)) return notify('Enter a total buy amount first.', 'error');
    if (!bundle.length) return notify('Generate bundle wallets before distributing.', 'error');

    // Sizing the fund needs the gas cost; fetch it now if the initial load
    // failed, and only fall back to no reserve if the chain is unreachable.
    let g = gas;
    if (!g) {
      try {
        g = await api('/gas');
        setGas(g);
      } catch {
        g = { buyGasEth: '0', sellGasEth: '0' };
      }
    }
    const reserve = Number(g.buyGasEth || 0) + SELL_RESERVE * Number(g.sellGasEth || 0);

    // ±30% jitter around equal, normalised to the exact total; the rounding
    // drift is pushed onto the last wallet so the sum is exactly what was typed.
    // Six decimals on a native launch, exactly as before; on a paired one, capped
    // at the pair token's own decimals so every amount is one the launch — and
    // the pricing call below — can parse.
    const places = pair ? Math.min(6, Number(pair.decimals) || 6) : 6;
    const amounts = splitTotal(bundle.length, total, { places });

    // ── NATIVE: buy and fund are the same asset, so Fund is arithmetic ─────────
    if (!pair) {
      bundle.forEach((w, i) => {
        const buy = amounts[i];
        setRow(w.id, { mode: 'fixed', buy: String(buy), fund: (buy + reserve).toFixed(6) });
      });
      report(
        `distributed ${total} ETH across ${bundle.length} wallets — each funded for its buy plus gas for ` +
          `${SELL_RESERVE} sells. Nothing was sent; edit any row, then Fund and launch as usual.`
      );
      notify(`Filled ${bundle.length} wallets for ${total} ETH. No ETH moved — edit, then Fund.`, 'ok');
      return;
    }

    // ── PAIRED: the Buy amounts are in the pair token, so the ETH must be PRICED ─
    // Priced by the dry run of the endpoint that will buy the pair token, because
    // that is the code that decides what a wallet must hold: it sizes the swap
    // against live quotes and it reports the reserve it will refuse a wallet for
    // lacking. A dry run takes no launch lock (see routes/wallets.js — it is
    // exempted precisely so the console can price in the background), signs
    // nothing and touches no nonce.
    setBusy('auto-fill');
    setFill(null);
    const targets = bundle
      .map((w, i) => ({ walletId: w.id, amountPair: String(amounts[i]) }))
      // A wallet whose share rounds to nothing has no swap to price, and the
      // endpoint refuses the whole request over a zero amount rather than
      // guessing. It is left unpriced and counted below.
      .filter((t) => Number(t.amountPair) > 0);

    let plan = null;
    let error = '';
    try {
      plan = await api('/wallets/swap-to-pair', 'POST', {
        variant,
        pairToken: pair.address,
        targets,
        dryRun: true,
      });
    } catch (err) {
      error = err.message;
    }
    setBusy('');

    // What each wallet keeps on top of its swap: the endpoint's OWN reserve — the
    // swap's gas, the launch's approve and buy at double, the preflight buffer —
    // so a wallet funded to this passes the very check that would refuse it, plus
    // this console's standing promise of gas for SELL_RESERVE exits.
    const filled = plan
      ? pairedFunds(plan, pairedReserveEth(plan.gasReserveEth, g.sellGasEth, SELL_RESERVE))
      : { funds: {}, unpriced: bundle.map((w) => w.id), totalEth: 0 };

    // The Buy column is filled either way — it is the pair-token split, and it
    // needs no quote. A wallet with no price gets NO Fund figure rather than a
    // wrong one; blank is a question the operator can answer.
    bundle.forEach((w, i) => {
      setRow(w.id, { mode: 'fixed', buy: String(amounts[i]), fund: filled.funds[w.id] ?? '' });
    });

    const priced = Object.keys(filled.funds).length;
    const unpriced = bundle.length - priced;
    setFill({ total, unit: pair.symbol, ethTotal: filled.totalEth, priced, unpriced, error });

    if (priced === 0) {
      report(
        `filled the Buy column with ${total} ${pair.symbol} across ${bundle.length} wallets, but could NOT ` +
          `price the ETH side: ${error || `no wallet could be priced against the ${pair.symbol} pool`}. ` +
          'The Fund column was left BLANK rather than filled with a wrong number — type it, or fix the ' +
          'pair and run this again. Nothing was sent.'
      );
      return notify(
        `Buy column filled in ${pair.symbol}. Fund left blank — the ETH could not be priced.`,
        'error'
      );
    }

    report(
      `distributed ${total} ${pair.symbol} across ${bundle.length} wallets — the Buy column is ` +
        `${pair.symbol}; each Fund is the ETH to SWAP for that ${pair.symbol} plus gas for the swap, the ` +
        `launch's approve + buy and ${SELL_RESERVE} sells, ≈${filled.totalEth.toFixed(6)} ETH in total` +
        (unpriced > 0 ? `. ${unpriced} wallet(s) could not be priced and were left blank` : '') +
        `. Nothing was sent; edit any row, Fund in step ${nums.fund ?? 4}, then buy ${pair.symbol} above.`
    );
    notify(
      `Filled ${bundle.length} wallets for ${total} ${pair.symbol} ≈ ${filled.totalEth.toFixed(4)} ETH. ` +
        'No ETH moved — edit, then Fund.',
      unpriced > 0 ? 'error' : 'ok'
    );
  }

  /**
   * Take the converter's answer into the Total buy field.
   *
   * THIS IS THE ONLY WAY A CONVERTED NUMBER EVER BECOMES A WRITTEN ONE, and it
   * takes a deliberate press. The alternative — a Total field that silently means
   * ETH sometimes and NVDA others, converted at whatever the rate was when
   * Distribute happened to be clicked — is the same unit ambiguity that produced
   * the bug this area was just fixed for. So the conversion lands VISIBLY in the
   * pair-token field, where the operator can read it, edit it, and see it is the
   * figure Distribute will split. The rate moves; the number they accepted does
   * not, which is the honest arrangement.
   */
  function takeConverted() {
    if (!rate?.pairOut) return;
    // Floored to the places the split writes at — the same rule splitTotal uses,
    // capped at the pair token's own decimals — and floored rather than rounded
    // so the total taken is never above what the quote actually offered.
    const places = Math.min(6, Number(pair.decimals) || 6);
    const scale = 10 ** places;
    const taken = String(Math.floor(Number(rate.pairOut) * scale) / scale);
    setTotalBuy(taken);
    // The previous fill priced a different total and is no longer an account of
    // anything on screen.
    setFill(null);
    notify(
      `Total buy set to ${taken} ${pair.symbol} — converted from ${rate.ethIn} ETH at the quote shown. ` +
        'Nothing was sent; press Distribute to split it.',
      'info'
    );
  }

  /**
   * PRICE what the ETH already sitting in the bundle wallets would buy.
   *
   * Reads only. It asks the backend for a per-wallet plan — real balance, gas held
   * back, live quote, and a CONSERVATIVE pair-token amount — and puts it on screen
   * as a preview. It writes nothing: the operator sees the ETH it would put to
   * work, the pair token that yields and every wallet being skipped, and only then
   * decides.
   */
  async function priceFromBalance() {
    setBusy('from-balance');
    setBalPlan(null);
    setBalErr('');
    try {
      const q = new URLSearchParams({
        pairToken: pair.address,
        variant,
        // The console owns this promise, so the console states it: gas for
        // SELL_RESERVE exits, on top of everything the launch itself needs.
        sells: String(SELL_RESERVE),
      });
      const out = await api(`/wallets/pair-from-balance?${q.toString()}`);
      setBalPlan(out);
      if (out.usable === 0) {
        notify(
          `No bundle wallet has ETH to spare after gas — nothing to fill. ${out.count} checked.`,
          'error'
        );
      }
    } catch (err) {
      setBalErr(err.message);
      notify(`Could not price this — ${err.message}`, 'error');
    } finally {
      setBusy('');
    }
  }

  /**
   * Write the previewed plan into the Buy column. Still moves no ETH.
   *
   * Each amount is the backend's own `buyPair` string, written back VERBATIM —
   * see balanceFill in pairBalance.js. It is the conservative figure the plan
   * showed, and it is only a guarantee if it is the figure that lands in the
   * field. A wallet the plan skipped gets nothing at all, not a zero: a zero
   * would read as a decision about it, and no decision was made.
   *
   * The Fund column is deliberately untouched. These wallets are ALREADY funded
   * — that is the premise of this whole mode — so there is nothing to send them,
   * and writing an ETH figure into Fund would invite a second funding run.
   */
  function applyBalancePlan() {
    const { patches, filled, skipped } = balanceFill(balPlan);
    Object.entries(patches).forEach(([id, patch]) => setRow(id, patch));
    const plan = balPlan;
    setBalPlan(null);
    // The auto-fill's own readout described a total that no longer describes this
    // column. Dropped rather than left on screen reading as current.
    setFill(null);

    report(
      `filled the Buy column for ${filled} wallet(s) from the ETH they already hold — ` +
        `${plan.totalBuyPair} ${plan.pairSymbol} in total, costing at most ${plan.totalSwapEth} ETH of their ` +
        `own balances. Each wallet keeps ${plan.reserveEth} ETH back: ${plan.gasReserveEth} for the swap and ` +
        `the launch's approve + buy, ${plan.sellReserveEth} for ${plan.sells} sells. Each amount is the live ` +
        `quote less ${plan.overshootBps / 100}%, so it is one the wallet can actually satisfy` +
        (skipped.length
          ? `. ${skipped.length} wallet(s) were left alone: ` +
            skipped.map((sk) => `${sk.address} (${sk.status})`).join(', ')
          : '') +
        '. Nothing was sent; edit any row, then buy ' +
        `${plan.pairSymbol} above.`
    );
    notify(
      `Filled ${filled} wallet(s) for ${Number(plan.totalBuyPair).toFixed(6)} ${plan.pairSymbol}. ` +
        'No ETH moved — edit, then buy the pair token.',
      skipped.length ? 'error' : 'ok'
    );
  }

  // ── the pair funding plan ───────────────────────────────────────────────────
  // WHICH WALLETS. Every bundle wallet with a Buy amount typed — that amount IS
  // the requirement, in the pair token's own units, because it is the same number
  // prepareV2 parses and then demands the wallet hold. A wallet on "all − gas" is
  // deliberately excluded: on a paired launch that mode means "spend whatever pair
  // balance you have", which names no amount to buy, so there is nothing to size a
  // swap against. It is stated below rather than silently dropped.
  const pairTargets = pair
    ? bundle
        .filter((w) => (rows[w.id]?.mode ?? 'fixed') !== 'all' && Number(rows[w.id]?.buy) > 0)
        .map((w) => ({ walletId: w.id, amountPair: String(rows[w.id].buy) }))
    : [];
  const pairAllMode = pair ? bundle.filter((w) => rows[w.id]?.mode === 'all').length : 0;
  const pairTotal = pairTargets.reduce((sum, t) => sum + Number(t.amountPair), 0);
  // Serialised so the preview below re-runs when the AMOUNTS change and not merely
  // when the array identity does (it is rebuilt every render).
  const pairKey = JSON.stringify(pairTargets);

  // The ETH this will cost, priced server-side against live quotes — the operator
  // must not be asked to approve a spend whose size is a guess. It is a dry run of
  // the real endpoint, so the figure on screen is produced by the code that will
  // spend it, including its skips and its refusals. Debounced, because it is a
  // chain read per wallet and the Buy column is typed in.
  useEffect(() => {
    if (!pair || pairTargets.length === 0) {
      setPairPlan(null);
      setPairErr('');
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const out = await api('/wallets/swap-to-pair', 'POST', {
          variant,
          pairToken: pair.address,
          targets: JSON.parse(pairKey),
          dryRun: true,
        });
        if (!alive) return;
        setPairPlan(out);
        setPairErr('');
      } catch (err) {
        if (!alive) return;
        setPairPlan(null);
        setPairErr(err.message);
      }
    }, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, pairKey, variant]);

  /**
   * Buy the pair token, one wallet at a time, each with its own ETH.
   *
   * The dev wallet never sends the token on: distributing it would write
   * dev → 20 wallets → they all buy the launch onto the chain, which is the
   * coordination a bundle is trying not to advertise.
   *
   * The result is kept on the panel as well as sent to the readout, because a run
   * where some wallets swapped, some were already funded and some were refused for
   * gas must not be reduced to one line somebody scrolls past.
   */
  async function runPairSwap() {
    setBusy('pair-swap');
    setPairOut(null);
    try {
      const out = await api('/wallets/swap-to-pair', 'POST', {
        variant,
        pairToken: pairAsk.pairToken,
        targets: pairAsk.targets,
      });
      setPairOut(out);
      report(out);
      const stuck = out.count - out.swapped - out.skippedAlreadyFunded;
      notify(
        stuck === 0
          ? `All ${out.count} wallet(s) hold their ${out.pairSymbol}. Spent ${out.totalEth} ETH.`
          : `${out.swapped} swapped, ${stuck} not funded — read the list under the table.`,
        stuck === 0 ? 'ok' : 'error'
      );
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
      notify(`Pair funding failed — ${err.message}`, 'error');
    } finally {
      setBusy('');
      setPairAsk(null);
    }
  }

  // ── the recovery plan: which wallets are HOLDING the pair token ─────────────
  // Not "which wallets have a Buy amount" — that is the funding question, and it is
  // asked of the table's fields. This one is asked of the CHAIN: the listing already
  // carries each wallet's real pair balance (the column beside Balance), so the
  // wallets with something to recover are the wallets holding some, whatever the Buy
  // column says. A balance that was not read is left out rather than assumed empty —
  // see recoverTargets in pairBalance.js.
  const recover = pair ? recoverTargets(bundle) : { targets: [], total: '0', unknown: 0 };
  // Serialised with the BALANCES, not just the ids, so the preview re-prices when a
  // wallet's holding changes rather than only when the set of holders does.
  const recoverKey = JSON.stringify(recover.targets.map((t) => ({ walletId: t.walletId, heldPair: t.heldPair })));
  // The endpoint's own shape: no amountPair at all, which is what "sell the whole
  // balance" means. The amount is read on chain per wallet by the code that sells it,
  // so nothing here has to be right about a number.
  const recoverTargetsSent = () => JSON.parse(recoverKey).map(({ walletId }) => ({ walletId }));

  // WHAT THE RECOVERY WOULD RETURN, priced server-side against live quotes — the
  // operator must not be asked to approve a sale whose proceeds are a guess. It is a
  // dry run of the real endpoint, so the figure is produced by the code that will
  // sell, including its impact refusals and its dust skips. Debounced, because it is
  // a chain read per wallet and the listing refreshes between funding steps.
  useEffect(() => {
    if (!pair || recover.targets.length === 0) {
      setBackPlan(null);
      setBackErr('');
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const out = await api('/wallets/swap-from-pair', 'POST', {
          variant,
          pairToken: pair.address,
          targets: recoverTargetsSent(),
          dryRun: true,
        });
        if (!alive) return;
        setBackPlan(out);
        setBackErr('');
      } catch (err) {
        if (!alive) return;
        setBackPlan(null);
        setBackErr(err.message);
      }
    }, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, recoverKey, variant]);

  /**
   * Sell the pair token back to ETH, one wallet at a time, each keeping its own
   * proceeds.
   *
   * The ETH lands back in the wallet that held the token — there is no sweep to the
   * dev wallet here, for the same reason the funding direction does not distribute
   * from it: an on-chain line between the dev wallet and the buyers is exactly what
   * a bundle is trying not to draw. Step 6's sweep is a separate, deliberate act.
   *
   * The result is kept on the panel as well as sent to the readout: a run where some
   * wallets sold, some were refused for price impact and some held only dust must not
   * be reduced to one line somebody scrolls past.
   */
  async function runPairSell() {
    setBusy('pair-sell');
    setBackOut(null);
    try {
      const out = await api('/wallets/swap-from-pair', 'POST', {
        variant,
        pairToken: backAsk.pairToken,
        targets: backAsk.targets,
      });
      setBackOut(out);
      report(out);
      const left = out.count - out.swapped;
      notify(
        left === 0
          ? `All ${out.count} wallet(s) sold their ${out.pairSymbol}. Recovered ${Number(out.totalEthOut).toFixed(6)} ETH.`
          : `${out.swapped} sold, ${left} still holding — read the list under the table.`,
        left === 0 ? 'ok' : 'error'
      );
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
      notify(`Selling ${pair?.symbol} back failed — ${err.message}`, 'error');
    } finally {
      setBusy('');
      setBackAsk(null);
    }
  }

  // The delete list is derived from the bundle wallets and intersected with the
  // ticks, never read out of the tick set directly. The dev wallet signs every
  // launch and holds the funds, so it is kept out of the bulk path by
  // construction rather than by remembering to check: it is given no checkbox,
  // select-all only ever adds bundle ids, and an id that reached the set some
  // other way still cannot survive this filter.
  const chosen = bundle.filter((w) => picked.has(w.id));
  const chosenEth = chosen.reduce((s, w) => s + Number(w.balanceEth || 0), 0);
  const chosenFunded = chosen.filter((w) => Number(w.balanceEth) > 0);

  const allPicked = bundle.length > 0 && chosen.length === bundle.length;
  const somePicked = chosen.length > 0 && !allPicked;

  // indeterminate is a property, not an attribute — JSX cannot set it.
  const allBox = useRef(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = somePicked;
  }, [somePicked]);

  // A wallet that has gone — deleted here, or from another tab — must not stay
  // ticked. The set feeds a delete loop, so an id that is no longer a bundle
  // wallet has no business in it.
  useEffect(() => {
    setPicked((prev) => {
      if (!prev.size) return prev;
      const live = new Set(wallets.filter((w) => w.role === roles.bundle).map((w) => w.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [wallets]);

  function tick(id, on) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /**
   * Delete wallets one at a time.
   *
   * There is no bulk endpoint, and these are deliberately not fired at once:
   * every DELETE rewrites the whole keystore file, and a failure has to be
   * attributable to one wallet rather than to "the batch". The list is
   * refreshed once at the end instead of after each one.
   */
  async function runDeletes(list) {
    setBusy('delete');
    setOutcome(null);
    const results = [];
    for (const w of list) {
      setNow(w.id);
      try {
        await api(`/wallets/${w.id}`, 'DELETE');
        results.push({ id: w.id, address: w.address, ok: true });
      } catch (err) {
        results.push({ id: w.id, address: w.address, ok: false, error: err.message });
      }
    }
    setNow('');
    setPicked(new Set());
    setOutcome(results);

    const failed = results.filter((r) => !r.ok);
    // Recorded in the readout like everything else. Nothing pulls the page down
    // to it — the operator deletes several in a row and the table is where the
    // next click is — and the same counts are drawn under this table anyway.
    report({
      deleted: results.length - failed.length,
      failed: failed.length,
      wallets: results.map((r) => ({
        address: r.address,
        status: r.ok ? 'deleted' : 'failed',
        ...(r.error ? { error: r.error } : {}),
      })),
    });

    // The deletes have already happened and are already reported; a refresh
    // that fails must not leave the panel stuck on "working…".
    await reload().catch(() => {});
    setBusy('');
  }

  // The share figures, keyed by wallet so a row can find its own. Order is
  // firing order and on a v2 curve the order IS the price, so this is a lookup
  // into a sequence, never a per-row calculation.
  const legs = new Map((share?.buys || []).map((l) => [l.key, l]));
  // Rows the operator asked to spend the whole balance on. Their real amount is
  // resolved server-side after gas, so the figures for them are ceilings on top
  // of a ceiling — said once, under the table, rather than on every row.
  // Whitelist, for the reason given above `bundle` — and now literally: the V2
  // roles exist, and "not the dev wallet" would count them here.
  const allMode = wallets.filter((w) => w.role === roles.bundle && rows[w.id]?.mode === 'all').length;
  // Wallets with something to buy. A zero-amount leg is kept in the sequence —
  // it moves nothing, so dropping it would change nothing — but it is not a
  // wallet that is buying, and counting it as one would misstate the bundle.
  const buyingCount = (share?.buys || []).filter((b) => b.estBps > 0).length;

  // ── THE LAUNCH'S QUOTE ASSET, AND THE ONE BRIDGE OUT OF IT ─────────────────
  //
  // Every quote-denominated figure on `share` — bundle.eth, total.eth, each
  // leg's mcEth, marketCap, the graduation threshold — is in the asset the launch
  // is PRICED IN. That is ETH on a native launch and on v1, and the pair token on
  // a paired one, and this panel used to write "ETH" after all of them regardless.
  //
  // `unit` is that asset's name, taken from the share itself rather than from
  // `pair`, so a label can never disagree with the arithmetic beside it: it is
  // whatever bundleShare actually walked the curve in.
  //
  // `toEth` is the ONLY conversion, and it is the last step before a dollar sign.
  // Native returns its argument untouched. Paired divides by the live rate, and
  // returns null when there is no usable one — which is the whole point: a
  // missing dollar figure is a question the operator can answer, and a wrong one
  // is not visible at all.
  const nativeQuote = isNativeLaunch(pair);
  const unit = share?.pairSymbol || 'ETH';
  const toEth = (amount) =>
    ethEquivalent(amount, { isNative: nativeQuote, pairPerEth: mcRate?.perEth });
  // Whether a dollar figure can be drawn at all. Native always can; paired needs
  // the rate. Used only to decide whether to say why one is missing.
  const dollarsBlocked = !nativeQuote && !mcRate;

  // What the delete dialog is asking about, and the figures it has to state.
  const pending = deleting || [];
  const pendingEth = pending.reduce((s, w) => s + Number(w.balanceEth || 0), 0);
  const pendingFunded = pending.filter((w) => Number(w.balanceEth) > 0);
  const one = pending.length === 1 ? pending[0] : null;

  return (
    <Step {...step}>
      <p className="lede">
        Each bundle wallet buys behind the dev buy, and each is capped at 5% of supply inside the
        restriction window. More wallets is how a bundle gets bigger without any one of them
        breaching that cap. The table below is where the whole run is sized: what each wallet is
        funded with in step {nums.fund ?? 4}, what it buys in step {nums.launch ?? 5}, and what that
        comes to as a share of supply.
      </p>

      {/* WHICH TABLE THIS IS, IN ONE LINE — and the two shapes it takes. Native
          is one asset and one column: the ETH you fund a wallet with is the ETH
          it buys with. Paired is two, and the ORDER between them runs back up the
          page — fund in ETH below, then come back here and buy the quote asset —
          which is exactly the trip nothing on screen used to mention. */}
      <p className="hint">
        {pair ? (
          <>
            Priced in <b>{pair.symbol}</b> (step {nums.quote ?? 1}). <b>Buy</b> is {pair.symbol};{' '}
            <b>Fund</b> is always ETH. The order is: size the bundle here → fund the ETH in step{' '}
            {nums.fund ?? 4} → come back here and buy {pair.symbol} with it → launch in step{' '}
            {nums.launch ?? 5}.
          </>
        ) : (
          <>
            Priced in <b>native ETH</b>. One asset: the ETH you fund a wallet with in step{' '}
            {nums.fund ?? 4} is the ETH it buys with — there is no second token to hold and no swap
            to run.
          </>
        )}
      </p>

      {/* The run at a glance, across the top of the step: the two counts and the
          two figures the bundle is judged by, lifted out of the table and the
          breakdown notice so the shape of it reads before the detail does. The
          grid stretches the tiles the full width of the card, so the summary is
          also what fills the head of the panel. Read-only — every value here is
          already computed below; nothing new is fetched or decided. */}
      <div className="stats">
        <div className="stat">
          <span>Bundle wallets</span>
          <b>
            {bundle.length} <span className="stat-of">/ {MAX_BUNDLE}</span>
          </b>
          {/* The room-left context, moved off the Generate row and onto the card
              that already carries the count — so how many more fit lives with how
              many there are. Same figure the button's max is clamped to. */}
          <span className="stat-of">{bundleRoom > 0 ? `room for ${bundleRoom} more` : 'full'}</span>
        </div>
        <div className="stat">
          <span>Funded</span>
          <b>
            {fundedBundle} <span className="stat-of">of {bundle.length}</span>
          </b>
        </div>
        <div className="stat">
          <span>Bundle buy</span>
          {/* In the launch's own quote asset. `unit` is ETH on a native launch
              and on v1, so this tile is unchanged there. */}
          <b>{share && Number(share.bundle.eth) > 0 ? `${share.bundle.eth} ${unit}` : '—'}</b>
        </div>
        <div
          className={`stat ${
            share?.marketCap && Number(share.marketCap.finalEth) > 0 ? 'ok' : ''
          }`}
        >
          <span>Predicted MC</span>
          <b>
            {share?.marketCap && Number(share.marketCap.finalEth) > 0
              ? usdMc(toEth(share.marketCap.finalEth), ethPrice) ||
                `${Number(share.marketCap.finalEth).toFixed(3)} ${unit}`
              : '—'}
          </b>
        </div>
      </div>

      {/* One strip regrouped into three clusters — Create, Seasoned, Utility —
          each its own row so they stop wrapping into a jumble. Nothing here
          changed but the grouping: same controls, same wiring, same conditions. */}

      {/* CREATE — bring bundle wallets into existence, by generating or import. */}
      <div className="row">
        <span className="ctl-label">Create</span>
        {/* Amber, for the same reason step 1's generate is: this is the forward
            action of step 3, and it sat grey among four other grey controls. */}
        <Busy
          className="btn-primary"
          busy={busy === 'bundle'}
          disabled={bundleRoom === 0}
          title={bundleRoom === 0 ? `at the ${MAX_BUNDLE}-wallet limit — delete some to add more` : ''}
          onClick={() =>
            act('bundle', () =>
              api('/wallets/generate', 'POST', {
                count: Math.min(Number(count) || 1, bundleRoom),
                role: roles.bundle,
                label: roles.bundle,
              })
            )
          }
        >
          Generate bundle wallets
        </Busy>
        <input
          type="number"
          min="1"
          max={bundleRoom || 1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          title="how many"
        />
        <button className="ghost" onClick={() => setShowImport((v) => !v)}>
          Import bundle keys
        </button>
      </div>

      {/* SEASONED. Available on BOTH launchers, and the destination is named on the button
          because the claim is ONE WAY: the backend re-roles v4seed -> this tab's bundle role
          and there is no un-claim short of the keystore archive. A wallet claimed onto the
          wrong launcher has spent its weeks of aging there. */}
      {(variant === 'v1' || variant === 'v2') && (
        <div className="row">
          <span className="ctl-label">Seasoned</span>
          <input
            type="number"
            min="1"
            max={Math.min(seasoned.count, bundleRoom) || 1}
            value={seasonedCount}
            onChange={(e) => setSeasonedCount(e.target.value)}
            title="how many seasoned wallets to claim"
            style={{ width: 70 }}
          />
          {/* A claim re-roles seasoned wallets INTO the bundle role, so it is
              gated by the same 31-wallet exemption cap as Generate — it cannot
              push the bundle past the limit any more than generating can. */}
          <Busy
            busy={busy === 'claim-seasoned'}
            className="ghost"
            disabled={bundleRoom === 0 || !seasoned.count}
            title={
              bundleRoom === 0
                ? `at the ${MAX_BUNDLE}-wallet limit — delete some to add more`
                : seasoned.count
                  ? ''
                  : 'no seasoned wallets ready yet'
            }
            onClick={claimSeasoned}
          >
            Use {seasonedCount} seasoned wallets in {variant.toUpperCase()}
          </Busy>
          <span className="hint">
            {seasoned.count} seasoned ready
            {bundleRoom > 0 ? ` · ${bundleRoom} bundle slot${bundleRoom === 1 ? '' : 's'} left` : ' · bundle full'}
            {' · '}
            <b>one way</b>
            {` — they leave V4 for ${variant.toUpperCase()}'s bundle and cannot be claimed back`}
          </span>
        </div>
      )}

      {/* UTILITY — read state back, and take the keys off the machine. Neither
          moves a wallet in or out of the bundle. */}
      <div className="row">
        <span className="ctl-label">Utility</span>
        {/* .quiet: a pure re-read. It changes nothing on chain, on disk or in
            the keystore, so it should not look like the create controls above
            that generate and import keys. */}
        <Busy
          busy={busy === 'reload'}
          className="quiet"
          onClick={() => act('reload', async () => 'balances refreshed')}
        >
          Refresh balances
        </Busy>
        {/* The same control, and the same typed confirmation, as the one beside
            the dev wallet's delete in step 1 — one component, drawn in both
            places, because both delete dialogs name a backup as the thing that
            makes the delete survivable.

            SCOPED, in three widths. This file used to be the WHOLE KEYSTORE —
            every tab's keys, V3 through V8, from a button that sits beside this
            launcher's bundle — so a backup taken to move one bundle carried
            everything. Left to right it narrows: the tab (this dev wallet and
            its bundle), the bundle alone, and — only once rows are ticked — the
            ticked rows alone. The third reads the SAME selection the bulk delete
            below reads, so "export selected" and "delete selected" can never
            disagree about which wallets they mean. */}
        <BackupControls variant={variant} wallets={wallets} report={report} />
        <BackupControls
          variant={variant}
          wallets={wallets}
          role={roles.bundle}
          label="Export bundle"
          report={report}
        />
        {chosen.length > 0 && (
          <BackupControls
            variant={variant}
            wallets={wallets}
            walletIds={chosen.map((w) => w.id)}
            label={`Export ${chosen.length} selected`}
            report={report}
          />
        )}
      </div>

      {/* No role here. These are bundle keys: the dev key is imported in step 1,
          beside the dev wallet it replaces and the delete that made room. */}
      {showImport && (
        <div className="row">
          <textarea
            rows="3"
            placeholder="bundle wallet private keys, one per line"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
          <Busy
            busy={busy === 'import'}
            onClick={() =>
              act('import', async () => {
                const made = await api('/wallets/import', 'POST', {
                  privateKeys: keys.split('\n'),
                  role: roles.bundle,
                });
                setKeys('');
                return made;
              })
            }
          >
            Import
          </Busy>
        </div>
      )}

      {bundle.length > 0 && (
        <div className="distribute">
          {/* The unit is in the eyebrow as well as beside the field. This box
              writes the Buy column, the Buy column is in the launch's quote
              asset, and on a paired launch that is not ETH — the whole defect
              being fixed here was a number whose unit had to be inferred. */}
          <b className="distribute-title">Auto-fill buys{pair ? ` · in ${pair.symbol}` : ''}</b>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            Total buy
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.5"
              value={totalBuy}
              // WHY THE TOTAL IS IN THE PAIR TOKEN, NOT ETH CONVERTED AT THE
              // QUOTE. The alternative — an ETH total converted to pair amounts
              // at the live rate — was rejected for three reasons. (1) The Buy
              // column IS the pair token: it is the number prepareV2 parses and
              // then demands the wallet hold, so a pair-token total is the only
              // one whose exact-sum guarantee is a guarantee about anything the
              // launch reads. Converting would make the typed number equal to no
              // number in the table. (2) The rate moves between the conversion
              // and the launch, so an "ETH total" would silently stop being that
              // total the moment it was typed — a second unit ambiguity dressed
              // as a convenience, and this control's bug was a unit ambiguity.
              // (3) The ETH question is still answered, and answered better:
              // priced per wallet by the swap endpoint below and stated as its
              // own figure. So the operator types what the bundle BUYS and reads
              // what it COSTS, with neither pretending to be the other.
              title={
                pair
                  ? `the total in ${pair.symbol} — the asset every bundle buy is denominated in on this ` +
                    'launch. The ETH each wallet needs is priced against the live pool and written to Fund.'
                  : undefined
              }
              onChange={(e) => {
                setTotalBuy(e.target.value);
                // The last fill priced a different total. It is no longer an
                // account of anything on screen.
                setFill(null);
              }}
              style={{ width: 90 }}
            />
            {buyUnit}
          </label>
          {/* Deliberately NOT the amber default: amber in this console means a
              spend, and this only writes fields. Ghost, like Generate/Import. */}
          <Busy
            className="ghost"
            busy={busy === 'auto-fill'}
            disabled={!(Number(totalBuy) > 0)}
            onClick={distribute}
          >
            Distribute across {bundle.length} wallet{bundle.length === 1 ? '' : 's'}
          </Busy>
          <span className="hint">
            {pair ? (
              <>
                random split in {pair.symbol} · each Fund is the ETH to swap for its {pair.symbol} + gas ·
                fields stay editable · moves no ETH
              </>
            ) : (
              <>
                random split · each funded for its buy + gas for {SELL_RESERVE} sells · fields stay
                editable · moves no ETH
              </>
            )}
          </span>
          {fundNeeded > 0 && (
            <div className="distribute-fund">
              Dev wallet needs ≈ <b>{fundNeeded.toFixed(4)} ETH</b> to fund all {bundle.length} buys
              <span className="hint">
                {' '}
                ({Number(totalBuy).toFixed(4)} buys + {(bundle.length * reservePerWallet).toFixed(4)} gas
                reserve) — your dev buy and the launch fee are on top. Underfunded wallets are skipped.
              </span>
            </div>
          )}

          {/* THE PAIRED READOUT. The same slot, the same class, and deliberately
              not a second box: this is still the auto-fill's own figure. What it
              may never be is the native line with a pair symbol swapped in — that
              line adds the typed total to a gas figure, and here the typed total
              is NVDA. So it states nothing until Distribute has priced the ETH,
              and then states what the pricing found, including what it could not
              price. */}
          {pair && Number(totalBuy) > 0 && (
            <div className="distribute-fund">
              {!fill ? (
                <span className="hint">
                  Buy is in {pair.symbol}; Fund is always ETH. Distribute prices that ETH per wallet
                  against the live {pair.symbol} pool — it is not this total converted, and no{' '}
                  {pair.symbol} figure is ever written into an ETH field.
                </span>
              ) : fill.priced === 0 ? (
                // No <b> here on purpose: .distribute-fund b is amber, amber is
                // this panel's money colour, and "nothing could be priced" is the
                // absence of a figure rather than one.
                <>
                  Fund column left blank — the ETH could not be priced
                  <span className="hint">
                    {' '}
                    {fill.error || `no wallet could be priced against the ${pair.symbol} pool`}. The Buy
                    column is filled, in {pair.symbol}. Type the Fund amounts, or fix the pair and run
                    this again — a wrong ETH figure was not written.
                  </span>
                </>
              ) : (
                <>
                  Dev wallet needs ≈ <b>{fill.ethTotal.toFixed(4)} ETH</b> to fund{' '}
                  {fill.priced === bundle.length ? `all ${bundle.length}` : `${fill.priced} of ${bundle.length}`}{' '}
                  wallets
                  <span className="hint">
                    {' '}
                    ({fill.total} {fill.unit} of buys, priced against the live pool, plus the gas each
                    wallet keeps for the swap, the launch's approve + buy and {SELL_RESERVE} sells) — your
                    dev buy and the launch fee are on top.
                    {fill.unpriced > 0 &&
                      ` ${fill.unpriced} wallet${fill.unpriced === 1 ? '' : 's'} could not be priced — ` +
                        `${fill.unpriced === 1 ? 'its Fund was' : 'their Funds were'} left blank.`}
                  </span>
                </>
              )}
            </div>
          )}

          {/* ── THE CONVERTER ──────────────────────────────────────────────────
              A calculator, not a second denomination. It carries NO money colour
              — this panel spends its single amber on the stripe around this whole
              box, and a converter moves nothing — so it is a hairline sub-row in
              grey with the figures at --ink.

              Every number in here states its unit next to itself, and the two
              units never meet in one sum: the left half asks what the pair-token
              total costs in ETH, the right half asks what an ETH figure buys in
              the pair token, and each is answered by a server-side quote against
              the live pool rather than by dividing one of these fields by a rate.

              The ETH box is a SEPARATE field on purpose. The Total buy field
              above is the pair token, always, and it is the only thing Distribute
              reads — so a converted figure can only become a written one by being
              taken into that field, visibly, by hand. */}
          {pair && (
            <div className="convert">
              <span className="convert-eyebrow">
                Converter · reads the live pool · writes nothing
              </span>

              {/* THE QUOTE STATES ITS OWN INPUT, NOT THE FIELD'S CURRENT VALUE.
                  The read is debounced, so between a keystroke and the answer the
                  field says one number and the last quote priced another —
                  printing the field's value beside the old quote's answer would
                  put a sentence on screen that was never true of anything. So the
                  line is drawn only while the quote is about what is typed; the
                  moment they diverge it says it is re-pricing. */}
              <span className="convert-line">
                {Number(totalBuy) > 0 ? (
                  rateErr ? (
                    <span className="hint">could not price this: {rateErr}</span>
                  ) : rate?.ethCost && Number(rate.pairIn) === Number(totalBuy) ? (
                    <>
                      {Number(rate.pairIn)} {pair.symbol} costs ≈{' '}
                      <b>{Number(rate.ethCost).toFixed(6)} ETH</b> to buy
                      {rate.ethCostConverged === false && (
                        <span className="hint">
                          {' '}
                          — and that is a FLOOR, not a price: the pool is too thin to quote this size
                          properly
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="hint">
                      pricing {totalBuy} {pair.symbol} against the live pool…
                    </span>
                  )
                ) : (
                  <span className="hint">
                    type a {pair.symbol} total above to see what it costs in ETH
                  </span>
                )}
              </span>

              <label className="convert-field">
                or I have
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.5"
                  value={ethTotal}
                  title={
                    `an ETH figure, converted to ${pair.symbol} at the live quote. It is NOT written ` +
                    'anywhere until you take it into the Total buy field above — that field, and the ' +
                    `Buy column it fills, are always ${pair.symbol}.`
                  }
                  onChange={(e) => setEthTotal(e.target.value)}
                  style={{ width: 90 }}
                />
                ETH
              </label>

              <span className="convert-line">
                {Number(ethTotal) > 0 ? (
                  rateErr ? (
                    <span className="hint">could not price this: {rateErr}</span>
                  ) : rate?.pairOut && Number(rate.ethIn) === Number(ethTotal) ? (
                    <>
                      buys ≈{' '}
                      <b>
                        {Number(rate.pairOut).toFixed(6)} {pair.symbol}
                      </b>
                      {/* The ONE path from a quote to a field, and it is a press. */}
                      <button
                        type="button"
                        className="quiet"
                        onClick={takeConverted}
                        title={`put ${Number(rate.pairOut).toFixed(6)} ${pair.symbol} into the Total buy field`}
                      >
                        use as total
                      </button>
                    </>
                  ) : (
                    <span className="hint">pricing {ethTotal} ETH against the live pool…</span>
                  )
                ) : (
                  <span className="hint">…and see what it buys</span>
                )}
              </span>

              {/* A rate is a quote and it moves. Said plainly, with the moment it
                  was taken, so no figure above can be mistaken for a fact. */}
              <span className="convert-note hint">
                {rate?.quotedAt
                  ? `live quote, taken ${new Date(rate.quotedAt).toLocaleTimeString()} — it moves. ` +
                    'Neither figure is written anywhere; the Buy column stays in ' +
                    `${pair.symbol}, and the ETH each wallet needs is priced per wallet below.`
                  : 'both figures are quotes against the live pool and move with it. The Buy column ' +
                    `is always ${pair.symbol}; the ETH is only ever a conversion.`}
              </span>
            </div>
          )}

          {/* ── FILL FROM WHAT THE WALLETS ALREADY HOLD ─────────────────────────
              The third auto-fill mode, and the one that matches how a bundle is
              actually funded: the ETH is already sitting in the wallets, so the
              question is not "pick a total" but "spend what is there, keep the
              gas, and let the result be the Buy amount".

              Two presses, on purpose. The first only PRICES — it shows the ETH it
              would put to work, the pair token that yields and every wallet it is
              skipping — and the second writes the fields. Neither sends anything.
              Both are .ghost: this box's one amber object is its own stripe, and
              writing a field is not a spend. */}
          {pair && bundle.length > 0 && (
            <div className="convert from-balance">
              <span className="convert-eyebrow">Or fill from the ETH the wallets already hold</span>
              <Busy className="ghost" busy={busy === 'from-balance'} onClick={priceFromBalance}>
                Use available ETH
              </Busy>
              <span className="hint">
                each wallet spends its OWN ETH, keeping back gas for the swap, the launch's approve +
                buy and {SELL_RESERVE} sells · prices only — nothing is written until you say so
              </span>

              {balErr && <span className="convert-note hint">could not price this: {balErr}</span>}

              {balPlan && (
                <div className="from-balance-plan">
                  <div className="from-balance-head">
                    Would put at most <b>{Number(balPlan.totalSwapEth).toFixed(6)} ETH</b> to work
                    across {balPlan.usable} of {balPlan.count} wallet
                    {balPlan.count === 1 ? '' : 's'}, buying ≈{' '}
                    <b>
                      {Number(balPlan.totalBuyPair).toFixed(6)} {balPlan.pairSymbol}
                    </b>
                  </div>
                  {/* Two totals, two assets, never one sum. The ETH figure is a
                      CEILING: the funding swap re-sizes its own input from the
                      smaller Buy amounts and so spends less than this. */}
                  <span className="hint">
                    at most, because each swap is re-sized from its own Buy amount · each wallet keeps{' '}
                    {Number(balPlan.reserveEth).toFixed(6)} ETH back (
                    {Number(balPlan.gasReserveEth).toFixed(6)} for the swap and the launch's approve +
                    buy, {Number(balPlan.sellReserveEth).toFixed(6)} for {balPlan.sells} sells) · each
                    Buy amount is the live quote less {balPlan.overshootBps / 100}%, so it is one the
                    wallet can actually satisfy
                    {balPlan.skippedNoEth > 0 &&
                      ` · ${balPlan.skippedNoEth} skipped, not enough ETH for the gas reserve`}
                    {balPlan.skippedImpact > 0 &&
                      ` · ${balPlan.skippedImpact} refused, the pool is too thin for that size`}
                    {balPlan.skippedDust > 0 &&
                      ` · ${balPlan.skippedDust} skipped, what their ETH buys rounds to nothing`}
                    {balPlan.failed > 0 && ` · ${balPlan.failed} could not be priced`}
                  </span>

                  {/* The skipped wallets BY NAME. A wallet silently left out is
                      the failure this whole feature exists to end. */}
                  {balPlan.results.some((r) => r.status !== 'ok') && (
                    <ul className="from-balance-skips">
                      {balPlan.results
                        .filter((r) => r.status !== 'ok')
                        .slice(0, 8)
                        .map((r) => (
                          <li key={r.walletId}>
                            <code>
                              {r.address.slice(0, 6)}…{r.address.slice(-4)}
                            </code>{' '}
                            {r.status}
                            {r.reason ? ` — ${r.reason}` : ''}
                          </li>
                        ))}
                      {balPlan.results.filter((r) => r.status !== 'ok').length > 8 && (
                        <li>
                          …and {balPlan.results.filter((r) => r.status !== 'ok').length - 8} more, all
                          in the readout once you fill.
                        </li>
                      )}
                    </ul>
                  )}

                  <div className="row">
                    <Busy
                      className="ghost"
                      busy={false}
                      disabled={balPlan.usable === 0}
                      title={
                        balPlan.usable === 0
                          ? 'no wallet has ETH to spare after gas'
                          : `write ${balPlan.usable} Buy amount(s) — no ETH moves`
                      }
                      onClick={applyBalancePlan}
                    >
                      Write {balPlan.usable} Buy amount{balPlan.usable === 1 ? '' : 's'}
                    </Busy>
                    <button type="button" className="link" onClick={() => setBalPlan(null)}>
                      discard
                    </button>
                    <span className="hint">
                      priced {new Date(balPlan.quotedAt).toLocaleTimeString()} · balances and quotes
                      move — price again if this has been sitting
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* PAIR FUNDING — only on a paired launch, and only when there are wallets to
          fund. On a native launch `pair` is null and this whole block is absent, which
          is why nothing here has to reason about ETH-quoted curves.

          Deliberately NOT a second amber box. The step's one amber object is the
          auto-fill stripe above; the money signal for this control belongs on the
          action, and the action is a .ghost because a dialog stands behind it. */}
      {pair && bundle.length > 0 && (
        <div className="pair-fund">
          <b className="pair-fund-title">Pair funding · {pair.symbol}</b>
          <span>
            {pairTargets.length} wallet{pairTargets.length === 1 ? '' : 's'} need{' '}
            <b>
              {pairTotal.toFixed(6)} {pair.symbol}
            </b>
          </span>
          <Busy
            className="ghost"
            busy={busy === 'pair-swap'}
            disabled={busy === 'pair-swap' || !pairPlan || pairPlan.wouldSwap === 0}
            onClick={() => setPairAsk({ ...pairPlan, targets: JSON.parse(pairKey) })}
          >
            Buy {pair.symbol} for {pairPlan ? pairPlan.wouldSwap : pairTargets.length} wallet
            {(pairPlan ? pairPlan.wouldSwap : pairTargets.length) === 1 ? '' : 's'}
          </Busy>
          {/* WHERE THIS SITS IN THE ORDER, because it is the one control on the
              page that runs AFTER a step below it. Each wallet buys its own
              {pair.symbol} with its OWN ETH, so it has to be funded first — and
              the funding step is the next one down. Saying so is the whole fix:
              nothing here moved, it just stopped being a trip the operator had
              to work out for themselves. */}
          <span className="hint">
            each wallet buys its own {pair.symbol} with its own ETH · run this AFTER step{' '}
            {nums.fund ?? 4} has funded them with ETH, and BEFORE arming the launch in step{' '}
            {nums.launch ?? 5}
          </span>

          {/* THE PRICE. A spend is never offered without its size: this is the real
              endpoint's own dry run, so the number is produced by the code that will
              spend it, and its skips are the skips the real run will make. */}
          <div className="pair-fund-cost">
            {pairTargets.length === 0 ? (
              <span className="hint">
                No bundle wallet has a Buy amount yet — type one (or use Auto-fill above). On a
                paired launch that column is in {pair.symbol}, not ETH.
              </span>
            ) : pairErr ? (
              <span className="hint">could not price this: {pairErr}</span>
            ) : !pairPlan ? (
              <span className="hint">pricing {pairTargets.length} wallet(s) against the live pool…</span>
            ) : (
              <>
                Spends ≈ <b>{Number(pairPlan.totalEth).toFixed(6)} ETH</b> to buy {pairPlan.wouldSwap}{' '}
                wallet{pairPlan.wouldSwap === 1 ? '' : 's'} their {pair.symbol}
                <span className="hint">
                  {pairPlan.skippedAlreadyFunded > 0 && ` · ${pairPlan.skippedAlreadyFunded} already funded`}
                  {pairPlan.skippedShort > 0 && ` · ${pairPlan.skippedShort} short of ETH`}
                  {pairPlan.skippedImpact > 0 &&
                    ` · ${pairPlan.skippedImpact} refused, the pool is too thin for that size`}
                  {pairPlan.failed > 0 && ` · ${pairPlan.failed} could not be priced`}
                  {pairAllMode > 0 &&
                    ` · ${pairAllMode} on "all − gas" are not funded here: that mode spends whatever ` +
                      `${pair.symbol} balance a wallet has, so there is no amount to buy`}
                </span>
              </>
            )}
          </div>

          {/* What the last real run actually did, per wallet — the console's own
              refusal instrument, the same one the delete run reports through. A run
              where some swapped, some were already funded and some were refused for
              gas must never be reduced to a single count. */}
          {pairOut && (
            <div
              // `danger`, not `warn`, exactly as the delete run's outcome above:
              // amber is this step's spending action and there is only one of it.
              className={`notice ${
                pairOut.swapped + pairOut.skippedAlreadyFunded === pairOut.count ? '' : 'danger'
              }`}
            >
              <h3>
                {pairOut.swapped} of {pairOut.count} swapped · {pairOut.totalEth} ETH spent
                {pairOut.skippedAlreadyFunded ? ` · ${pairOut.skippedAlreadyFunded} already funded` : ''}
              </h3>
              <ul>
                {pairOut.results
                  .filter((r) => r.status !== 'skipped-already-funded')
                  .map((r) => (
                    <li key={r.walletId}>
                      <code>
                        {r.address.slice(0, 6)}…{r.address.slice(-4)}
                      </code>{' '}
                      {r.status} — holds {r.holdingPair} {pairOut.pairSymbol} of {r.needPair}
                      {r.reason ? `. ${r.reason}` : ''}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* THE WAY BACK — the exact reverse of the box above, and the box above is why
          it exists: buying the pair token was a one-way door, so a changed quote
          asset, an abandoned launch or a bundle sized wrong left NVDA sitting in up
          to 31 wallets with no console path to the ETH inside it.

          IT IS DRAWN ONLY WHEN THERE IS SOMETHING TO RECOVER. Not "on a paired
          launch", not "when there are wallets" — only when a bundle wallet is
          actually HOLDING some of the pair token, which the column beside Balance
          already knows. A recovery control on an empty bundle is an invitation to
          press a spending button that would do nothing.

          Same tier as the funding trigger beside it: a .ghost button with a dialog
          standing behind it, because this spends real gas and sells a real position
          and the confirm belongs in the dialog. NOT a second amber object — this
          step's one amber is still the auto-fill stripe, and this box reuses the
          same .pair-fund classes as the funding one, which carry no money colour. */}
      {/* `|| backOut` is not decoration. A run that empties every wallet also empties
          `recover.targets`, so without it the box — and the per-wallet account of what
          just happened — would unmount at the exact moment it is most needed, leaving
          a completed spend reported only in the readout a page below. A run stays on
          screen until the operator navigates away from it. */}
      {pair && (recover.targets.length > 0 || backOut) && (
        <div className="pair-fund">
          <b className="pair-fund-title">Recover ETH · sell {pair.symbol} back</b>
          {recover.targets.length === 0 ? (
            <span className="hint">
              No bundle wallet holds {pair.symbol} any more — what the last run did is below.
            </span>
          ) : (
            <>
            <span>
              {recover.targets.length} wallet{recover.targets.length === 1 ? '' : 's'} hold{' '}
              <b>
                {Number(recover.total).toFixed(6)} {pair.symbol}
              </b>
            </span>
            <Busy
              className="ghost"
              busy={busy === 'pair-sell'}
              disabled={busy === 'pair-sell' || !backPlan || backPlan.wouldSwap === 0}
              onClick={() => setBackAsk({ ...backPlan, targets: recoverTargetsSent() })}
            >
              Sell {pair.symbol} from {backPlan ? backPlan.wouldSwap : recover.targets.length} wallet
              {(backPlan ? backPlan.wouldSwap : recover.targets.length) === 1 ? '' : 's'}
            </Busy>
            {/* THE WAY OUT OF A CHANGED MIND, named as such. This is the
                recovery the quote-asset station points at: change what the
                launch is priced in and whatever the wallets already bought stays
                with them, and this is what turns it back into ETH. It has to be
                run while the launch is still priced in that asset — the listing
                carries one quote asset's balances at a time. */}
            <span className="hint">
              each wallet sells its WHOLE {pair.symbol} balance and keeps the ETH · run this before
              arming a launch, never against one already armed · this is also the way back if you
              change the quote asset in step {nums.quote ?? 1} — sell first, while the launch is
              still priced in {pair.symbol}
            </span>

            {/* THE PROCEEDS. A sale is never offered without what it returns: this is the
                real endpoint's own dry run, so the figure is produced by the code that
                will sell it, and its refusals are the refusals the real run will make. */}
            <div className="pair-fund-cost">
              {backErr ? (
                <span className="hint">could not price this: {backErr}</span>
              ) : !backPlan ? (
                <span className="hint">
                  pricing {recover.targets.length} wallet(s) against the live pool…
                </span>
              ) : backPlan.wouldSwap === 0 ? (
                // No <b> here on purpose: .pair-fund-cost b is the headline figure, and
                // "nothing can be sold" is the absence of one rather than one.
                <>
                  Nothing can be sold right now
                  <span className="hint">
                    {backPlan.skippedImpact > 0 &&
                      ` · ${backPlan.skippedImpact} refused, the pool is too thin for that size`}
                    {backPlan.skippedDust > 0 &&
                      ` · ${backPlan.skippedDust} hold dust worth less than the gas to sell it`}
                    {backPlan.skippedShort > 0 && ` · ${backPlan.skippedShort} short of gas for the sale`}
                    {backPlan.skippedEmpty > 0 && ` · ${backPlan.skippedEmpty} hold none`}
                    {backPlan.failed > 0 && ` · ${backPlan.failed} could not be priced`}
                    {' · '}nothing was sent.
                  </span>
                </>
              ) : (
                <>
                  Sells{' '}
                  <b>
                    {Number(backPlan.totalPairSold).toFixed(6)} {pair.symbol}
                  </b>{' '}
                  for ≈ <b>{Number(backPlan.totalQuotedEth).toFixed(6)} ETH</b> back into{' '}
                  {backPlan.wouldSwap} wallet{backPlan.wouldSwap === 1 ? '' : 's'}
                  <span className="hint">
                    {' '}
                    — a live quote, floored at {(backPlan.overshootBps / 100).toFixed(1)}% below it, so a
                    worse fill reverts with the {pair.symbol} intact
                    {backPlan.skippedImpact > 0 &&
                      ` · ${backPlan.skippedImpact} refused, the pool is too thin for that size`}
                    {backPlan.skippedDust > 0 &&
                      ` · ${backPlan.skippedDust} hold dust worth less than the gas to sell it`}
                    {backPlan.skippedShort > 0 && ` · ${backPlan.skippedShort} short of gas for the sale`}
                    {backPlan.failed > 0 && ` · ${backPlan.failed} could not be priced`}
                    {recover.unknown > 0 &&
                      ` · ${recover.unknown} wallet(s) have no ${pair.symbol} balance read yet and are not ` +
                        'included — refresh balances'}
                  </span>
                </>
              )}
            </div>
            </>
          )}

          {/* What the last real sale actually did, per wallet — the same refusal
              instrument the funding run and the delete run report through. */}
          {backOut && (
            <div className={`notice ${backOut.swapped === backOut.count ? '' : 'danger'}`}>
              <h3>
                {backOut.swapped} of {backOut.count} sold · {backOut.totalPairSold} {backOut.pairSymbol}{' '}
                for {backOut.totalEthOut} ETH
              </h3>
              <ul>
                {backOut.results.map((r) => (
                  <li key={r.walletId}>
                    <code>
                      {r.address.slice(0, 6)}…{r.address.slice(-4)}
                    </code>{' '}
                    {r.status} — sold {r.soldPair ?? '0'} {backOut.pairSymbol}
                    {r.receivedEth ? ` for ${r.receivedEth} ETH` : ''}, still holds {r.holdingPair}
                    {r.reason ? `. ${r.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="table-scroll">
        <table className="wallet-list">
          <thead>
            <tr>
              <th>
                {/* Selects the bundle wallets and only ever the bundle wallets;
                    the dev wallet is not in this list at all. */}
                <input
                  ref={allBox}
                  type="checkbox"
                  checked={allPicked}
                  disabled={!bundle.length || busy === 'delete'}
                  title="select every bundle wallet"
                  onChange={(e) =>
                    setPicked(e.target.checked ? new Set(bundle.map((b) => b.id)) : new Set())
                  }
                />
              </th>
              <th>Role</th>
              <th>Address</th>
              {/* "(ETH)" ONLY when there is a second balance beside it. On a
                  native launch this header is the word it has always been and
                  the table is the table it has always been — there is one
                  balance and no ambiguity to resolve. On a paired launch there
                  are two, in two assets, and an unlabelled one next to a labelled
                  one is exactly the unit ambiguity this whole area was fixed
                  for. */}
              <th>{pair ? 'Balance (ETH)' : 'Balance'}</th>
              {/* THE PAIR COLUMN. Present only on a paired launch, headed with
                  the token's own symbol, and it is what each wallet actually
                  HOLDS of the asset its buy is denominated in — the state that
                  decides whether preflight keeps the wallet or drops it. */}
              {pair && (
                <th
                  title={
                    `what each wallet holds of ${pair.symbol}, the asset every buy on this launch is ` +
                    'denominated in. A wallet holding less than its Buy amount is skipped by preflight.'
                  }
                >
                  {pair.symbol}
                </th>
              )}
              <th>Fund (ETH)</th>
              <th>Buy mode</th>
              {/* NOT "(ETH)". On a paired launch every bundle buy is denominated in the PAIR
                  token, and this panel has no way to know which one — the pair is chosen in
                  step 5. Naming a unit here was wrong half the time, so it names none. The
                  Fund column keeps (ETH) because that really is ETH: gas, whatever the pair. */}
              <th>Buy amount</th>
              {/* Not "Est. share": on v2 it is not an estimate. The ~ on each
                  figure is what says which one this is. */}
              <th>Supply share</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={pair ? 10 : 9} className="empty">
                  No wallets yet. Generate the bundle wallets above — the dev wallet from step 1
                  appears here too.
                </td>
              </tr>
            )}
            {visible.map((w) => {
              const row = rows[w.id] || {};
              const isDev = w.role === roles.dev;
              const bal = Number(w.balanceEth);
              return (
                <tr key={w.id}>
                  <td>
                    {/* No checkbox on the dev wallet — not a disabled one, none.
                        It signs the launch and holds the funds, and the bulk
                        delete must have no path to it, accidental or otherwise. */}
                    {w.role === roles.bundle && (
                      <input
                        type="checkbox"
                        checked={picked.has(w.id)}
                        disabled={busy === 'delete'}
                        title="select for bulk delete"
                        onChange={(e) => tick(w.id, e.target.checked)}
                      />
                    )}
                  </td>
                  <td>
                    <span className={`role ${w.role}`}>{w.role}</span>
                  </td>
                  {/* Shortened, with the full address on hover and on the copy
                      button beside it. This column was 326px of unbreakable hex
                      — a third of the table, and the reason the delete column
                      was painted outside the card. The row's × still opens a
                      dialog that states the whole address, and the delete is
                      keyed by w.id, so nothing here is decided from the
                      shortened text. */}
                  <td className="addr">
                    <Address value={w.address} />
                  </td>
                  <td>
                    <span className={`bal ${bal === 0 ? 'zero' : ''}`}>{bal.toFixed(6)}</span>
                  </td>
                  {/* WHAT THIS WALLET HOLDS OF THE PAIR TOKEN, against what its
                      own Buy amount will demand of it.

                      The comparison is a subtraction in ONE asset — both sides
                      are the pair token — done as scaled integers in
                      pairBalance.js, because "short" is the state that makes
                      preflight drop the wallet and it must not be a float
                      rounding artefact.

                      The colours are the two the law allows here. Jade for a
                      wallet that ALREADY holds what it needs: past tense, already
                      true, nothing to do. Vermilion for short, which is the same
                      vermilion the Fund column's shortfall uses and means the
                      same thing — this row is one preflight will skip. Neither is
                      a money colour: this column moves nothing, and the panel's
                      one amber object is still the auto-fill stripe.

                      A balance that was not READ is a dash, never a zero. Zero is
                      a claim, and the claim would be that a funded wallet is
                      empty. */}
                  {pair && (
                    <td>
                      {(() => {
                        const held = w.pairBalance;
                        // The dev buy is set in step 5, not in this table, so the
                        // dev row has no requirement here to be measured against —
                        // its holding is shown as the plain fact it is. A row on
                        // "all − gas" names no amount either: that mode is
                        // resolved server-side from the live balance.
                        const need = isDev || row.mode === 'all' ? null : row.buy;
                        const state = pairStatus(held, need);
                        if (state === 'unknown') {
                          return (
                            <span
                              className="bal zero"
                              title={
                                `not read — the listing carries a ${pair.symbol} balance only once the ` +
                                'launch is paired and the factory confirms the token. Refresh balances.'
                              }
                            >
                              —
                            </span>
                          );
                        }
                        const shown = Number(held).toFixed(6);
                        if (state === 'short') {
                          const gap = pairShortfall(held, need);
                          return (
                            <span
                              className="bal short"
                              title={
                                `holds ${held} ${pair.symbol}, its buy needs ${row.buy} ${pair.symbol} — ` +
                                `${gap} short. Preflight skips this wallet. Buy ${pair.symbol} for it above.`
                              }
                            >
                              {shown}
                              <span className="gap">
                                short {Number(gap).toFixed(6)}
                              </span>
                            </span>
                          );
                        }
                        if (state === 'ok') {
                          return (
                            <span
                              className="bal has"
                              title={`holds ${held} ${pair.symbol}; its buy needs ${row.buy} — funded`}
                            >
                              {shown}
                            </span>
                          );
                        }
                        return (
                          <span
                            className={`bal ${Number(held) === 0 ? 'zero' : ''}`}
                            title={
                              isDev
                                ? `holds ${held} ${pair.symbol} — the dev buy is sized in step 5`
                                : `holds ${held} ${pair.symbol}; no Buy amount is set for this wallet yet`
                            }
                          >
                            {shown}
                          </span>
                        );
                      })()}
                    </td>
                  )}
                  <td>
                    {!isDev && (
                      <input
                        type="number"
                        step="0.0001"
                        placeholder="0.0"
                        value={row.fund ?? ''}
                        onChange={(e) => setRow(w.id, { fund: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {!isDev && (
                      <select
                        value={row.mode ?? 'fixed'}
                        onChange={(e) => setRow(w.id, { mode: e.target.value })}
                      >
                        <option value="fixed">fixed</option>
                        <option value="all">all − gas</option>
                      </select>
                    )}
                  </td>
                  <td>
                    {!isDev && (
                      <input
                        type="number"
                        step="0.0001"
                        placeholder="0.0"
                        // "all − gas" is resolved server-side from the live
                        // balance, so an amount here would be meaningless.
                        disabled={row.mode === 'all'}
                        value={row.mode === 'all' ? '' : row.buy ?? ''}
                        onChange={(e) => setRow(w.id, { buy: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    {/* The dev row shows the dev buy, which is not typed here at
                        all — it is set in step 5 and it executes FIRST, inside
                        the launch transaction. On a curve that matters: it moves
                        the price every bundle wallet then pays. */}
                    {isDev ? (
                      <Share
                        leg={share?.dev}
                        exact={share?.exact}
                        title={`the dev buy, made inside the launch itself and before every bundle buy — ≈${tokens(
                          share?.dev?.estTokens
                        )} tokens`}
                      />
                    ) : (
                      <Share leg={legs.get(w.id)} exact={share?.exact} />
                    )}
                    {/* The market cap this row's buy walks the curve to, landing
                        in order behind the dev buy. Updates as the amount is
                        typed. */}
                    {(() => {
                      // In the LAUNCH'S QUOTE ASSET — the curve is walked in it,
                      // so the cap comes out in it. The dollars are that figure
                      // taken to ETH at the live rate and no other way; with no
                      // rate there are simply no dollars, and the line under the
                      // table says why.
                      const mcQuote = isDev ? share?.dev?.mcEth : legs.get(w.id)?.mcEth;
                      if (!(Number(mcQuote) > 0)) return null;
                      const dollars = usdMc(toEth(mcQuote), ethPrice);
                      return (
                        <div
                          className="mc-row hint"
                          title={`predicted market cap after this buy — ${mcQuote} ${unit}`}
                        >
                          MC {dollars ? `${dollars} · ` : ''}
                          {Number(mcQuote).toFixed(3)} {unit}
                        </div>
                      );
                    })()}
                  </td>
                  <td>
                    <Busy
                      busy={now === w.id}
                      className="ghost"
                      disabled={busy === 'delete'}
                      title="delete this wallet"
                      onClick={() => setDeleting([w])}
                    >
                      ×
                    </Busy>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The bundle total, next to the amounts that make it, and honest about
          how much it can be trusted. This is the question the operator has been
          answering by launching and looking afterwards. */}
      {/* NO SHARE, AND WHY. A paired launch whose pairTokenEconomics never
          reached the console cannot be priced at all: the launch config's own
          constants are the NATIVE curve and using them is not an approximation,
          it is a different launch — 61.20% where the truth was 14.95%. So the
          share column, the per-row caps and this whole box are absent, and the
          absence is explained rather than left looking like a bundle of nothing.
          A plain notice: grey rule, grey body, no <b>. The one amber in this
          panel is the Distribute stripe and it stays the only one. */}
      {!share && shareBlocked && (
        <div className="notice">
          <h3>
            <span>no supply share for this pair</span>
          </h3>
          <ul>
            <li>{shareBlocked}</li>
            <li>
              A wrong figure here is worse than an absent one: it is what the whole table is
              sized against, and it does not look wrong.
            </li>
          </ul>
        </div>
      )}

      {share && (share.bundle.bps > 0 || share.dev) && (
        <div className={`notice ${share.over.length || share.graduation?.crosses ? 'danger' : ''}`}>
          {/* The figure the whole run is sized against, and until now one
              silkscreen label among the several in this box. It is given size
              and weight rather than a colour: every colour in this console
              names a state, and "this is the one that decides the launch" is
              not a state. The dev buy stays at label size beside it — it is
              context for this number, not a second headline.

              Wrapped in one span because this h3 is a flex row: an element
              child of it becomes a flex item, and the figure would be laid out
              beside the words rather than inside the sentence. */}
          <h3>
            <span>
              bundle takes{' '}
              <b className="tally">
                {share.exact ? '' : '≈'}
                {pct(share.bundle.bps)}
              </b>{' '}
              of supply
              {share.dev ? ` · dev buy ${share.exact ? '' : '≈'}${pct(share.dev.estBps)} first` : ''}
            </span>
            {/* The predicted market cap the whole bundle reaches — the figure
                the launch is really being sized for. Live: it moves with every
                amount typed above. Dollars for reading, ETH for the exact
                number the curve fixes. */}
            {share.marketCap && Number(share.marketCap.finalEth) > 0 && (
              <span className="mc-headline">
                predicted MC{' '}
                <b className="tally">
                  {usdMc(toEth(share.marketCap.finalEth), ethPrice) ||
                    `${Number(share.marketCap.finalEth).toFixed(3)} ${unit}`}
                </b>
                <span className="hint">
                  {Number(share.marketCap.finalEth).toFixed(3)} {unit} · opens{' '}
                  {usdMc(toEth(share.marketCap.openingEth), ethPrice) ||
                    `${Number(share.marketCap.openingEth).toFixed(3)} ${unit}`}
                </span>
              </span>
            )}
          </h3>

          {share.marketCap && (
            <label className="hint mc-price" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              1 ETH = $
              <input
                type="number"
                value={ethPrice}
                min="0"
                step="1"
                onChange={(e) => {
                  manualRef.current = true;
                  setEthPrice(e.target.value);
                }}
                style={{ width: 90 }}
              />
              {priceLive ? (
                manualRef.current && Number(ethPrice).toFixed(2) !== Number(priceLive.usd).toFixed(2) ? (
                  <button
                    type="button"
                    className="link"
                    title={`live ${priceLive.source}${priceLive.stale ? ' (stale)' : ''} price`}
                    onClick={() => {
                      manualRef.current = false;
                      setEthPrice(Number(priceLive.usd).toFixed(2));
                    }}
                  >
                    ↻ use live ${Number(priceLive.usd).toFixed(2)}
                  </button>
                ) : (
                  <span title={`from ${priceLive.source}, refreshes each minute`}>
                    {priceLive.stale ? 'last known' : 'live'} · {priceLive.source}
                  </span>
                )
              ) : (
                <span>— sets the dollar figures; the ETH figures are exact</span>
              )}
            </label>
          )}
          <ul>
            <li>
              {buyingCount} wallet{buyingCount === 1 ? '' : 's'} · {share.bundle.eth} {unit} · ≈
              {tokens(share.bundle.tokens)} tokens
              {share.dev
                ? ` · ${share.total.eth} ${unit} and ${share.exact ? '' : '≈'}${pct(
                    share.total.bps
                  )} counting the dev buy`
                : ''}
            </li>

            {/* The total is one figure and the rows are ranges, and the
                difference between those two is not a hedge — it is the only
                thing about a bundle that is genuinely unknown before it is
                fired. Say it once, here, rather than per row. */}
            <li>
              The total does not depend on the order they land in: the same ETH across more
              wallets buys the same tokens between them. What the order decides is the SPLIT, so
              each row is a range — landing first, behind only the dev buy, to landing last,
              behind the whole rest of the bundle. They are broadcast together and the sequencer
              picks.
            </li>

            {/* v1 and v2 are not equally knowable and the panel must not
                pretend otherwise. One is arithmetic, the other is the best
                reading available before a pool exists. */}
            {share.exact ? (
              <li>
                Exact — the curve is a constant product against the config's phantom reserve, both
                fixed before the launch is sent, and the dev buy is taken off it first.
              </li>
            ) : (
              <li>
                Estimate — there is no pool until the launch runs, so this walks the pool the
                config opens: the whole supply at its initial tick. The bundle's own price impact
                is in these figures; the pool's 1% fee is not, and a real v3 position is not quite
                a constant product, so they still read a little HIGH.
              </li>
            )}

            {/* WHICH CURVE THESE FIGURES ARE OFF. The launch config's phantom
                reserve and graduation threshold are the NATIVE ones; a paired
                launch runs on the factory's own economics for the quote asset,
                in that asset's units. Saying so is not decoration — this panel
                priced paired bundles against the native curve and reported
                61.20% of supply for a bundle that takes 14.95%, and the figure
                that was wrong looked exactly like the figure that is right. */}
            {!nativeQuote && share.marketCap && (
              <li>
                Priced against the {unit} curve the factory sets for this pair — it opens at{' '}
                {Number(share.marketCap.openingEth).toFixed(3)} {unit}
                {share.graduation
                  ? ` and graduates at ${Number(share.graduation.thresholdEth).toFixed(3)} ${unit}`
                  : ''}
                . NOT the launch config{'’'}s own phantom reserve and threshold, which are the
                native ETH ones: every approved pair has its own, and they span three orders of
                magnitude, so neither is an approximation of the other. Every {unit} figure above
                is the pair token; the Fund column is still ETH.
              </li>
            )}

            {/* THE DOLLAR FIGURES, AND WHEN THERE ARE NONE. A market cap in the
                pair token becomes dollars through a live ETH<->pair quote and no
                other way. Without one the caps stand — they are arithmetic — and
                the $ is simply absent, said here rather than left to look like a
                launch worth nothing. No <b>: .distribute-fund b is this panel's
                amber and an absent figure must not wear the money colour. */}
            {!nativeQuote && mcRate && (
              <li>
                Dollar figures convert {unit} to ETH at {mcRate.perEth.toFixed(6)} {unit} per ETH —
                a live quote taken{' '}
                {mcRate.quotedAt ? new Date(mcRate.quotedAt).toLocaleTimeString() : 'just now'} at a{' '}
                {MC_PROBE_ETH} ETH probe, refreshed each minute, and then multiplied by the ETH
                price above. It moves; the {unit} figures beside it do not.
              </li>
            )}
            {dollarsBlocked && (
              <li>
                No $ figures: the ETH to {unit} rate could not be quoted
                {mcRateErr ? ` (${mcRateErr})` : ''}, so the market cap is shown in {unit} only. The
                shares and caps above are unaffected — they are the curve{'’'}s own arithmetic
                and need no quote. Nothing here is converted at a guessed rate.
              </li>
            )}

            {allMode > 0 && (
              <li>
                {allMode} wallet{allMode === 1 ? '' : 's'} on “all − gas” — counted at the whole
                balance, because the amount is only resolved after gas at preflight.
              </li>
            )}

            {/* A buy over the launch-window cap does not clamp: it reverts,
                spends its gas and buys nothing. */}
            {share.over.length > 0 && (
              <li>
                {share.over.length} wallet{share.over.length === 1 ? '' : 's'} over the{' '}
                {share.caps.maxWalletBps / 100}% wallet cap or {share.caps.maxTxBps / 100}% per-buy
                cap — {share.over.length === 1 ? 'that buy REVERTS' : 'those buys REVERT'} inside the
                restriction window and{' '}
                {share.over.length === 1 ? 'wastes its gas' : 'waste their gas'}:{' '}
                {share.over
                  .slice(0, 4)
                  .map((id) => wallets.find((w) => w.id === id)?.address || id)
                  .join(', ')}
                {share.over.length > 4 ? ` …and ${share.over.length - 4} more` : ''}. Measured at
                the pool's opening price — above the range beside it, and the same yardstick
                preflight uses. A cap breach reverts, so this one errs early on purpose.
              </li>
            )}

            {share.graduation?.crosses && (
              <li>
                {share.graduation.raisedEth} {unit} into the curve reaches the{' '}
                {share.graduation.thresholdEth} {unit} graduation threshold — this bundle graduates the
                curve on the way in, and a graduated launch cannot be exited through the curve.
              </li>
            )}
          </ul>
        </div>
      )}

      {chosen.length > 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          <Busy busy={busy === 'delete'} className="danger" onClick={() => setDeleting(chosen)}>
            Delete {chosen.length} wallet{chosen.length === 1 ? '' : 's'}
          </Busy>
          <button
            className="link"
            disabled={busy === 'delete'}
            onClick={() => setPicked(new Set())}
          >
            clear selection
          </button>
          {/* The balance is on the bar as well as in the dialog: an operator
              who ticks a funded wallet should see it before the click, not
              only in the thing they are about to dismiss. */}
          <span className="hint">
            {eth(chosenEth)} ETH selected
            {chosenFunded.length > 0 &&
              ` · ${chosenFunded.length} of ${chosen.length} hold${
                chosenFunded.length === 1 ? 's' : ''
              } ETH — sweep first`}
          </span>
        </div>
      )}

      {/* The outcome of the last delete, in the panel that ran it. The Result
          panel has it too, but it is a page down and this action no longer
          scrolls there. */}
      {outcome && (
        <div className={`notice ${outcome.some((r) => !r.ok) ? 'danger' : ''}`}>
          <h3>
            {outcome.filter((r) => r.ok).length} of {outcome.length} deleted
            {outcome.some((r) => !r.ok) ? ` · ${outcome.filter((r) => !r.ok).length} failed` : ''}
          </h3>
          <ul>
            {outcome.every((r) => r.ok) && (
              <li>
                Out of the keystore, and their keys are in the archive on the server — if any of
                that was a mistake, <code>npm run archive:restore</code> there is the way back.
              </li>
            )}
            {outcome
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.id}>
                  {r.address} — {r.error}. Still in the keystore; try again.
                </li>
              ))}
          </ul>
        </div>
      )}

      {/* Still vermilion, though the keys survive in the archive. What this
          dialog warns about has not changed: funded wallets go out of reach of
          everything in this console until somebody deliberately puts them back,
          and twelve of them go at once. "A second click could undo it" is the
          test for dropping the colour, and the way back is now a shell command
          on the server — the opposite of a second click. One dialog for one
          wallet and for twelve. */}
      {/* The pair funding confirm. Vermilion when the console is live, exactly as the
          launch dialog is: this buys a token with real ETH from up to 31 wallets and
          there is no undo. One amber object in here — the confirm button — and no
          amber band, which is the defect this console keeps re-growing. */}
      <Modal
        open={Boolean(pairAsk)}
        danger={live}
        title={live ? `Buy ${pair?.symbol} with ${pairAsk?.totalEth} ETH?` : `Dry run: buy ${pair?.symbol}`}
        question={null}
        confirmLabel={live ? `Buy ${pair?.symbol} for ${pairAsk?.wouldSwap} wallet(s)` : 'Run (dry run)'}
        onConfirm={runPairSwap}
        onCancel={() => setPairAsk(null)}
      >
        <div className="modal-facts">
          <Fact label="Pair token" mono>
            {pair?.symbol} · {pair?.address}
          </Fact>
          <Fact label="Wallets">
            {pairAsk?.wouldSwap} of {pairAsk?.count} (the rest are already funded or refused)
          </Fact>
          <Fact label="Total to spend">{pairAsk?.totalEth} ETH</Fact>
          <Fact label="Each wallet buys">its own {pair?.symbol}, with its own ETH</Fact>
        </div>
        <p>
          Every wallet keeps enough ETH for the launch's own approve and buy. A wallet that cannot
          cover both is refused rather than part-funded, and every wallet is reported either way.
          Run this BEFORE arming the launch — arming signs against each wallet's current nonce.
        </p>
      </Modal>

      {/* The recovery confirm. Vermilion when the console is live, exactly as the
          funding dialog beside it: this sells a real position from up to 31 wallets at
          a public pool's price and there is no undo — the ETH comes back, but the
          tokens are gone at whatever the pool paid. One amber object in here, the
          confirm button, and no amber band. */}
      <Modal
        open={Boolean(backAsk)}
        danger={live}
        title={
          live
            ? `Sell ${Number(backAsk?.totalPairSold || 0).toFixed(6)} ${pair?.symbol} back to ETH?`
            : `Dry run: sell ${pair?.symbol} back`
        }
        question={null}
        confirmLabel={live ? `Sell from ${backAsk?.wouldSwap} wallet(s)` : 'Run (dry run)'}
        onConfirm={runPairSell}
        onCancel={() => setBackAsk(null)}
      >
        <div className="modal-facts">
          <Fact label="Pair token" mono>
            {pair?.symbol} · {pair?.address}
          </Fact>
          <Fact label="Wallets">
            {backAsk?.wouldSwap} of {backAsk?.count} (the rest hold none, hold dust, or were refused)
          </Fact>
          <Fact label="Total to sell">
            {backAsk?.totalPairSold} {pair?.symbol}
          </Fact>
          <Fact label="Expected back">≈ {backAsk?.totalQuotedEth} ETH, at the quote just taken</Fact>
          <Fact label="Each wallet keeps">its own proceeds — nothing is swept anywhere</Fact>
        </div>
        <p>
          Each sale is floored at {((backAsk?.overshootBps ?? 300) / 100).toFixed(1)}% below the live
          quote, so a worse fill reverts and that wallet keeps its {pair?.symbol} rather than dumping
          it. A wallet whose whole balance would move the pool too far is refused outright, and one
          holding less than the gas costs to sell is left alone. Every wallet is reported either way.
        </p>
        <p className="hint">
          The quote moves between this dialog and the block that mines it. Run this BEFORE arming a
          launch — each wallet spends two nonces here (an approve and the swap), and arming signs
          against the nonce it reads.
        </p>
      </Modal>

      <Modal
        open={pending.length > 0}
        danger
        title={one ? 'Delete this wallet?' : `Delete ${pending.length} bundle wallets?`}
        question={null}
        confirmLabel={`Delete ${pending.length} wallet${pending.length === 1 ? '' : 's'}`}
        onConfirm={() => {
          const list = pending;
          setDeleting(null);
          if (list.length) runDeletes(list);
        }}
        onCancel={() => setDeleting(null)}
      >
        <div className="modal-facts">
          {one ? (
            <>
              <Fact label="Address" mono>
                {one.address}
              </Fact>
              <Fact label="Role">{one.role}</Fact>
              <Fact label="Balance">{eth(one.balanceEth)} ETH</Fact>
            </>
          ) : (
            <>
              <Fact label="Wallets">{pending.length} bundle wallets</Fact>
              <Fact label="Total balance">{eth(pendingEth)} ETH</Fact>
              <Fact label="Holding ETH">
                {pendingFunded.length} of {pending.length}
              </Fact>
            </>
          )}
        </div>

        {/* Said plainly, because the alternative is a surprise in the wrong
            direction: an operator deleting an exposed key expects it gone, and
            it is not. It is archived — encrypted exactly as the keystore is,
            under the same passphrase.

            The archive is not on this console and not on the API at all, so
            this dialog cannot offer the way back; it names it instead. Pointing
            at an affordance that is not there would be worse than saying
            nothing. The cap is stated for the same reason the archiving is: the
            operator is owed the true version of what a delete does, and at 100
            deletions the oldest key is destroyed to make room. */}
        <p>
          {one ? 'The key is' : 'The keys are'} <b>archived, not destroyed</b>.{' '}
          {one ? 'This wallet leaves' : 'These wallets leave'} the keystore and{' '}
          {one ? 'its key moves' : 'their keys move'} to an archive beside it, encrypted the same
          way under the same passphrase. Nothing in this console can reach{' '}
          {one ? 'it' : 'them'}: restoring is <code>npm run archive:restore</code> on the server,
          and <code>npm run archive:purge</code> there is what erases a key for good.
        </p>
        <p className="hint">
          The archive keeps the last 100 deletions per user. Past that, each delete destroys the
          oldest archived key — the activity log records it by address.
        </p>

        {/* The balance is the part that is not merely inconvenient. An archived
            wallet is one nothing in this console can sign for — funding,
            launching and sell-all all read the live keystore — so the balance is
            out of reach until it is restored, and gone for good if it is purged.
            Sweep is one step below and takes seconds, so the dialog names it
            rather than leaving the operator to remember it after the fact. */}
        {pendingFunded.length > 0 && (
          <div className="notice danger">
            <h3>
              {pendingFunded.length === 1
                ? one
                  ? 'This wallet holds ETH'
                  : '1 of these wallets holds ETH'
                : `${pendingFunded.length} of these wallets hold ETH`}
            </h3>
            <ul>
              {/* Two words carry this dialog: how much, and that it stops being
                  spendable. Everything around them is procedure — where the ETH
                  does not go, what to run instead — and procedure read at the
                  same weight as the amount is how an operator confirms a funded
                  delete having seen only the shape of a warning. */}
              <li>
                <b className="crux">{eth(pendingEth)} ETH</b> becomes{' '}
                <b className="crux">unspendable</b> the moment{' '}
                {one ? 'this wallet is' : 'these wallets are'} archived, and stays that way until{' '}
                {one ? 'it is' : 'they are'} restored from the server. Purging the archived{' '}
                {one ? 'key' : 'keys'} there burns it permanently.
                {one?.role !== 'dev' && ' Deleting does not return it to the dev wallet.'}
              </li>
              {/* Sweep pulls funds INTO the dev wallet, so it is no answer for
                  the dev wallet itself — and that is the one row where the
                  balance is usually largest. */}
              {one?.role === roles.dev ? (
                <li>
                  This is the dev wallet. Sweep moves funds into it, not out, so nothing in this
                  console can rescue this balance — send it somewhere you control first.
                </li>
              ) : (
                <li>
                  Cancel, run <b>Sweep back to dev</b> in step 4, then delete — it empties{' '}
                  {one ? 'the wallet' : 'these wallets'} into the dev wallet first.
                </li>
              )}
              {!one &&
                pendingFunded.slice(0, 6).map((w) => (
                  <li key={w.id}>
                    {w.address} — {eth(w.balanceEth)} ETH
                  </li>
                ))}
              {!one && pendingFunded.length > 6 && (
                <li>…and {pendingFunded.length - 6} more with a balance.</li>
              )}
            </ul>
          </div>
        )}

        {/* The wallet list carries a native balance and nothing else, so this
            dialog can only ever speak for ETH. It says so rather than letting
            "0.000000 ETH" be read as "empty".

            Step 6 is only an answer for a BUNDLE wallet. findSellable is called
            with ks.bundleWallets(), filtered to role === 'bundle', so sell-all
            has never touched the dev wallet and never will — telling an operator
            about to delete it to "sell it in step 6 first" sent them to a panel
            that would list nothing of theirs. The dev row's × opens this same
            dialog, so the branch has to be here. */}
        {one?.role === roles.dev ? (
          <p className="hint">
            Token balances are not in this table and are not counted above. Step 6 sells what the
            bundle wallets hold and never touches this one — a launched token sitting here has to be
            moved out the same way as the ETH.
          </p>
        ) : (
          <p className="hint">
            Token balances are not in this table and are not counted above. If{' '}
            {one ? 'this wallet' : 'any of these'} still holds a launched token, sell it in step 6
            first.
          </p>
        )}
      </Modal>
    </Step>
  );
}
