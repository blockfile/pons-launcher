'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZeroAddress, getAddress, hexlify, randomBytes } = require('ethers');

const C = require('./constants');
const state = require('./state');
const { TpError } = require('./errors');
const { fakeChain } = require('./test-helpers/fakeChain');

const lc = (a) => String(a).toLowerCase();
const ZERO = lc(ZeroAddress);
const randomAddress = () => getAddress(hexlify(randomBytes(20)));

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURVE = '0xca11a000000000000000000000000000000000a1';
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const POOL_ID = '0x048c7f7f128df4df2ca6394512ee2f949b9cff0ab4cb39ec84dd28aa8c39ff62';
const V1_POOL = '0x1000000000000000000000000000000000000001';

const BAL = 'function balanceOf(address owner) view returns (uint256)';
const ALLOW = 'function allowance(address owner, address spender) view returns (uint256)';
const ETH_BAL = 'function getEthBalance(address addr) view returns (uint256)';
const P2_ALLOW =
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)';

// Venues shaped exactly as venue.js returns them (only the fields state.js reads matter).
const CURVE_VENUE = {
  kind: 'curve',
  token: TOKEN,
  decimals: 18,
  pairToken: ZERO,
  pairDecimals: 18,
  nativeQuote: true,
  curve: CURVE,
  spenders: { approve: CURVE },
};
const AMZN_VENUE = { ...CURVE_VENUE, pairToken: AMZN, nativeQuote: false };
const GRAD_VENUE = {
  kind: 'graduated',
  token: TOKEN,
  decimals: 18,
  pairToken: ZERO,
  pairDecimals: 18,
  nativeQuote: true,
  poolId: POOL_ID,
  poolKey: { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: ZERO },
  spenders: { approve: lc(C.PERMIT2), permit2Router: lc(C.UNIVERSAL_ROUTER) },
};

/** balances etc. are keyed by lower-case owner. */
function walletChain({ token = TOKEN, spender, balances = {}, allowances = {}, eth = {}, permit2 = {}, pair = null, pairBalances = {} } = {}) {
  const fc = fakeChain();
  fc.on(token, BAL, ([o]) => {
    const v = balances[lc(o)];
    if (v instanceof Error) throw v;
    return [v ?? 0n];
  });
  fc.on(token, ALLOW, ([o, s]) => [lc(s) === lc(spender) ? allowances[lc(o)] ?? 0n : 0n]);
  fc.on(C.MULTICALL3, ETH_BAL, ([a]) => [eth[lc(a)] ?? 0n]);
  fc.on(C.PERMIT2, P2_ALLOW, ([u, t, s]) =>
    lc(t) === lc(token) && lc(s) === lc(C.UNIVERSAL_ROUTER) && permit2[lc(u)]
      ? [permit2[lc(u)].amount, permit2[lc(u)].expiration, 0n]
      : [0n, 0n, 0n]
  );
  if (pair) fc.on(pair, BAL, ([o]) => [pairBalances[lc(o)] ?? 0n]);
  return fc;
}

// ── normalizeAddresses ──────────────────────────────────────────────────────

test('normalizeAddresses: EIP-55 out, duplicates dropped, order kept', () => {
  const a = randomAddress();
  const b = randomAddress();
  assert.deepEqual(state.normalizeAddresses([lc(a), b, a]), [a, b]);
});

test('normalizeAddresses: more than 100 is too_many; junk is bad_address naming the index only', () => {
  const many = Array.from({ length: 101 }, randomAddress);
  assert.throws(() => state.normalizeAddresses(many), (e) => e instanceof TpError && e.code === 'too_many');
  assert.doesNotThrow(() => state.normalizeAddresses(many.slice(0, 100)));
  assert.throws(
    () => state.normalizeAddresses([randomAddress(), 'hello']),
    (e) => e.code === 'bad_address' && e.message.includes('addresses[1]') && !e.message.includes('hello')
  );
  // bad EIP-55 checksum (the EIP's own vector with one letter's case flipped)
  assert.throws(
    () => state.normalizeAddresses(['0x52908400098527886e0F7030069857D2E4169EE7']),
    (e) => e.code === 'bad_address'
  );
  assert.throws(() => state.normalizeAddresses('0xabc'), (e) => e.code === 'bad_request');
});

// ── readWallets ─────────────────────────────────────────────────────────────

test('readWallets (curve): balance, allowance TO THE CURVE, ETH, pending nonce; no permit2', async () => {
  const a = randomAddress();
  const b = randomAddress();
  const fc = walletChain({
    spender: CURVE,
    balances: { [lc(a)]: 5000n, [lc(b)]: 0n },
    allowances: { [lc(a)]: 4000n },
    eth: { [lc(a)]: 10n ** 16n, [lc(b)]: 7n },
  });
  fc.setNonce(a, 12).setNonce(b, 3);
  const out = await state.readWallets(CURVE_VENUE, [a, b], { provider: fc.provider });
  assert.deepEqual(out, [
    { address: a, tokenBalance: '5000', ethBalance: '10000000000000000', nonce: 12, allowance: '4000', permit2: null, pairBalance: null },
    { address: b, tokenBalance: '0', ethBalance: '7', nonce: 3, allowance: '0', permit2: null, pairBalance: null },
  ]);
  const nonceReads = fc.log.filter((l) => l.name === 'getTransactionCount');
  assert.deepEqual(nonceReads.map((l) => l.tag), ['pending', 'pending']);
  assert.equal(fc.count('aggregate3'), 1); // every balance/allowance in ONE request
});

test('readWallets (graduated): token allowance to Permit2 and Permit2 allowance to the router', async () => {
  const a = randomAddress();
  const fc = walletChain({
    spender: C.PERMIT2,
    balances: { [lc(a)]: 9n },
    allowances: { [lc(a)]: 9n },
    permit2: { [lc(a)]: { amount: 9n, expiration: 1900000000n } },
  });
  const [w] = await state.readWallets(GRAD_VENUE, [a], { provider: fc.provider });
  assert.equal(w.allowance, '9');
  assert.deepEqual(w.permit2, { amount: '9', expiration: 1900000000 });
  const p2 = fc.log.find((l) => l.name === 'allowance' && l.to === lc(C.PERMIT2));
  assert.equal(lc(p2.args[2]), lc(C.UNIVERSAL_ROUTER));
});

test('readWallets (token-quoted curve): the pair-token balance rides along', async () => {
  const a = randomAddress();
  const fc = walletChain({ spender: CURVE, pair: AMZN, pairBalances: { [lc(a)]: 123n } });
  const [w] = await state.readWallets(AMZN_VENUE, [a], { provider: fc.provider });
  assert.equal(w.pairBalance, '123');
});

test('readWallets (graduated, token-quoted): five slots per wallet land in the right fields', async () => {
  const a = randomAddress();
  const b = randomAddress();
  const fc = walletChain({
    spender: C.PERMIT2,
    balances: { [lc(a)]: 11n, [lc(b)]: 22n },
    allowances: { [lc(a)]: 1n, [lc(b)]: 2n },
    eth: { [lc(a)]: 3n, [lc(b)]: 4n },
    permit2: { [lc(b)]: { amount: 5n, expiration: 6n } },
    pair: AMZN,
    pairBalances: { [lc(a)]: 7n, [lc(b)]: 8n },
  });
  const venue = { ...GRAD_VENUE, pairToken: AMZN, nativeQuote: false };
  const [wa, wb] = await state.readWallets(venue, [a, b], { provider: fc.provider });
  assert.deepEqual(
    [wa.tokenBalance, wa.allowance, wa.ethBalance, wa.permit2, wa.pairBalance],
    ['11', '1', '3', { amount: '0', expiration: 0 }, '7']
  );
  assert.deepEqual(
    [wb.tokenBalance, wb.allowance, wb.ethBalance, wb.permit2, wb.pairBalance],
    ['22', '2', '4', { amount: '5', expiration: 6 }, '8']
  );
});

test('readWallets: an unreadable field is null, never 0 — and the rest of the batch still answers', async () => {
  const a = randomAddress();
  const b = randomAddress();
  const fc = walletChain({
    spender: CURVE,
    balances: { [lc(a)]: new Error('revert'), [lc(b)]: 1n },
  });
  fc.setNonce(a, new Error('rpc down'));
  fc.setNonce(b, 4);
  const [wa, wb] = await state.readWallets(CURVE_VENUE, [a, b], { provider: fc.provider });
  assert.equal(wa.tokenBalance, null);
  assert.equal(wa.nonce, null);
  assert.equal(wb.tokenBalance, '1');
  assert.equal(wb.nonce, 4);
});

test('readWallets: 100 graduated wallets are 400 reads in two Multicall3 chunks', async () => {
  const addrs = Array.from({ length: 100 }, randomAddress);
  const fc = walletChain({ spender: C.PERMIT2 });
  const out = await state.readWallets(GRAD_VENUE, addrs, { provider: fc.provider });
  assert.equal(out.length, 100);
  assert.equal(fc.count('aggregate3'), 2);
  assert.ok(out.every((w, i) => w.address === addrs[i] && w.tokenBalance === '0' && w.permit2.amount === '0'));
});

test('readWallets: nonces are read in parallel but never more than NONCE_CONCURRENCY at once', async () => {
  const addrs = Array.from({ length: 30 }, randomAddress);
  const fc = walletChain({ spender: CURVE });
  let inFlight = 0;
  let peak = 0;
  const provider = {
    ...fc.provider,
    async getTransactionCount() {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return 1;
    },
  };
  await state.readWallets(CURVE_VENUE, addrs, { provider });
  assert.ok(peak > 1, 'nonce reads should overlap');
  assert.ok(peak <= state.NONCE_CONCURRENCY, `peak ${peak} > ${state.NONCE_CONCURRENCY}`);
});

test('readWallets refuses more than 100 wallets before touching the chain', async () => {
  const fc = walletChain({ spender: CURVE });
  const many = Array.from({ length: 101 }, randomAddress);
  await assert.rejects(state.readWallets(CURVE_VENUE, many, { provider: fc.provider }), (e) => e.code === 'too_many');
  assert.equal(fc.log.length, 0);
});

// ── prices ──────────────────────────────────────────────────────────────────

test('priceFromReserves: a live curve (holdings.test.js:1183-1190 reserves), and pair decimals honoured', () => {
  const p = state.priceFromReserves({
    quoteReserve: 1729500000000000000n,
    tokenReserve: 971379011274934952298352125n,
    decimals: 18,
    pairDecimals: 18,
  });
  const expected = 1.7295 / 971379011.274934952298352125;
  assert.ok(Math.abs(p / expected - 1) < 1e-12, `${p} vs ${expected}`);
  // A 6-decimal pair (USDG): 3236 USDG against 1e9 tokens → 3.236e-6 USDG per token.
  const usdg = state.priceFromReserves({ quoteReserve: 3236n * 10n ** 6n, tokenReserve: 10n ** 27n, decimals: 18, pairDecimals: 6 });
  assert.ok(Math.abs(usdg / 3.236e-6 - 1) < 1e-12, String(usdg));
  assert.equal(state.priceFromReserves({ quoteReserve: 1n, tokenReserve: 0n, decimals: 18, pairDecimals: 18 }), null);
});

test('priceFromSqrt: orientation and decimals', () => {
  const one = 1n << 96n; // raw price 1
  assert.equal(state.priceFromSqrt({ sqrtPriceX96: one, tokenIsToken0: true, decimals: 18, pairDecimals: 18 }), 1);
  assert.equal(state.priceFromSqrt({ sqrtPriceX96: one, tokenIsToken0: false, decimals: 18, pairDecimals: 18 }), 1);
  const s = (10n ** 8n) << 96n; // raw price exactly 1e16 (currency1 per currency0)
  assert.equal(state.priceFromSqrt({ sqrtPriceX96: s, tokenIsToken0: true, decimals: 18, pairDecimals: 18 }), 1e16);
  // token is currency1 against a 6-decimal quote: 1e-16 raw → 1e-16 × 1e18 / 1e6 = 1e-4
  const p = state.priceFromSqrt({ sqrtPriceX96: s, tokenIsToken0: false, decimals: 18, pairDecimals: 6 });
  assert.ok(Math.abs(p / 1e-4 - 1) < 1e-12, String(p));
});

test('priceFromSqrt reproduces the live v1 pool reading in evm/pricing.js:70-74', () => {
  // 72,915.416942227609 tokens at sqrtPriceX96 2146001890159706666683605869625172,
  // token = token1 (WETH sorts first). Spot, pre-fee — pricing.js's gross.
  const sqrt = 2146001890159706666683605869625172n;
  const tokensIn = 72915416942227609000000n;
  const gross = (tokensIn * (1n << 192n)) / (sqrt * sqrt);
  const expected = Number(gross) / 1e18 / 72915.416942227609;
  const p = state.priceFromSqrt({ sqrtPriceX96: sqrt, tokenIsToken0: false, decimals: 18, pairDecimals: 18 });
  assert.ok(Math.abs(p / expected - 1) < 1e-9, `${p} vs ${expected}`);
  // and the 1%-fee proceeds match the measured quoteSellOutV1 figure to 1e-6
  assert.ok(Math.abs((p * 72915.416942227609 * 0.99 * 1e18) / 98390581041968 - 1) < 1e-6);
});

// ── readMark ────────────────────────────────────────────────────────────────

test('readMark (curve): reserves + fee SUM, all read at the one block it reports', async () => {
  const fc = fakeChain({ block: 777 });
  fc.on(CURVE, 'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)', () => [
    1729500000000000000n,
    971379011274934952298352125n,
  ]);
  fc.on(CURVE, 'function feeBps() view returns (uint256)', () => [100n]);
  fc.on(CURVE, 'function creatorTaxBps() view returns (uint256)', () => [200n]);
  const m = await state.readMark(CURVE_VENUE, { provider: fc.provider });
  assert.equal(m.block, 777);
  assert.equal(m.quoteReserve, '1729500000000000000');
  assert.equal(m.tokenReserve, '971379011274934952298352125');
  assert.equal(m.feeBps, 300);
  assert.equal(m.curveFeeBps, 100);
  assert.equal(m.creatorTaxBps, 200);
  assert.ok(Math.abs(m.price / (1.7295 / 971379011.274934952298352125) - 1) < 1e-12);
  assert.equal(fc.log.find((l) => l.name === 'aggregate3').blockTag, 777);
});

test('readMark honours deps.blockTag (the indexer pins the block it just indexed)', async () => {
  const fc = fakeChain({ block: 900 });
  fc.on(CURVE, 'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)', () => [1n, 1n]);
  fc.on(CURVE, 'function feeBps() view returns (uint256)', () => [100n]);
  fc.on(CURVE, 'function creatorTaxBps() view returns (uint256)', () => [0n]);
  const m = await state.readMark(CURVE_VENUE, { provider: fc.provider, blockTag: 850 });
  assert.equal(m.block, 850);
  assert.equal(fc.log.find((l) => l.name === 'aggregate3').blockTag, 850);
});

test('readMark (graduated): StateView slot0 + liquidity for the venue poolId', async () => {
  const fc = fakeChain({ block: 10 });
  const sqrt = (10n ** 8n) << 96n;
  fc.on(C.STATE_VIEW, 'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', ([id]) =>
    lc(id) === POOL_ID ? [sqrt, 368410, 0, 0] : [0n, 0, 0, 0]
  );
  fc.on(C.STATE_VIEW, 'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)', () => [555n]);
  const m = await state.readMark(GRAD_VENUE, { provider: fc.provider });
  // ETH (0x0) is currency0, the token currency1 → quote per token = 1 / 1e16
  assert.ok(Math.abs(m.price / 1e-16 - 1) < 1e-12, String(m.price));
  assert.equal(m.sqrtPriceX96, sqrt.toString());
  assert.equal(m.liquidity, '555');
  assert.equal(m.tick, 368410);
  assert.equal(m.block, 10);
});

test('readMark (v1): the pool slot0 + liquidity, oriented by tokenIsToken0', async () => {
  const fc = fakeChain({ block: 11 });
  const sqrt = 2146001890159706666683605869625172n;
  fc.on(V1_POOL, 'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', () => [
    sqrt,
    204145,
    0,
    1,
    1,
    0,
    true,
  ]);
  fc.on(V1_POOL, 'function liquidity() view returns (uint128)', () => [42n]);
  const v1 = { kind: 'v1', token: '0x86d26b51fd707abd05b04084fbb6c1db3708e7de', decimals: 18, pairToken: lc(C.WETH), pairDecimals: 18, pool: V1_POOL, tokenIsToken0: false };
  const m = await state.readMark(v1, { provider: fc.provider });
  assert.ok(m.price > 1.3e-9 && m.price < 1.4e-9, String(m.price));
  assert.equal(m.liquidity, '42');
  assert.equal(m.tick, 204145);
});

test('readMark: an unreadable venue is TpError unavailable, never a made-up price', async () => {
  const fc = fakeChain();
  await assert.rejects(state.readMark(CURVE_VENUE, { provider: fc.provider }), (e) => e.code === 'unavailable');
});

// ── feeParams ───────────────────────────────────────────────────────────────

// Every feeParams test injects `ethPrice`: the real ethPrice.js would go out to
// the exchanges, and these tests run offline.
const PRICE = async () => ({ usd: 3150.25, source: 'coinbase', at: 1 });

test('feeParams: 2 x base fee, priority 0, gas caps copied from the repo, the head block time, ETH/USD alongside', async () => {
  const fc = fakeChain({ baseFee: 20000000n, block: 99, timestamp: 1_760_000_123 });
  const f = await state.feeParams({ provider: fc.provider, ethPrice: PRICE });
  assert.deepEqual(f, {
    maxFeePerGas: '40000000',
    maxPriorityFeePerGas: '0',
    baseFeePerGas: '20000000',
    block: 99,
    // the page's clock for deadlines and Permit2 expiries (a visitor's PC clock may be off)
    timestamp: 1_760_000_123,
    gasLimits: {
      approve: '100000',
      permit2Approve: '100000',
      sellCurve: '600000',
      sellV4: '500000',
      sellV1: '600000',
      pairSwap: '450000',
    },
    ethUsd: 3150.25,
  });
  assert.doesNotThrow(() => JSON.stringify(f));
});

test('feeParams: no base fee reported is unavailable, not a guess — a good price does not mask it', async () => {
  const provider = { async getBlock() { return { number: 1, baseFeePerGas: null }; } };
  await assert.rejects(
    state.feeParams({ provider, ethPrice: PRICE }),
    (e) => e instanceof TpError && e.code === 'unavailable'
  );
});

test('feeParams: ethUsd is null — never a guess, never an error — whenever the price is unavailable', async () => {
  const fc = fakeChain({ baseFee: 20000000n, block: 99 });
  // A stale figure is still a figure: ethPrice.js serves its last price when both exchanges are down.
  const stale = await state.feeParams({ provider: fc.provider, ethPrice: async () => ({ usd: 3000, stale: true }) });
  assert.equal(stale.ethUsd, 3000);

  const broken = [
    async () => {
      throw new Error('no price source reachable');
    },
    () => {
      throw new Error('a synchronous throw');
    },
    async () => ({ usd: Number.NaN }),
    async () => ({ usd: 0 }),
    async () => ({ usd: -5 }),
    async () => null,
  ];
  for (const ethPrice of broken) {
    const f = await state.feeParams({ provider: fc.provider, ethPrice });
    assert.equal(f.ethUsd, null);
    assert.equal(f.maxFeePerGas, '40000000'); // the gas figures never depend on the price
  }
  // An injected provider with no injected price never reaches the exchanges.
  assert.equal((await state.feeParams({ provider: fc.provider })).ethUsd, null);
});

test('feeParams: a price source that hangs holds /fees for at most the wait, then ethUsd is null', async () => {
  assert.equal(state.ETH_USD_WAIT_MS, 1500);
  const fc = fakeChain({ baseFee: 20000000n, block: 99 });
  const started = Date.now();
  const f = await state.feeParams({
    provider: fc.provider,
    ethPrice: () => new Promise(() => {}), // never settles
    ethUsdWaitMs: 30,
  });
  assert.equal(f.ethUsd, null);
  assert.equal(f.maxFeePerGas, '40000000');
  assert.ok(Date.now() - started < 1000, 'feeParams waited on a hung price source');
});
