import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyMotion, MotionConfig, domMax } from 'framer-motion';
import { LuRocket, LuArrowRightLeft, LuLink, LuClock, LuBanknote, LuRepeat, LuFlame, LuSend } from 'react-icons/lu';
import ThemeToggle from './ThemeToggle.jsx';
import { api, getApiKey, setApiKey } from './api.js';
import { shortAddress } from './format.js';
// The console and the backend's preflight run the SAME arithmetic, out of one
// file neither of them owns — see shared/bundleShare.js for why, and
// vite.config.js for how a CommonJS module gets into this bundle. Default
// import because that file is CommonJS: the backend requires it directly.
import bundleShareModule from '../../shared/bundleShare.js';
import { rolesFor } from './variant.js';
import { NATIVE_PAIR, isNativePair, pairOptions, selectedPair } from './pairAssets.js';
// Which curve a paired launch is priced against, and the one place a pair-token
// figure becomes an ETH one. See components/pairCurve.js.
import { shareInputs } from './components/pairCurve.js';
// The quote asset AS AN ORDER OF WORK: which stations this launcher has and in
// what order, the one line each of them states about what it needs, and what
// changing the quote asset after the wallets are into it would cost. Pure and
// tested beside itself — see components/quoteAsset.js.
import {
  stepOrder,
  stepNeed,
  pairHoldings,
  shortOfPair,
  ethShortfall,
  pairChangeImpact,
  strandedRecord,
  strandingCleared,
} from './components/quoteAsset.js';
import Modal, { Fact } from './components/Modal.jsx';
import Guide from './components/Guide.jsx';
import QuotePanel from './components/QuotePanel.jsx';
import Sequence from './components/Sequence.jsx';
import DevWalletPanel from './components/DevWalletPanel.jsx';
import WalletsPanel from './components/WalletsPanel.jsx';
import FundPanel from './components/FundPanel.jsx';
// The station between funding and launching, on a launch priced in something
// other than ETH: each bundle wallet buying its own quote asset with its own
// ETH, because nothing can SEND it that asset. Absent from the plan, and from
// the page, on a native launch.
import PairSwapPanel from './components/PairSwapPanel.jsx';
import DispersersPanel from './components/DispersersPanel.jsx';
import LaunchForm from './components/LaunchForm.jsx';
import ResultPanel from './components/ResultPanel.jsx';
import SellPanel from './components/SellPanel.jsx';
import HolderFeesPanel from './components/HolderFeesPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import BundlerV2Panel from './components/BundlerV2Panel.jsx';
import ExternalFundPanel from './components/ExternalFundPanel.jsx';
import Toaster from './components/Toaster.jsx';
// V3 renders its own console, out of its own directory, sharing no state with
// the tree below — see frontend/src/v3/V3Console.jsx. It is a branch here and
// nothing else: every prop, effect and step of the v1/v2 flow is untouched.
import V3Console from './v3/V3Console.jsx';
import V4Console from './v4/V4Console.jsx';
import V5Console from './v5/V5Console.jsx';
// V6 is V3's relay chain re-pointed at letscash V4 pools — its own console, its
// own directory, sharing no state with any tab. Same branch-not-blend rule as V3.
import V6Console from './v6/V6Console.jsx';
// V7 is V6's relay chain re-pointed at flap.sh bonding curves (non-graduated,
// native-quoted flap tokens) — its own console, its own directory, sharing no
// state with any tab. Same branch-not-blend rule as V3/V6.
import V7Console from './v7/V7Console.jsx';
// V8 is not a launcher at all — no launch, no token, no buy, no sell. It moves
// ETH from one source wallet out to many through Relay and sweeps it back. Its
// own console, its own directory, sharing no state with any tab.
import V8Console from './v8/V8Console.jsx';

const { bundleShare, pairedLaunchConfig, hasPairEconomics } = bundleShareModule;

// One definition of the shortener, in format.js, so there is one place to look
// when asking where an address is ever displayed less than whole. The sequence
// chips take the tighter 8+4 they have always used: they are a status line, and
// the address in them is a label for a wallet, not a value to check.
const short = (a) => shortAddress(a, 8, 4);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

// The current tab's name for the top bar. Presentation only: a lookup keyed by
// the same `tab` state the sidebar switches, rendering a label and nothing else.
// It is the tab buttons' own text, lifted out so the frame can title the page
// without re-deriving it.
const TAB_TITLE = {
  v1: 'Launcher',
  v2: 'V2 · external funding',
  v3: 'V3 · relay chain',
  v4: 'V4 · seasoning',
  v5: 'V5 · letscash',
  v6: 'V6 · letscash relay',
  v7: 'V7 · flap relay',
  v8: 'V8 · relay transfer',
};

// What a launch cannot be armed without, in the order step 5 asks for it, and
// how the sequence names each one when it is not there yet.
const DRAFT_FIELDS = [
  ['name', 'a name'],
  ['symbol', 'a symbol'],
  ['logo', 'a logo'],
];

/**
 * The animation feature set, declared once for the whole console.
 *
 * domMax is the smallest set that still carries layout animation, which the
 * marker travelling between stations needs — nothing in CSS can move an element
 * between two different parents. It is also the expensive half of the library:
 * dropping to domAnimation, and with it the travelling marker, is worth about
 * 47 kB, and dropping animation altogether about 131 kB. Everything on this page
 * is legible without a single frame of movement, so that trade is available at
 * any time; it is spent here on the one thing static styling cannot say, which
 * is that progress through a procedure is travel and not a jump.
 */
const animation = domMax;

export default function App() {
  // The v2 bundler tab is hidden — see the note in the render below for why.
  // A constant rather than state: while it is off there is no second tab to
  // switch to, and a switcher with one destination is furniture.
  const SHOW_V2_BUNDLER = false;
  const [mode, setMode] = useState('v1');
  // Which launcher is on screen. 'v1' is the six-step sequence that has always
  // been here and is untouched by this switch. 'v2' is the experimental bench:
  // funding that arrives from outside the console, where there is no signed
  // transaction to follow and the balance is the only evidence. Kept behind a
  // tab rather than folded into step 4 because v1 moves real money and must not
  // change shape while something next to it is being tried out.
  const [tab, setTab] = useState('v1');
  // The role pair the whole console is currently drawing. Only one tab renders
  // at a time, so every list below filters on these rather than on the literal
  // 'dev'/'bundle' it used when there was one launcher.
  const roles = rolesFor(tab);
  const [health, setHealth] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [history, setHistory] = useState([]);
  const [output, setOutput] = useState('Connecting…');
  // Seeded from the key api.js restored out of sessionStorage, so a refresh
  // finds the field already filled and every panel below already entitled to
  // read — see the note in api.js for why sessionStorage and not localStorage.
  const [key, setKey] = useState(getApiKey);
  // The three facts step 5 cannot be armed without — name, symbol and a logo
  // pinned to IPFS — handed up by LaunchForm as they are typed. They used to be
  // a row on the checklist above the console; when the six steps replaced it,
  // the logo half of this survived as state with a writer and no reader. Step 5
  // states them now, which is where an operator looks for them.
  const [draft, setDraft] = useState(null);
  // Per-wallet fund / buy-mode / buy-amount, keyed by wallet id. Lifted here
  // because both the Fund and Launch panels read the same rows.
  const [rows, setRows] = useState({});
  // What the launch is shaped like — protocol, the chosen launch config, the
  // dev buy, the creator tax. It is typed in step 5 but it decides what step 3's
  // amounts BUY, so LaunchForm pushes it up here the way it already pushes the
  // logo up for the sequence.
  const [sizing, setSizing] = useState(null);
  // THE QUOTE ASSET — the launch's FIRST decision, and now the first station.
  //
  // It used to be a dropdown inside the launch form, which is the last step, and
  // it decides what nearly every control above it means: the unit the Buy column
  // is typed in, the ETH each wallet has to be funded with to buy that much of
  // it, whether there is a swap to run at all, and which curve the supply share
  // and the market cap are computed against. So the operator picked it at the
  // bottom and walked back up to fund and swap. It is picked at the top now, and
  // every step below READS it.
  //
  // `pairToken` is the picker's value. `configV2` is the factory read the option
  // list and each asset's curve constants come from — owned here rather than
  // inside the launch form for the same reason: two stations depend on it, and a
  // value a panel fetches for itself is a value the step above it cannot see.
  // `pair` is the resolved selection and is NULL on a native launch, which is
  // what keeps every pair control off a native launcher entirely.
  const [pairToken, setPairToken] = useState(NATIVE_PAIR);
  const [configV2, setConfigV2] = useState(null);
  // The change the confirmation dialog is asking about, frozen with the impact
  // it was priced against. Null means no dialog, and no dialog means nothing
  // changes — the same rule every spending dialog in this console keeps.
  const [pendingPair, setPendingPair] = useState(null);
  // An asset the console has walked away from while wallets were still holding
  // it. REMEMBERED, because the listing carries the balance of exactly one quote
  // asset and the abandoned one is not visible anywhere once the pair changes.
  const [stranded, setStranded] = useState(null);
  // What steps 2 and 6 found, handed up by the panels that already fetched it.
  // The strip at the top of the page states every step's state, and it must not
  // do that by making the same two requests a second time.
  const [dispersers, setDispersers] = useState(null);
  const [sellable, setSellable] = useState(null);

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  // ── THE QUOTE ASSET, RESOLVED ───────────────────────────────────────────────
  //
  // Which protocol the form is on decides whether there is a quote asset at all:
  // pons v1 is a Uniswap pool priced in ETH and has no such thing. It arrives
  // with `sizing`, which the launch form pushes up as soon as it mounts; before
  // then the selection is still the native default, so this window is inert.
  const launchProtocol = sizing?.protocol || 'v2';
  const canPair = launchProtocol === 'v2';
  const quoteOptions = useMemo(() => pairOptions(configV2), [configV2]);
  // Resolved against the LIVE list, so a token un-approved between reads falls
  // back to native rather than pointing at nothing.
  const quote = useMemo(() => selectedPair(configV2, pairToken), [configV2, pairToken]);
  const nativeQuote = !canPair || isNativePair(quote.address);
  // Memoised on the resolved FIELDS rather than on the option object, which
  // selectedPair rebuilds every call: `pair` is a dependency of the share memo
  // and of three effects a page down, and a fresh identity per render would
  // re-fire all of them for nothing.
  //
  // phantomQuote and graduationThreshold are the factory's pairTokenEconomics
  // for this asset — the PAIRED curve. Dropping them is the bug that walked NVDA
  // amounts through native's curve and reported 61.20% of supply for a bundle
  // that takes 14.95%.
  const pair = useMemo(
    () =>
      nativeQuote
        ? null
        : {
            address: quote.address,
            symbol: quote.symbol,
            decimals: quote.decimals,
            phantomQuote: quote.phantomQuote,
            graduationThreshold: quote.graduationThreshold,
          },
    [
      nativeQuote,
      quote.address,
      quote.symbol,
      quote.decimals,
      quote.phantomQuote,
      quote.graduationThreshold,
    ]
  );

  // Drop what belongs to the launcher being left. Both of these are answers
  // about a specific set of wallets, and v2 has no disperser panel to overwrite
  // the value at all — so without this, switching to v2 would keep showing v1's
  // deployed contracts and let step 4 claim a funding run would be batched
  // through them.
  useEffect(() => {
    setDispersers(null);
    setSellable(null);
    // And the abandoned-quote-asset warning, for the same reason: it names a
    // COUNT OF WALLETS, and the wallets it counted belong to the launcher being
    // left. Carried across, it would report v1's stranded NVDA against v2's
    // bundle — a number about a set of keys that is no longer on screen.
    setStranded(null);
  }, [tab]);

  /**
   * What every bundle amount currently on screen would take of the supply.
   *
   * Computed here rather than in either panel because both read it: the wallet
   * table puts a figure on each row as it is typed, and the arm bar states the
   * total next to the button. Client-side because it has to answer between
   * keystrokes — see shared/bundleShare.js, which is the same module preflight
   * runs, so the live figure and the warning that stops a launch cannot come
   * from two implementations.
   *
   * Every input comes from the live factory configs the panels already fetched.
   * Nothing here is hardcoded: the owner can change supply, caps, the phantom
   * reserve or the graduation threshold between one launch and the next, and a
   * console that remembered last week's numbers would be confidently wrong.
   */
  const sized = useMemo(() => {
    if (!sizing?.launchConfig) return { share: null, blocked: null };
    // WHICH CURVE. A native launch is the launch config's own phantom reserve and
    // graduation threshold; a PAIRED one is the factory's pairTokenEconomics for
    // the chosen quote asset, and the amounts in the Buy column are that token
    // rather than ETH. Both facts come from `pair`, and both were missing here:
    // this walked NVDA amounts through native's 1.68 ETH curve and drew the
    // result as ETH. See components/pairCurve.js. Native is the identity — the
    // same config object, bundleShare's own defaults — so it is unchanged.
    const inputs = shareInputs({
      protocol: sizing.protocol,
      launchConfig: sizing.launchConfig,
      pair,
      pairedLaunchConfig,
      hasPairEconomics,
    });
    // A pair whose curve did not reach the console gets NO share. Every figure
    // downstream is a percentage of supply or a market cap, and off the wrong
    // curve each of them is wrong by a multiple rather than a rounding — so the
    // panels draw nothing and print `blocked` instead.
    if (!inputs.launchConfig) return { share: null, blocked: inputs.blocked };
    return {
      blocked: null,
      share: bundleShare({
        protocol: sizing.protocol,
        launchConfig: inputs.launchConfig,
        creatorTaxBps: sizing.creatorTaxBps,
        // Denominated in the LAUNCH'S QUOTE ASSET, exactly as prepareV2 parses it
        // — the field is labelled "Dev buy (NVDA)" on a paired launch and it is
        // pair-token units the curve receives.
        devBuyEth: sizing.devBuyEth,
        // The quote asset every *Eth figure that comes back is in. Native leaves
        // these at bundleShare's own defaults and every number unchanged.
        pairDecimals: inputs.pairDecimals,
        pairSymbol: inputs.pairSymbol,
        // Table order is firing order — prepare() walks the same list the same
        // way — and on a curve the order is the price, so it has to match.
        buys: wallets
          .filter((w) => w.role === roles.bundle)
          .map((w) => ({
            key: w.id,
            // "all − gas" is resolved server-side from the live balance. The
            // balance is its ceiling and gas is a rounding error beside a buy,
            // so the row is shown rather than left blank — flagged as an
            // approximation in the summary under the table.
            amountEth: rows[w.id]?.mode === 'all' ? w.balanceEth : rows[w.id]?.buy,
          })),
      }),
    };
  }, [sizing, wallets, rows, roles, pair]);
  const share = sized.share;
  const shareBlocked = sized.blocked;

  // Strings stay strings so errors read as errors; everything else is a payload
  // for ResultPanel to lay out.
  //
  // Nothing here moves the viewport. Reporting used to reveal as well — the
  // readout scrolled itself into view on every answer — and being thrown to the
  // bottom of the page mid-step is worse than having to look for the answer,
  // most of all during a launch. So the only thing carried alongside the payload
  // is WHEN it arrived: the readout puts it in the chip on its own header, which
  // is how a still panel says it has something new without moving anything.
  const [reportedAt, setReportedAt] = useState('');
  const report = (v) => {
    setOutput(v);
    setReportedAt(new Date().toLocaleTimeString());
  };

  // THE LISTING'S ONE QUERY PARAMETER, AND THE WHOLE OF THE PAIR COLUMN'S COST.
  //
  // `pair` is null on a native launch and on every launch until step 5 picks a
  // quote asset, and the listing then makes exactly the reads it has always made
  // and returns exactly the fields it has always returned. With an address it
  // also carries what each wallet holds of that token, read server-side in one
  // batched call — see routes/wallets.js.
  //
  // Read through a ref rather than closed over, so this callback keeps a STABLE
  // identity: every panel below takes it as `reload`, and handing them a new
  // function each time the picker moved would re-run their effects for nothing.
  const pairAddress = pair?.address || null;
  const pairRef = useRef(pairAddress);
  pairRef.current = pairAddress;
  const loadWallets = useCallback(async () => {
    const token = pairRef.current;
    setWallets(await api(token ? `/wallets?pairToken=${encodeURIComponent(token)}` : '/wallets'));
  }, []);
  // Per launcher. The store is one file per user and the variant is what
  // separates the two inside it — without this filter v2's step 5 reads v1's
  // launches as its own and reports DONE for a run it never made.
  const loadHistory = useCallback(
    async () => setHistory(await api(`/launches?limit=15&variant=${tab}`)),
    [tab]
  );

  const loadAll = useCallback(async () => {
    try {
      setHealth(await api('/health'));
      await loadWallets();
      setConfigs(await api('/configs'));
      await loadHistory();
      setOutput('Ready. Run Preflight when the sequence above is complete.');
    } catch (err) {
      setOutput(`ERROR: ${err.message}`);
    }
  }, [loadWallets, loadHistory]);

  // Re-read everything when the key changes: the key decides not just what you
  // may do but what you can see, so a new key means a different console.
  // Debounced because this fires on every keystroke of a pasted key.
  useEffect(() => {
    const t = setTimeout(loadAll, key ? 400 : 0);
    return () => clearTimeout(t);
  }, [loadAll, key]);

  const live = Boolean(health && !health.dryRun);
  const funded = wallets.filter((w) => w.role === roles.bundle && Number(w.balanceEth) > 0).length;

  // Whether this console may read at all, and what it re-reads on. It is not
  // the key: a deployment that injects the key at nginx (the map block in
  // deploy/nginx-rhbond.conf) never puts one in the browser, and health comes
  // back with `user` set instead; a deployment with no key configured needs
  // nothing at all. The panels below key their reloads on this string, so it
  // has to change when the identity changes and be truthy whenever the console
  // is entitled — otherwise they hide their own errors as "no key yet".
  const credential =
    key || health?.user || (health && !health.apiKeyRequired ? 'open' : '');

  // A CHANGED QUOTE ASSET RE-READS THE LISTING, and nothing else does. The pair
  // column has to be about the launch now on screen, and switching NVDA → SPCX
  // leaves every balance in it answering the wrong question.
  //
  // Deliberately not on mount: the previous value is seeded, so native → native
  // (both null) never fires and a native launch is left with loadAll's single
  // read, exactly as before. A failed re-read is swallowed — the listing already
  // on screen is still true about ETH, and loadAll reports its own errors.
  const lastPairRef = useRef(pairAddress);
  useEffect(() => {
    if (lastPairRef.current === pairAddress) return;
    lastPairRef.current = pairAddress;
    if (!credential) return;
    loadWallets().catch(() => {});
  }, [pairAddress, credential, loadWallets]);

  // THE V2 FACTORY READ, owned here rather than inside the launch form.
  //
  // It carries the approved quote assets and each one's curve constants, which
  // the FIRST station now needs — a picker that has to wait for the last panel
  // to mount before it has a list is not a picker at the front. Read once per
  // console, only for the two tabs that launch, and only when this console is
  // entitled to read at all. Its own effect and its own catch: a failure here
  // must not take out loadAll's "Ready" line, and the picker still has native.
  useEffect(() => {
    if (tab !== 'v1' && tab !== 'v2') return undefined;
    if (!credential || configV2) return undefined;
    let alive = true;
    api('/v2/configs')
      .then((c) => alive && setConfigV2(c))
      .catch((err) => alive && report(`ERROR: v2 configs — ${err.message}`));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, credential, configV2]);

  // ── CHANGING THE QUOTE ASSET, WHICH IS THE ONE DANGEROUS EDGE ──────────────
  //
  // Both pickers — the station at the front and the launch form's own — call
  // this and neither applies a change itself. It is free before any work has
  // been done, and it is not free afterwards: the Buy column keeps its digits
  // and they start meaning a different token, the Fund column was priced against
  // the old pool, and any wallet that already bought the old asset keeps holding
  // it somewhere this console can no longer see (the listing carries exactly one
  // quote asset). So the cost is priced first and stated in a dialog, and the
  // asset walked away from is REMEMBERED so the way back can be pointed at.
  const bundleWallets = wallets.filter((w) => w.role === roles.bundle);
  const holdings = pairHoldings(bundleWallets);
  const typedBuys = bundleWallets.filter((w) => Number(rows[w.id]?.buy) > 0).length;
  const typedFunds = bundleWallets.filter((w) => Number(rows[w.id]?.fund) > 0).length;

  function applyPair(next, impact) {
    setPairToken(next);
    const record = strandedRecord(impact);
    if (record) setStranded(record);
  }

  // The guarded request. Same address is a no-op — a select re-emitting its own
  // value must never raise a dialog — and a change that costs nothing is applied
  // without one, because an operator who changes their mind before doing any
  // work should not be made to read about it.
  function askPair(next) {
    const to = quoteOptions.find((t) => t.address.toLowerCase() === String(next).toLowerCase());
    const impact = pairChangeImpact({
      from: { address: quote.address, symbol: quote.symbol, native: nativeQuote },
      to: { address: to?.address || next, symbol: to?.symbol || '' },
      holders: holdings,
      restated: typedBuys,
      repriced: typedFunds,
    });
    if (impact.same) return;
    if (!impact.needsConfirm) return applyPair(to?.address || next, impact);
    setPendingPair({ address: to?.address || next, symbol: to?.symbol || '—', impact });
  }

  // The remembered stranding retires only when the launch is priced in that
  // asset again AND nothing is holding it — two live readings, never a guess.
  useEffect(() => {
    if (strandingCleared(stranded, quote.address, holdings)) setStranded(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stranded, quote.address, holdings.wallets]);

  // Only ask for a key when one is actually missing. If nginx supplies it, or
  // the deployment has none, the field is not a prompt — it is a lie.
  const needsKey = Boolean(health && health.apiKeyRequired && !health.user);

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Six steps, and the state of each derived from what is actually true right
   * now rather than from anything this component remembers. Exactly one step is
   * `now`: the first that is not done and whose predecessor is. Everything after
   * it is `later` and says which step it is waiting on.
   *
   * `later` is a statement about ORDER, not permission. Nothing below is
   * disabled by it: an operator who wants to generate bundle wallets before a
   * dev wallet exists is allowed to, and the console's job is to say what the
   * sequence expects, not to hold the keys hostage to it.
   *
   * Step 2 is the exception: the backend uses individual transfers below the
   * batching threshold regardless, so it is genuinely optional and never makes
   * a later step wait. Marking it required would be the console lying about the
   * code underneath it.
   *
   * Step 6 has no done state. Selling everything empties the list, which is the
   * same list you have before you have launched anything, so "done" would be
   * indistinguishable from "not started".
   */
  const steps = useMemo(() => {
    const dev = wallets.find((w) => w.role === roles.dev);
    const bundle = wallets.filter((w) => w.role === roles.bundle);
    const activeDispersers = dispersers?.addresses?.length ?? 0;
    const threshold = dispersers?.batchThreshold;
    const sellCount = Array.isArray(sellable) ? sellable.length : 0;
    const last = history[0];
    const launched = history.length > 0;
    // What step 5 is still missing, in the order the form asks for it. `done`
    // stays "has launched" — a filled-in form is not a launch — so this rides
    // on the detail line, which is where every other step says what it is
    // waiting for.
    const missing = DRAFT_FIELDS.filter(([k]) => !draft?.[k]).map(([, label]) => label);
    const quoteSymbol = pair ? pair.symbol : 'ETH';

    // THE TWO READINGS THE SWAP STATION IS BUILT ON, and the only two the plan
    // needs. `pairReady` is how many buying wallets already hold what their buy
    // will demand — the same question preflight asks. `ethShort` is whether they
    // can pay for the rest: it has no dry run up here (the station itself owns
    // that), so it reads the Fund column, which is the figure the fill wrote out
    // of that very dry run. The station states the exact number; the plan states
    // the shape.
    const pairReady = pair ? shortOfPair(bundle, rows) : { short: 0, ready: 0, unknown: 0, buying: 0 };
    const ethShort = pair
      ? ethShortfall({ bundle, rows })
      : { short: 0, ready: 0, unknown: 0, targets: 0, missing: '0', need: '0' };

    const fullPlan = [
      {
        key: 'quote',
        n: 1,
        title: 'Choose the quote asset',
        // A choice with a default is a choice that has always been made: the
        // launch IS priced in something from the first paint, so this station is
        // never a thing to go and do. It is jade and it states the answer, which
        // is exactly what the strip at the top exists for — a first-time
        // operator learns what the run is denominated in before reading a single
        // control below it.
        //
        // `needs: 0` because nothing can precede the first decision, and because
        // a done step clears the waiting chain: without it, "waits on step 2 —
        // create dev wallet first" would vanish off the station below.
        done: true,
        needs: 0,
        detail: pair
          ? `${pair.symbol} — the dev buy and every bundle buy are spent in ${pair.symbol}, not ETH`
          : 'ETH (native) — the bundle buys with the ETH you fund it with',
      },
      {
        key: 'dev',
        n: 1,
        title: 'Create dev wallet',
        done: Boolean(dev),
        detail: dev
          ? `${short(dev.address)} · ${Number(dev.balanceEth).toFixed(4)} ETH`
          : 'it signs the launch and pays for everything',
      },
      {
        key: 'disperser',
        n: 2,
        title: 'Deploy disperser contract',
        optional: true,
        done: activeDispersers > 0,
        needs: dev ? 0 : 1,
        detail: activeDispersers
          ? `${plural(activeDispersers, 'contract')} in use${threshold ? ` · batches ${threshold}+ recipients` : ''}`
          : 'without one, funding sends one transfer per wallet',
      },
      {
        key: 'wallets',
        n: 3,
        title: 'Generate bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · ${funded} funded`
          : 'each buys behind the dev buy, capped at 5%',
      },
      {
        key: 'fund',
        n: 4,
        title: 'Fund bundle wallets',
        done: funded > 0,
        detail: bundle.length
          ? `${funded} of ${bundle.length} hold ETH`
          : 'ETH out of the dev wallet, one row each',
      },
      {
        key: 'swap',
        n: 5,
        // THE STATION THE ORDER WAS MISSING. It exists only while the launch is
        // priced in something other than ETH, and it is where each bundle wallet
        // buys its own quote asset with its own ETH — because no path in this
        // console can SEND that asset to a wallet: the funding run is ETH
        // transfers and the bridge quotes native at both ends.
        //
        // `done` is deliberately strict. Every buying wallet must be CONFIRMED
        // holding enough — a wallet whose pair balance was never read is counted
        // in `unknown` and keeps the station open, because "done" here means
        // preflight will not drop anybody, and an unread balance is a question
        // rather than a yes.
        //
        // `launched` outranks it, exactly as it does on every other station: the
        // buys have spent the quote asset, so the pair column empties and this
        // step would otherwise flip from done back to NOW after a successful
        // launch and claim the caret off the readout.
        title: `Buy ${quoteSymbol} for the bundle`,
        done: launched || (pairReady.buying > 0 && pairReady.ready === pairReady.buying),
        detail: launched
          ? `the bundle bought its ${quoteSymbol} before the launch`
          : pairReady.buying
          ? `${pairReady.ready} of ${pairReady.buying} hold their ${quoteSymbol}`
          : ethShort.short > 0
            ? `${ethShort.short} wallet${ethShort.short === 1 ? '' : 's'} short of ETH — fund them first`
            : `each wallet buys its own ${quoteSymbol} with its own ETH`,
      },
      {
        key: 'launch',
        n: 6,
        title: 'Launch + bundle',
        done: launched,
        detail: last
          ? `${last.params?.symbol || short(last.token)} · ${
              (last.buys || []).filter((b) => b.status === 'confirmed').length
            }/${(last.buys || []).length} filled${last.dryRun ? ' · dry run' : ''}`
          : // Nothing typed yet is not a shortfall — it is the state every run
            // starts in — so the step says what it is for rather than listing
            // three things the operator has not had a chance to do.
            missing.length === DRAFT_FIELDS.length
            ? 'the dev buy runs inside the launch itself'
            : missing.length
              ? `still needs ${andList(missing)}`
              : 'name, symbol and logo ready',
      },
      {
        key: 'sell',
        n: 6,
        title: 'Sell everything',
        done: false,
        detail: sellCount
          ? `${plural(sellCount, 'token')} your bundle still holds`
          : 'nothing your bundle holds is sellable yet',
      },
    ];

    // Steps this launcher does not have simply are not in its plan — v2 funds
    // with individual transfers, so it has no disperser step; v1 launches into a
    // Uniswap pool priced in ETH, so it has no quote asset to choose. The
    // remaining steps renumber to close the gap rather than skipping a number.
    // The ORDER and the membership are decided in one place, and tested there —
    // see components/quoteAsset.js.
    const keys = stepOrder({
      dispersers: roles.dispersers,
      quote: tab === 'v2',
      // LIVE, not a launcher capability: the swap station appears the moment the
      // launch is priced in something other than ETH and disappears the moment it
      // is not. There is nothing to swap into on a native launch, so there is no
      // station, no number and no panel.
      paired: Boolean(pair),
    });
    const plan = fullPlan.filter((s) => keys.includes(s.key));
    plan.forEach((s, i) => {
      s.n = i + 1;
    });

    // Every station's live number, so a panel can name another one without
    // knowing where it sits — the numbering closes by KEY, not by position, and
    // "fund in step 4" is wrong on one of the two launchers at any time.
    const nums = Object.fromEntries(plan.map((s) => [s.key, s.n]));

    // ONE LINE PER STATION: what it is for, and what has to be true before its
    // controls do anything. Written in one place, in one voice, so the answer to
    // "why is this button dead" is on the page rather than in a title attribute
    // — see stepNeed in components/quoteAsset.js.
    const facts = {
      nums,
      paired: Boolean(pair),
      pairSymbol: quoteSymbol,
      hasDev: Boolean(dev),
      bundleCount: bundle.length,
      dispersers: activeDispersers,
      needsDisperser: roles.dispersers,
      fundTargets: bundle.filter((w) => Number(rows[w.id]?.fund) > 0).length,
      buyTargets: bundle.filter(
        (w) => (rows[w.id]?.mode === 'all' && Number(w.balanceEth) > 0) || Number(rows[w.id]?.buy) > 0
      ).length,
      shortOfPair: pairReady.short,
      // The swap station's own facts. `swapTargets` is NOT `buyTargets`: a row on
      // "all − gas" names no amount to size a swap against, so it counts for the
      // launch and not for the swap.
      swapTargets: pairReady.buying,
      shortOfEth: ethShort.short,
      missingEth: Number(ethShort.missing) > 0 ? Number(ethShort.missing).toFixed(6) : '',
      draftMissing: missing,
      launched,
      sellCount,
    };
    plan.forEach((s) => {
      s.need = stepNeed(s.key, facts);
    });

    // The chain of required steps. A step waits on the last required one before
    // it; `needs` set explicitly wins, which is how the optional step still
    // says it cannot be paid for before there is a dev wallet.
    let previousRequired = null;
    let claimed = false;
    return plan.map((s) => {
      const waitsOn = s.needs === 0 ? null : (s.needs ?? previousRequired);
      const blocked = waitsOn != null && !plan[waitsOn - 1].done;
      if (!s.optional) previousRequired = s.done ? null : s.n;

      // `done` outranks everything: deleting every bundle wallet after a launch
      // must not un-launch step 5.
      let state = 'later';
      if (s.done) state = 'done';
      else if (!blocked && !s.optional && !claimed) {
        state = 'now';
        claimed = true;
      }

      return {
        ...s,
        id: `step-${s.n}`,
        state,
        // A blocked optional step is not "optional" yet — it cannot be run at
        // all — so it reads as later, and only says optional once it could be
        // done and is being passed over.
        chip:
          state === 'done'
            ? 'done'
            : state === 'now'
              ? 'now'
              : s.optional && !blocked
                ? 'optional'
                : 'later',
        // WHY THIS STEP CANNOT RUN YET, and the step that fixes it — followed by
        // the plain-language line every station states about itself. A blocked
        // step used to say only which number it was waiting on; now it says what
        // it is for as well, so a dead control is never presented without its
        // reason beside it.
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : state === 'later' && s.optional
              ? 'Optional. Skipping it costs nothing until the bundle is large enough to batch.'
              : null,
      };
    });
    // `rows` and `pair` are in here because the per-step line states what has
    // been typed and what the launch is priced in. Both change often; the memo
    // only builds strings.
  }, [wallets, funded, rows, pair, tab, dispersers, sellable, history, draft, roles]);

  // The step whose panel is drawn where, so a panel never has to know its own
  // number and the order lives in one place — this file, in render order below.
  // By KEY, not by position. v2 has no disperser step, so its numbering closes
  // the gap and a panel asking for "step 2" would get the wrong one.
  const step = (key) => steps.find((s) => s.key === key) || null;
  // The same map the plan built, for the panels that name another station.
  const nums = useMemo(() => Object.fromEntries(steps.map((s) => [s.key, s.n])), [steps]);

  return (
    // reducedMotion="user" hands the whole question to the operating system:
    // every layout and transform animation below is switched off when the
    // machine asks for it, without each component checking. `strict` refuses
    // the full motion component outright, so the heavy import cannot creep back
    // in unnoticed the next time something needs animating.
    <LazyMotion features={animation} strict>
      <MotionConfig reducedMotion="user">
        <Toaster />
        {/* The SOLARBA-chrome shell. Presentation only: the same header, tabs
            and panels reparented into a sidebar + top bar + content + status bar
            frame. `live` (already in scope) turns the whole frame vermilion the
            instant the server can spend — see shell.css for the signature. */}
        <div className={`app-shell ${live ? 'is-live' : ''}`}>
          {/* The sidebar of destinations. The four launcher tabs move here as
              nav items — the same onClick and the same is-on condition, restyled
              from quiet chips into a rail. Choosing a tab is navigation, so the
              active item wears indigo (the neutral primary), never the amber a
              step spends. */}
          <aside className="side">
            <div className="side-brand">
              <span className="glyph">p</span>
              <span className="word">
                pons<b>·</b>launcher
              </span>
            </div>
            <nav className="side-nav">
              <div className="side-label">Consoles</div>
              <button
                type="button"
                className={tab === 'v1' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v1')}
              >
                <LuRocket size={16} aria-hidden="true" />
                Launcher
              </button>
              <button
                type="button"
                className={tab === 'v2' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v2')}
              >
                <LuArrowRightLeft size={16} aria-hidden="true" />
                V2 · external funding
              </button>
              <button
                type="button"
                className={tab === 'v3' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v3')}
              >
                <LuLink size={16} aria-hidden="true" />
                V3 · relay chain
              </button>
              <button
                type="button"
                className={tab === 'v4' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v4')}
              >
                <LuClock size={16} aria-hidden="true" />
                V4 · seasoning
              </button>
              <button
                type="button"
                className={tab === 'v5' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v5')}
              >
                <LuBanknote size={16} aria-hidden="true" />
                V5 · letscash
              </button>
              <button
                type="button"
                className={tab === 'v6' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v6')}
              >
                <LuRepeat size={16} aria-hidden="true" />
                V6 · letscash relay
              </button>
              {/* V7 · flap relay — HIDDEN for now. The tab is fully built and wired
                  (import, TAB_TITLE entry, and the `tab === 'v7'` render branch below
                  all remain); only this nav button is removed so it cannot be reached
                  from the UI. To re-enable, uncomment this button.
              <button
                type="button"
                className={tab === 'v7' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v7')}
              >
                <LuFlame size={16} aria-hidden="true" />
                V7 · flap relay
              </button>
              */}
              <button
                type="button"
                className={tab === 'v8' ? 'side-item is-on' : 'side-item'}
                onClick={() => setTab('v8')}
              >
                <LuSend size={16} aria-hidden="true" />
                V8 · relay transfer
              </button>
            </nav>
            <div className="side-foot">
              <ThemeToggle />
            </div>
          </aside>

          {/* The top bar. The chain/user readout becomes chips, the dry/live
              mode becomes the mode-chip, and the API-key field and its forget
              button move here unchanged — same handlers, same needsKey gate. */}
          <header className="topbar">
            <div className="topbar-title">
              {TAB_TITLE[tab]}
              <span className="sub">
                {tab === 'v1'
                  ? `the ${steps.length}-step sequence — dev wallet funds everything`
                  : tab === 'v2'
                    ? `${steps.length} steps, no disperser — funded from outside this console`
                    : tab === 'v3'
                      ? 'not a launcher — distributes a live token, one wallet at a time'
                      : tab === 'v4'
                        ? 'not a launcher — drips ETH into fresh wallets over weeks'
                        : tab === 'v5'
                          ? 'the letscash.fun bundler — launcher first buy, fanned out to a bundle'
                          : tab === 'v8'
                            ? 'not a launcher — moves ETH from one wallet to many through Relay, then back'
                            : 'not a launcher — distributes a live letscash token through Relay, one wallet at a time'}
              </span>
            </div>

            <span className="spacer" />

            {health && (
              <span className="chip">
                <span className="chip-dot ok" />
                <span className="k">chain</span>
                <b className="v">{health.chainId}</b>
              </span>
            )}
            {health && health.multiUser && (
              <span className="chip">
                <span className="k">signed in</span>
                <b className="v">{health.user || 'nobody'}</b>
              </span>
            )}

            <div className={`mode-chip ${live ? 'is-live' : ''}`}>
              {!health ? 'connecting' : live ? 'live' : 'dry run'}
            </div>

            {needsKey && (
              <>
                <input
                  type="password"
                  placeholder="API key"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setApiKey(e.target.value);
                  }}
                />
                {/* A key that survives a refresh needs a way out that is not
                    "close every tab" — a shared screen is the usual reason. */}
                {key && (
                  <button
                    className="link"
                    title="clear the key from this tab"
                    onClick={() => {
                      setKey('');
                      setApiKey('');
                    }}
                  >
                    forget
                  </button>
                )}
              </>
            )}

            {/* Multi-user deployments proxy through nginx, which overwrites this
                field's header with the key mapped to your login — if that map is
                missing an entry, the key you paste here is silently ignored. */}
            {health && health.multiUser && !health.user && (
              <div className="hint">not signed in — nginx may be swallowing the key field; ask whoever runs this deployment to check the login map</div>
            )}
          </header>

          {/* The working area. The same <main> as before — its grid, its
              panels, its records — only reparented into the shell's scrolling
              content column. The .tabs row is gone from here: its buttons are
              the sidebar nav now, and its per-tab hint is the top bar's
              subtitle. Everything below is byte-for-byte the old flow. */}
          <div className="content">
            <main>

          {/* V3 replaces the whole flow rather than adding to it: it does not
              launch, so it has no step in common with the tree below beyond
              having wallets at all. Its state lives inside it. */}
          {tab === 'v3' ? (
            <V3Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : tab === 'v4' ? (
            <V4Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : tab === 'v5' ? (
            <V5Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : tab === 'v6' ? (
            <V6Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : tab === 'v7' ? (
            <V7Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : tab === 'v8' ? (
            <V8Console
              health={health}
              credential={credential}
              report={report}
              output={output}
              reportedAt={reportedAt}
            />
          ) : (
          <>

          {/* THE V2 BUNDLER TAB IS HIDDEN, and the reason is not that it is
              unfinished. It targets the pons v1 factory, whose owner set
              launchEnabled to false on 2026-08-12 at 19:42 UTC — 22 seconds
              after the last launch landed — on both v1 factories, and has
              never once toggled that flag back in either contract's history.
              The whitelist is provably empty: not one WhitelistedLauncherUpdated
              event has ever been emitted, the constructor never writes the
              mapping, and neither contract is a proxy. So there is no address
              that can launch on v1, and nothing behind this tab can work.

              Pons v2 is where launches go now, and it is already reachable —
              the protocol selector inside the launch form below switches the
              whole flow to /v2/*. It needs no tab of its own.

              Left mounted rather than deleted: if v1 ever reopens, restoring
              this is flipping SHOW_V2_BUNDLER, and the strategy behind it is
              still the right one for that factory. Delete it once v2 is the
              only thing anyone launches on. */}
          {SHOW_V2_BUNDLER && (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <button
                  type="button"
                  className={mode === 'v1' ? '' : 'ghost'}
                  onClick={() => setMode('v1')}
                >
                  V1 bundler
                </button>
                <button
                  type="button"
                  className={mode === 'v2' ? '' : 'ghost'}
                  onClick={() => setMode('v2')}
                >
                  V2 bundler
                </button>
                <span className="spacer" />
                <span className="hint">
                  {mode === 'v1'
                    ? 'dev buy, then a bundle at the open block'
                    : 'no dev buy, then one contract buy after the snipers exit'}
                </span>
              </div>

              {mode === 'v2' && (
                <BundlerV2Panel
                  explorer={health?.explorer || ''}
                  credential={credential}
                  report={report}
                  wallets={wallets}
                  configs={configs}
                  reload={loadWallets}
                />
              )}
            </>
          )}

          {/* `sequence` is presentation only — it is what lets the stylesheet
              put the inter-step gap where the steps actually are. Everything
              below is nested inside this one div so a single `hidden` can take
              the whole v1 flow off the page, and a grid gap on <main> only ever
              spaces main's DIRECT children, so until this class existed the six
              step cards sat flush against each other. The class carries no
              behaviour; the `hidden` expression is untouched. */}
          <div className="sequence" hidden={SHOW_V2_BUNDLER && mode !== 'v1'}>
          <Sequence
            steps={steps}
            notice={
              !health
                ? 'Connecting to the server…'
                : needsKey && !key
                  ? 'Paste the API key in the top bar — without it the console can neither read nor spend.'
                  : null
            }
          />
          <Guide steps={steps} />

          {/* THE FIRST STATION, on the launcher that has one. Everything below
              it is denominated in what is picked here, which is why it is here
              and not two thirds of the way down the launch form. Choosing moves
              no money, so this panel carries none of the money colours. */}
          {tab === 'v2' && (
            <QuotePanel
              step={step('quote')}
              options={quoteOptions}
              value={quote.address}
              symbol={quote.symbol}
              native={nativeQuote}
              loading={!configV2}
              bundleCount={bundleWallets.length}
              holdings={holdings}
              stranded={stranded}
              onStrandedDismiss={() => setStranded(null)}
              onRequest={askPair}
              nums={nums}
            />
          )}

          {/* CHANGING WHAT THE LAUNCH IS PRICED IN — the one edge that can
              quietly cost money, so it is the one thing here that asks first.
              Rendered once, from the owner of the value, and reached from BOTH
              pickers: the station above and the launch form's own.

              Not `danger`. Vermilion is reserved for what cannot be taken back,
              and this can: the tokens do not move, and pricing the launch in the
              old asset again brings them back into view. The confirm is indigo —
              a neutral forward action that spends nothing — which also leaves
              this dialog with exactly one non-grey object in it. */}
          <Modal
            open={Boolean(pendingPair)}
            title={`Price this launch in ${pendingPair?.symbol || ''}?`}
            question="Change the quote asset?"
            confirmLabel={`Price it in ${pendingPair?.symbol || ''}`}
            confirmClass="btn-primary"
            onConfirm={() => {
              const p = pendingPair;
              setPendingPair(null);
              if (p) applyPair(p.address, p.impact);
            }}
            onCancel={() => setPendingPair(null)}
          >
            <div className="modal-facts">
              <Fact label="Priced in now">{quote.symbol}</Fact>
              <Fact label="Change to">{pendingPair?.symbol || '—'}</Fact>
              <Fact label="Buy amounts typed">{pendingPair?.impact.restated ?? 0}</Fact>
              <Fact label="Fund amounts typed">{pendingPair?.impact.repriced ?? 0}</Fact>
              {pendingPair?.impact.strands && (
                <Fact label={`Wallets holding ${pendingPair.impact.strands.symbol}`}>
                  {pendingPair.impact.strands.wallets} ·{' '}
                  {Number(pendingPair.impact.strands.total).toFixed(6)}{' '}
                  {pendingPair.impact.strands.symbol}
                </Fact>
              )}
            </div>
            {/* The same grey ticket the panels use for a list of consequences —
                no new class, no second colour in the dialog. */}
            <div className="notice">
            <ul>
              {(pendingPair?.impact.restated ?? 0) > 0 && (
                <li>
                  The <b>Buy</b> column keeps its numbers and they start meaning{' '}
                  {pendingPair?.symbol}, not {quote.symbol}. Re-size the bundle before you launch.
                </li>
              )}
              {(pendingPair?.impact.repriced ?? 0) > 0 && (
                <li>
                  The <b>Fund</b> column was priced against the {quote.symbol} pool by the endpoint
                  that would have spent it. It is not that price against {pendingPair?.symbol}.
                </li>
              )}
              {pendingPair?.impact.strands && (
                <li>
                  {pendingPair.impact.strands.wallets} wallet
                  {pendingPair.impact.strands.wallets === 1 ? '' : 's'} already hold{' '}
                  {Number(pendingPair.impact.strands.total).toFixed(6)}{' '}
                  {pendingPair.impact.strands.symbol}. Nothing spends it and nothing is lost, but
                  this console reads the balance of one quote asset at a time — so it goes{' '}
                  <b className="crux">invisible here</b> until the launch is priced in{' '}
                  {pendingPair.impact.strands.symbol} again.
                </li>
              )}
              {pendingPair?.impact.strands && (
                <li>
                  To turn it back into ETH first: cancel, and use{' '}
                  <b>Recover ETH · sell {pendingPair.impact.strands.symbol} back</b> in step{' '}
                  {nums.wallets}. It sells each wallet's whole balance and leaves the ETH in the
                  wallet.
                </li>
              )}
            </ul>
            </div>
          </Modal>

          <DevWalletPanel
            variant={tab}
            step={step('dev')}
            wallets={wallets}
            explorer={health?.explorer || ''}
            reload={loadWallets}
            report={report}
          />
          {roles.dispersers && (
          <DispersersPanel
            variant={tab}
            step={step('disperser')}
            explorer={health?.explorer || ''}
            credential={credential}
            report={report}
            onState={setDispersers}
          />
          )}
          <WalletsPanel
            variant={tab}
            step={step('wallets')}
            wallets={wallets}
            rows={rows}
            setRow={setRow}
            share={share}
            shareBlocked={shareBlocked}
            pair={pair}
            live={live}
            reload={loadWallets}
            report={report}
            nums={nums}
          />
          <FundPanel
            variant={tab}
            step={step('fund')}
            wallets={wallets}
            rows={rows}
            dispersers={dispersers}
            reload={loadWallets}
            report={report}
            pair={pair}
            nums={nums}
          />
          {/* The v2 bench: ETH that arrives from outside the console. It sits
              beside step 4 because it answers the same question — is every
              wallet funded — for the case where this console did not send it. */}
          {tab === 'v2' && (
            <ExternalFundPanel wallets={wallets} rows={rows} reload={loadWallets} variant={tab} />
          )}

          {/* THE SWAP, AS A STATION. It sits here — after the ETH arrives, before
              the launch is armed — because that is the only place it can run: each
              bundle wallet buys its own quote asset with its OWN ETH, since no
              path in this console can send that asset to a wallet.

              It used to be two boxes inside the wallet table, four hundred lines
              above the step that funds them, explaining in prose that it ran AFTER
              that step. The order is now the order of the page. Absent entirely on
              a native launch: `pair` is null, the station is not in the plan, and
              `step('swap')` returns nothing to draw. */}
          {pair && step('swap') && (
            <PairSwapPanel
              variant={tab}
              step={step('swap')}
              wallets={wallets}
              rows={rows}
              pair={pair}
              live={live}
              reload={loadWallets}
              report={report}
              nums={nums}
            />
          )}

          {/* The form READS the quote asset now; it does not own it. `pair` is
              resolved above, out of the factory read this file owns, and the
              picker the form still draws goes through the same guarded setter
              the first station's does — so changing it there states its cost
              instead of quietly stranding the wallets holding the old one.
              `onPairReset` is the ONE unguarded write: the protocol switch
              putting a pons-v1 launch back on native, because an effect must
              never raise a dialog. */}
          <LaunchForm
            variant={tab}
            step={step('launch')}
            configs={configs}
            wallets={wallets}
            rows={rows}
            live={live}
            share={share}
            reload={loadWallets}
            reloadHistory={loadHistory}
            report={report}
            onDraft={setDraft}
            onSizing={setSizing}
            configV2={configV2}
            quoteOptions={quoteOptions}
            pairToken={quote.address}
            pair={pair}
            onPairToken={askPair}
            onPairReset={setPairToken}
            ownsPair={tab !== 'v2'}
            nums={nums}
          />
          {/* The console's answer, between the launch and the exit because that is
              where it falls: you launch, you read this, and only later do you
              decide to sell. Unnumbered — it is a readout, not a seventh step —
              and never jade, because what lands here is as often a revert as a
              confirmation. The spine passing through it is the launch's, so it
              takes its fill from step 5 rather than from its own contents.

              The chip is the whole of the notification: grey, still, and only
              there once an action has actually answered. It replaces a panel
              that used to come and find the operator. */}
          <ResultPanel
            step={{
              id: 'readout',
              title: 'Result',
              state: 'readout',
              chip: reportedAt ? `updated ${reportedAt}` : null,
              railDone: step('launch')?.state === 'done',
            }}
            output={output}
          />
          <SellPanel
            variant={tab}
            step={{ ...step('sell'), last: true }}
            explorer={health?.explorer || ''}
            credential={credential}
            live={live}
            reload={loadWallets}
            report={report}
            onState={setSellable}
          />

          {/* Post-launch, v2 only: route a launched token's creator fee to its
              holders. Its own panel rather than a numbered step — it is an
              optional management action, not part of the launch sequence, and it
              touches the real pons v2 holder-fee factory. */}
          {tab === 'v2' && (
            <HolderFeesPanel
              explorer={health?.explorer || ''}
              credential={credential}
              live={live}
              wallets={wallets}
            />
          )}

          </div>
          </>
          )}

          {/* Where the sequence stops. Everything below is a record of runs that
              already happened, and the left edge changes to say so. Outside the
              tab: the history and the activity log are the same records whichever
              strategy produced them. */}
          <div className="divider">
            <span>records</span>
          </div>

          <HistoryPanel entries={history} explorer={health?.explorer || ''} />
          {/* `admin` comes from health, which is the server's answer about this
              caller — it decides whether the user selector is drawn at all. The
              backend checks it again on every read; this flag draws controls, it
              does not grant anything. */}
          <ActivityPanel
            explorer={health?.explorer || ''}
            credential={credential}
            admin={Boolean(health?.admin)}
            me={health?.user || ''}
          />
            </main>
          </div>

          {/* The status bar. Built only from values already in scope — the
              chain, the signed-in user, and `live` — with the dry/live
              indicator as its point: jade while nothing broadcasts, vermilion
              the moment the console can spend. No new fetch, no new hook. */}
          <footer className="statusbar">
            {health && (
              <span>
                <span className="k">chain</span>
                <b>{health.chainId}</b>
              </span>
            )}
            {health && health.multiUser && (
              <span>
                <span className="k">user</span>
                <b>{health.user || 'nobody'}</b>
              </span>
            )}
            <span className="spacer" />
            <span className={!health ? '' : live ? 'live' : 'ok'}>
              {!health
                ? 'connecting…'
                : live
                  ? 'live · spends real funds'
                  : 'dry run · broadcasts nothing'}
            </span>
          </footer>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
