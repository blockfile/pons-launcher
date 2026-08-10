'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rateFromTick, estimateTokensOut, capCheck, quoteSellOutV1 } = require('./pricing');

const eth = (n) => BigInt(Math.round(n * 1e18));

// A real launch, used as the anchor for every number below:
//   token        0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F
//   initialTick  -204200
//   supply       1,000,000,000
//   observed     0.003 ETH bought 2,186,029 tokens (dev buy, on chain)
const REAL = {
  supply: (1_000_000_000n * 10n ** 18n).toString(),
  initialTick: -204200,
  maxWalletBps: 500, // 5%
  maxTxBps: 550, // 5.5%
};
const OBSERVED_TOKENS = 2_186_029;

test('the opening rate matches what the chain actually paid out', () => {
  const est = estimateTokensOut({ amountInWei: eth(0.003), initialTick: REAL.initialTick });
  const ratio = est / OBSERVED_TOKENS;
  // Within 10%: the estimate ignores the 1% pool fee and price impact, so it
  // reads a little high. Being wrong by orders of magnitude — the bug this
  // test exists to catch — is what must never happen again.
  assert.ok(ratio > 0.9 && ratio < 1.1, `estimated ${est}, chain paid ${OBSERVED_TOKENS} (ratio ${ratio})`);
});

test('the sign of the tick does not flip the answer', () => {
  // The tick's sign follows the pool's address ordering, not the economics.
  assert.equal(rateFromTick(-204200), rateFromTick(204200));
});

test('a real bundle buy is correctly seen as far under the cap', () => {
  // 0.00156489 ETH — the amount each bundle wallet used on that launch.
  const r = capCheck({ amountInWei: eth(0.00156489), launchConfig: REAL });
  assert.ok(r.estBps > 5 && r.estBps < 20, `expected ~11 bps, got ${r.estBps}`);
  assert.equal(r.exceedsWallet, false);
  assert.equal(r.exceedsTx, false);
});

test('a buy that would really breach 5% is flagged', () => {
  // 5% of a billion tokens is 50,000,000, which needs roughly 0.068 ETH here.
  const r = capCheck({ amountInWei: eth(0.09), launchConfig: REAL });
  assert.ok(r.estBps > 500, `expected over 500 bps, got ${r.estBps}`);
  assert.equal(r.exceedsWallet, true);
  assert.equal(r.exceedsTx, true);
});

test('the wallet cap bites before the transaction cap', () => {
  // Between 5% and 5.5% only the wallet limit is breached.
  const r = capCheck({ amountInWei: eth(0.0705), launchConfig: REAL });
  assert.ok(r.estBps > 500 && r.estBps < 550, `expected 500-550 bps, got ${r.estBps}`);
  assert.equal(r.exceedsWallet, true);
  assert.equal(r.exceedsTx, false);
});

test('unusable input degrades to zero rather than NaN', () => {
  assert.equal(estimateTokensOut({ amountInWei: 0n, initialTick: -204200 }), 0);
  assert.equal(estimateTokensOut({ amountInWei: eth(1), initialTick: 9e9 }), 0);
  const r = capCheck({ amountInWei: eth(1), launchConfig: { ...REAL, supply: '0' } });
  assert.equal(r.estBps, 0);
  assert.equal(r.exceedsWallet, false);
});

// ── quoting a v1 sell ──────────────────────────────────────────────────────
// Anchored to a live reading rather than to the formula it came from:
//   token   0x86D26b51fD707abD05b04084fbb6c1DB3708e7De  (1% pool, token1)
//   pool    sqrtPriceX96 2146001890159706666683605869625172
//   selling 72,915.416942227609343587 tokens returned 98383459876113 wei from
//           an eth_call of the real swap with the allowance overridden.

const LIVE_SQRT = 2146001890159706666683605869625172n;
const LIVE_TOKENS = 72915416942227609343587n;
const LIVE_ETH_OUT = 98383459876113n; // what the chain actually returned

test('quoteSellOutV1 lands on the live pool reading, a hair above it', () => {
  const q = quoteSellOutV1({
    tokensIn: LIVE_TOKENS,
    sqrtPriceX96: LIVE_SQRT,
    tokenIsToken0: false,
    poolFee: 10000,
  });

  assert.equal(q, 98390581041968n);
  // ABOVE, never below: it is the spot price, so it cannot see the impact of
  // the sell itself. A quote that came in UNDER the real fill would be a bug —
  // the operator would be told to expect less than the pool would give.
  assert.ok(q > LIVE_ETH_OUT, 'the spot price is a ceiling');
  const overBps = Number(((q - LIVE_ETH_OUT) * 10000n) / LIVE_ETH_OUT);
  assert.ok(overBps <= 5, `expected within 5 bps of the live fill, got ${overBps}`);
});

test('quoteSellOutV1 takes the pool fee off the output', () => {
  const args = { tokensIn: LIVE_TOKENS, sqrtPriceX96: LIVE_SQRT, tokenIsToken0: false };
  const gross = quoteSellOutV1({ ...args, poolFee: 0 });
  const net = quoteSellOutV1({ ...args, poolFee: 10000 });
  assert.equal(net, gross - gross / 100n, '10000 is one percent, not one bip');
});

test('quoteSellOutV1 inverts the price when the token is token0', () => {
  // token0 is priced IN token1, so the same sqrtPrice gives the reciprocal.
  const asToken1 = quoteSellOutV1({
    tokensIn: 10n ** 18n,
    sqrtPriceX96: LIVE_SQRT,
    tokenIsToken0: false,
  });
  const asToken0 = quoteSellOutV1({
    tokensIn: 10n ** 18n,
    sqrtPriceX96: LIVE_SQRT,
    tokenIsToken0: true,
  });
  assert.ok(asToken0 > asToken1, 'getting the side wrong is off by the price squared');
});

test('quoteSellOutV1 is zero for nothing to sell and never negative', () => {
  assert.equal(quoteSellOutV1({ tokensIn: 0n, sqrtPriceX96: LIVE_SQRT, tokenIsToken0: false }), 0n);
  assert.equal(quoteSellOutV1({ tokensIn: LIVE_TOKENS, sqrtPriceX96: 0n, tokenIsToken0: false }), 0n);
});
