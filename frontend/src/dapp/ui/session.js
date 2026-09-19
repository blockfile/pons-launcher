/**
 * One open token's selling session — the money path of the page, kept out of
 * React so it can be tested with fakes and so a render never sits between a
 * click and the network call.
 *
 * What it holds: wallet STATE by address (balances, nonce, allowance — public
 * data), per-row status, the local nonce book, the preview quote cache and the
 * in-flight ops. What it never holds: a private key. Signing goes through
 * deps.store.signTx(address, txRequest), which returns a raw signed hex.
 *
 * Flows (spec "The flows"):
 *   load    postWallets -> holders only, ticked -> auto-arm
 *   arm     planArm -> sign -> ONE broadcast -> receipts -> ONE batched
 *           re-read -> ready
 *   sell    planSell -> sign all -> ONE broadcast -> optimistic balances ->
 *           receipts -> landed / reverted. A curve prices from the streamed
 *           mark (no chain read unless the mark is stale); a pool asks ONE
 *           exact /quote for this click's own amounts
 *   pair    landed sells on a token-quoted curve OR token-quoted graduated
 *           pool (AMZN, SPCX...) -> ONE batched read of the pair balances ->
 *           at most two /quote/pair -> approve + swap per wallet at
 *           consecutive nonces -> ONE broadcast. Proceeds that stay in the
 *           pair token (a refusal) keep a lasting retry and a Convert action;
 *           an earlier visit's (pairLedger) are listed and converted only on
 *           a click
 *   nonces  'known' = already sent (never re-signed); 'low'/'high' -> resync
 *           from /wallets and re-sign ONCE; a 'low' sell whose balance already
 *           dropped is recorded as landed instead (re-signing would sell twice);
 *           a 'low' pair leg is rebuilt from a fresh balance read, never re-signed
 *   venue   the session follows the venue the server reports (a /wallets
 *           answer, a stream snapshot, a phase event): a graduation mid-session
 *           re-arms every wallet for the pool
 */
import { fmtUnits, quoteSymbol, quoteDecimals, errText } from './format.js';
import { buildQuoteCache, quotesForClick, walkCurve, classifyError, hasPairLeg, gasNeeded, toTxRequest, resolveMissed, chunkByWallet } from './sellMath.js';
// Pure pool-quote helpers of Task 10's planner (no network, no keys). A pool
// floor must come from attachQuotes: planSell treats a bare /quote row — one
// without worstOut — as 'no quote' (Task 10 contract notes 4 and 5).
import { sellRequests, attachQuotes, SKIP } from '../chain/plan.js';
import { MAX_ROUTE_IMPACT_BPS } from '../chain/constants.js';

const lower = (a) => String(a || '').toLowerCase();
const sub = (a, b) => (a > b ? a - b : 0n);
const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const READ_CHUNK = 100;
const BROADCAST_MAX = 100;
// The backend quotes at most this many sells per /quote (api.js, quote.js). The
// tab's own sells still in flight ride along as `ahead`, never as a row.
const MAX_QUOTE_ROWS = 100;
const MISSED_AFTER_MS = 20_000;
const DROP_AFTER_MS = 60_000;
const EARLY_KEEP_MS = 30_000;
const PAIR_DEADLINE_S = 300;
// Receipts of one click arrive within a few hundred ms of each other: their
// follow-up reads (arm confirmations, pair legs) are collected this long and
// sent as ONE request, not one per wallet (nginx allows 10 r/s per visitor).
const BATCH_MS = 250;
// A refused pair leg is retried after this long, doubling, capped.
const PAIR_BACKOFF_MS = 15_000;
const PAIR_BACKOFF_MAX_MS = 600_000;
// A pair balance below what the landed sells guarantee is a node behind them
// (the nonce and the balances are separate requests, maybe separate nodes): the
// leg waits for a read that holds them. Only a shortfall that holds across reads
// for this long is believed (the proceeds left another way, or a leg of ours
// landed unseen) — never one read.
const SHORT_TRUST_MS = 60_000;
// A pair batch the route refuses for price impact is halved (smallest legs
// first) at most this many times per flush; the legs set aside are re-batched
// after PAIR_SPLIT_MS, once the part that passed has moved the route.
const MAX_PAIR_SPLITS = 4;
const PAIR_SPLIT_MS = 5_000;
// The preview's quote cache (pools): refreshed this often while visible, and
// trusted this long. It never sizes a floor.
const PREVIEW_REFRESH_MS = 5_000;
const PREVIEW_MAX_AGE_MS = 10_000;
const QUOTE_BACKOFF_MS = 30_000;
// A curve mark is stale when no live stream has carried it for this long, or
// when the stream has shown trades newer than it for this long.
const MARK_OFFLINE_MS = 5_000;
const MARK_LAG_MS = 1_500;
// A full load may raise a wallet's optimistic balance only this long after
// its last landed sell (a read served a block behind would hand the sold
// tokens back).
const LANDED_SETTLE_MS = 10_000;
// planArm's per-wallet reasons (chain/plan.js SKIP.NO_GAS / SKIP.UNREAD, Task 10).
const ARM_NO_GAS = SKIP.NO_GAS;
const ARM_UNREAD = SKIP.UNREAD;

export function createSession({
  venue: venue0,
  mark: mark0,
  fees: fees0,
  slippageBps: slip0 = 1500,
  own,
  hub,
  deps,
  onView = () => {},
  onVenue = () => {},
}) {
  let venue = venue0;
  let mark = mark0 || null;
  let fees = fees0;
  let slippageBps = slip0;
  const ownSets = own || { txs: new Set(), addrs: new Set() };
  const nonces = new deps.NonceBook();

  const W = new Map(); // lower address -> wallet record
  let order = []; // lower addresses, load order = the fixed sell order
  const pending = new Map(); // lower hash -> op
  const early = new Map(); // receipts that beat their broadcast reply
  const seen = new Set();
  const walk = []; // curve sells not yet reflected in the streamed mark
  const pairs = new Map(); // lower address -> pair-leg state
  // Rows removeRows set aside while something of theirs was in flight: out of
  // `order` (never listed, chosen, quoted, armed or re-read) but still in W, so
  // their receipts land, their sells still count as `ahead` in a pool quote, and
  // a wallet loaded again meanwhile keeps them. tick() drops a row once settled.
  const leaving = new Set();
  let cache = null;
  let cacheGen = 0;
  let quoting = false;
  let quoteBackoffUntil = 0;
  let ticks = 0;
  let timer = null;
  let settleTimer = null;
  const settleKeys = new Set();
  const resyncKeys = new Set();
  let resyncQueued = false;
  const armQueue = new Set();
  let armTimer = null;
  const pairQueue = new Set();
  let pairTimer = null;
  let lock = Promise.resolve();
  let emitQueued = false;
  let disposed = false;
  let opSeq = 0;
  let venueMoving = false;
  // mark freshness (curve floors are priced from it)
  let markAt = deps.now();
  let live = false;
  let tradeBlock = null;
  let tradeAt = 0;
  // the chain's clock: deadlines and Permit2 expiries never trust the PC clock
  let clockOffsetMs = 0;
  let clockWarned = false;

  const now = () => deps.now();
  const nowSec = () => Math.floor((deps.now() + clockOffsetMs) / 1000);
  const qSym = () => quoteSymbol(venue);
  const qDec = () => quoteDecimals(venue);
  const pairSym = () => venue.pairSymbol || 'pair';
  const tokFmt = (v) => fmtUnits(v, venue.decimals, 2);
  const isPool = () => venue.kind !== 'curve';
  // Token-quoted curves AND token-quoted graduated pools (e.g. SPCX) pay out the
  // pair token; v1 pools pair with WETH and unwrap in the sell. Same rule as
  // chain/plan.js pairLegGas, whose 'no gas' check reserves this leg's gas.
  const isPairLeg = () => hasPairLeg(venue);
  const sleep = (ms) => (deps.sleep ? deps.sleep(ms) : new Promise((r) => deps.setTimeout(r, ms)));
  const say = (message, kind = 'info') => {
    if (hub) hub.emit('toast', { message, kind });
  };
  const refused = (reason, skipped = []) => ({ sent: 0, failed: 0, skipped, reason });
  /**
   * A pool /quote body for `pct` % of each wallet's optimistic balance, in
   * chain/plan.js sellRequests form: largest first (the backend quotes
   * cumulatively in this order), zero sells and dust left out.
   */
  const poolBody = (list, pct) =>
    sellRequests({ wallets: list.map((w) => ({ address: w.address, tokenBalance: w.optimistic.toString() })), pct });
  /** A /quote answer joined to its body: rows with the worst-order floor (worstOut). Throws on a mismatch. */
  const attached = (body, res) => [...attachQuotes(body, (res && res.quotes) || []).values()];

  /** Nonce allocation + signing never interleave between two operations. */
  function withLock(fn) {
    const run = lock.then(() => fn());
    lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function emit() {
    if (emitQueued || disposed) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      if (!disposed) onView(view());
    });
  }

  function canSell(w) {
    return w.ticked && w.optimistic > 0n && w.needsArm === false && !w.gasShort && !w.armError;
  }

  function pair(key) {
    let p = pairs.get(key);
    if (!p) {
      p = {
        baseline: null, // the pair balance the automatic leg leaves alone (the visitor's own + carried); null = not read yet
        owedMin: 0n, // a lower bound of this session's proceeds still in the wallet: landed minimum-outs less what landed legs covered
        credit: 0n, // landed legs' amounts beyond the owedMin they covered: proceeds of sells whose receipts are still to come
        measured: 0n, // the last fresh read's balance above the baseline
        shortSince: 0, // when reads first came back below owedMin (0: they do not)
        minNonce: 0, // a read below this nonce predates a landed op of ours
        touched: false, // a sell of this wallet was sent: the baseline can no longer be read
        carried: 0n, // an earlier visit's unconverted proceeds (pairLedger): converted only on a click
        manual: false, // the queued leg is the visitor's Convert click: carried proceeds go too
        running: false,
        again: false,
        retryAt: 0,
        backoffMs: 0,
      };
      pairs.set(key, p);
    }
    return p;
  }

  /** This session's pair-token proceeds still to be turned into ETH (the automatic leg's amount). */
  const pendingOf = (p) => max(p.measured, p.owedMin);
  /** Everything a row offers to convert: this session's proceeds and an earlier visit's. */
  const convertibleOf = (p) => pendingOf(p) + p.carried;

  /** What React sees: addresses, balances and statuses. Nothing else. */
  function view() {
    const legs = isPairLeg();
    const rows = order
      .map((k) => W.get(k))
      .filter(Boolean)
      .map((w) => {
        const p = legs ? pairs.get(w.key) : null;
        const owed = p ? convertibleOf(p) : 0n;
        return {
          address: w.address,
          ticked: w.ticked,
          tokens: w.optimistic.toString(),
          ethBalance: String(w.state.ethBalance ?? '0'),
          status: w.status,
          detail: w.detail,
          hash: w.hash,
          needsArm: w.needsArm === true,
          gasShort: w.gasShort,
          canSell: canSell(w),
          pairPending: owed.toString(),
          canConvert: !!p && owed > 0n && !p.running,
        };
      });
    let tokens = 0n;
    let ticked = 0;
    let sellable = 0;
    let arming = 0;
    let failedArm = 0;
    let convertible = 0;
    for (const r of rows) {
      if (r.ticked) {
        ticked += 1;
        tokens += BigInt(r.tokens);
        if (r.canSell) sellable += 1;
      }
      if (r.status === 'arming') arming += 1;
      if (r.status === 'failed' && r.needsArm) failedArm += 1;
      if (r.canConvert) convertible += 1;
    }
    return { rows, totals: { tokens: tokens.toString(), ticked, sellable, arming, failedArm, convertible } };
  }

  function setRow(w, status, detail = '', hash) {
    if (!w) return;
    w.status = status;
    w.detail = detail;
    if (hash !== undefined) w.hash = hash;
  }

  /**
   * needsArm via planArm itself on a scratch nonce book (one source of truth),
   * then the gas check. planArm's entry for the wallet decides (Task 10
   * contract note 6):
   *   txs planned                -> needs approval; planArm already checked the
   *                                 wallet can pay for them AND one sell
   *   txs [], reason 'no gas'    -> needs approval it cannot pay for: flagged
   *                                 with the ETH it needs, never armed, never 'ready'
   *   txs [], 'state unavailable'-> a field the server could not read: flagged
   *                                 until a re-read (Refresh) reads it
   *   left out                   -> armed (or empty): the sell's own gas check,
   *                                 sell + the pair leg (= planSell's 'no gas' rule)
   * An empty `txs` is never read as "no approval needed".
   */
  function computeNeeds(w) {
    w.armError = null;
    let entry = null;
    try {
      const scratch = new deps.NonceBook();
      scratch.seed(w.address, Number(w.state.nonce) || 0);
      const plans = deps.planArm({ venue, wallets: [w.state], fees, nonces: scratch, now: nowSec() }) || [];
      entry = plans.find((p) => p && lower(p.address) === w.key) || null;
    } catch (e) {
      w.needsArm = null; // unknown: not sellable, and a Retry cannot fix a planning error
      w.gasShort = null;
      w.armError = `cannot plan the approval: ${errText(e)}`;
      return;
    }
    if (entry && entry.reason === ARM_UNREAD) {
      w.needsArm = null;
      w.gasShort = null;
      w.armError = 'wallet state unavailable — press Refresh';
      return;
    }
    const planned = !!entry && Array.isArray(entry.txs) && entry.txs.length > 0;
    const noGas = !!entry && !planned && entry.reason === ARM_NO_GAS;
    w.needsArm = planned || noGas;
    try {
      const need = gasNeeded(venue, fees, { needsArm: w.needsArm });
      let short;
      if (noGas) short = true;
      else if (planned) short = false; // planArm signed off on approvals + one sell
      else short = BigInt(w.state.ethBalance ?? 0) < need;
      w.gasShort = short ? `needs ${fmtUnits(need, 18, 6)} ETH for gas` : null;
    } catch {
      w.gasShort = noGas ? 'not enough ETH for the approvals and one sell' : null;
    }
  }

  /** The status a row rests at when nothing of its own is in flight. */
  function rest(w) {
    if (w.armError) return setRow(w, 'failed', w.armError);
    if (w.gasShort) return setRow(w, 'skipped', w.gasShort);
    if (w.needsArm) return setRow(w, 'idle', w.ticked ? 'needs approval' : 'not ticked');
    return setRow(w, 'ready', '');
  }

  function applyState(w, ws, { exact }) {
    w.state = ws;
    w.address = ws.address || w.address;
    let bal = 0n;
    try {
      bal = BigInt(ws.tokenBalance ?? 0);
    } catch {
      bal = 0n;
    }
    const fresh = sub(bal, w.inflight);
    // A re-read may lag the chain; outside a full load it can only LOWER the optimistic balance.
    w.optimistic = exact ? fresh : fresh < w.optimistic ? fresh : w.optimistic;
    // A pair baseline that did not read at load is taken from the first read that
    // cannot yet hold this page's proceeds (no sell of the wallet has been sent).
    if (isPairLeg() && ws.pairBalance !== undefined && ws.pairBalance !== null) {
      const p = pair(w.key);
      if (p.baseline === null && !p.touched) p.baseline = sub(BigInt(ws.pairBalance), p.owedMin);
    }
    computeNeeds(w);
  }

  // ── the venue ──────────────────────────────────────────────────────────────
  /** A report of this token's venue that the session has not followed yet. A phase only moves forward: curve -> pool. */
  function moved(v) {
    return !!v && lower(v.token) === lower(venue.token) && venue.kind === 'curve' && v.kind === 'graduated';
  }

  function venueChanged() {
    return new Error('the token moved to a new venue — re-reading', { cause: { code: 'venue_changed' } });
  }

  async function readStates(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += READ_CHUNK) {
      const addrs = keys.slice(i, i + READ_CHUNK).map((k) => (W.get(k) ? W.get(k).address : k));
      const res = await deps.api.postWallets(venue.token, addrs);
      // /wallets reports the venue its allowances are read against. States read
      // for a pool must never be judged against the curve: follow the venue, and
      // let the reload it triggers read them again.
      if (res && moved(res.venue)) {
        const v = res.venue;
        queueMicrotask(() => {
          applyVenue(v).catch(() => {});
        });
        throw venueChanged();
      }
      out.push(...((res && res.wallets) || []));
    }
    return out;
  }

  /**
   * Follow a venue the server reports for this token. Only a curve -> pool
   * graduation is followed; the same venue, another token or a step backwards
   * is ignored. Re-arms every wallet for the new spender.
   * @returns {Promise<boolean>} whether the session moved
   */
  async function applyVenue(v) {
    if (disposed || venueMoving || !moved(v)) return false;
    venueMoving = true;
    try {
      venue = v;
      cache = null;
      cacheGen += 1;
      walk.length = 0;
      for (const w of W.values()) w.armTried = false;
      onVenue(v);
      say(`${v.symbol || 'The token'} moved to a new venue — re-arming the wallets.`);
      await loadWallets(order.map((k) => W.get(k).address));
    } finally {
      venueMoving = false;
    }
    return true;
  }

  /**
   * Put a wallet's nonce book back on the chain after a failure consumed a
   * nonce locally that never reached it. Queued and batched: a refused
   * 100-wallet broadcast costs ONE /wallets read, not a hundred. A wallet that
   * signed again after the read began is left alone — its own error path
   * resyncs it.
   */
  function resync(key) {
    resyncKeys.add(key);
    if (resyncQueued) return;
    resyncQueued = true;
    queueMicrotask(() => {
      resyncQueued = false;
      const keys = [...resyncKeys].filter((k) => W.has(k));
      resyncKeys.clear();
      if (keys.length) resyncMany(keys);
    });
  }

  async function resyncMany(keys) {
    const seqs = new Map(keys.map((k) => [k, W.get(k).sendSeq]));
    try {
      const states = await readStates(keys);
      for (const ws of states) {
        const w = W.get(lower(ws.address));
        if (!w || w.sendSeq !== seqs.get(w.key)) continue;
        nonces.resync(w.address, Number(ws.nonce) || 0);
        applyState(w, ws, { exact: false });
      }
      noteNonces(keys);
      emit();
    } catch {
      // The next send's own nonce error resyncs it.
    }
  }

  /**
   * The proceeds an earlier visit left in the pair token (pairLedger), as far as
   * this fresh read can vouch for them:
   *   - dropped when the wallet has sent a transaction since that this page did
   *     not (its nonce moved past the one recorded): the visitor may have moved
   *     them out and bought pair tokens to hold;
   *   - clamped to what the wallet holds above its own pair tokens (the recorded
   *     balance less the recorded proceeds);
   *   - not listed when the read lacks a nonce or a pair balance (the entry stays).
   * The session never converts them on its own: only a Convert click does.
   */
  function carriedFrom(ws) {
    const L = deps.pairLedger;
    const e = L ? L.get(venue.pairToken, ws.address) : null;
    if (!e || e.owed <= 0n) return 0n;
    const n = ws.nonce === null || ws.nonce === undefined ? NaN : Number(ws.nonce);
    if (ws.pairBalance === undefined || ws.pairBalance === null || !Number.isSafeInteger(n)) return 0n;
    let keep = 0n;
    if (e.nonce !== null && e.bal !== null && n <= e.nonce) keep = min(e.owed, sub(BigInt(ws.pairBalance), sub(e.bal, e.owed)));
    if (keep !== e.owed) L.set(venue.pairToken, ws.address, keep, { nonce: e.nonce ?? undefined, bal: e.bal === null ? undefined : sub(e.bal, e.owed - keep) });
    return keep;
  }

  async function loadWallets(addresses) {
    const keys = [...new Set((addresses || []).map(lower))].filter((k) => ADDRESS.test(k));
    if (!keys.length) {
      emit();
      return;
    }
    let states;
    try {
      states = await readStates(keys);
    } catch (e) {
      if (e && e.cause && e.cause.code === 'venue_changed') return; // applyVenue reloads
      throw e;
    }
    const legs = isPairLeg();
    for (const ws of states) {
      const key = lower(ws && ws.address);
      if (!ADDRESS.test(key)) continue;
      let w = W.get(key);
      if (!w) {
        let bal = 0n;
        try {
          bal = BigInt(ws.tokenBalance ?? 0);
        } catch {
          bal = 0n;
        }
        // Proceeds an earlier visit left in the pair token, checked against this read.
        const carried = legs ? carriedFrom(ws) : 0n;
        if (bal <= 0n && carried <= 0n) continue; // the table lists holders (and unconverted proceeds) only
        w = {
          key,
          address: ws.address,
          ticked: true,
          status: 'idle',
          detail: '',
          hash: null,
          inflight: 0n,
          optimistic: 0n,
          ops: 0,
          sendSeq: 0,
          armTried: false,
          needsArm: null,
          gasShort: null,
          armError: null,
          landedAt: 0,
          state: ws,
        };
        W.set(key, w);
        order.push(key);
        nonces.seed(ws.address, Number(ws.nonce) || 0);
        if (legs) {
          const p = pair(key);
          // The automatic leg leaves the whole balance alone — the visitor's own pair
          // tokens AND the carried proceeds, which only a Convert click swaps.
          p.carried = carried;
          if (ws.pairBalance !== undefined && ws.pairBalance !== null) p.baseline = BigInt(ws.pairBalance);
        }
        applyState(w, ws, { exact: true });
        if (legs && carried > 0n) persistPair(key); // re-dated, at this read's nonce
      } else {
        // Loaded again before its sells settled (removeRows): listed again, with
        // those sells still in flight — never its chain balance as sellable.
        if (leaving.delete(key)) order.push(key);
        // A read a block behind must not hand back tokens a sell that just landed took.
        applyState(w, ws, { exact: now() - w.landedAt > LANDED_SETTLE_MS });
      }
      if (w.ops === 0) {
        w.armTried = false;
        rest(w);
      }
    }
    emit();
    await arm();
  }

  function pickArm(retry) {
    return order
      .map((k) => W.get(k))
      .filter(
        (w) =>
          w &&
          w.ticked &&
          w.needsArm === true &&
          !w.armError &&
          !w.gasShort &&
          w.ops === 0 &&
          (retry ? w.status === 'failed' || w.status === 'idle' : w.status === 'idle' && !w.armTried)
      );
  }

  async function arm({ retry = false } = {}) {
    let cands = pickArm(retry);
    if (!cands.length) return;
    if (retry) {
      // A retry never re-signs an approval that already landed: read first.
      try {
        const states = await readStates(cands.map((w) => w.key));
        for (const ws of states) {
          const w = W.get(lower(ws.address));
          if (w && w.ops === 0) applyState(w, ws, { exact: w.inflight === 0n });
        }
      } catch {
        // plan from what we have
      }
      for (const w of cands) if (w.ops === 0 && w.needsArm !== true) rest(w);
      cands = pickArm(true);
      if (!cands.length) {
        emit();
        return;
      }
    }
    for (const w of cands) {
      w.armTried = true;
      setRow(w, 'arming', 'signing approvals', null);
    }
    emit();
    const raws = [];
    const metas = [];
    try {
      await withLock(async () => {
        const plans = deps.planArm({ venue, wallets: cands.map((w) => w.state), fees, nonces, now: nowSec() }) || [];
        for (const p of plans) {
          const w = W.get(lower(p.address));
          if (!w) continue;
          const txs = p.txs || [];
          if (!txs.length) continue;
          w.sendSeq += 1;
          try {
            const signed = [];
            for (const tx of txs) signed.push(await deps.store.signTx(w.address, tx));
            signed.forEach((raw, i) => {
              w.ops += 1;
              raws.push(raw);
              metas.push({ id: ++opSeq, kind: 'arm', key: w.key, tx: txs[i] });
            });
          } catch (e) {
            setRow(w, 'failed', `approval not signed: ${errText(e)}`);
            resync(w.key);
          }
        }
      });
    } catch (e) {
      for (const w of cands) {
        setRow(w, 'failed', `approval not planned: ${errText(e)}`);
        resync(w.key);
      }
      emit();
      return;
    }
    for (const w of cands) if (w.status === 'arming' && !metas.some((m) => m.key === w.key)) rest(w);
    if (raws.length) await send(raws, metas);
    else emit();
  }

  function registered(m) {
    const w = W.get(m.key);
    pending.set(m.hash, m);
    if (m.kind === 'sell') {
      ownSets.txs.add(m.hash);
      setRow(w, 'sent', `selling ${tokFmt(m.amount)} (${m.pct}%)`, m.hash);
    } else if (m.kind === 'arm') {
      setRow(w, 'arming', 'approval sent', m.hash);
    } else if (m.kind === 'pairSwap') {
      setRow(w, 'sent', `swapping ${fmtUnits(m.amount, qDec(), 4)} ${pairSym()} → ETH`, m.hash);
    }
    const e = early.get(m.hash);
    if (e) {
      early.delete(m.hash);
      onReceipt(e.receipt);
    }
  }

  function failed(m, error) {
    m.failed = true;
    const w = W.get(m.key);
    if (!w) return;
    w.ops = Math.max(0, w.ops - 1);
    if (m.kind === 'sell') {
      w.inflight = sub(w.inflight, m.amount);
      w.optimistic += m.amount;
      dropWalk(m);
    }
    const why = classifyError(error) === 'funds' ? 'not enough ETH for gas' : errText(error);
    if (m.kind === 'pairSwap') {
      const p = pair(m.key);
      p.running = false;
      p.manual = false; // a refused click needs a new click for the carried proceeds
      backoff(p);
      persistPair(m.key); // what the ledger took as swapped is owed again
      setRow(w, 'failed', `${pairSym()} → ETH not sent: ${why} — retrying`, m.hash || null);
    } else {
      setRow(w, 'failed', why, m.hash || null);
    }
    resync(m.key);
  }

  async function send(raws, metas, t0 = now()) {
    const chunks = chunkByWallet(metas, BROADCAST_MAX);
    const replyP = Promise.all(
      chunks.map((idx) =>
        deps.api.broadcast(
          venue.token,
          idx.map((i) => raws[i])
        ).then(
          (res) => ({ idx, results: (res && res.results) || [] }),
          (e) => ({ idx, results: idx.map(() => ({ ok: false, error: errText(e) })) })
        )
      )
    );
    emit(); // paint "sent" while the request is in flight — after the fetch has started
    const replies = await replyP;
    const retry = [];
    const newOwn = [];
    for (const { idx, results } of replies) {
      idx.forEach((i, j) => {
        const m = metas[i];
        const r = results[j] || { ok: false, error: 'no result from the server' };
        let hash = r.hash ? lower(r.hash) : null;
        if (!hash) {
          try {
            hash = lower(deps.hashOf(raws[i]));
          } catch {
            hash = null;
          }
        }
        m.hash = hash;
        m.t0 = t0;
        m.sentAt = now();
        const kind = r.ok ? 'ok' : classifyError(r.error);
        if ((kind === 'ok' || kind === 'known') && hash) {
          registered(m);
          if (m.kind === 'sell') newOwn.push(hash);
          return;
        }
        if ((kind === 'low' || kind === 'high') && !m.retried) {
          retry.push({ m, kind });
          return;
        }
        failed(m, r.error || 'rejected');
      });
    }
    if (newOwn.length && hub) hub.emit('own', newOwn);
    if (retry.length) await retryNonce(retry);
    noteNonces(metas.map((m) => m.key));
    emit();
  }

  /**
   * The ledger's entries of these wallets (any pair token) now expect the nonce
   * this page signs with next: its own sends — on any token — never make an
   * earlier visit's proceeds look moved by someone else.
   */
  function noteNonces(keys) {
    if (!deps.pairLedger || !deps.pairLedger.touch) return;
    const list = [];
    for (const key of new Set(keys)) {
      const w = W.get(key);
      const n = w ? nonces.peek(w.address) : undefined;
      if (Number.isSafeInteger(n)) list.push({ address: w.address, nonce: n });
    }
    if (list.length) deps.pairLedger.touch(list);
  }

  async function retryNonce(list) {
    const keys = [...new Set(list.map((x) => x.m.key))];
    let states;
    try {
      states = await readStates(keys);
    } catch (e) {
      for (const { m } of list) failed(m, `nonce resync failed: ${errText(e)}`);
      return;
    }
    const byKey = new Map(states.map((s) => [lower(s.address), s]));
    const redo = [];
    const rebuild = new Map(); // key -> the leg was the visitor's Convert click
    for (const { m, kind } of list) {
      const ws = byKey.get(m.key);
      if (!ws) {
        failed(m, 'wallet state unavailable');
        continue;
      }
      if (m.kind === 'sell' && kind === 'low' && resolveMissed({ before: m.before, amount: m.amount, fresh: ws.tokenBalance ?? 0 }) === 'landed') {
        // The nonce is used AND the balance already dropped by this sell: it landed. Re-signing would sell twice.
        const w = W.get(m.key);
        if (w) {
          w.ops = Math.max(0, w.ops - 1);
          w.inflight = sub(w.inflight, m.amount);
          w.landedAt = now();
          setRow(w, 'landed', `sold ${tokFmt(m.amount)} · receipt not seen`, m.hash);
        }
        dropWalk(m);
        if (isPairLeg()) sellLanded(m);
        continue;
      }
      if (m.kind === 'pairApprove' || m.kind === 'pairSwap') {
        // Never re-sign a pair leg: its amount came from a balance read that a
        // leg which DID land would make wrong (it would swap the visitor's own
        // pair tokens). Rebuild it from a fresh read instead.
        const w = W.get(m.key);
        if (w) w.ops = Math.max(0, w.ops - 1);
        if (m.kind === 'pairSwap') pair(m.key).running = false;
        rebuild.set(m.key, rebuild.get(m.key) || !!m.manual);
        continue;
      }
      redo.push({ m, ws });
    }
    if (rebuild.size) {
      await withLock(async () => {
        for (const key of rebuild.keys()) {
          const w = W.get(key);
          const ws = byKey.get(key);
          if (w && ws) nonces.resync(w.address, Number(ws.nonce) || 0);
        }
      });
      for (const [key, manual] of rebuild) queuePair(key, { now: true, manual });
    }
    if (!redo.length) return;
    const raws = [];
    const metas = [];
    await withLock(async () => {
      for (const key of new Set(redo.map((x) => x.m.key))) {
        const w = W.get(key);
        const ws = byKey.get(key);
        nonces.resync(w.address, Number(ws.nonce) || 0);
        applyState(w, ws, { exact: false });
      }
      redo.sort((a, b) => Number(a.m.tx.nonce) - Number(b.m.tx.nonce));
      for (const { m } of redo) {
        const w = W.get(m.key);
        const tx = { ...m.tx, nonce: nonces.next(w.address) };
        w.sendSeq += 1;
        try {
          raws.push(await deps.store.signTx(w.address, tx));
          metas.push({ ...m, tx, retried: true, hash: null });
        } catch (e) {
          failed(m, `re-sign failed: ${errText(e)}`);
        }
      }
    });
    if (raws.length) await send(raws, metas);
  }

  // ── the curve mark ─────────────────────────────────────────────────────────
  function effectiveMark() {
    if (venue.kind !== 'curve' || !mark || mark.quoteReserve === undefined || mark.quoteReserve === null) return mark;
    const hasBlock = mark.block !== undefined && mark.block !== null;
    const amounts = walk.filter((e) => e.block === null || (hasBlock && e.block > mark.block)).map((e) => e.amount);
    return amounts.length ? walkCurve(mark, amounts) : mark;
  }

  function dropWalk(m) {
    const i = walk.findIndex((e) => e.id === m.id);
    if (i >= 0) walk.splice(i, 1);
  }

  function setWalkBlock(m, block) {
    const e = walk.find((x) => x.id === m.id);
    if (!e) return;
    if (block === null || block === undefined) dropWalk(m);
    else e.block = Number(block);
  }

  function onMark(m) {
    if (!m) return;
    mark = m;
    markAt = now();
    if (m.block === undefined || m.block === null) return;
    for (let i = walk.length - 1; i >= 0; i -= 1) if (walk[i].block !== null && walk[i].block <= m.block) walk.splice(i, 1);
  }

  /** The stream is up (true) or down (false). While up, it carries every new mark. */
  function setLive(on) {
    live = !!on;
    if (live) markAt = now();
  }

  /** Trades the stream delivered: a mark older than them is behind the curve. */
  function onTrades(list) {
    for (const t of Array.isArray(list) ? list : []) {
      const b = Number(t && t.block);
      if (Number.isFinite(b) && (tradeBlock === null || b > tradeBlock)) {
        tradeBlock = b;
        tradeAt = now();
      }
    }
  }

  /** A curve floor must not be priced from this mark: none, no live stream carrying it, or behind trades seen. */
  function markStale() {
    if (venue.kind !== 'curve') return false;
    if (!mark || mark.quoteReserve === undefined || mark.quoteReserve === null) return true;
    const t = now();
    if (!live && t - markAt > MARK_OFFLINE_MS) return true;
    const mb = mark.block === undefined || mark.block === null ? null : Number(mark.block);
    return tradeBlock !== null && mb !== null && tradeBlock > mb && t - tradeAt > MARK_LAG_MS;
  }

  // ── arm confirmation, batched ──────────────────────────────────────────────
  function queueConfirm(key) {
    const w = W.get(key);
    if (!w) return;
    setRow(w, 'arming', 'approval landed — checking the allowance');
    armQueue.add(key);
    if (armTimer === null) {
      armTimer = deps.setTimeout(() => {
        armTimer = null;
        confirmArms();
      }, BATCH_MS);
    }
    emit();
  }

  /** ONE read for every approval that landed together; the short ones are re-read, never re-signed. */
  async function confirmArms() {
    let keys = [...armQueue].filter((k) => W.has(k));
    armQueue.clear();
    const armedFor = venue;
    let lastError = null;
    for (let attempt = 0; attempt < 4 && keys.length; attempt += 1) {
      if (attempt) await sleep(500 * attempt);
      if (venue !== armedFor) return; // a graduation re-arms every wallet for the new spender
      let states;
      try {
        states = await readStates(keys);
        lastError = null;
      } catch (e) {
        lastError = e;
        continue;
      }
      const byKey = new Map(states.map((s) => [lower(s.address), s]));
      const short = [];
      for (const k of keys) {
        const w = W.get(k);
        if (!w) continue;
        const ws = byKey.get(k);
        if (ws) applyState(w, ws, { exact: w.inflight === 0n });
        if (w.needsArm === false) {
          if (w.ops !== 0) continue;
          if (w.gasShort || w.armError) rest(w);
          else setRow(w, 'ready', 'approved');
        } else {
          short.push(k);
        }
      }
      keys = short;
      emit();
    }
    if (venue !== armedFor) return;
    for (const k of keys) {
      const w = W.get(k);
      if (!w || w.ops !== 0) continue;
      // A read that failed says nothing about the allowance: never a failed arm
      // (whose Retry would pay for a second approval), just a row to re-read.
      if (lastError) setRow(w, 'arming', 'approval landed — could not re-read the allowance; press Refresh');
      else setRow(w, 'failed', 'the approval landed but the allowance still reads short');
    }
    emit();
  }

  function scheduleSettle(key) {
    settleKeys.add(key);
    if (settleTimer !== null) return;
    settleTimer = deps.setTimeout(() => {
      settleTimer = null;
      settle();
    }, 600);
  }

  async function settle() {
    const keys = [...settleKeys];
    settleKeys.clear();
    if (!keys.length) return;
    try {
      const states = await readStates(keys);
      for (const ws of states) {
        const w = W.get(lower(ws.address));
        if (w) applyState(w, ws, { exact: false });
      }
      emit();
    } catch {
      // The next receipt or a Refresh re-reads.
    }
  }

  function onReceipt(r) {
    if (!r || !r.hash) return;
    const hash = lower(r.hash);
    if (seen.has(hash)) return;
    const m = pending.get(hash);
    if (!m) {
      early.set(hash, { receipt: r, at: now() }); // maybe ours, before the broadcast reply; else another visitor's
      return;
    }
    seen.add(hash);
    pending.delete(hash);
    const w = W.get(m.key);
    if (w) w.ops = Math.max(0, w.ops - 1);
    const ok = r.status === 'landed';
    const ms = now() - (m.t0 || m.sentAt || now());
    const where = r.block === null || r.block === undefined ? 'receipt not seen' : `block ${r.block} · ${ms} ms`;
    if (m.kind === 'arm') {
      if (!ok) setRow(w, 'failed', 'approval reverted', hash);
      else if (w && w.ops === 0) queueConfirm(m.key);
    } else if (m.kind === 'sell') {
      if (w) w.inflight = sub(w.inflight, m.amount);
      if (ok) {
        if (w) w.landedAt = now();
        setWalkBlock(m, r.block);
        setRow(w, 'landed', `sold ${tokFmt(m.amount)} · ≈ +${fmtUnits(m.expectedOut, qDec(), 4)} ${qSym()} · ${where}`, hash);
        if (isPairLeg()) sellLanded(m);
      } else {
        dropWalk(m);
        if (w) w.optimistic += m.amount;
        setRow(w, 'reverted', `price moved more than ${slippageBps / 100}% — tokens kept`, hash);
      }
      scheduleSettle(m.key);
    } else if (m.kind === 'pairApprove') {
      if (!ok) setRow(w, 'failed', `${pairSym()} approval reverted — ${pairSym()} kept in the wallet`, hash);
    } else if (m.kind === 'pairSwap') {
      const p = pair(m.key);
      p.running = false;
      if (ok) {
        // An earlier visit's proceeds it swapped leave the baseline with them.
        const c = min(m.carriedPart || 0n, p.carried);
        p.carried -= c;
        if (p.baseline !== null) p.baseline = sub(p.baseline, c);
        // This session's part covers what was owed; the rest — proceeds of sells
        // whose receipts have not arrived yet — is a credit their receipts use up,
        // so a late receipt never asks for a second leg of proceeds already swapped.
        const auto = sub(m.amount, c);
        const covered = min(p.owedMin, auto);
        p.owedMin -= covered;
        p.credit += auto - covered;
        p.measured = sub(p.measured, auto);
        p.minNonce = Math.max(p.minNonce, Number(m.tx.nonce) + 1);
        p.backoffMs = 0;
        p.retryAt = 0;
        persistPair(m.key);
        setRow(w, 'landed', `${pairSym()} → ETH done · ${where}`, hash);
      } else {
        backoff(p);
        persistPair(m.key); // owed again
        setRow(w, 'reverted', `${pairSym()} → ETH swap reverted — ${pairSym()} kept in the wallet; retrying`, hash);
      }
      if (p.again) {
        p.again = false;
        queuePair(m.key);
      }
      scheduleSettle(m.key);
    }
    emit();
  }

  // ── the pair -> ETH leg ────────────────────────────────────────────────────
  function sellLanded(m) {
    const p = pair(m.key);
    // A leg that already swapped this sell's proceeds (its receipt came late) left a credit.
    const used = min(p.credit, m.minOut);
    p.credit -= used;
    p.owedMin += m.minOut - used;
    p.shortSince = 0; // a shortfall seen before these proceeds says nothing about them
    p.minNonce = Math.max(p.minNonce, Number(m.tx.nonce) + 1);
    persistPair(m.key);
    queuePair(m.key);
  }

  /**
   * Remember what this wallet is owed across a token switch or a reload
   * (pairLedger): the proceeds, the balance the page expects (its own pair
   * tokens + the proceeds) and the nonce it signs with next. `less`: a leg about
   * to be sent — written as if it will land, so a page closed before its receipt
   * never counts those proceeds twice; a revert or a refusal writes them back.
   */
  function persistPair(key, less = { auto: 0n, carried: 0n }) {
    const w = W.get(key);
    if (!w || !deps.pairLedger || !isPairLeg()) return;
    const p = pair(key);
    const owed = sub(pendingOf(p), less.auto) + sub(p.carried, less.carried);
    const own = p.baseline === null ? 0n : sub(p.baseline, p.carried);
    const n = nonces.peek(w.address);
    deps.pairLedger.set(venue.pairToken, w.address, owed, { nonce: Number.isSafeInteger(n) ? n : Number(w.state.nonce) || 0, bal: own + owed });
  }

  function backoff(p) {
    p.backoffMs = p.backoffMs ? Math.min(p.backoffMs * 2, PAIR_BACKOFF_MAX_MS) : PAIR_BACKOFF_MS;
    p.retryAt = now() + p.backoffMs;
  }

  function refusePair(key, why) {
    const p = pair(key);
    p.running = false;
    p.manual = false; // a refused click needs a new click for the carried proceeds
    backoff(p);
    persistPair(key); // anything written as if a leg would land is owed again
    const w = W.get(key);
    if (w && w.ops === 0) setRow(w, 'failed', why);
  }

  /** A leg set aside from a batch the route refused whole: re-batched after PAIR_SPLIT_MS (the tick), keeping its click. */
  function deferPair(l) {
    const p = pair(l.key);
    p.running = false;
    p.manual = l.manual;
    p.retryAt = now() + PAIR_SPLIT_MS;
  }

  /**
   * Queue a wallet's pair leg for the next batch.
   *   manual  the visitor pressed Convert: no backoff wait, and an earlier visit's proceeds go too
   *   now     no backoff wait (a leg rebuilt after 'nonce too low')
   */
  function queuePair(key, { manual = false, now: soon = false } = {}) {
    // A wallet that left the tab (removeRows) has no key here to sign a leg
    // with: the pair ledger keeps what it is owed, and an import lists it with
    // Convert. Loaded again before its row went, the tick's retry queues it.
    if (disposed || !isPairLeg() || !W.has(key) || leaving.has(key)) return;
    const p = pair(key);
    if (manual) p.manual = true;
    if (manual || soon) {
      p.retryAt = 0;
      p.backoffMs = 0;
    }
    if (p.running) {
      p.again = true;
      return;
    }
    pairQueue.add(key);
    if (pairTimer !== null) return;
    pairTimer = deps.setTimeout(() => {
      pairTimer = null;
      flushPairs();
    }, BATCH_MS);
  }

  /**
   * How much of the pair token the automatic leg swaps for a wallet, from a read
   * whose nonce includes every landed op of ours (ws.nonce >= p.minNonce) — or
   * null when the read cannot be trusted yet:
   *   known baseline   the balance above it — never more (a swap of more would
   *                    take the visitor's own pair tokens). A balance below what
   *                    the landed sells guarantee (owedMin) is a node behind
   *                    them — the nonce and the balances are separate requests —
   *                    so it is re-read and never lowers owedMin on its own:
   *                    only a shortfall that holds across reads for
   *                    SHORT_TRUST_MS is believed
   *   baseline unread  at most the landed sells' minimum-outs (<= the proceeds)
   *   balance unread   the landed sells' minimum-outs
   */
  function measure(p, ws) {
    if (ws.pairBalance === undefined || ws.pairBalance === null) return p.owedMin;
    const bal = BigInt(ws.pairBalance);
    if (p.baseline === null) return min(p.owedMin, bal);
    const delta = sub(bal, p.baseline);
    if (delta < p.owedMin) {
      const t = now();
      if (!p.shortSince) p.shortSince = t;
      if (t - p.shortSince < SHORT_TRUST_MS) return null;
      p.owedMin = delta; // it held for a minute of reads: the proceeds left another way
    }
    p.shortSince = 0;
    p.measured = delta;
    return delta;
  }

  /**
   * The second leg of every sell whose proceeds are a pair token — a
   * token-quoted curve (AMZN) or a token-quoted graduated pool (SPCX): pair
   * token -> ETH in the same wallet, for every queued wallet at once.
   *
   * ONE read of the queued wallets (re-read up to twice while it predates a
   * landed op), ONE quote of the whole batch S and one of S - aMin (aMin the
   * smallest leg). The legs go out together and fill in any order, so each
   * leg's floor is priced as if it landed LAST: by concavity its output is at
   * least a x (Q(S) - Q(S - aMin)) / aMin, and the second quote (the best route
   * for S - aMin) can only make that bound lower. Then approve + swap per wallet
   * at consecutive nonces, all signed under one lock and sent in ONE broadcast
   * (chunkByWallet keeps a wallet's pair together).
   */
  async function flushPairs() {
    if (disposed || !isPairLeg()) return;
    const t = now();
    const due = [...pairQueue].filter((k) => {
      const p = pair(k);
      return W.has(k) && !leaving.has(k) && !p.running && t >= p.retryAt;
    });
    pairQueue.clear();
    if (!due.length) return;
    for (const k of due) pair(k).running = true;
    const legs = [];
    let waitFor = due;
    let readError = null;
    for (let attempt = 0; attempt < 3 && waitFor.length; attempt += 1) {
      if (attempt) await sleep(500);
      let states;
      try {
        states = await readStates(waitFor);
        readError = null;
      } catch (e) {
        readError = e;
        continue;
      }
      const byKey = new Map(states.map((s) => [lower(s.address), s]));
      const stale = [];
      for (const k of waitFor) {
        const w = W.get(k);
        const p = pair(k);
        const ws = byKey.get(k);
        if (!w || !ws) {
          stale.push(k);
          continue;
        }
        applyState(w, ws, { exact: false });
        const read = ws.pairBalance !== undefined && ws.pairBalance !== null;
        if (read && (Number(ws.nonce) || 0) < p.minNonce) {
          stale.push(k); // a node behind our own landed ops: its balance cannot be trusted
          continue;
        }
        const auto = measure(p, ws);
        if (auto === null) {
          stale.push(k); // below what our landed sells guarantee: a node behind them
          continue;
        }
        // A Convert click also swaps an earlier visit's proceeds — what the wallet
        // holds above the visitor's own pair tokens, never more.
        let carriedPart = 0n;
        if (p.manual && p.carried > 0n && read && p.baseline !== null) {
          carriedPart = min(p.carried, sub(sub(BigInt(ws.pairBalance), sub(p.baseline, p.carried)), auto));
        }
        const manual = p.manual;
        p.manual = false;
        persistPair(k);
        const amount = auto + carriedPart;
        if (amount > 0n) legs.push({ key: k, amount, carriedPart, manual, pairBefore: read ? BigInt(ws.pairBalance) : null });
        else p.running = false; // nothing (left) to convert
      }
      waitFor = stale;
    }
    for (const k of waitFor) {
      refusePair(k, readError ? `${pairSym()} → ETH not sent: ${errText(readError)} — retrying` : `${pairSym()} → ETH waiting for a fresh balance read — retrying`);
    }
    if (!legs.length) {
      emit();
      return;
    }

    // The route's impact guard, pinned here as in chain/plan.js planPairLeg
    // (MAX_ROUTE_IMPACT_BPS): the QuoterV2 saturates on an oversized input, so
    // minOut alone cannot see a drained pool (memory v3-token-quoted-route).
    // It judges the whole batch: a batch it refuses may pass in smaller pieces
    // (each wallet alone often does), so it is halved — smallest legs first —
    // and what passes converts now; the rest are re-batched shortly, never
    // quoted whole again. Only a leg too deep on its own waits out the backoff.
    let batch = [...legs].sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1));
    let S;
    let aMin;
    let q;
    let qRest = null;
    let tooDeep = false;
    for (let split = 0; ; split += 1) {
      S = batch.reduce((a, l) => a + l.amount, 0n);
      aMin = batch[0].amount;
      try {
        [q, qRest] = await Promise.all([
          deps.api.postPairQuote(venue.pairToken, S.toString()),
          batch.length > 1 ? deps.api.postPairQuote(venue.pairToken, (S - aMin).toString()) : Promise.resolve(null),
        ]);
      } catch (e) {
        for (const l of batch) refusePair(l.key, `${pairSym()} → ETH not sent: ${errText(e)} — retrying`);
        emit();
        return;
      }
      tooDeep = !!q && Number(q.impactBps) > MAX_ROUTE_IMPACT_BPS;
      if (!tooDeep || batch.length === 1 || split >= MAX_PAIR_SPLITS) break;
      let n = 0;
      let part = 0n;
      while (n < batch.length - 1 && part + batch[n].amount <= S / 2n) {
        part += batch[n].amount;
        n += 1;
      }
      for (const l of batch.slice(Math.max(n, 1))) deferPair(l);
      batch = batch.slice(0, Math.max(n, 1));
    }
    const full = q && q.ok === true && !tooDeep ? BigInt(q.amountOut ?? 0) : 0n;
    let tail = full;
    if (batch.length > 1) {
      const rest = qRest ? BigInt(qRest.amountOut ?? 0) : 0n;
      tail = rest > 0n ? sub(full, rest) : 0n;
    }
    if (full <= 0n || tail <= 0n) {
      const why = tooDeep ? `price impact over ${MAX_ROUTE_IMPACT_BPS / 100}%` : (q && q.reason) || 'no route to ETH';
      for (const l of batch) refusePair(l.key, `${pairSym()} kept in the wallet — ${why}; retrying later`);
      emit();
      return;
    }
    const raws = [];
    const metas = [];
    await withLock(async () => {
      for (const l of batch) {
        const w = W.get(l.key);
        const worst = (l.amount * tail) / aMin;
        const minOut = (worst * BigInt(10_000 - slippageBps)) / 10_000n;
        if (!w || minOut <= 0n) {
          refusePair(l.key, `${pairSym()} kept in the wallet — no route to ETH for this amount`);
          continue;
        }
        const n1 = nonces.next(w.address);
        const n2 = nonces.next(w.address);
        w.sendSeq += 1;
        try {
          const a = toTxRequest(deps.approveTx(venue.pairToken, deps.swapRouter, l.amount), { nonce: n1, gasLimit: fees.gasLimits.approve, fees });
          const s = toTxRequest(deps.pairToEthTx(q, l.amount, minOut, w.address, nowSec() + PAIR_DEADLINE_S), {
            nonce: n2,
            gasLimit: fees.gasLimits.pairSwap,
            fees,
          });
          const rawA = await deps.store.signTx(w.address, a);
          const rawS = await deps.store.signTx(w.address, s);
          raws.push(rawA, rawS);
          w.ops += 2;
          metas.push(
            { id: ++opSeq, kind: 'pairApprove', key: l.key, tx: a, manual: l.manual },
            { id: ++opSeq, kind: 'pairSwap', key: l.key, tx: s, amount: l.amount, carriedPart: l.carriedPart, manual: l.manual, pairBefore: l.pairBefore }
          );
          // Saved as if the swap will land: should the page close before its receipt,
          // the next visit leaves at worst these proceeds unconverted — never counts
          // them twice and swaps the visitor's own pair tokens. A revert or a refusal
          // writes them back (onReceipt, failed, refusePair).
          persistPair(l.key, { auto: l.amount - l.carriedPart, carried: l.carriedPart });
          setRow(w, 'sent', `swapping ${fmtUnits(l.amount, qDec(), 4)} ${pairSym()} → ETH`);
        } catch (e) {
          refusePair(l.key, `${pairSym()} → ETH not signed: ${errText(e)}`);
          resync(l.key);
        }
      }
    });
    if (raws.length) await send(raws, metas);
    else emit();
  }

  /** The Convert action: turn this wallet's (or every wallet's) known pair proceeds into ETH now. */
  function convertPair(address) {
    if (!isPairLeg()) return 0;
    const keys = address ? [lower(address)] : [...pairs.keys()];
    let n = 0;
    for (const k of keys) {
      const p = pairs.get(k);
      if (!p || !W.has(k) || leaving.has(k) || convertibleOf(p) <= 0n) continue;
      queuePair(k, { manual: true });
      n += 1;
    }
    return n;
  }

  // ── a click ────────────────────────────────────────────────────────────────
  /**
   * The wallets of `list` that planSell would send once it has a quote: a dry
   * run with no quotes on a scratch nonce book, keeping the wallets whose only
   * reason not to send is 'no quote'. A gas-short, unarmed or still-arming
   * wallet is left out of the pool quote body, so it never inflates the click
   * total every other wallet's floor is priced against (and never pushes the
   * body past the pool's impact cap). One source of truth: planSell's own rules.
   */
  function sellable(list, pct) {
    if (!list.length) return list;
    try {
      const scratch = new deps.NonceBook();
      for (const w of list) scratch.seed(w.address, Number(w.state.nonce) || 0);
      const plan =
        deps.planSell({
          venue,
          mark: effectiveMark(),
          wallets: list.map((w) => ({ ...w.state, tokenBalance: w.optimistic.toString() })),
          pct,
          slippageBps,
          quotes: [],
          fees,
          nonces: scratch,
          now: nowSec(),
        }) || [];
      const ok = new Set(plan.filter((p) => p && p.reason === SKIP.NO_QUOTE).map((p) => lower(p.address)));
      return list.filter((w) => ok.has(w.key));
    } catch {
      return list.filter(canSell);
    }
  }

  /** The tokens the tab's own sells still have in flight: this click lands behind them (/quote `ahead`). */
  function inflightTotal() {
    let total = 0n;
    for (const w of W.values()) total += w.inflight;
    return total;
  }

  /**
   * One click. A curve prices from the streamed mark with no chain read (unless
   * the mark is stale); a pool asks ONE exact /quote for this click's own
   * amounts.
   *
   * Pool floors come from chain/plan.js attachQuotes (worstOut: priced as if
   * the wallet lands after every other sell of the click — Task 10 contract
   * note 4) of an exact /quote of this click's sellRequests body: only the
   * wallets that can sell, behind the tab's own pool sells still in flight
   * (`ahead`, which is not a row: a full 100-wallet body still fits).
   * Never from the preview cache: scaled from a quote of every wallet's FULL
   * balance, that floor is sized for a 100 % exit and on a thin pool sits far
   * below what the visitor's slippage setting promises. planSell uses a quote
   * only for exactly the amount it sells, so a wallet whose balance moved while
   * quoting is skipped 'no quote', never sold against someone else's floor.
   */
  async function sell(pct) {
    const t0 = now();
    const chosen = order.map((k) => W.get(k)).filter((w) => w && w.ticked && w.optimistic > 0n);
    if (!chosen.length) return refused('no ticked wallet holds tokens');
    if (markStale()) {
      // The stream is down or behind: one fresh read of the mark before a curve floor is priced from it.
      let res;
      try {
        res = await deps.api.getToken(venue.token);
      } catch (e) {
        return refused(`the price feed is catching up (${errText(e)}) — try again`);
      }
      if (res && moved(res.venue)) {
        applyVenue(res.venue).catch(() => {});
        return refused('the token just graduated — re-arming the wallets for its pool; click again once they are ready');
      }
      if (res && res.mark) onMark(res.mark);
      if (markStale()) return refused('the price feed is catching up — try again');
    }
    let qc = null;
    let exact = null; // the attachQuotes rows of the exact /quote of this click
    let inBody = new Set();
    if (isPool()) {
      let body;
      try {
        body = poolBody(sellable(chosen, pct), pct);
      } catch (e) {
        return refused(errText(e));
      }
      if (body.length > MAX_QUOTE_ROWS) {
        return refused(`a pool click sells from at most ${MAX_QUOTE_ROWS} wallets — untick some and click again`);
      }
      inBody = new Set(body.map((s) => lower(s.address)));
      if (!body.length) exact = []; // nothing to quote: planSell skips each wallet with its own reason
      else {
        const ahead = inflightTotal();
        try {
          const res = await deps.api.postQuote(venue.token, body, ahead > 0n ? { ahead: ahead.toString() } : undefined);
          exact = attached(body, res);
          qc = buildQuoteCache(body, exact, now());
        } catch (e) {
          return refused(`quote failed: ${errText(e)}`);
        }
      }
      cache = null; // our own sells move the pool: the preview must not reuse these
      cacheGen += 1;
    }
    const raws = [];
    const metas = [];
    const skipped = [];
    const details = new Map(); // lower address -> planSell's detail (the backend's words on a 'no quote')
    try {
      await withLock(async () => {
        const holding = chosen.filter((w) => w.optimistic > 0n);
        let quotes = [];
        if (isPool()) {
          // Scaled down from this click's own exact quote when a concurrent click
          // lowered a balance (every wallet still fits under its quoted amount);
          // otherwise the exact rows as answered, which planSell matches amount
          // for amount and skips the rest 'no quote' — with the backend's reason
          // when it refused a row.
          quotes = quotesForClick(qc, poolBody(holding.filter((w) => inBody.has(w.key)), pct), now(), Infinity) || exact;
        }
        const plan =
          deps.planSell({
            venue,
            mark: effectiveMark(),
            wallets: holding.map((w) => ({ ...w.state, tokenBalance: w.optimistic.toString() })),
            pct,
            slippageBps,
            quotes,
            fees,
            nonces,
            now: nowSec(),
          }) || [];
        for (const p of plan) {
          const w = W.get(lower(p.address));
          if (!w) continue;
          if (!p.tx) {
            skipped.push({ address: w.address, reason: p.reason || 'skipped' });
            if (p.detail) details.set(w.key, errText(p.detail));
            continue;
          }
          w.sendSeq += 1;
          let raw;
          try {
            raw = await deps.store.signTx(w.address, p.tx);
          } catch (e) {
            skipped.push({ address: w.address, reason: `not signed: ${errText(e)}` });
            resync(w.key);
            continue;
          }
          const amount = BigInt(p.amount);
          const m = {
            id: ++opSeq,
            kind: 'sell',
            key: w.key,
            tx: p.tx,
            amount,
            minOut: BigInt(p.minOut ?? 0),
            expectedOut: BigInt(p.expectedOut ?? 0),
            before: w.optimistic,
            pct,
          };
          w.optimistic = sub(w.optimistic, amount);
          w.inflight += amount;
          w.ops += 1;
          if (isPairLeg()) pair(w.key).touched = true;
          if (venue.kind === 'curve') walk.push({ id: m.id, amount, block: null });
          raws.push(raw);
          metas.push(m);
        }
      });
    } catch (e) {
      for (const m of metas) {
        const w = W.get(m.key);
        w.optimistic += m.amount;
        w.inflight = sub(w.inflight, m.amount);
        w.ops = Math.max(0, w.ops - 1);
        dropWalk(m);
      }
      for (const w of chosen) resync(w.key);
      emit();
      return refused(`could not plan the sell: ${errText(e)}`, skipped);
    }
    for (const s of skipped) {
      const w = W.get(lower(s.address));
      if (w && w.ops === 0) setRow(w, 'skipped', details.has(w.key) ? `${s.reason} — ${details.get(w.key)}` : s.reason);
    }
    if (!raws.length) {
      emit();
      return refused(skipped.length ? 'every wallet was skipped' : 'nothing to sell', skipped);
    }
    for (const m of metas) setRow(W.get(m.key), 'sent', `sending ${tokFmt(m.amount)} (${pct}%)`, null);
    await send(raws, metas, t0);
    const failedN = metas.filter((m) => m.failed).length;
    return { sent: metas.length - failedN, failed: failedN, skipped, reason: null };
  }

  /**
   * "50 % ≈ 0.84 ETH": the same planSell on a scratch nonce book — nothing is
   * signed. A pool's figure is scaled from the preview cache (every sellable
   * wallet's FULL balance), which by concavity UNDER-states what a smaller
   * click pays: `atLeast` says so. The click itself always quotes exactly.
   */
  function preview(pct) {
    const chosen = order.map((k) => W.get(k)).filter((w) => w && w.ticked && w.optimistic > 0n);
    if (!chosen.length || !fees) return { total: null, count: 0, skipped: 0, reason: 'no ticked wallet holds tokens' };
    let quotes = [];
    try {
      if (isPool()) {
        const cached = sellable(chosen, pct).filter((w) => cache && cache.byAddr.has(w.key));
        quotes = cached.length ? quotesForClick(cache, poolBody(cached, pct), now(), PREVIEW_MAX_AGE_MS) : null;
        if (!quotes) return { total: null, count: 0, skipped: 0, reason: 'quoting…' };
      }
      const scratch = new deps.NonceBook();
      for (const w of chosen) scratch.seed(w.address, Number(w.state.nonce) || 0);
      const plan =
        deps.planSell({
          venue,
          mark: effectiveMark(),
          wallets: chosen.map((w) => ({ ...w.state, tokenBalance: w.optimistic.toString() })),
          pct,
          slippageBps,
          quotes,
          fees,
          nonces: scratch,
          now: nowSec(),
        }) || [];
      const sends = plan.filter((p) => p.tx);
      return {
        total: sends.reduce((a, p) => a + BigInt(p.expectedOut ?? 0), 0n),
        count: sends.length,
        skipped: plan.length - sends.length,
        reason: null,
        atLeast: isPool(),
      };
    } catch (e) {
      return { total: null, count: 0, skipped: 0, reason: errText(e) };
    }
  }

  /**
   * The PREVIEW's pool quote cache: one /quote for every sellable ticked
   * wallet's FULL optimistic balance (a sellRequests body at 100 %), joined by
   * attachQuotes. It feeds preview() only — a click always quotes its own
   * amounts. Backs off after a refusal (a 429 must not repeat every tick).
   */
  async function refreshQuotes() {
    if (!isPool() || quoting || now() < quoteBackoffUntil) return;
    const holders = order.map((k) => W.get(k)).filter((w) => w && canSell(w));
    if (!holders.length) return;
    quoting = true;
    const gen = cacheGen;
    const at = now();
    try {
      const body = poolBody(holders, 100);
      if (!body.length || body.length > MAX_QUOTE_ROWS) return;
      const res = await deps.api.postQuote(venue.token, body);
      if (gen === cacheGen) cache = buildQuoteCache(body, attached(body, res), at);
    } catch {
      quoteBackoffUntil = now() + QUOTE_BACKOFF_MS; // the preview says 'quoting…' meanwhile
    } finally {
      quoting = false;
    }
  }

  /** A receipt the stream never delivered (a reconnect gap): decide from the wallet's nonce and balances. */
  async function sweep({ force = false } = {}) {
    const t = now();
    const age = force ? 3000 : MISSED_AFTER_MS;
    const stale = [...pending.values()].filter((m) => t - m.sentAt >= age);
    if (!stale.length) return;
    let states;
    try {
      states = await readStates([...new Set(stale.map((m) => m.key))]);
    } catch {
      return;
    }
    const byKey = new Map(states.map((s) => [lower(s.address), s]));
    for (const m of stale) {
      if (!pending.has(m.hash)) continue;
      const ws = byKey.get(m.key);
      if (!ws) continue;
      if ((Number(ws.nonce) || 0) > Number(m.tx.nonce)) {
        let status = 'landed';
        if (m.kind === 'sell') status = resolveMissed({ before: m.before, amount: m.amount, fresh: ws.tokenBalance ?? 0 });
        else if (m.kind === 'pairSwap' && m.pairBefore !== null && m.pairBefore !== undefined && ws.pairBalance !== undefined && ws.pairBalance !== null) {
          // The swap took `amount` of the pair token if it landed. Proceeds of a sell
          // landing meanwhile can only push this toward 'reverted' — the safe side:
          // the leg is then measured and run again.
          status = resolveMissed({ before: m.pairBefore, amount: m.amount, fresh: ws.pairBalance });
        }
        onReceipt({ hash: m.hash, status, block: null, gasUsed: null });
      } else if (t - m.sentAt >= DROP_AFTER_MS) {
        pending.delete(m.hash);
        seen.add(m.hash);
        failed(m, 'not mined after 60 s');
      }
    }
    emit();
  }

  function tick() {
    if (disposed) return;
    ticks += 1;
    if (isPool() && !deps.isHidden() && (!cache || now() - cache.at >= PREVIEW_REFRESH_MS)) refreshQuotes();
    if (ticks % 5 === 0) {
      sweep();
      // The pair leg's lasting trigger: this session's proceeds still in the pair
      // token (a refused leg, a reverted swap) are retried once their backoff has
      // passed. An earlier visit's (carried) never are: only a click converts them.
      if (isPairLeg()) {
        const t = now();
        for (const [k, p] of pairs) if (!p.running && (pendingOf(p) > 0n || (p.manual && p.carried > 0n)) && t >= p.retryAt) queuePair(k);
      }
    }
    const t = now();
    for (const [h, e] of early) if (t - e.at > EARLY_KEEP_MS) early.delete(h);
    dropSettled();
  }

  function setTicked(address, on) {
    const w = W.get(lower(address));
    if (!w) return;
    w.ticked = !!on;
    if (w.ops === 0) rest(w);
    emit();
    if (on) arm();
  }

  function setAllTicked(on) {
    for (const w of W.values()) {
      w.ticked = !!on;
      if (w.ops === 0) rest(w);
    }
    emit();
    if (on) arm();
  }

  /** New gas figures. Their head-block time is the page's clock from now on. */
  function setFees(f) {
    if (!f) return;
    fees = f;
    syncClock(f);
    for (const w of W.values()) {
      computeNeeds(w);
      if (w.ops === 0 && (w.status === 'idle' || w.status === 'ready' || w.status === 'skipped')) rest(w);
    }
    emit();
  }

  function syncClock(f) {
    const ts = f && f.timestamp !== undefined && f.timestamp !== null ? Number(f.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts <= 0) return;
    clockOffsetMs = ts * 1000 - deps.now();
    if (!clockWarned && Math.abs(clockOffsetMs) > 60_000) {
      clockWarned = true;
      const mins = Math.round(Math.abs(clockOffsetMs) / 60_000);
      say(`This computer's clock is off by about ${mins} min — the page signs deadlines with the chain's time.`);
    }
  }

  function setSlippage(bps) {
    slippageBps = bps;
  }

  /**
   * Forget every row, the curve walk and every pair leg. Only for the visitor's
   * own Clear: sells still in flight stop counting, so a wallet loaded again
   * before they are mined would offer their tokens a second time. A wallet that
   * leaves on its own (another device, Lock) goes through removeRows instead.
   */
  function reset() {
    W.clear();
    order = [];
    pairs.clear();
    leaving.clear();
    cache = null;
    cacheGen += 1;
    walk.length = 0;
    emit();
  }

  /** Nothing of the row is in flight: no sell, approval or pair leg unanswered, no pair leg being read or signed. */
  function settled(w) {
    const p = pairs.get(w.key);
    return w.ops === 0 && w.inflight === 0n && !(p && p.running);
  }

  function drop(key) {
    W.delete(key);
    leaving.delete(key);
    pairs.delete(key);
    pairQueue.delete(key);
    armQueue.delete(key);
    settleKeys.delete(key);
    resyncKeys.delete(key);
  }

  /**
   * The rows of wallets that left this tab: another device removed them from
   * the account (the sync already took their keys), or Lock / Disconnect took
   * the account's wallets away. Nothing else changes — every other row keeps
   * its sells in flight and its optimistic balance, the curve walk keeps every
   * sell not yet in the mark, and the other wallets' pair legs keep running.
   *
   * A row with nothing in flight goes now. A row with a sell, an approval or a
   * pair leg in flight leaves the table now (out of `order`: never listed,
   * chosen, quoted, armed or re-read again) but stays in W until it settles:
   * its receipts still land, its sells still ride `ahead` of a pool click, and
   * a wallet loaded again before then keeps them in flight (loadWallets), so
   * the next click sells 50 % of what is left — never of its chain balance.
   * tick() drops the row once it has settled.
   * @param {string[]} addresses
   * @returns {{removed: number, deferred: number}} rows gone now / gone once settled
   */
  function removeRows(addresses) {
    let removed = 0;
    let deferred = 0;
    for (const a of Array.isArray(addresses) ? addresses : []) {
      const key = lower(a);
      const w = W.get(key);
      if (!w || leaving.has(key)) continue;
      order = order.filter((k) => k !== key);
      if (settled(w)) {
        drop(key);
        removed += 1;
      } else {
        leaving.add(key);
        deferred += 1;
      }
    }
    if (removed || deferred) emit();
    return { removed, deferred };
  }

  /** tick(): a row removeRows set aside goes once nothing of it is in flight. */
  function dropSettled() {
    for (const key of [...leaving]) {
      const w = W.get(key);
      if (!w || settled(w)) drop(key);
    }
  }

  function start() {
    if (timer === null) timer = deps.setInterval(tick, 1000);
  }

  function dispose() {
    disposed = true;
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
    for (const id of [settleTimer, armTimer, pairTimer]) if (id !== null) deps.clearTimeout(id);
    settleTimer = null;
    armTimer = null;
    pairTimer = null;
  }

  syncClock(fees0);

  return {
    start,
    dispose,
    loadWallets,
    reload: () => loadWallets(deps.store.addresses()),
    reset,
    removeRows,
    setTicked,
    setAllTicked,
    arm,
    sell,
    preview,
    convertPair,
    onReceipt,
    onMark,
    onTrades,
    setLive,
    applyVenue,
    // The stream's 'phase' event: the same path as any other report of the venue.
    onPhase: (v) => applyVenue(v),
    onReconnect: () => sweep({ force: true }),
    setFees,
    setSlippage,
    tick,
    sweep,
    refreshQuotes,
    view,
    get venue() {
      return venue;
    },
    get mark() {
      return mark;
    },
  };
}
