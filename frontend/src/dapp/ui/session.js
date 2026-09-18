/**
 * One open token's selling session — the money path of the page, kept out of
 * React so it can be tested with fakes and so a render never sits between a
 * click and the network call.
 *
 * What it holds: wallet STATE by address (balances, nonce, allowance — public
 * data), per-row status, the local nonce book, the pool quote cache and the
 * in-flight ops. What it never holds: a private key. Signing goes through
 * deps.store.signTx(address, txRequest), which returns a raw signed hex.
 *
 * Flows (spec "The flows"):
 *   load    postWallets -> holders only, ticked -> auto-arm
 *   arm     planArm -> sign -> ONE broadcast -> receipts -> re-read -> ready
 *   sell    planSell (no chain read) -> sign all -> ONE broadcast ->
 *           optimistic balances -> receipts -> landed / reverted
 *   pair    a landed sell on a token-quoted curve OR token-quoted graduated
 *           pool (AMZN, SPCX...) -> read pair balance -> postPairQuote ->
 *           approve + swap at consecutive nonces -> broadcast
 *   nonces  'known' = already sent (never re-signed); 'low'/'high' -> resync
 *           from /wallets and re-sign ONCE; a 'low' sell whose balance already
 *           dropped is recorded as landed instead (re-signing would sell twice)
 */
import { fmtUnits, quoteSymbol, quoteDecimals, errText } from './format.js';
import {
  QUOTE_MAX_AGE_MS,
  buildQuoteCache,
  quotesForClick,
  walkCurve,
  classifyError,
  hasPairLeg,
  gasNeeded,
  toTxRequest,
  resolveMissed,
  chunkByWallet,
} from './sellMath.js';
// Pure pool-quote helpers of Task 10's planner (no network, no keys). A pool
// floor must come from attachQuotes: planSell treats a bare /quote row — one
// without worstOut — as 'no quote' (Task 10 contract notes 4 and 5).
import { sellRequests, attachQuotes } from '../chain/plan.js';
import { MAX_ROUTE_IMPACT_BPS } from '../chain/constants.js';

const lower = (a) => String(a || '').toLowerCase();
const sub = (a, b) => (a > b ? a - b : 0n);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const READ_CHUNK = 100;
const BROADCAST_MAX = 100;
const MISSED_AFTER_MS = 20_000;
const DROP_AFTER_MS = 60_000;
const EARLY_KEEP_MS = 30_000;
const PAIR_DEADLINE_S = 300;
// planArm's per-wallet reasons (chain/plan.js SKIP.NO_GAS / SKIP.UNREAD, Task 10).
// The session receives planArm through deps, so it matches the strings.
const ARM_NO_GAS = 'no gas';
const ARM_UNREAD = 'state unavailable';

export function createSession({ venue: venue0, mark: mark0, fees: fees0, slippageBps: slip0 = 1500, own, hub, deps, onView = () => {} }) {
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
  let cache = null;
  let cacheGen = 0;
  let quoting = false;
  let ticks = 0;
  let timer = null;
  let settleTimer = null;
  const settleKeys = new Set();
  const resyncKeys = new Set();
  let resyncQueued = false;
  let lock = Promise.resolve();
  let emitQueued = false;
  let disposed = false;
  let opSeq = 0;

  const now = () => deps.now();
  const nowSec = () => Math.floor(deps.now() / 1000);
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

  /** What React sees: addresses, balances and statuses. Nothing else. */
  function view() {
    const rows = order
      .map((k) => W.get(k))
      .filter(Boolean)
      .map((w) => ({
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
      }));
    let tokens = 0n;
    let ticked = 0;
    let sellable = 0;
    let arming = 0;
    let failedArm = 0;
    for (const r of rows) {
      if (r.ticked) {
        ticked += 1;
        tokens += BigInt(r.tokens);
        if (r.canSell) sellable += 1;
      }
      if (r.status === 'arming') arming += 1;
      if (r.status === 'failed' && r.needsArm) failedArm += 1;
    }
    return { rows, totals: { tokens: tokens.toString(), ticked, sellable, arming, failedArm } };
  }

  function setRow(w, status, detail = '', hash) {
    if (!w) return;
    w.status = status;
    w.detail = detail;
    if (hash !== undefined) w.hash = hash;
  }

  function pair(key) {
    let p = pairs.get(key);
    if (!p) {
      p = { baseline: 0n, owedMin: 0n, running: false, again: false };
      pairs.set(key, p);
    }
    return p;
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
    computeNeeds(w);
  }

  async function readStates(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += READ_CHUNK) {
      const addrs = keys.slice(i, i + READ_CHUNK).map((k) => (W.get(k) ? W.get(k).address : k));
      const res = await deps.api.postWallets(venue.token, addrs);
      out.push(...((res && res.wallets) || []));
    }
    return out;
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
      emit();
    } catch {
      // The next send's own nonce error resyncs it.
    }
  }

  async function loadWallets(addresses) {
    const keys = [...new Set((addresses || []).map(lower))].filter((k) => ADDRESS.test(k));
    if (!keys.length) {
      emit();
      return;
    }
    const states = await readStates(keys);
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
        if (bal <= 0n) continue; // the table lists holders only
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
          state: ws,
        };
        W.set(key, w);
        order.push(key);
        nonces.seed(ws.address, Number(ws.nonce) || 0);
        if (ws.pairBalance !== undefined && ws.pairBalance !== null) pair(key).baseline = BigInt(ws.pairBalance);
      }
      applyState(w, ws, { exact: true });
      if (w.ops === 0) {
        w.armTried = false;
        rest(w);
      }
    }
    emit();
    await arm();
  }

  async function arm({ retry = false } = {}) {
    const cands = order
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
    if (!cands.length) return;
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
    if (m.kind === 'pairSwap') pair(m.key).running = false;
    const why = classifyError(error) === 'funds' ? 'not enough ETH for gas' : errText(error);
    setRow(w, 'failed', why, m.hash || null);
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
    emit();
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
          setRow(w, 'landed', `sold ${tokFmt(m.amount)} · receipt not seen`, m.hash);
        }
        dropWalk(m);
        if (isPairLeg()) {
          pair(m.key).owedMin += m.minOut;
          runPair(m.key);
        }
        continue;
      }
      redo.push({ m, ws });
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
    if (m.block === undefined || m.block === null) return;
    for (let i = walk.length - 1; i >= 0; i -= 1) if (walk[i].block !== null && walk[i].block <= m.block) walk.splice(i, 1);
  }

  async function confirmArm(key) {
    const w = W.get(key);
    if (!w) return;
    setRow(w, 'arming', 'approval landed — checking the allowance');
    emit();
    for (let i = 0; i < 3; i += 1) {
      try {
        const [ws] = await readStates([key]);
        if (ws) applyState(w, ws, { exact: w.inflight === 0n });
      } catch {
        // retried below
      }
      if (w.needsArm === false) {
        setRow(w, 'ready', 'approved');
        emit();
        return;
      }
      await sleep(500);
    }
    setRow(w, 'failed', 'the approval landed but the allowance still reads short');
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
      else if (w && w.ops === 0) confirmArm(m.key);
    } else if (m.kind === 'sell') {
      if (w) w.inflight = sub(w.inflight, m.amount);
      if (ok) {
        setWalkBlock(m, r.block);
        setRow(w, 'landed', `sold ${tokFmt(m.amount)} · ≈ +${fmtUnits(m.expectedOut, qDec(), 4)} ${qSym()} · ${where}`, hash);
        if (isPairLeg()) {
          pair(m.key).owedMin += m.minOut;
          runPair(m.key);
        }
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
        p.owedMin = sub(p.owedMin, m.owed);
        setRow(w, 'landed', `${pairSym()} → ETH done · ${where}`, hash);
      } else {
        setRow(w, 'reverted', `${pairSym()} → ETH swap reverted — ${pairSym()} kept in the wallet`, hash);
      }
      if (p.again) {
        p.again = false;
        runPair(m.key);
      }
      scheduleSettle(m.key);
    }
    emit();
  }

  /**
   * The second leg of a sell whose proceeds are a pair token — a token-quoted
   * curve (AMZN) or a token-quoted graduated pool (SPCX): pair token -> ETH in
   * the same wallet. minOut on a pool sell is in pair-token units too (the
   * /quote answer prices the pool's output currency), so the same floor holds.
   * Amount: the wallet's pair balance above what it held at load (so a pair
   * position the visitor already had is left alone), floored at the sum of the
   * landed sells' minimum-outs (a stale read cannot under-measure it — the
   * same floor V3's sellViaRoute uses). One leg in flight per wallet.
   */
  async function runPair(key) {
    const w = W.get(key);
    if (!w) return;
    const p = pair(key);
    if (p.running) {
      p.again = true;
      return;
    }
    p.running = true;
    p.again = false;
    const owed = p.owedMin;
    try {
      let amount = owed;
      const [ws] = await readStates([key]);
      if (ws) {
        if (ws.pairBalance !== undefined && ws.pairBalance !== null) {
          const delta = sub(BigInt(ws.pairBalance), p.baseline);
          amount = delta > owed ? delta : owed;
        }
        applyState(w, ws, { exact: false });
      }
      if (amount <= 0n) {
        p.running = false;
        return;
      }
      const q = await deps.api.postPairQuote(venue.pairToken, amount.toString());
      // The route's impact guard, pinned here as in chain/plan.js planPairLeg
      // (MAX_ROUTE_IMPACT_BPS): the QuoterV2 saturates on an oversized input, so
      // minOut alone cannot see a drained pool (memory v3-token-quoted-route).
      const tooDeep = !!q && Number(q.impactBps) > MAX_ROUTE_IMPACT_BPS;
      const out = q && q.ok === true && !tooDeep ? BigInt(q.amountOut ?? 0) : 0n;
      const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
      if (minOut <= 0n) {
        p.running = false;
        const why = tooDeep ? `price impact over ${MAX_ROUTE_IMPACT_BPS / 100}%` : (q && q.reason) || 'no route to ETH';
        setRow(w, 'failed', `${pairSym()} kept in the wallet — ${why}`);
        emit();
        return;
      }
      const raws = [];
      const metas = [];
      await withLock(async () => {
        const n1 = nonces.next(w.address);
        const n2 = nonces.next(w.address);
        w.sendSeq += 1;
        const a = toTxRequest(deps.approveTx(venue.pairToken, deps.swapRouter, amount), { nonce: n1, gasLimit: fees.gasLimits.approve, fees });
        const s = toTxRequest(deps.pairToEthTx(q, amount, minOut, w.address, nowSec() + PAIR_DEADLINE_S), {
          nonce: n2,
          gasLimit: fees.gasLimits.pairSwap,
          fees,
        });
        const rawA = await deps.store.signTx(w.address, a);
        const rawS = await deps.store.signTx(w.address, s);
        raws.push(rawA, rawS);
        w.ops += 2;
        metas.push({ id: ++opSeq, kind: 'pairApprove', key, tx: a }, { id: ++opSeq, kind: 'pairSwap', key, tx: s, owed, amount });
      });
      setRow(w, 'sent', `swapping ${fmtUnits(amount, qDec(), 4)} ${pairSym()} → ETH`);
      await send(raws, metas);
    } catch (e) {
      p.running = false;
      setRow(w, 'failed', `${pairSym()} → ETH not sent: ${errText(e)}`);
      resync(key);
      emit();
    }
  }

  /**
   * One click. No chain read on a curve; a pool reads the quote cache and
   * fetches only when it is stale.
   *
   * Pool floors come from chain/plan.js attachQuotes (worstOut: priced as if
   * the wallet lands after every other sell of the click — Task 10 contract
   * note 4), either scaled from the warm cache (refreshQuotes explains why the
   * scaled floor still holds) or from an exact /quote of this click's
   * sellRequests body. planSell uses a quote only for exactly the amount it
   * sells, so a wallet whose balance moved while quoting is skipped 'no quote',
   * never sold against someone else's floor.
   */
  async function sell(pct) {
    const t0 = now();
    const chosen = order.map((k) => W.get(k)).filter((w) => w && w.ticked && w.optimistic > 0n);
    if (!chosen.length) return { sent: 0, failed: 0, skipped: [], reason: 'no ticked wallet holds tokens' };
    let qc = null;
    let exact = null; // the attachQuotes rows of an exact /quote of this click
    if (isPool()) {
      let body;
      try {
        body = poolBody(chosen, pct);
      } catch (e) {
        return { sent: 0, failed: 0, skipped: [], reason: errText(e) };
      }
      if (!body.length) exact = []; // every amount rounds to 0: planSell skips each 'no balance'
      else if (quotesForClick(cache, body, now())) qc = cache;
      else {
        try {
          const res = await deps.api.postQuote(venue.token, body);
          exact = attached(body, res);
          qc = buildQuoteCache(body, exact, now());
        } catch (e) {
          return { sent: 0, failed: 0, skipped: [], reason: `quote failed: ${errText(e)}` };
        }
      }
      cache = null; // our own sells move the pool: the next click must not reuse these
      cacheGen += 1;
    }
    const raws = [];
    const metas = [];
    const skipped = [];
    const details = new Map(); // lower address -> planSell's detail (the backend's words on a 'no quote')
    let reason = null;
    try {
      await withLock(async () => {
        const live = chosen.filter((w) => w.optimistic > 0n);
        let quotes = [];
        if (isPool()) {
          // Scaled from qc when every wallet still fits under its quoted amount
          // (a concurrent click may have lowered it); otherwise the exact rows as
          // answered, which planSell matches amount for amount and skips the rest
          // 'no quote' — with the backend's reason when it refused a row.
          quotes = quotesForClick(qc, poolBody(live, pct), now(), Infinity) || exact;
          if (!quotes) {
            reason = 'balances changed while quoting — click again';
            return;
          }
        }
        const plan =
          deps.planSell({
            venue,
            mark: effectiveMark(),
            wallets: live.map((w) => ({ ...w.state, tokenBalance: w.optimistic.toString() })),
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
      return { sent: 0, failed: 0, skipped, reason: `could not plan the sell: ${errText(e)}` };
    }
    for (const s of skipped) {
      const w = W.get(lower(s.address));
      if (w && w.ops === 0) setRow(w, 'skipped', details.has(w.key) ? `${s.reason} — ${details.get(w.key)}` : s.reason);
    }
    if (!raws.length) {
      emit();
      return { sent: 0, failed: 0, skipped, reason: reason || (skipped.length ? 'every wallet was skipped' : 'nothing to sell') };
    }
    for (const m of metas) setRow(W.get(m.key), 'sent', `sending ${tokFmt(m.amount)} (${pct}%)`, null);
    await send(raws, metas, t0);
    const failedN = metas.filter((m) => m.failed).length;
    return { sent: metas.length - failedN, failed: failedN, skipped, reason: null };
  }

  /** "50 % ≈ 0.84 ETH": the same planSell on a scratch nonce book — nothing is signed. */
  function preview(pct) {
    const chosen = order.map((k) => W.get(k)).filter((w) => w && w.ticked && w.optimistic > 0n);
    if (!chosen.length || !fees) return { total: null, count: 0, skipped: 0, reason: 'no ticked wallet holds tokens' };
    let quotes = [];
    try {
      if (isPool()) {
        quotes = quotesForClick(cache, poolBody(chosen, pct), now(), 10_000);
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
      };
    } catch (e) {
      return { total: null, count: 0, skipped: 0, reason: errText(e) };
    }
  }

  /**
   * The warm pool quote cache: one /quote for every ticked wallet's FULL
   * optimistic balance (a sellRequests body at 100 %), joined by attachQuotes
   * so every row carries worstOut, the worst-landing-order floor.
   *
   * Why a click may scale that floor down (quotesForClick): let the cached body
   * total S, wallet a's quoted amount A, and attachQuotes' worstOut <= Q(S) -
   * Q(S - A). A click sells amt_i <= A_i from each wallet it quotes (anything
   * more is a cache miss), so its total T <= S and T - amt <= S - A. A pool's
   * output Q is concave, so its average rate over [T - amt, T] is at least the
   * rate over [S - A, S] (both ends lie to the left). Hence
   *   floor(worstOut x amt / A) <= amt x (Q(S) - Q(S - A)) / A <= Q(T) - Q(T - amt):
   * still a lower bound on what the wallet is paid whichever order the click
   * lands in. The pool moving in the <= 2 s since the quote is what slippage covers.
   */
  async function refreshQuotes() {
    if (!isPool() || quoting) return;
    const holders = order.map((k) => W.get(k)).filter((w) => w && w.ticked && w.optimistic > 0n);
    if (!holders.length) return;
    quoting = true;
    const gen = cacheGen;
    const at = now();
    try {
      const body = poolBody(holders, 100);
      if (!body.length) return;
      const res = await deps.api.postQuote(venue.token, body);
      if (gen === cacheGen) cache = buildQuoteCache(body, attached(body, res), at);
    } catch {
      // The cache ages out; the next click fetches exact quotes.
    } finally {
      quoting = false;
    }
  }

  /** A receipt the stream never delivered (a reconnect gap): decide from the wallet's nonce and balance. */
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
        const status = m.kind === 'sell' ? resolveMissed({ before: m.before, amount: m.amount, fresh: ws.tokenBalance ?? 0 }) : 'landed';
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
    if (isPool() && !deps.isHidden() && (!cache || now() - cache.at >= QUOTE_MAX_AGE_MS)) refreshQuotes();
    if (ticks % 5 === 0) sweep();
    const t = now();
    for (const [h, e] of early) if (t - e.at > EARLY_KEEP_MS) early.delete(h);
  }

  async function onPhase(v) {
    if (!v) return;
    venue = v;
    cache = null;
    cacheGen += 1;
    walk.length = 0;
    for (const w of W.values()) w.armTried = false;
    say(`${v.symbol || 'The token'} moved to a new venue — re-arming the wallets.`);
    await loadWallets(order.map((k) => W.get(k).address));
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

  function setFees(f) {
    if (!f) return;
    fees = f;
    for (const w of W.values()) {
      computeNeeds(w);
      if (w.ops === 0 && (w.status === 'idle' || w.status === 'ready' || w.status === 'skipped')) rest(w);
    }
    emit();
  }

  function setSlippage(bps) {
    slippageBps = bps;
  }

  function reset() {
    W.clear();
    order = [];
    pairs.clear();
    cache = null;
    cacheGen += 1;
    walk.length = 0;
    emit();
  }

  function start() {
    if (timer === null) timer = deps.setInterval(tick, 1000);
  }

  function dispose() {
    disposed = true;
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
    if (settleTimer !== null) deps.clearTimeout(settleTimer);
    settleTimer = null;
  }

  return {
    start,
    dispose,
    loadWallets,
    reload: () => loadWallets(deps.store.addresses()),
    reset,
    setTicked,
    setAllTicked,
    arm,
    sell,
    preview,
    onReceipt,
    onMark,
    onPhase,
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
