'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { rateFromTick, estimateTokensOut, capCheck } = require('./pricing');

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
