'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sliceTokens, estimateFeasibility, DEFAULT_VARIANCE_PCT, MAX_VARIANCE_PCT } = require('./sizing');

// ── sliceTokens ───────────────────────────────────────────────────────────────

test('the LAST wallet (remainingWallets === 1) takes the whole remaining balance', () => {
  assert.equal(sliceTokens({ tokenBalance: 123n, remainingWallets: 1, variancePct: 30, roll: 0.5 }), 123n);
  // Even with variance set — the last wallet is exact, no jitter, so the position ends on zero.
  assert.equal(sliceTokens({ tokenBalance: 1000n, remainingWallets: 1, variancePct: 90, roll: 0 }), 1000n);
});

test('with variance 0 it is exactly the running mean (balance ÷ walletsLeft)', () => {
  assert.equal(sliceTokens({ tokenBalance: 1000n, remainingWallets: 4, variancePct: 0 }), 250n);
  assert.equal(sliceTokens({ tokenBalance: 999n, remainingWallets: 3, variancePct: 0 }), 333n);
});

test('variance swings the slice around the mean, bounded by roll', () => {
  const mean = 1000n / 5n; // 200
  const low = sliceTokens({ tokenBalance: 1000n, remainingWallets: 5, variancePct: 30, roll: 0 }); // -30%
  const high = sliceTokens({ tokenBalance: 1000n, remainingWallets: 5, variancePct: 30, roll: 1 }); // +30%
  assert.equal(low, (mean * 7000n) / 10000n); // 140
  assert.equal(high, (mean * 13000n) / 10000n); // 260
  // The midpoint roll reproduces the mean.
  assert.equal(sliceTokens({ tokenBalance: 1000n, remainingWallets: 5, variancePct: 30, roll: 0.5 }), mean);
});

test('on the variance path a slice is never zero and never exceeds the balance', () => {
  // A tiny balance with variance in play clamps up to 1 rather than rounding to 0
  // (a zero slice would sell/transfer/buy nothing and leave a hole in the tape).
  const s = sliceTokens({ tokenBalance: 3n, remainingWallets: 2, variancePct: 90, roll: 0 });
  assert.ok(s >= 1n, 'never zero when variance is in play');
  assert.ok(s <= 3n, 'never more than the balance');
  // A high roll (mean 5 + 90% = 9.5 → 9) stays under the balance.
  assert.ok(sliceTokens({ tokenBalance: 10n, remainingWallets: 2, variancePct: 90, roll: 1 }) <= 10n);
});

test('sliceTokens refuses an empty position, a bad wallet count, and out-of-range variance', () => {
  assert.throws(() => sliceTokens({ tokenBalance: 0n, remainingWallets: 3 }), /nothing left/);
  assert.throws(() => sliceTokens({ tokenBalance: 100n, remainingWallets: 0 }), /positive integer/);
  assert.throws(() => sliceTokens({ tokenBalance: 100n, remainingWallets: 2, variancePct: MAX_VARIANCE_PCT + 1 }), /variance/);
  assert.equal(DEFAULT_VARIANCE_PCT, 30);
});

// ── estimateFeasibility ───────────────────────────────────────────────────────

const GAS = { mainGas: 10n, buyGas: 5n, buffer: 2n };

test('feasible when the per-wallet average clears main gas + the buy after the relay fee', () => {
  // 1000 / 4 = 250 per wallet; minus 10 gas = 240; ×97% = 232 > 5+2. Feasible.
  const r = estimateFeasibility({ positionValueWei: 1000n, walletCount: 4, ...GAS, relayFeePct: 3 });
  assert.equal(r.feasible, true);
  assert.equal(r.perWalletWei, 250n);
  assert.equal(r.reason, null);
});

test('infeasible reasons: worthless, slice-below-gas, buy-underfunded', () => {
  assert.deepEqual(estimateFeasibility({ positionValueWei: 0n, walletCount: 3, ...GAS }).reason, 'worthless');
  // per-wallet 8, minus 10 gas ≤ 0 → slice-below-gas
  assert.equal(estimateFeasibility({ positionValueWei: 24n, walletCount: 3, ...GAS }).reason, 'slice-below-gas');
  // per-wallet 13, minus 10 = 3, ×97% = 2 ≤ buyGas(5)+buffer(2) → buy-underfunded
  assert.equal(estimateFeasibility({ positionValueWei: 39n, walletCount: 3, ...GAS }).reason, 'buy-underfunded');
});
