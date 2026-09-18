'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Take-profit dApp — sell quotes for the three pons venues, and the quote for
// turning a pair token (AMZN, SPCX, USDG…) into ETH.
//
// READS ONLY. It never signs, never broadcasts and never sees a key: the browser
// asks "what would these sells pay?", this module asks the chain, and the answer
// sizes the browser's own minimum-out.
//
// Copied, not imported (tab-isolation rule — see the plan's Global Constraints):
//   - the probe-vs-full price-impact guard: backend/src/evm/v3/poolswap.js:330-365
//   - the V4Quoter four-field struct:        backend/src/evm/v5/swap.js:130-150
//   - the pair route (paths, fee tiers, QuoterV2.quoteExactInput):
//                                            backend/src/evm/v3/swaproute.js:30-154
//   - the curve sell maths:                  backend/src/evm/v2/holdings.js:439-450,
//     with the rounding corrected to the contract's (see curveSellOut).
//
// ONE CLICK = SEVERAL WALLETS SELLING IN A ROW. The wallets of one click land one
// after another, so wallet k sells into a pool the first k-1 have already moved.
// Every venue here is therefore quoted CUMULATIVELY, in the order the browser
// sends: wallet k's output is Q(S_k) − Q(S_{k-1}), where S_k is the sum of the
// first k amounts. That is what lets the browser give the tail a minimum-out it
// can actually meet (spec decision 4).
//
// THE QUOTER SATURATES (memory: v3-token-quoted-route). A V3/V4 quoter handed an
// oversized input does not revert — it returns most of the pool. A floor sized from
// that number "expects" the drain and permits it. Only a comparison with a near-spot
// probe sees it, which is what impactOf does, and a row over the cap is ok:false.
// ─────────────────────────────────────────────────────────────────────────────

const { Interface, solidityPacked } = require('ethers');

const C = require('./constants');
const { TpError } = require('./errors');
const providers = require('./providers');

const BPS = 10_000n;
const ZERO = '0x0000000000000000000000000000000000000000';

// At most this many sells per request (the plan's ≤ 100 wallets).
const MAX_SELLS = 100;
// Quotes per Multicall3 eth_call. A V4 quote through the pons hook costs a few
// hundred thousand gas; 25 keeps one eth_call far under the node's call gas cap.
const CALLS_PER_MULTICALL = 25;
// Amounts are uint128 in the V4 quoter; nothing real comes near it.
const MAX_AMOUNT = 1n << 128n;

// poolswap.js:330 — the impact probe is a thousandth of the trade.
const IMPACT_PROBE_DIVISOR = 1000n;
// swaproute.js:54 — USDG<->pairToken fee tiers to try, richest-first.
const PAIR_FEE_TIERS = [3000, 500, 100, 10000];

// The caps a row is refused over. A token sell is the visitor's own decision, so
// its cap only catches a quote that has saturated (a drained pool reads ~99%);
// the pair→ETH leg keeps V3's 10% (config.js:410, v3Route.maxImpactBps), because
// refusing it only leaves the pair token in the wallet.
const SELL_IMPACT_CAP_BPS = Number(process.env.TP_MAX_SELL_IMPACT_BPS || 5000);
const PAIR_IMPACT_CAP_BPS = Number(process.env.TP_PAIR_MAX_IMPACT_BPS || 1000);

// ── ABIs ─────────────────────────────────────────────────────────────────────
const multicallIface = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);
// backend/src/evm/v2/abi.js:137,146,147,148
const curveIface = new Interface([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
]);
// backend/src/evm/v5/swap.js:130,139-140,147-150 — the V4Quoter's NEWER four-field
// params (no sqrtPriceLimitX96). The router's struct differs; see broadcast.js.
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const v4QuoterIface = new Interface([
  `function quoteExactInputSingle(tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);
// backend/src/evm/v3/swaproute.js:39-41 — QuoterV2.quoteExactInput, the signature
// V3 verified live. A one-hop path gives exactly quoteExactInputSingle's answer.
const quoterV2Iface = new Interface([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);
const v3PoolIface = new Interface(['function fee() view returns (uint24)']);

const lc = (a) => String(a).toLowerCase();

// ── input checks ─────────────────────────────────────────────────────────────
function parseAddress(value, what) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TpError('bad_address', `${what} is not an address`);
  }
  return value.toLowerCase();
}

function parseAmount(value, what) {
  if (typeof value !== 'string' || !/^[0-9]{1,39}$/.test(value)) {
    throw new TpError('bad_request', `${what} must be a decimal string of base units`);
  }
  const n = BigInt(value);
  if (n >= MAX_AMOUNT) throw new TpError('bad_request', `${what} is larger than any token supply`);
  return n;
}

function parseSells(sells) {
  if (!Array.isArray(sells) || sells.length === 0) {
    throw new TpError('bad_request', 'sells must be a non-empty list of {address, amount}');
  }
  if (sells.length > MAX_SELLS) throw new TpError('too_many', `at most ${MAX_SELLS} sells per quote`);
  return sells.map((s, i) => {
    if (!s || typeof s !== 'object') throw new TpError('bad_request', `sell ${i} must be {address, amount}`);
    return { address: parseAddress(s.address, `sell ${i} address`), amount: parseAmount(s.amount, `sell ${i} amount`) };
  });
}

// ── the maths ────────────────────────────────────────────────────────────────

/**
 * The pons v2 curve's sell, exact to the wei. holdings.js:439-450's constant
 * product, with ONE correction measured on the live chain (2026-09-19): the
 * curve rounds the fee and the creator tax SEPARATELY. On curve 0xEBfC…0C76,
 * block 66473033 (feeBps 100, creatorTaxBps 100), the CurveSell event paid
 * 467695541613799671; holdings' combined rounding gives …670, this gives …671.
 * The same reading proved the reserve walk: quoteReserve fell by the GROSS
 * (fee and tax leave the curve too) and tokenReserve rose by tokensIn.
 *
 * @returns {{out: bigint, gross: bigint}}
 */
function curveSellOut({ tokensIn, quoteReserve, tokenReserve, feeBps = 0, creatorTaxBps = 0 }) {
  const amount = BigInt(tokensIn);
  const t = BigInt(tokenReserve);
  const q = BigInt(quoteReserve);
  if (amount <= 0n || t + amount <= 0n) return { out: 0n, gross: 0n };
  const gross = (q * amount) / (t + amount);
  const fee = (gross * BigInt(feeBps)) / BPS;
  const tax = (gross * BigInt(creatorTaxBps)) / BPS;
  const out = gross - fee - tax;
  return { out: out > 0n ? out : 0n, gross };
}

/** poolswap.js:332-336 — a thousandth of the trade, or the trade itself when tiny. */
function probeFor(amountIn) {
  const amt = BigInt(amountIn);
  const probe = amt / IMPACT_PROBE_DIVISOR;
  return probe > 0n ? probe : amt;
}

/**
 * poolswap.js:354-364 — impactBps = 10000 · (1 − (fullOut/amt) / (probeOut/probe)).
 * A FLOOR on the true impact (at absurd sizes the probe saturates too), which is
 * the safe direction for a guard that refuses on a high reading.
 */
function impactOf(fullOut, amt, probeOut, probe) {
  if (amt <= 0n || probe <= 0n || probeOut == null || probeOut <= 0n) return 10_000;
  const kept = Number((fullOut * probe * BPS) / (probeOut * amt));
  return Math.max(0, Math.min(10_000, 10_000 - kept));
}

/** swaproute.js:57-70 — a packed Uniswap v3 path: token, fee, token, fee, token. */
function encodePath(path, fees) {
  const types = [];
  const values = [];
  path.forEach((addr, i) => {
    types.push('address');
    values.push(addr);
    if (i < fees.length) {
      types.push('uint24');
      values.push(Number(fees[i]));
    }
  });
  return solidityPacked(types, values);
}

// ── chain access ─────────────────────────────────────────────────────────────

/**
 * Many read calls in as few eth_calls as possible: Multicall3.aggregate3 with
 * allowFailure, CALLS_PER_MULTICALL at a time, the chunks concurrently. Both
 * quoters return normally from an eth_call (they catch their own internal
 * revert), so they batch like any view.
 *
 * @returns {Promise<Array<{success: boolean, returnData: string}>>}
 */
async function aggregate(rpc, calls) {
  const chunks = [];
  for (let i = 0; i < calls.length; i += CALLS_PER_MULTICALL) chunks.push(calls.slice(i, i + CALLS_PER_MULTICALL));
  const answers = await Promise.all(
    chunks.map(async (chunk) => {
      let ret;
      try {
        ret = await rpc.call({
          to: C.MULTICALL3,
          data: multicallIface.encodeFunctionData('aggregate3', [
            chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })),
          ]),
        });
      } catch (_err) {
        throw new TpError('unavailable', 'the chain did not answer the quote — try again', 503);
      }
      return multicallIface
        .decodeFunctionResult('aggregate3', ret)[0]
        .map((r) => ({ success: Boolean(r.success), returnData: r.returnData }));
    })
  );
  return answers.flat();
}

/** Decode one quoter answer; null when the call failed or returned nothing. */
function decodeOut(iface, name, answer) {
  if (!answer || !answer.success || !answer.returnData || answer.returnData === '0x') return null;
  try {
    return BigInt(iface.decodeFunctionResult(name, answer.returnData)[0]);
  } catch (_err) {
    return null;
  }
}

// A v3 pool's fee tier never changes, so it is read once per pool.
const v1FeeCache = new Map();

async function v1PoolFee(pool, rpc) {
  const key = lc(pool);
  if (v1FeeCache.has(key)) return v1FeeCache.get(key);
  let fee;
  try {
    const ret = await rpc.call({ to: key, data: v3PoolIface.encodeFunctionData('fee', []) });
    fee = Number(v3PoolIface.decodeFunctionResult('fee', ret)[0]);
  } catch (_err) {
    throw new TpError('unavailable', 'could not read the v1 pool fee — try again', 503);
  }
  v1FeeCache.set(key, fee);
  return fee;
}

// ── venues ───────────────────────────────────────────────────────────────────

function row(address, amountOut, impactBps, ok, reason) {
  return { address, amountOut: amountOut.toString(), impactBps, ok, reason: ok ? null : reason };
}

/** Curve: one read of reserves + fees, then the exact maths walked wallet by wallet. */
async function quoteCurve(venue, list, rpc) {
  const target = lc(venue.curve);
  const res = await aggregate(rpc, [
    { target, callData: curveIface.encodeFunctionData('getReserves', []) },
    { target, callData: curveIface.encodeFunctionData('feeBps', []) },
    { target, callData: curveIface.encodeFunctionData('creatorTaxBps', []) },
    { target, callData: curveIface.encodeFunctionData('graduated', []) },
  ]);
  if (!res[0].success || !res[1].success || !res[2].success) {
    throw new TpError('unavailable', 'could not read the curve — try again', 503);
  }
  const [q0, t0] = curveIface.decodeFunctionResult('getReserves', res[0].returnData).map(BigInt);
  const feeBps = BigInt(curveIface.decodeFunctionResult('feeBps', res[1].returnData)[0]);
  const creatorTaxBps = BigInt(curveIface.decodeFunctionResult('creatorTaxBps', res[2].returnData)[0]);
  const graduated = res[3].success ? Boolean(curveIface.decodeFunctionResult('graduated', res[3].returnData)[0]) : false;

  if (graduated || t0 === 0n) {
    return list.map((s) => row(s.address, 0n, 0, false, 'graduated'));
  }

  let q = q0;
  let t = t0;
  let cum = 0n;
  return list.map((s) => {
    if (s.amount === 0n) return row(s.address, 0n, 0, false, 'nothing to sell');
    const { out, gross } = curveSellOut({ tokensIn: s.amount, quoteReserve: q, tokenReserve: t, feeBps, creatorTaxBps });
    // The live walk (see curveSellOut): the curve gives up the gross, keeps the tokens.
    q -= gross;
    t += s.amount;
    cum += s.amount;
    // Spot is q0/t0; this click's gross rate by wallet k is q0/(t0 + S_k). Fees excluded.
    const impactBps = Number((cum * BPS) / (t0 + cum));
    return row(s.address, out, impactBps, out > 0n, 'the curve pays nothing for this amount');
  });
}

/** How to quote one amount on this venue's pool: {target, encode(amount), decode(answer)}. */
async function poolQuoter(venue, rpc) {
  const token = lc(venue.token);
  if (venue.kind === 'graduated') {
    const k = venue.poolKey;
    const poolKey = {
      currency0: lc(k.currency0),
      currency1: lc(k.currency1),
      fee: Number(k.fee),
      tickSpacing: Number(k.tickSpacing),
      hooks: lc(k.hooks),
    };
    if (poolKey.currency0 !== token && poolKey.currency1 !== token) {
      throw new TpError('not_pons', 'the pool key does not contain this token');
    }
    // A sell spends the token: zeroForOne exactly when the token is currency0
    // (poolswap.js:372-376).
    const zeroForOne = poolKey.currency0 === token;
    return {
      target: C.V4_QUOTER,
      encode: (amount) =>
        v4QuoterIface.encodeFunctionData('quoteExactInputSingle', [
          { poolKey, zeroForOne, exactAmount: amount, hookData: '0x' },
        ]),
      decode: (answer) => decodeOut(v4QuoterIface, 'quoteExactInputSingle', answer),
    };
  }
  // v1: token -> WETH through the launch's own Uniswap v3 pool, at that pool's fee.
  if (lc(venue.pairToken) !== lc(C.WETH)) {
    throw new TpError('not_pons', 'this v1 pool is not paired with WETH');
  }
  const fee = await v1PoolFee(venue.pool, rpc);
  const path = encodePath([token, lc(C.WETH)], [fee]);
  return {
    target: C.QUOTER_V2,
    encode: (amount) => quoterV2Iface.encodeFunctionData('quoteExactInput', [path, amount]),
    decode: (answer) => decodeOut(quoterV2Iface, 'quoteExactInput', answer),
  };
}

/** Graduated (V4) and v1 (V3) pools: cumulative quotes + the impact guard. */
async function quotePool(venue, list, rpc) {
  const positives = list.filter((s) => s.amount > 0n);
  if (!positives.length) return list.map((s) => row(s.address, 0n, 0, false, 'nothing to sell'));

  let running = 0n;
  const cums = list.map((s) => (running += s.amount));
  const smallest = positives.reduce((m, s) => (s.amount < m ? s.amount : m), positives[0].amount);
  const probe = probeFor(smallest);

  const amounts = [...new Set([probe, ...cums.filter((c, i) => list[i].amount > 0n)].map(String))].map(BigInt);
  const quoter = await poolQuoter(venue, rpc);
  const answers = await aggregate(
    rpc,
    amounts.map((a) => ({ target: quoter.target, callData: quoter.encode(a) }))
  );
  const outOf = new Map(amounts.map((a, i) => [a.toString(), quoter.decode(answers[i])]));
  const probeOut = outOf.get(probe.toString());

  return list.map((s, k) => {
    if (s.amount === 0n) return row(s.address, 0n, 0, false, 'nothing to sell');
    const S = cums[k];
    const prevS = k === 0 ? 0n : cums[k - 1];
    const full = outOf.get(S.toString());
    const prev = prevS === 0n ? 0n : outOf.get(prevS.toString());
    if (full == null || prev == null) return row(s.address, 0n, 10_000, false, 'the quoter could not price this sell');
    const out = full > prev ? full - prev : 0n;
    const impactBps = impactOf(full, S, probeOut, probe);
    if (out === 0n) return row(s.address, 0n, impactBps, false, 'the pool pays nothing for this amount');
    if (impactBps > SELL_IMPACT_CAP_BPS) {
      return row(
        s.address,
        out,
        impactBps,
        false,
        `this click would move the pool ${(impactBps / 100).toFixed(1)}% by this wallet ` +
          `(max ${SELL_IMPACT_CAP_BPS / 100}%) — the pool is too thin; sell a smaller %`
      );
    }
    return row(s.address, out, impactBps, true, null);
  });
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Quote a click's sells, in the order they will be sent.
 *
 * @param {object} venue a Venue from venue.js
 * @param {Array<{address: string, amount: string}>} sells amounts in token base units
 * @param {{provider?: object}} [deps] tests inject a fake provider
 * @returns {Promise<Array<{address, amountOut, impactBps, ok, reason}>>}
 *   amountOut: decimal string, in the PAIR token's base units (wei for ETH/WETH).
 */
async function quoteSells(venue, sells, deps = {}) {
  if (!venue || !venue.kind) throw new TpError('bad_request', 'no venue to quote');
  const list = parseSells(sells);
  const rpc = deps.provider || providers.tpReadProvider();
  if (venue.kind === 'curve') return quoteCurve(venue, list, rpc);
  if (venue.kind === 'graduated' || venue.kind === 'v1') return quotePool(venue, list, rpc);
  throw new TpError('not_pons', `venue kind ${venue.kind} cannot be quoted`);
}

/**
 * Quote pairToken -> ETH: pair -> USDG -> WETH on SwapRouter02's pools
 * (swaproute.js:64-70), or USDG -> WETH directly when the pair IS USDG.
 *
 * Every USDG<->pair fee tier is quoted in ONE Multicall3 call, each with its
 * impact probe, and the tier that pays the most for THIS amount wins. (swaproute
 * discovers the tier with a fixed 0.001-ETH buy probe; a sell of a known amount
 * can simply ask each tier. The probe is a thousandth of the amount — poolswap's
 * rule — because pair tokens do not all have 18 decimals: USDG has 6.)
 *
 * @returns {Promise<{amountOut: string, path: string[], fees: number[], impactBps: number, ok: boolean, reason: string|null}>}
 */
async function quotePairToEth(pairToken, amount, deps = {}) {
  const pair = parseAddress(pairToken, 'pairToken');
  const amt = parseAmount(amount, 'amount');
  if (pair === ZERO || pair === lc(C.WETH)) {
    throw new TpError('bad_request', 'this pair is ETH already — there is nothing to convert');
  }
  if (amt === 0n) throw new TpError('bad_request', 'amount must be positive');
  const rpc = deps.provider || providers.tpReadProvider();

  const weth = lc(C.WETH);
  const usdg = lc(C.USDG);
  const wethUsdgFee = Number(C.WETH_USDG_FEE);
  const routes =
    pair === usdg
      ? [{ path: [usdg, weth], fees: [wethUsdgFee] }]
      : PAIR_FEE_TIERS.map((fee) => ({ path: [pair, usdg, weth], fees: [fee, wethUsdgFee] }));
  const probe = probeFor(amt);

  const calls = [];
  for (const r of routes) {
    const path = encodePath(r.path, r.fees);
    calls.push({ target: C.QUOTER_V2, callData: quoterV2Iface.encodeFunctionData('quoteExactInput', [path, probe]) });
    calls.push({ target: C.QUOTER_V2, callData: quoterV2Iface.encodeFunctionData('quoteExactInput', [path, amt]) });
  }
  const answers = await aggregate(rpc, calls);

  let best = null;
  routes.forEach((r, i) => {
    const probeOut = decodeOut(quoterV2Iface, 'quoteExactInput', answers[2 * i]);
    const fullOut = decodeOut(quoterV2Iface, 'quoteExactInput', answers[2 * i + 1]);
    if (fullOut != null && fullOut > 0n && (!best || fullOut > best.fullOut)) best = { ...r, probeOut, fullOut };
  });

  if (!best) {
    return {
      amountOut: '0',
      path: [],
      fees: [],
      impactBps: 10_000,
      ok: false,
      reason: 'no USDG pool with liquidity for this pair token — it cannot be converted to ETH here',
    };
  }
  const impactBps = impactOf(best.fullOut, amt, best.probeOut, probe);
  const ok = impactBps <= PAIR_IMPACT_CAP_BPS;
  return {
    amountOut: best.fullOut.toString(),
    path: best.path,
    fees: best.fees,
    impactBps,
    ok,
    reason: ok
      ? null
      : `converting this much would move the ${best.path.length === 3 ? 'pair/USDG' : 'USDG/WETH'} pool ` +
        `${(impactBps / 100).toFixed(1)}% (max ${PAIR_IMPACT_CAP_BPS / 100}%) — it stays in the pair token for now`,
  };
}

module.exports = {
  quoteSells,
  quotePairToEth,
  _private: {
    curveSellOut,
    probeFor,
    impactOf,
    encodePath,
    parseSells,
    v1FeeCache,
    PAIR_FEE_TIERS,
    SELL_IMPACT_CAP_BPS,
    PAIR_IMPACT_CAP_BPS,
    CALLS_PER_MULTICALL,
  },
};
