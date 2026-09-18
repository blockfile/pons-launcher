// A click, turned into per-wallet transactions — with NO chain read.
//
// Everything here is pure: the warm state (wallets, mark, quotes, fees) comes in,
// unsigned txRequests go out, and the only mutation is the NonceBook handing out
// nonces. The UI signs each tx with walletStore.signTx and posts them all in one
// /broadcast.
//
// txRequest = {to, data, value, nonce, gasLimit, maxFeePerGas,
//              maxPriorityFeePerGas: 0n, chainId: 4663, type: 2}
//
// Amounts: amount = floor(optimisticBalance x pct / 100) in BigInt, with pct taken
// as basis points (pctBps = round(pct x 100)) so a fractional percent is exact;
// 100 % sells the exact optimistic balance. The optimistic balance is the last
// read balance minus what this tab already has IN FLIGHT for that wallet, so two
// fast 50 % clicks sell 75 %, never 100 % (spec: "Click 50 %").
//
// FLOORS DO NOT ASSUME A LANDING ORDER. The /broadcast proxy sends the wallets of
// a click concurrently and the sequencer fills them in ARRIVAL order, so any
// wallet may land after every other one. Each wallet's floor is therefore priced
// for that worst case — sold after ALL the other sells of the same click — and
// only then cut by the slippage (spec decision 4: the tail must not revert
// because the rest of the click moved the price):
//   curve  worstOut = curveSellWorst(mark, amount, clickTotal - amount): exact
//          maths on the lowest reserves any order can leave (curveMath.js).
//   pool   worstOut from the /quote answer by attachQuotes: a lower bound on
//          Q(S) - Q(S - amount), S the click total (see attachQuotes).
//   minOut = worstOut x (10000 - slippageBps) / 10000.
// expectedOut is the ESTIMATE shown to the visitor — the curve walked in send
// order, or the pool's cumulative quote row — and the estimates of one click sum
// to what the whole click pays, whatever the order. minOut <= worstOut <= expectedOut.
//
// `now` is unix SECONDS everywhere in this file.

import { approveTx, permit2ApproveTx, curveSellTx, v4SellTx, v1SellTx, pairToEthTx, routeHops } from './build.js';
import { quoteCurveSell, applyCurveSell, curveSellWorst } from './curveMath.js';
import {
  CHAIN_ID,
  DEADLINE_SECONDS,
  MAX_ROUTE_IMPACT_BPS,
  PERMIT2,
  PERMIT2_EXPIRY_SECONDS,
  PERMIT2_REARM_MARGIN_SECONDS,
  SELL_EXPIRY_MARGIN_SECONDS,
  SWAP_ROUTER02,
  UNIVERSAL_ROUTER,
} from './constants.js';

/** Why a wallet was left out of a click. */
export const SKIP = {
  NO_BALANCE: 'no balance',
  NOT_ARMED: 'not armed',
  NO_GAS: 'no gas',
  NO_QUOTE: 'no quote',
  UNREAD: 'state unavailable',
  IMPACT: 'price impact',
};

// A wallet selling under a millionth of the click is left out of the pool quote:
// the backend sizes its impact probe from the SMALLEST amount (Task 4 quotePool),
// and a dust-sized probe reads as a drained pool and refuses the whole click.
const DUST_DIVISOR = 1_000_000n;

const lc = (a) => String(a).toLowerCase();
const big = (v) => (v == null ? 0n : BigInt(String(v)));

/** A percent (number, may be fractional) as basis points, 1..10000. */
export function pctToBps(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) throw new RangeError('percent must be a number');
  const bps = Math.round(n * 100);
  if (bps < 1 || bps > 10000) throw new RangeError('percent must be between 0.01 and 100');
  return BigInt(bps);
}

function slippageOf(slippageBps) {
  const n = Number(slippageBps);
  if (!Number.isInteger(n) || n < 0 || n >= 10000) throw new RangeError('slippage must be 0 to 9999 bps');
  return BigInt(n);
}

function secondsOf(now) {
  const n = Number(now);
  // Date.now() is milliseconds; taken as seconds it would grant a Permit2
  // allowance that effectively never expires. Refuse it loudly.
  if (!Number.isFinite(n) || n <= 0 || n > 1e11) throw new RangeError('now must be unix SECONDS');
  return Math.floor(n);
}

/** worstOut x (10000 - slippage) / 10000. */
function floorOf(worstOut, slip) {
  return (worstOut * (10000n - slip)) / 10000n;
}

/** {address: amount} / Map / undefined -> Map(lowercase address -> bigint). */
function amountMap(source) {
  const out = new Map();
  if (!source) return out;
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  for (const [k, v] of entries) out.set(lc(k), big(v));
  return out;
}

/** Map / {address: quote} / [{address, ...}] -> Map(lowercase address -> quote). */
function quoteMap(source) {
  const out = new Map();
  if (!source) return out;
  if (source instanceof Map) {
    for (const [k, v] of source) out.set(lc(k), v);
  } else if (Array.isArray(source)) {
    for (const q of source) if (q && q.address) out.set(lc(q.address), q);
  } else {
    for (const [k, v] of Object.entries(source)) out.set(lc(k), v);
  }
  return out;
}

/** The contracts each venue must approve, from the PINNED constants. */
export function expectedSpenders(venue) {
  switch (venue && venue.kind) {
    case 'curve':
      return { approve: lc(venue.curve) };
    case 'graduated':
      return { approve: lc(PERMIT2), permit2Router: lc(UNIVERSAL_ROUTER) };
    case 'v1':
      return { approve: lc(SWAP_ROUTER02) };
    default:
      throw new Error(`unknown venue kind ${venue && venue.kind}`);
  }
}

/**
 * The venue's spenders must be the pinned ones. A mismatch means the allowance
 * the server measured is against some other contract — refuse rather than
 * approve or sell against it.
 */
function checkSpenders(venue) {
  const want = expectedSpenders(venue);
  const got = venue.spenders || {};
  if (lc(got.approve) !== want.approve) {
    throw new Error(`the ${venue.kind} venue names spender ${got.approve}, expected ${want.approve} — refusing`);
  }
  if (want.permit2Router && lc(got.permit2Router) !== want.permit2Router) {
    throw new Error(`the graduated venue names router ${got.permit2Router}, expected ${want.permit2Router} — refusing`);
  }
  return want;
}

function gasFor(fees, name) {
  const g = fees && fees.gasLimits ? fees.gasLimits[name] : undefined;
  if (g == null) throw new Error(`fee params carry no ${name} gas limit`);
  return BigInt(String(g));
}

function sellGasName(kind) {
  if (kind === 'curve') return 'sellCurve';
  if (kind === 'graduated') return 'sellV4';
  if (kind === 'v1') return 'sellV1';
  throw new Error(`unknown venue kind ${kind}`);
}

/** A pair-token-quoted curve or pool pays out the pair token; turning it into ETH costs approve + swap. */
function pairLegGas(venue, fees) {
  return venue.kind !== 'v1' && !venue.nativeQuote ? gasFor(fees, 'approve') + gasFor(fees, 'pairSwap') : 0n;
}

function feeFields(fees) {
  if (!fees || fees.maxFeePerGas == null) throw new Error('fee params carry no maxFeePerGas');
  return { maxFeePerGas: BigInt(String(fees.maxFeePerGas)), maxPriorityFeePerGas: 0n, chainId: CHAIN_ID, type: 2 };
}

/**
 * The curve's fee and creator tax, SEPARATELY — the curve floors each on its own
 * (curveMath.js). The curve Mark (Task 3) carries curveFeeBps and creatorTaxBps
 * plus their sum feeBps; when the sum is present too it must agree. A Mark with
 * only the sum is priced as {curveFeeBps: sum, creatorTaxBps: 0}: flooring the
 * sum once is at most 1 wei BELOW the exact figure — the safe side. A missing fee
 * throws: a silent 0 would overstate every sell and set every floor too high.
 */
function curveFees(mark) {
  const has = (v) => v !== undefined && v !== null;
  const fee = has(mark.curveFeeBps) ? Number(mark.curveFeeBps) : null;
  const tax = has(mark.creatorTaxBps) ? Number(mark.creatorTaxBps) : null;
  const sum = has(mark.feeBps) ? Number(mark.feeBps) : null;
  if ((fee === null) !== (tax === null)) throw new Error('the curve mark carries half its fee — cannot price a sell');
  if (fee === null && sum === null) throw new Error('the curve mark carries no fee — cannot price a sell');
  if (fee !== null && sum !== null && fee + tax !== sum) {
    throw new Error('the curve mark fee does not add up — refusing to price a sell');
  }
  const parts = fee !== null ? { curveFeeBps: fee, creatorTaxBps: tax } : { curveFeeBps: sum, creatorTaxBps: 0 };
  for (const v of [parts.curveFeeBps, parts.creatorTaxBps]) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) throw new Error('the curve mark fee is out of range');
  }
  if (parts.curveFeeBps + parts.creatorTaxBps > 10000) throw new Error('the curve mark fee is out of range');
  return parts;
}

/** The curve reserves and fees a click is priced on. */
function curveReserves(mark) {
  if (!mark || mark.quoteReserve == null || mark.tokenReserve == null) {
    throw new Error('the curve mark carries no reserves — cannot price a sell');
  }
  return {
    quoteReserve: BigInt(String(mark.quoteReserve)),
    tokenReserve: BigInt(String(mark.tokenReserve)),
    ...curveFees(mark),
  };
}

/** Task 3 sends null (never '0') for a field it could not read. */
function unread(venue, w) {
  if (w.tokenBalance == null || w.allowance == null || w.ethBalance == null) return true;
  return venue.kind === 'graduated' && w.permit2 != null && (w.permit2.amount == null || w.permit2.expiration == null);
}

/**
 * What a click of `pct` would sell from each wallet, in wallet order.
 * @returns {{address, available: bigint, amount: bigint}[]}
 */
export function sellAmounts({ wallets, pct, inflight }) {
  const bps = pctToBps(pct);
  const pending = amountMap(inflight);
  return wallets.map((w) => {
    const held = big(w.tokenBalance) - (pending.get(lc(w.address)) || 0n);
    const available = held > 0n ? held : 0n;
    const amount = bps === 10000n ? available : (available * bps) / 10000n;
    return { address: w.address, available, amount };
  });
}

/**
 * The /api/tp/quote `sells` body for a pool click: one row per wallet, at the
 * amount it will sell (a decimal string), ordered LARGEST FIRST (ties by
 * address). The backend quotes cumulatively in this order, so the smallest sell
 * is quoted last, against the whole click — that is what gives attachQuotes a
 * tight order-free floor. Zero sells and dust (under a millionth of the click)
 * are left out; planSell skips those wallets as 'no quote'.
 * @returns {{address: string, amount: string}[]}
 */
export function sellRequests({ wallets, pct, inflight }) {
  const positive = sellAmounts({ wallets, pct, inflight }).filter((s) => s.amount > 0n);
  const total = positive.reduce((sum, s) => sum + s.amount, 0n);
  return positive
    .filter((s) => s.amount * DUST_DIVISOR >= total)
    .sort((x, y) => {
      if (x.amount !== y.amount) return x.amount > y.amount ? -1 : 1;
      return lc(x.address) < lc(y.address) ? -1 : 1;
    })
    .map((s) => ({ address: s.address, amount: s.amount.toString() }));
}

/**
 * Join a /quote answer to the body it answers and price every wallet's floor for
 * the worst landing order.
 *
 * `sells` must be EXACTLY the body that was posted (sellRequests output, same
 * order) and `quotes` the answer's rows, which Task 4 returns in request order:
 * row j pays Q(S_j) - Q(S_{j-1}), S_j the running total of the body. So a clean
 * tail — rows j..n all ok — pays O_j = Q(S) - Q(S - T_j), T_j the tail's amount.
 *
 * A wallet selling a lands, at worst, after all the rest: it is paid
 * Q(S) - Q(S - a). A pool's output is concave in its input (the price only
 * falls as a sell proceeds), so the average rate over the last a tokens is at
 * least the average over any shorter last stretch. With T the longest clean tail
 * no longer than a:
 *   worstOut = floor(a x O / T) <= Q(S) - Q(S - a)
 * exact for the smallest wallet (T = a) and for equal amounts. A wallet whose own
 * row is refused, or that finds no clean tail (e.g. the whole click would move
 * the pool past the backend's saturation cap), gets worstOut 0 and planSell
 * skips it as 'no quote', with the backend's reason as `detail`.
 *
 * Throws when the answer does not line up with the body (length, order,
 * address) — a floor must never be sized from someone else's row.
 * @returns {Map<string, {address, amount: string, amountOut: string, worstOut: string, impactBps, ok, reason}>}
 */
export function attachQuotes(sells, quotes) {
  const rows = Array.isArray(quotes) ? quotes : [];
  if (!Array.isArray(sells) || rows.length !== sells.length) {
    throw new Error('the quote answer does not match the request — refusing to size floors from it');
  }
  const seen = new Set();
  sells.forEach((s, i) => {
    const key = lc(s.address);
    if (seen.has(key) || !rows[i] || lc(rows[i].address) !== key) {
      throw new Error('the quote answer does not match the request — refusing to size floors from it');
    }
    seen.add(key);
  });
  const amounts = sells.map((s) => big(s.amount));

  // Clean tails, shortest first: {T, O} for rows j..n, while every row is ok.
  const tails = [];
  let tailReason = null;
  let T = 0n;
  let O = 0n;
  for (let j = sells.length - 1; j >= 0; j -= 1) {
    const q = rows[j];
    if (q.ok !== true || q.amountOut == null || amounts[j] <= 0n) {
      tailReason = q.reason || 'the pool could not price the end of this click';
      break;
    }
    T += amounts[j];
    O += big(q.amountOut);
    tails.push({ T, O });
  }

  const out = new Map();
  sells.forEach((s, k) => {
    const q = rows[k];
    const a = amounts[k];
    let best = null;
    for (const tail of tails) {
      if (tail.T > a) break;
      best = tail;
    }
    const own = q.ok === true && q.amountOut != null && a > 0n;
    const worstOut = own && best ? (a * best.O) / best.T : 0n;
    let reason = q.reason || null;
    if (own && !best) reason = tailReason || 'no quote covers the end of this click';
    out.set(lc(s.address), {
      address: s.address,
      amount: a.toString(),
      amountOut: String(q.amountOut == null ? '0' : q.amountOut),
      worstOut: worstOut.toString(),
      impactBps: q.impactBps,
      ok: own && worstOut > 0n,
      reason: own && worstOut > 0n ? null : reason,
    });
  });
  return out;
}

/**
 * Arm: approve each wallet's CURRENT balance once (spec decision 6).
 *   curve / v1: token.approve(spenders.approve, balance) when allowance < balance.
 *   graduated:  token.approve(Permit2, balance) when allowance < balance, and
 *               Permit2.approve(token, router, balance, now + 24 h) when the grant
 *               is missing, short, or has under an hour left.
 * Wallets with nothing to do are omitted. A wallet that cannot pay for its
 * approvals AND one sell is returned with txs [] and reason 'no gas' (an approval
 * it can pay for but never use is gas thrown away); one whose state the server
 * could not read, with reason 'state unavailable'. Nonces are consumed only for
 * the txs returned.
 * @returns {{address, txs: object[], reason: string|null}[]}
 */
export function planArm({ venue, wallets, fees, nonces, now }) {
  const spenders = checkSpenders(venue);
  const nowS = secondsOf(now);
  const base = feeFields(fees);
  const sellGas = gasFor(fees, sellGasName(venue.kind)) + pairLegGas(venue, fees);
  const out = [];
  for (const w of wallets) {
    if (unread(venue, w)) {
      out.push({ address: w.address, txs: [], reason: SKIP.UNREAD });
      continue;
    }
    const balance = big(w.tokenBalance);
    if (balance <= 0n) continue;
    const calls = [];
    if (big(w.allowance) < balance) {
      calls.push({ call: approveTx(venue.token, spenders.approve, balance), gasLimit: gasFor(fees, 'approve') });
    }
    if (venue.kind === 'graduated') {
      const p = w.permit2;
      const stale =
        !p || big(p.amount) < balance || Number(p.expiration) < nowS + PERMIT2_REARM_MARGIN_SECONDS;
      if (stale) {
        calls.push({
          call: permit2ApproveTx(venue.token, spenders.permit2Router, balance, nowS + PERMIT2_EXPIRY_SECONDS),
          gasLimit: gasFor(fees, 'permit2Approve'),
        });
      }
    }
    if (!calls.length) continue;
    const armGas = calls.reduce((sum, c) => sum + c.gasLimit, 0n);
    if (big(w.ethBalance) < (armGas + sellGas) * base.maxFeePerGas) {
      out.push({ address: w.address, txs: [], reason: SKIP.NO_GAS });
      continue;
    }
    const txs = calls.map((c) => ({ ...c.call, nonce: nonces.next(w.address), gasLimit: c.gasLimit, ...base }));
    out.push({ address: w.address, txs, reason: null });
  }
  return out;
}

/**
 * Sell `pct` % from every wallet.
 *
 * @param {object} p
 * @param {object} p.venue    Venue
 * @param {object} p.mark     curve: Mark {quoteReserve, tokenReserve, curveFeeBps,
 *   creatorTaxBps[, feeBps]}, already walked forward by this tab's own sells that
 *   are in flight (Task 12 effectiveMark). Pools: unused.
 * @param {object[]} p.wallets WalletState[], in send order
 * @param {number} p.pct      percent, may be fractional
 * @param {number} p.slippageBps integer 0..9999
 * @param {Map|object|object[]} [p.quotes] pools: attachQuotes() output for THIS
 *   click (amount, amountOut, worstOut per wallet). A bare /quote row carries no
 *   worstOut and is treated as no quote.
 * @param {object} p.fees     feeParams()
 * @param {NonceBook} p.nonces
 * @param {number} p.now      unix seconds
 * @param {Map|object} [p.inflight] per-address token amounts already sent, not yet landed
 * @returns {{address, amount, expectedOut, worstOut, minOut, tx, reason, detail}[]}
 *   one row per wallet, in order. A skipped row has tx null, zero amounts, a
 *   reason from SKIP and, for 'no quote', the backend's words in `detail`.
 */
export function planSell({ venue, mark, wallets, pct, slippageBps, quotes, fees, nonces, now, inflight }) {
  checkSpenders(venue);
  const slip = slippageOf(slippageBps);
  const nowS = secondsOf(now);
  const deadline = BigInt(nowS + DEADLINE_SECONDS);
  const base = feeFields(fees);
  const gasLimit = gasFor(fees, sellGasName(venue.kind));
  const gasNeeded = (gasLimit + pairLegGas(venue, fees)) * base.maxFeePerGas;
  const pending = amountMap(inflight);
  const quoteBy = quoteMap(quotes);
  const start = venue.kind === 'curve' ? curveReserves(mark) : null;

  // Pass 1 — who sends and how much. Nothing here depends on another wallet.
  const amounts = sellAmounts({ wallets, pct, inflight });
  const entries = wallets.map((w, i) => {
    const skip = (reason, detail = null) => ({ w, reason, detail });
    if (unread(venue, w)) return skip(SKIP.UNREAD);
    const { amount } = amounts[i];
    if (amount <= 0n) return skip(SKIP.NO_BALANCE);

    // Allowances shrink as sells land, exactly like the balance — so they are
    // judged optimistically too.
    const inFlight = pending.get(lc(w.address)) || 0n;
    if (big(w.allowance) - inFlight < amount) return skip(SKIP.NOT_ARMED);
    if (venue.kind === 'graduated') {
      const p = w.permit2;
      if (!p || big(p.amount) - inFlight < amount) return skip(SKIP.NOT_ARMED);
      if (Number(p.expiration) < nowS + SELL_EXPIRY_MARGIN_SECONDS) return skip(SKIP.NOT_ARMED);
    }
    if (big(w.ethBalance) < gasNeeded) return skip(SKIP.NO_GAS);
    if (start) return { w, amount, reason: null };

    // Pool: the floor comes from attachQuotes, for exactly this amount.
    const q = quoteBy.get(lc(w.address));
    if (!q) return skip(SKIP.NO_QUOTE);
    if (q.ok === false) return skip(SKIP.NO_QUOTE, q.reason || null);
    if (q.worstOut == null || q.amountOut == null || q.amount == null || big(q.amount) !== amount) {
      return skip(SKIP.NO_QUOTE);
    }
    const worstOut = big(q.worstOut);
    const minOut = floorOf(worstOut, slip);
    if (minOut <= 0n) return skip(SKIP.NO_QUOTE, q.reason || null);
    return { w, amount, expectedOut: big(q.amountOut), worstOut, minOut, reason: null };
  });

  // Pass 2 (curve) — every sender is priced for the worst order, against the
  // whole click, and estimated in send order.
  if (start) {
    const clickTotal = entries.reduce((sum, e) => (e.reason === null ? sum + e.amount : sum), 0n);
    let walk = start;
    for (const e of entries) {
      if (e.reason !== null) continue;
      e.expectedOut = quoteCurveSell(walk, e.amount);
      walk = applyCurveSell(walk, e.amount);
      e.worstOut = curveSellWorst(start, e.amount, clickTotal - e.amount);
      // A curve reverts atomically and quotes deterministically, so a dust sell
      // whose floor rounds to 0 still goes (build.js curveSellTx).
      e.minOut = floorOf(e.worstOut, slip);
    }
  }

  // Pass 3 — calldata and nonces, in send order, for the senders only.
  return entries.map((e) => {
    if (e.reason !== null) {
      return {
        address: e.w.address,
        amount: 0n,
        expectedOut: 0n,
        worstOut: 0n,
        minOut: 0n,
        tx: null,
        reason: e.reason,
        detail: e.detail,
      };
    }
    let call;
    if (venue.kind === 'curve') call = curveSellTx(venue.curve, e.amount, e.minOut, e.w.address);
    else if (venue.kind === 'graduated') call = v4SellTx(venue, e.amount, e.minOut, e.w.address, deadline);
    else call = v1SellTx(venue, e.amount, e.minOut, e.w.address, deadline);
    const nonce = nonces.next(e.w.address);
    return {
      address: e.w.address,
      amount: e.amount,
      expectedOut: e.expectedOut,
      worstOut: e.worstOut,
      minOut: e.minOut,
      tx: { ...call, nonce, gasLimit, ...base },
      reason: null,
      detail: null,
    };
  });
}

/**
 * The second leg of a pair-token-quoted sell (spec "Token-quoted pair"): once the
 * sell has landed with `amountIn` of the pair token, approve exactly that to
 * SwapRouter02 and swap it to native ETH in the same wallet, at consecutive
 * nonces. `route` is the /api/tp/quote/pair answer for exactly `amountIn`:
 * pair -> USDG -> WETH, or USDG -> WETH when the pair IS USDG.
 * Refused over MAX_ROUTE_IMPACT_BPS: the QuoterV2 saturates on an oversized
 * input, so the floor alone cannot see a drained pool (memory v3-token-quoted-route).
 * @returns {{address, txs: object[], expectedOut: bigint, minOut: bigint, reason: string|null}}
 */
export function planPairLeg({ venue, address, amountIn, route, slippageBps, fees, nonces, now }) {
  const slip = slippageOf(slippageBps);
  const nowS = secondsOf(now);
  const amount = big(amountIn);
  const none = (reason) => ({ address, txs: [], expectedOut: 0n, minOut: 0n, reason });
  if (amount <= 0n) return none(SKIP.NO_BALANCE);
  if (!route || route.ok === false || route.amountOut == null) return none(SKIP.NO_QUOTE);
  if (Number(route.impactBps) > MAX_ROUTE_IMPACT_BPS) return none(SKIP.IMPACT);
  const { tokens } = routeHops(route);
  if (tokens[0].toLowerCase() !== lc(venue.pairToken)) {
    throw new Error('the pair route does not start at the venue pair token — refusing');
  }
  const expectedOut = big(route.amountOut);
  const minOut = floorOf(expectedOut, slip);
  if (minOut <= 0n) return none(SKIP.NO_QUOTE);
  const base = feeFields(fees);
  const deadline = BigInt(nowS + DEADLINE_SECONDS);
  const approve = {
    ...approveTx(tokens[0], SWAP_ROUTER02, amount),
    nonce: nonces.next(address),
    gasLimit: gasFor(fees, 'approve'),
    ...base,
  };
  const swap = {
    ...pairToEthTx(route, amount, minOut, address, deadline),
    nonce: nonces.next(address),
    gasLimit: gasFor(fees, 'pairSwap'),
    ...base,
  };
  return { address, txs: [approve, swap], expectedOut, minOut, reason: null };
}
