'use strict';

// Offline: every chain answer comes from the fake provider below, which speaks
// Multicall3.aggregate3 and models each quoter as a constant-product pool.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Interface, id } = require('ethers');

const C = require('./constants');
const { TpError } = require('./errors');
const { quoteSells, quotePairToEth, _private } = require('./quote');

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const V1_POOL = '0x3333333333333333333333333333333333333333';
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const ZERO = '0x0000000000000000000000000000000000000000';
const A1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const A2 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2';
const A3 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3';

const mc = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const curveI = new Interface([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
]);
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const v4Q = new Interface([
  `function quoteExactInputSingle(tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);
const v3Q = new Interface([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);
const poolI = new Interface(['function fee() view returns (uint24)']);

/** Constant product with a 1% input fee — the fake every pool quote uses. */
function cpOut(amountIn, rIn, rOut) {
  const x = (BigInt(amountIn) * 99n) / 100n;
  return (BigInt(rOut) * x) / (BigInt(rIn) + x);
}

/** Split a packed v3 path into hops [{tokenIn, fee, tokenOut}]. */
function hops(pathHex) {
  const h = pathHex.slice(2).toLowerCase();
  const out = [];
  for (let i = 0; i + 86 <= h.length; i += 46) {
    out.push({ tokenIn: '0x' + h.slice(i, i + 40), fee: parseInt(h.slice(i + 40, i + 46), 16), tokenOut: '0x' + h.slice(i + 46, i + 86) });
  }
  return out;
}

/**
 * handle(target, callData) -> returnData hex, or throws to mark that inner call failed.
 * Records every eth_call so tests can count round trips.
 */
function fakeProvider(handle) {
  const calls = [];
  return {
    calls,
    async call({ to, data }) {
      calls.push({ to: to.toLowerCase(), data });
      if (to.toLowerCase() === C.MULTICALL3) {
        const inner = mc.decodeFunctionData('aggregate3', data)[0];
        const results = inner.map((c) => {
          try {
            return [true, handle(c.target.toLowerCase(), c.callData)];
          } catch (_err) {
            return [false, '0x'];
          }
        });
        return mc.encodeFunctionResult('aggregate3', [results]);
      }
      return handle(to.toLowerCase(), data);
    },
  };
}

// ── live fixture (chain 4663, read 2026-09-19) ──────────────────────────────
// Curve 0xEBfCaFE39ED532cfBaB07FC53c8A26AFC77f0C76, block 66473033, tx
// 0xce7c9da9ecf4c695ae252116a1bd28fa3eb66b588346c806136bd31ad900a8f6.
// getReserves at block-1 / block, and the CurveSell event's data words.
const LIVE = {
  before: { q: 15686659869309136435n, t: 345972825901495681386889301n },
  after: { q: 15209419520723626568n, t: 356828742645022267089198202n },
  feeBps: 100n,
  creatorTaxBps: 100n,
  tokensIn: 10855916743526585702308901n,
  quoteOut: 467695541613799671n,
};

function curveHandler({ q, t, feeBps, creatorTaxBps, graduated = false }) {
  return (target, data) => {
    assert.equal(target, CURVE);
    const name = curveI.parseTransaction({ data }).name;
    if (name === 'getReserves') return curveI.encodeFunctionResult('getReserves', [q, t]);
    if (name === 'feeBps') return curveI.encodeFunctionResult('feeBps', [feeBps]);
    if (name === 'creatorTaxBps') return curveI.encodeFunctionResult('creatorTaxBps', [creatorTaxBps]);
    return curveI.encodeFunctionResult('graduated', [graduated]);
  };
}

const curveVenue = { kind: 'curve', token: TOKEN, curve: CURVE, pairToken: AMZN, nativeQuote: false };

test('curve: reproduces a live CurveSell to the wei (fee and tax rounded separately)', async () => {
  const rpc = fakeProvider(curveHandler({ ...LIVE.before, feeBps: LIVE.feeBps, creatorTaxBps: LIVE.creatorTaxBps }));
  const [r] = await quoteSells(curveVenue, [{ address: A1, amount: LIVE.tokensIn.toString() }], { provider: rpc });
  assert.equal(r.amountOut, LIVE.quoteOut.toString());
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.address, A1);
  assert.equal(r.impactBps, Number((LIVE.tokensIn * 10000n) / (LIVE.before.t + LIVE.tokensIn)));
  assert.equal(rpc.calls.length, 1, 'reserves + fees + graduated in ONE multicall');
});

test('curve: the second wallet is quoted on the reserves the chain really had after the first', async () => {
  const rpc = fakeProvider(curveHandler({ ...LIVE.before, feeBps: LIVE.feeBps, creatorTaxBps: LIVE.creatorTaxBps }));
  const second = 10n ** 24n;
  const rows = await quoteSells(
    curveVenue,
    [
      { address: A1, amount: LIVE.tokensIn.toString() },
      { address: A2, amount: second.toString() },
    ],
    { provider: rpc }
  );
  // Independently: the formula applied to the LIVE after-reserves.
  const gross = (LIVE.after.q * second) / (LIVE.after.t + second);
  const want = gross - (gross * 100n) / 10000n - (gross * 100n) / 10000n;
  assert.equal(rows[1].amountOut, want.toString());
});

test('curve: a zero row is skipped and does not move the walk', async () => {
  const rpc = fakeProvider(curveHandler({ ...LIVE.before, feeBps: 100n, creatorTaxBps: 0n }));
  const rows = await quoteSells(
    curveVenue,
    [
      { address: A1, amount: '0' },
      { address: A2, amount: LIVE.tokensIn.toString() },
    ],
    { provider: rpc }
  );
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].reason, 'nothing to sell');
  const alone = _private.curveSellOut({ tokensIn: LIVE.tokensIn, quoteReserve: LIVE.before.q, tokenReserve: LIVE.before.t, feeBps: 100n, creatorTaxBps: 0n });
  assert.equal(rows[1].amountOut, alone.out.toString());
});

test('curve: a graduated curve refuses every row with reason "graduated"', async () => {
  const rpc = fakeProvider(curveHandler({ q: 1n, t: 0n, feeBps: 100n, creatorTaxBps: 0n, graduated: true }));
  const rows = await quoteSells(curveVenue, [{ address: A1, amount: '1000' }], { provider: rpc });
  assert.deepEqual(rows, [{ address: A1, amountOut: '0', impactBps: 0, ok: false, reason: 'graduated' }]);
});

// ── graduated (V4) ───────────────────────────────────────────────────────────
const nativePoolKey = { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK };
const gradVenue = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: ZERO,
  nativeQuote: true,
  poolKey: nativePoolKey,
  poolId: id('pool'),
  spenders: { approve: C.PERMIT2, permit2Router: C.UNIVERSAL_ROUTER },
};
const R_TOKEN = 10n ** 27n; // tokens in the pool
const R_QUOTE = 5n * 10n ** 18n; // 5 ETH

function v4Handler(expect) {
  const seen = [];
  const fn = (target, data) => {
    assert.equal(target, C.V4_QUOTER);
    const [p] = v4Q.decodeFunctionData('quoteExactInputSingle', data);
    seen.push(p);
    assert.equal(p.poolKey.currency0.toLowerCase(), expect.poolKey.currency0);
    assert.equal(p.poolKey.currency1.toLowerCase(), expect.poolKey.currency1);
    assert.equal(Number(p.poolKey.fee), expect.poolKey.fee);
    assert.equal(Number(p.poolKey.tickSpacing), expect.poolKey.tickSpacing);
    assert.equal(p.poolKey.hooks.toLowerCase(), expect.poolKey.hooks);
    assert.equal(p.zeroForOne, expect.zeroForOne);
    assert.equal(p.hookData, '0x');
    if (expect.failAt != null && BigInt(p.exactAmount) === expect.failAt) throw new Error('quoter reverted');
    return v4Q.encodeFunctionResult('quoteExactInputSingle', [cpOut(p.exactAmount, R_TOKEN, R_QUOTE), 90000n]);
  };
  fn.seen = seen;
  return fn;
}

test('graduated: cumulative quotes — wallet k gets Q(S_k) − Q(S_k−1), in one multicall', async () => {
  const h = v4Handler({ poolKey: nativePoolKey, zeroForOne: false });
  const rpc = fakeProvider(h);
  const a1 = 10n ** 24n;
  const a2 = 2n * 10n ** 24n;
  const rows = await quoteSells(
    gradVenue,
    [
      { address: A1, amount: a1.toString() },
      { address: A2, amount: a2.toString() },
    ],
    { provider: rpc }
  );
  assert.equal(rows[0].amountOut, cpOut(a1, R_TOKEN, R_QUOTE).toString());
  assert.equal(rows[1].amountOut, (cpOut(a1 + a2, R_TOKEN, R_QUOTE) - cpOut(a1, R_TOKEN, R_QUOTE)).toString());
  assert.ok(BigInt(rows[1].amountOut) < BigInt(rows[0].amountOut) * 2n, 'the tail fills worse');
  assert.equal(rows[0].ok, true);
  assert.equal(rows[1].ok, true);
  assert.ok(rows[1].impactBps > rows[0].impactBps);
  assert.equal(rpc.calls.length, 1, 'probe + both cumulative amounts in ONE eth_call');
  assert.equal(h.seen.length, 3);
});

test('graduated: the token as currency0 sells zeroForOne = true', async () => {
  // An ERC-20 pair numerically ABOVE the token sorts the token first.
  const pair = '0xfffffffffffffffffffffffffffffffffffffff1';
  const key = { currency0: TOKEN, currency1: pair, fee: 0, tickSpacing: 200, hooks: HOOK };
  const rpc = fakeProvider(v4Handler({ poolKey: key, zeroForOne: true }));
  const rows = await quoteSells(
    { ...gradVenue, pairToken: pair, nativeQuote: false, poolKey: key },
    [{ address: A1, amount: '1000000000000000000000' }],
    { provider: rpc }
  );
  assert.equal(rows[0].ok, true);
});

test('graduated: a sell that drains the pool is refused by the impact guard', async () => {
  const rpc = fakeProvider(v4Handler({ poolKey: nativePoolKey, zeroForOne: false }));
  const rows = await quoteSells(gradVenue, [{ address: A1, amount: (10n ** 28n).toString() }], { provider: rpc });
  assert.equal(rows[0].ok, false);
  assert.ok(rows[0].impactBps > _private.SELL_IMPACT_CAP_BPS);
  assert.match(rows[0].reason, /too thin/);
  assert.notEqual(rows[0].amountOut, '0', 'the saturated figure is still reported, just refused');
});

test('graduated: a quote that fails marks only the rows that need it', async () => {
  const a1 = 10n ** 24n;
  const rpc = fakeProvider(v4Handler({ poolKey: nativePoolKey, zeroForOne: false, failAt: a1 + a1 }));
  const rows = await quoteSells(
    gradVenue,
    [
      { address: A1, amount: a1.toString() },
      { address: A2, amount: a1.toString() },
    ],
    { provider: rpc }
  );
  assert.equal(rows[0].ok, true);
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].reason, 'the quoter could not price this sell');
});

test('graduated: 60 wallets go out as 3 multicalls of at most 25 quotes', async () => {
  const rpc = fakeProvider(v4Handler({ poolKey: nativePoolKey, zeroForOne: false }));
  const sells = Array.from({ length: 60 }, (_, i) => ({
    address: '0x' + (i + 1).toString(16).padStart(40, '0'),
    amount: (10n ** 21n).toString(),
  }));
  const rows = await quoteSells(gradVenue, sells, { provider: rpc });
  assert.equal(rows.length, 60);
  assert.equal(rpc.calls.length, 3);
  for (const c of rpc.calls) assert.ok(mc.decodeFunctionData('aggregate3', c.data)[0].length <= 25);
});

test('graduated: a dead RPC is TpError unavailable (503)', async () => {
  const rpc = { async call() { throw new Error('socket hang up'); } };
  await assert.rejects(
    quoteSells(gradVenue, [{ address: A1, amount: '1000' }], { provider: rpc }),
    (err) => err instanceof TpError && err.code === 'unavailable' && err.status === 503
  );
});

// ── v1 (Uniswap v3 pool) ─────────────────────────────────────────────────────
test('v1: quotes token -> WETH at the pool\'s own fee, read once and cached', async () => {
  _private.v1FeeCache.clear();
  let feeReads = 0;
  const rpc = fakeProvider((target, data) => {
    if (target === V1_POOL) {
      feeReads += 1;
      assert.equal(data, poolI.encodeFunctionData('fee', []));
      return poolI.encodeFunctionResult('fee', [10000]);
    }
    assert.equal(target, C.QUOTER_V2);
    const [path, amountIn] = v3Q.decodeFunctionData('quoteExactInput', data);
    assert.deepEqual(hops(path), [{ tokenIn: TOKEN, fee: 10000, tokenOut: C.WETH }]);
    return v3Q.encodeFunctionResult('quoteExactInput', [cpOut(amountIn, R_TOKEN, R_QUOTE), [], [], 0n]);
  });
  const v1Venue = { kind: 'v1', token: TOKEN, pool: V1_POOL, pairToken: C.WETH, nativeQuote: true, spenders: { approve: C.SWAP_ROUTER02 } };
  const sells = [{ address: A1, amount: (10n ** 24n).toString() }];
  const first = await quoteSells(v1Venue, sells, { provider: rpc });
  await quoteSells(v1Venue, sells, { provider: rpc });
  assert.equal(first[0].amountOut, cpOut(10n ** 24n, R_TOKEN, R_QUOTE).toString());
  assert.equal(first[0].ok, true);
  assert.equal(feeReads, 1);
});

// ── input checks ─────────────────────────────────────────────────────────────
test('input: sells are checked before any chain read', async () => {
  const rpc = { async call() { throw new Error('must not be called'); } };
  const code = (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(quoteSells(gradVenue, [], { provider: rpc })), 'bad_request');
  assert.equal(await code(quoteSells(gradVenue, Array.from({ length: 101 }, () => ({ address: A1, amount: '1' })), { provider: rpc })), 'too_many');
  assert.equal(await code(quoteSells(gradVenue, [{ address: 'nope', amount: '1' }], { provider: rpc })), 'bad_address');
  assert.equal(await code(quoteSells(gradVenue, [{ address: A1, amount: '1.5' }], { provider: rpc })), 'bad_request');
  assert.equal(await code(quoteSells(gradVenue, [{ address: A1, amount: 5 }], { provider: rpc })), 'bad_request');
  assert.equal(await code(quoteSells({ ...gradVenue, kind: 'flap' }, [{ address: A1, amount: '1' }], { provider: rpc })), 'not_pons');
});

// ── ahead: the visitor's own sells still in flight (review round 3: F5) ──────
test('ahead: every row is quoted behind the tokens still in flight, which are neither a row nor counted in the 100', async () => {
  const h = v4Handler({ poolKey: nativePoolKey, zeroForOne: false });
  const rpc = fakeProvider(h);
  const a = 10n ** 24n;
  const ahead = 3n * 10n ** 24n;
  const rows = await quoteSells(gradVenue, [{ address: A1, amount: a.toString() }], { provider: rpc }, { ahead: ahead.toString() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, A1);
  assert.equal(rows[0].amountOut, (cpOut(ahead + a, R_TOKEN, R_QUOTE) - cpOut(ahead, R_TOKEN, R_QUOTE)).toString());
  assert.ok(BigInt(rows[0].amountOut) < cpOut(a, R_TOKEN, R_QUOTE), 'priced behind the sells in flight');

  const full = Array.from({ length: 100 }, (_, i) => ({ address: '0x' + (i + 1).toString(16).padStart(40, '0'), amount: (10n ** 21n).toString() }));
  const all = await quoteSells(gradVenue, full, { provider: rpc }, { ahead: ahead.toString() });
  assert.equal(all.length, 100, 'a full 100-wallet body plus what is in flight');
  assert.equal(all[0].address, full[0].address);

  const none = await quoteSells(gradVenue, [{ address: A1, amount: a.toString() }], { provider: rpc }, { ahead: '0' });
  assert.equal(none[0].amountOut, cpOut(a, R_TOKEN, R_QUOTE).toString(), '0 ahead: nothing in flight');
});

test('ahead: a curve walks the reserves past the tokens in flight first', async () => {
  const rpc = fakeProvider(curveHandler({ ...LIVE.before, feeBps: LIVE.feeBps, creatorTaxBps: LIVE.creatorTaxBps }));
  const second = 10n ** 24n;
  const [r] = await quoteSells(curveVenue, [{ address: A2, amount: second.toString() }], { provider: rpc }, { ahead: LIVE.tokensIn.toString() });
  const gross = (LIVE.after.q * second) / (LIVE.after.t + second);
  assert.equal(r.amountOut, (gross - (gross * 100n) / 10000n - (gross * 100n) / 10000n).toString());
});

test('ahead: a bad amount is refused before any chain read', async () => {
  const rpc = { async call() { throw new Error('must not be called'); } };
  const code = (p) => p.then(() => null, (e) => e.code);
  for (const bad of ['-1', '1.5', 5, 'x', (1n << 128n).toString()]) {
    assert.equal(await code(quoteSells(gradVenue, [{ address: A1, amount: '1' }], { provider: rpc }, { ahead: bad })), 'bad_request', String(bad));
  }
});

// ── pair -> ETH ──────────────────────────────────────────────────────────────
function pairHandler(pools) {
  return (target, data) => {
    assert.equal(target, C.QUOTER_V2);
    const [path, amountIn] = v3Q.decodeFunctionData('quoteExactInput', data);
    let amt = BigInt(amountIn);
    for (const hop of hops(path)) {
      const pool = pools[`${hop.tokenIn}>${hop.tokenOut}@${hop.fee}`];
      if (!pool) throw new Error('no pool');
      amt = cpOut(amt, pool[0], pool[1]);
    }
    return v3Q.encodeFunctionResult('quoteExactInput', [amt, [], [], 0n]);
  };
}

const E18 = 10n ** 18n;
const PAIR_POOLS = {
  // AMZN/USDG: the 0.30% tier is the deep one, 1% is thin, 0.05% has no pool.
  [`${AMZN}>${C.USDG}@3000`]: [228n * E18, 28_000n * 10n ** 6n],
  [`${AMZN}>${C.USDG}@10000`]: [2n * E18, 200n * 10n ** 6n],
  [`${AMZN}>${C.USDG}@100`]: [1n * E18, 1n * 10n ** 6n],
  [`${C.USDG}>${C.WETH}@100`]: [50_000_000n * 10n ** 6n, 20_000n * E18],
};

test('pair: routes AMZN -> USDG -> WETH through the tier that pays the most, in one eth_call', async () => {
  const rpc = fakeProvider(pairHandler(PAIR_POOLS));
  const q = await quotePairToEth(AMZN, E18.toString(), { provider: rpc });
  assert.equal(q.ok, true);
  assert.equal(q.reason, null);
  assert.deepEqual(q.path, [AMZN, C.USDG, C.WETH]);
  assert.deepEqual(q.fees, [3000, 100]);
  const usdg = cpOut(E18, 228n * E18, 28_000n * 10n ** 6n);
  assert.equal(q.amountOut, cpOut(usdg, 50_000_000n * 10n ** 6n, 20_000n * E18).toString());
  assert.ok(q.impactBps < 100);
  assert.equal(rpc.calls.length, 1);
});

test('pair: USDG itself is one hop, USDG -> WETH at the WETH/USDG fee', async () => {
  const rpc = fakeProvider(pairHandler(PAIR_POOLS));
  const q = await quotePairToEth(C.USDG, (100n * 10n ** 6n).toString(), { provider: rpc });
  assert.deepEqual(q.path, [C.USDG, C.WETH]);
  assert.deepEqual(q.fees, [100]);
  assert.equal(q.ok, true);
});

test('pair: a conversion that would drain the thin pool is refused but still reported', async () => {
  const rpc = fakeProvider(pairHandler(PAIR_POOLS));
  const q = await quotePairToEth(AMZN, (1000n * E18).toString(), { provider: rpc });
  assert.equal(q.ok, false);
  assert.ok(q.impactBps > _private.PAIR_IMPACT_CAP_BPS);
  assert.match(q.reason, /stays in the pair token/);
  assert.notEqual(q.amountOut, '0');
});

test('pair: no pool at any tier -> ok false with an empty route', async () => {
  const rpc = fakeProvider(pairHandler({}));
  const q = await quotePairToEth(AMZN, E18.toString(), { provider: rpc });
  assert.deepEqual(q, {
    amountOut: '0',
    path: [],
    fees: [],
    impactBps: 10000,
    ok: false,
    reason: 'no USDG pool with liquidity for this pair token — it cannot be converted to ETH here',
  });
});

test('pair: ETH, WETH, a bad address and a zero amount are refused', async () => {
  const rpc = { async call() { throw new Error('must not be called'); } };
  const code = (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(quotePairToEth(ZERO, '1', { provider: rpc })), 'bad_request');
  assert.equal(await code(quotePairToEth(C.WETH, '1', { provider: rpc })), 'bad_request');
  assert.equal(await code(quotePairToEth('0x12', '1', { provider: rpc })), 'bad_address');
  assert.equal(await code(quotePairToEth(AMZN, '0', { provider: rpc })), 'bad_request');
});

test('golden selectors', () => {
  assert.equal(v4Q.getFunction('quoteExactInputSingle').selector, '0xaa9d21cb');
  assert.equal(v3Q.getFunction('quoteExactInput').selector, '0xcdca1753');
  assert.equal(mc.getFunction('aggregate3').selector, '0x82ad56cb');
  assert.equal(curveI.getFunction('getReserves').selector, '0x0902f1ac');
});

test('maths helpers: probe and impact match poolswap.js', () => {
  assert.equal(_private.probeFor(999n), 999n);
  assert.equal(_private.probeFor(10_000n), 10n);
  assert.equal(_private.impactOf(50n, 100n, 1n, 1n), 5000);
  assert.equal(_private.impactOf(100n, 100n, 1n, 1n), 0);
  assert.equal(_private.impactOf(1n, 100n, 0n, 1n), 10000);
  assert.equal(
    _private.encodePath([AMZN, C.USDG, C.WETH], [3000, 100]).toLowerCase(),
    ('0x' + AMZN.slice(2) + '000bb8' + C.USDG.slice(2) + '000064' + C.WETH.slice(2)).toLowerCase()
  );
});
