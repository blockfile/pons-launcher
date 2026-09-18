import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sellAmount,
  buildQuoteCache,
  quotesForClick,
  walkCurve,
  classifyError,
  hasPairLeg,
  gasNeeded,
  toTxRequest,
  resolveMissed,
  chunkByWallet,
  summarizeSkips,
  stageOf,
} from './sellMath.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

test('sellAmount floors and sells the exact balance at 100 %', () => {
  assert.equal(sellAmount(999n, 50), 499n);
  assert.equal(sellAmount('999', 100), 999n);
  assert.equal(sellAmount(0n, 50), 0n);
  // two fast 50 % clicks sell 75 %, never 100 %
  const first = sellAmount(1000n, 50);
  const second = sellAmount(1000n - first, 50);
  assert.equal(first + second, 750n);
});

test('quotesForClick scales a fresh full-balance quote down, conservatively', () => {
  const cache = buildQuoteCache(
    [{ address: A, amount: '1000' }, { address: B, amount: '2000' }],
    [
      { address: B.toUpperCase().replace('0X', '0x'), amountOut: '900', impactBps: 100, ok: true },
      { address: A, amountOut: '500', impactBps: 30, ok: true },
    ],
    10_000
  );
  const q = quotesForClick(cache, [{ address: A, amount: '500' }, { address: B, amount: '1000' }], 11_000);
  // Each entry echoes the amount it prices: chain/plan.js planSell uses a pool
  // quote only when quote.amount equals the amount it sells (Task 10 contract note 4).
  assert.deepEqual(q, [
    { address: A, amount: '500', amountOut: '250', impactBps: 15, ok: true, reason: null },
    { address: B, amount: '1000', amountOut: '450', impactBps: 50, ok: true, reason: null },
  ]);
  const full = quotesForClick(cache, [{ address: A, amount: 1000n }], 11_000);
  assert.deepEqual(full, [{ address: A, amount: '1000', amountOut: '500', impactBps: 30, ok: true, reason: null }], 'a bigint amount is echoed as a decimal string');
});

test('quotesForClick scales the worst-order floor too when the cache holds one (chain/plan.js attachQuotes rows)', () => {
  // attachQuotes rows carry worstOut: the floor planSell requires. Scaled by the
  // same ratio and floored, it stays a lower bound (session.js explains why).
  const cache = buildQuoteCache(
    [{ address: A, amount: '1000' }],
    [{ address: A, amount: '1000', amountOut: '500', worstOut: '401', impactBps: 30, ok: true, reason: null }],
    10_000
  );
  assert.deepEqual(quotesForClick(cache, [{ address: A, amount: '500' }], 11_000), [
    { address: A, amount: '500', amountOut: '250', worstOut: '200', impactBps: 15, ok: true, reason: null },
  ]);
});

test('quotesForClick refuses stale, missing, refused or grown entries', () => {
  const cache = buildQuoteCache(
    [{ address: A, amount: '1000' }, { address: B, amount: '1000' }],
    [
      { address: A, amountOut: '500', impactBps: 30, ok: true },
      { address: B, amountOut: '0', impactBps: 9000, ok: false, reason: 'impact' },
    ],
    10_000
  );
  assert.equal(quotesForClick(cache, [{ address: A, amount: '500' }], 12_001), null, 'older than 2 s');
  assert.equal(quotesForClick(cache, [{ address: B, amount: '500' }], 10_500), null, 'refused quote');
  assert.equal(quotesForClick(cache, [{ address: A, amount: '1001' }], 10_500), null, 'balance grew');
  assert.equal(quotesForClick(cache, [{ address: '0x' + 'c'.repeat(40), amount: '1' }], 10_500), null, 'missing');
  assert.equal(quotesForClick(null, [], 0), null);
  assert.ok(quotesForClick(cache, [{ address: A, amount: '500' }], 99_999, Infinity), 'maxAge Infinity');
});

test('walkCurve moves the reserves by each pending sell in turn', () => {
  const mark = { block: 5, price: 1, quoteReserve: '1000', tokenReserve: '1000' };
  const w = walkCurve(mark, [100n, 0n, 100n]);
  // first: gross = 1000*100/1100 = 90 -> q 910, t 1100; second: 910*100/1200 = 75 -> q 835, t 1200
  assert.equal(w.quoteReserve, '835');
  assert.equal(w.tokenReserve, '1200');
  assert.equal(w.block, 5);
  assert.equal(mark.quoteReserve, '1000', 'input untouched');
});

test('classifyError', () => {
  assert.equal(classifyError('already known'), 'known');
  assert.equal(classifyError('Nonce too low: next nonce 7, tx nonce 5'), 'low');
  assert.equal(classifyError('replacement transaction underpriced'), 'low');
  assert.equal(classifyError('nonce too high'), 'high');
  assert.equal(classifyError('insufficient funds for gas * price + value'), 'funds');
  assert.equal(classifyError('execution reverted'), 'other');
  assert.equal(classifyError(undefined), 'other');
});

test('gasNeeded adds approvals and the pair leg (token-quoted curves AND graduated pools, as plan.js pairLegGas)', () => {
  const fees = {
    maxFeePerGas: '10',
    gasLimits: { approve: 50, permit2Approve: 60, sellCurve: 100, sellV4: 200, sellV1: 150, pairSwap: 300 },
  };
  assert.equal(gasNeeded({ kind: 'curve', nativeQuote: true }, fees), 1000n);
  assert.equal(gasNeeded({ kind: 'curve', nativeQuote: true }, fees, { needsArm: true }), 1500n);
  assert.equal(gasNeeded({ kind: 'curve', nativeQuote: false }, fees), 4500n);
  assert.equal(gasNeeded({ kind: 'graduated', nativeQuote: true }, fees, { needsArm: true }), 3100n);
  // SPCX-paired pool: sellV4 200 + approve 50 + pairSwap 300 = 550 gas
  assert.equal(gasNeeded({ kind: 'graduated', nativeQuote: false }, fees), 5500n);
  assert.equal(gasNeeded({ kind: 'graduated', nativeQuote: false }, fees, { needsArm: true }), 6600n);
  assert.equal(gasNeeded({ kind: 'v1', nativeQuote: true }, fees), 1500n);
  assert.equal(gasNeeded({ kind: 'v1', nativeQuote: false }, fees), 1500n, 'v1 unwraps WETH in the sell: no pair leg');
  assert.equal(hasPairLeg({ kind: 'curve', nativeQuote: false }), true);
  assert.equal(hasPairLeg({ kind: 'graduated', nativeQuote: false }), true);
  assert.equal(hasPairLeg({ kind: 'graduated', nativeQuote: true }), false);
  assert.equal(hasPairLeg({ kind: 'v1', nativeQuote: false }), false);
  assert.equal(hasPairLeg(null), false);
});

test('toTxRequest matches the contract txRequest', () => {
  const tx = toTxRequest({ to: A, data: '0x12' }, { nonce: 7, gasLimit: '80000', fees: { maxFeePerGas: '123' } });
  assert.deepEqual(tx, {
    to: A,
    data: '0x12',
    value: 0n,
    nonce: 7,
    gasLimit: 80000n,
    maxFeePerGas: 123n,
    maxPriorityFeePerGas: 0n,
    chainId: 4663,
    type: 2,
  });
});

test('resolveMissed', () => {
  assert.equal(resolveMissed({ before: 1000n, amount: 400n, fresh: 600n }), 'landed');
  assert.equal(resolveMissed({ before: 1000n, amount: 400n, fresh: 1000n }), 'reverted');
});

test('chunkByWallet never splits a wallet across requests', () => {
  const metas = [{ key: 'a' }, { key: 'a' }, { key: 'b' }, { key: 'b' }, { key: 'c' }];
  assert.deepEqual(chunkByWallet(metas, 3), [[0, 1], [2, 3, 4]]);
  assert.deepEqual(chunkByWallet(metas, 100), [[0, 1, 2, 3, 4]]);
  assert.deepEqual(chunkByWallet([], 100), []);
});

test('summarizeSkips and stageOf', () => {
  assert.equal(summarizeSkips([{ reason: 'not armed' }, { reason: 'not armed' }, { reason: 'no gas' }]), '2 not armed, 1 no gas');
  assert.equal(stageOf({ venue: null, rows: [] }), 'empty');
  assert.equal(stageOf({ venue: {}, rows: [] }), 'token');
  assert.equal(stageOf({ venue: {}, rows: [{ ticked: true, canSell: false }] }), 'wallets');
  assert.equal(stageOf({ venue: {}, rows: [{ ticked: true, canSell: true }] }), 'armed');
});
