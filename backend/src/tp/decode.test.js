'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AbiCoder, zeroPadValue, id } = require('ethers');

const { decodeLog, priceOf } = require('./decode');
const { TOPICS, POOL_MANAGER, WETH } = require('./constants');

const abi = AbiCoder.defaultAbiCoder();
const topicOf = (addr) => zeroPadValue(addr, 32);
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12, `${actual} is not ${expected}`);

const TX = '0x' + 'ab'.repeat(32);

// ── fixtures (real numbers where the chain gave them; see decode.js header) ──────────

const CURVE = '0x1df4f56471c8c4540afa3b5f324e75a66bacdf9d'; // live pons v2 curve (sampled)
const ROUTER = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const ALICE = '0xd1df06767842f9222746facaa191446c9f473cc9';
// Venue shapes as Task 2 builds them: every key present, null when it does not apply.
const curveVenue = {
  kind: 'curve',
  token: '0x1111111111111111111111111111111111111111',
  curve: CURVE,
  formerCurve: null,
  poolKey: null,
  poolId: null,
  pool: null,
  decimals: 18,
  pairDecimals: 18,
  nativeQuote: true,
  phase: 0,
};

function curveLog(topic0, words, t1, t2, extra = {}) {
  return {
    address: CURVE,
    topics: [topic0, topicOf(t1), topicOf(t2)],
    data: abi.encode(['uint256', 'uint256', 'uint256', 'uint256'], words),
    blockNumber: 66_451_000,
    index: 7,
    transactionHash: TX,
    ...extra,
  };
}

const GRAD_TOKEN = '0x07ebb29a38fbcb41563817e5e19f2cec619c90d2'; // live graduated pons v2 token
const POOL_ID = '0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const gradVenue = {
  kind: 'graduated',
  token: GRAD_TOKEN,
  curve: null,
  formerCurve: null,
  pool: null,
  decimals: 18,
  pairDecimals: 18,
  nativeQuote: true,
  phase: 2,
  poolId: POOL_ID,
  // fee 0 / tickSpacing 200 as on every live pons launch (Task 2); decode reads only the currencies
  poolKey: { currency0: '0x0000000000000000000000000000000000000000', currency1: GRAD_TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
};

function v4Log(amount0, amount1, sender, extra = {}) {
  return {
    address: POOL_MANAGER,
    topics: [TOPICS.V4_SWAP, POOL_ID, topicOf(sender)],
    data: abi.encode(
      ['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'],
      [amount0, amount1, 2n ** 96n, 10n ** 21n, -207_000, 10_000]
    ),
    blockNumber: 66_452_000,
    index: 3,
    transactionHash: TX,
    ...extra,
  };
}

const V1_POOL = '0x10cc6bd38112cac182db90b6a71d8bb5939526ba';
const HIGH_TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // sorts after WETH → token1
const LOW_TOKEN = '0x0000000000000000000000000000000000000abc'; // sorts before WETH → token0
const v1Venue = (token, pairToken = WETH) => ({
  kind: 'v1',
  token,
  curve: null,
  formerCurve: null,
  poolKey: null,
  poolId: null,
  pool: V1_POOL,
  pairToken,
  decimals: 18,
  pairDecimals: 18,
  nativeQuote: true,
  phase: null,
});

function v3Log(amount0, amount1, recipient, extra = {}) {
  return {
    address: V1_POOL,
    topics: [TOPICS.V3_SWAP, topicOf(ROUTER), topicOf(recipient)],
    data: abi.encode(
      ['int256', 'int256', 'uint160', 'uint128', 'int24'],
      [amount0, amount1, 2n ** 96n, 10n ** 20n, 12]
    ),
    blockNumber: 66_453_000,
    index: 9,
    transactionHash: TX,
    ...extra,
  };
}

// ── the topic constants Task 1 pinned are the ones this decoder was checked against ──

test('the four trade topics are the live ones', () => {
  assert.equal(TOPICS.CURVE_BUY, '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455');
  assert.equal(TOPICS.CURVE_SELL, '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df');
  assert.equal(TOPICS.V4_SWAP, id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
  assert.equal(TOPICS.V3_SWAP, id('Swap(address,address,int256,int256,uint160,uint128,int24)'));
});

// ── curve ──────────────────────────────────────────────────────────────────────────

test('CurveBuy: quote in, tokens out, trader is the recipient (topic 2)', () => {
  // A live CurveBuy (curve 0x1df4…, 2026-09-19): 1 % fee and a 3 % tax in words 2-3.
  const log = curveLog(
    TOPICS.CURVE_BUY,
    [928125000000000n, 120788867418937879394353n, 9281250000000n, 27843750000000n],
    ROUTER,
    ALICE
  );
  const t = decodeLog(log, curveVenue);
  assert.equal(t.side, 'buy');
  assert.equal(t.quoteAmt, '928125000000000');
  assert.equal(t.tokenAmt, '120788867418937879394353');
  assert.equal(t.trader, ALICE);
  assert.equal(t.block, 66_451_000);
  assert.equal(t.logIndex, 7);
  assert.equal(t.tx, TX);
  assert.equal(t.ts, 0, 'the indexer fills ts');
  near(t.price, 928125000000000 / 120788867418937879394353);
});

test('CurveSell: tokens in, quote out, trader is the seller (topic 1)', () => {
  const log = curveLog(
    TOPICS.CURVE_SELL,
    [50_000n * 10n ** 18n, 380000000000000n, 3838383838383n, 0n],
    ALICE,
    ROUTER
  );
  const t = decodeLog(log, curveVenue);
  assert.equal(t.side, 'sell');
  assert.equal(t.tokenAmt, (50_000n * 10n ** 18n).toString());
  assert.equal(t.quoteAmt, '380000000000000');
  assert.equal(t.trader, ALICE);
  near(t.price, 0.00038 / 50_000);
});

test('a 6-decimal pair (USDG) prices in human units', () => {
  const venue = { ...curveVenue, pairDecimals: 6, nativeQuote: false };
  const log = curveLog(TOPICS.CURVE_BUY, [1_000_000n, 1000n * 10n ** 18n, 0n, 0n], ROUTER, ALICE);
  near(decodeLog(log, venue).price, 0.001);
});

test("a graduated venue still decodes its former curve's events (pre-graduation history)", () => {
  const venue = { ...gradVenue, formerCurve: CURVE };
  const t = decodeLog(curveLog(TOPICS.CURVE_BUY, [10n ** 15n, 10n ** 23n, 0n, 0n], ROUTER, ALICE), venue);
  assert.equal(t.side, 'buy');
  near(t.price, 1e-8);
});

test('curve events from any other contract are ignored', () => {
  const log = curveLog(TOPICS.CURVE_BUY, [1n, 1n, 0n, 0n], ROUTER, ALICE, {
    address: '0x2222222222222222222222222222222222222222',
  });
  assert.equal(decodeLog(log, curveVenue), null);
});

test('a zero side, a removed log or a short data field decodes to null', () => {
  assert.equal(decodeLog(curveLog(TOPICS.CURVE_BUY, [0n, 5n, 0n, 0n], ROUTER, ALICE), curveVenue), null);
  assert.equal(
    decodeLog(curveLog(TOPICS.CURVE_BUY, [5n, 5n, 0n, 0n], ROUTER, ALICE, { removed: true }), curveVenue),
    null
  );
  assert.equal(decodeLog(curveLog(TOPICS.CURVE_BUY, [5n, 5n, 0n, 0n], ROUTER, ALICE, { data: '0x' }), curveVenue), null);
});

test('raw RPC shape: hex blockNumber / logIndex, and a real blockTimestamp is kept', () => {
  const log = curveLog(TOPICS.CURVE_BUY, [10n ** 15n, 10n ** 23n, 0n, 0n], ROUTER, ALICE, {
    blockNumber: '0x3f5fc2d',
    index: undefined,
    logIndex: '0x1f',
    blockTimestamp: '0x6aad87f0',
  });
  const t = decodeLog(log, curveVenue);
  assert.equal(t.block, 0x3f5fc2d);
  assert.equal(t.logIndex, 0x1f);
  assert.equal(t.ts, 0x6aad87f0);
  // the public RPC's 0x0 means "unknown", not 1970
  const zero = decodeLog({ ...log, blockTimestamp: '0x0' }, curveVenue);
  assert.equal(zero.ts, 0);
});

// ── graduated (Uniswap v4 PoolManager Swap) ──────────────────────────────────────────

test('v4 buy: the swapper PAID quote (amount0 < 0) and received tokens (amount1 > 0)', () => {
  // Live swap on 0x07ebb29a…: 0.0198 ETH in, 1717.14 tokens out of the PoolManager.
  const t = decodeLog(v4Log(-19800000000000000n, 1717142733944712236609n, ROUTER), gradVenue);
  assert.equal(t.side, 'buy');
  assert.equal(t.quoteAmt, '19800000000000000');
  assert.equal(t.tokenAmt, '1717142733944712236609');
  assert.equal(t.trader, ROUTER, 'the v4 sender is the router, not the wallet');
  near(t.price, 0.0198 / 1717.142733944712236609);
});

test('v4 sell: the swapper received quote (amount0 > 0) and paid tokens (amount1 < 0)', () => {
  const t = decodeLog(v4Log(37982438038650248n, -3293401130177974505882n, HOOK), gradVenue);
  assert.equal(t.side, 'sell');
  assert.equal(t.quoteAmt, '37982438038650248');
  assert.equal(t.tokenAmt, '3293401130177974505882');
  near(t.price, 0.037982438038650248 / 3293.401130177974505882);
});

test('v4 with the token as currency0 flips the orientation', () => {
  const PAIR = '0xffffffffffffffffffffffffffffffffffffffff';
  const venue = { ...gradVenue, poolKey: { ...gradVenue.poolKey, currency0: GRAD_TOKEN, currency1: PAIR } };
  // paid 5 tokens (amount0 < 0), received 2 quote (amount1 > 0) → a sell at 0.4
  const t = decodeLog(v4Log(-5n * 10n ** 18n, 2n * 10n ** 18n, ROUTER), venue);
  assert.equal(t.side, 'sell');
  near(t.price, 0.4);
});

test('v4 swaps of another pool, or not from the PoolManager, are ignored', () => {
  const other = v4Log(-1n, 1n, ROUTER);
  other.topics = [TOPICS.V4_SWAP, '0x' + '11'.repeat(32), topicOf(ROUTER)];
  assert.equal(decodeLog(other, gradVenue), null);
  assert.equal(decodeLog(v4Log(-1n, 1n, ROUTER, { address: V1_POOL }), gradVenue), null);
  // both sides the same sign is not a trade
  assert.equal(decodeLog(v4Log(-1n, -1n, ROUTER), gradVenue), null);
});

// ── pons v1 (Uniswap v3 pool Swap) ───────────────────────────────────────────────────

test('v3 amounts are the POOL delta: token in (+) and WETH out (−) is a sell', () => {
  assert.ok(BigInt(HIGH_TOKEN) > BigInt(WETH), 'fixture: token sorts as token1');
  const t = decodeLog(v3Log(-5n * 10n ** 17n, 1000n * 10n ** 18n, ALICE), v1Venue(HIGH_TOKEN));
  assert.equal(t.side, 'sell');
  assert.equal(t.tokenAmt, (1000n * 10n ** 18n).toString());
  assert.equal(t.quoteAmt, (5n * 10n ** 17n).toString());
  assert.equal(t.trader, ALICE, 'the v3 recipient');
  near(t.price, 0.0005);
});

test('v3 buy with the token as token1', () => {
  const t = decodeLog(v3Log(10n ** 18n, -2000n * 10n ** 18n, ALICE), v1Venue(HIGH_TOKEN));
  assert.equal(t.side, 'buy');
  near(t.price, 0.0005);
});

test('v3 with the token as token0, and a zero pairToken falls back to WETH', () => {
  assert.ok(BigInt(LOW_TOKEN) < BigInt(WETH), 'fixture: token sorts as token0');
  const venue = v1Venue(LOW_TOKEN, '0x0000000000000000000000000000000000000000');
  const t = decodeLog(v3Log(1000n * 10n ** 18n, -25n * 10n ** 16n, ALICE), venue);
  assert.equal(t.side, 'sell');
  near(t.price, 0.00025);
});

test('v1 honours venue.tokenIsToken0 when the venue carries it', () => {
  // The same amounts as the token1 sell above, read with the token as token0: the
  // pool PAID the token (−) and received the quote (+) — a buy at 1000 / 0.5.
  const venue = { ...v1Venue(HIGH_TOKEN), tokenIsToken0: true };
  const t = decodeLog(v3Log(-5n * 10n ** 17n, 1000n * 10n ** 18n, ALICE), venue);
  assert.equal(t.side, 'buy');
  near(t.price, 2000);
});

test('v3 swaps from another pool are ignored', () => {
  assert.equal(decodeLog(v3Log(1n, -1n, ALICE, { address: CURVE }), v1Venue(HIGH_TOKEN)), null);
});

test('priceOf refuses a missing decimals field rather than guessing 18', () => {
  assert.equal(priceOf(10n, 10n, undefined, 18), null);
  near(priceOf(10n ** 18n, 4n * 10n ** 18n, 18, 18), 0.25);
});
