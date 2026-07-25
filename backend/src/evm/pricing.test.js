'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { priceFromTick, estimateTokensOut, capCheck } = require('./pricing');

const eth = (n) => BigInt(Math.round(n * 1e18));

// Addresses chosen so the ordering is unambiguous in each direction.
const LOW = '0x0000000000000000000000000000000000000001';
const HIGH = '0xffffffffffffffffffffffffffffffffffffffff';

test('tick 0 is a price of 1', () => {
  assert.equal(priceFromTick(0), 1);
});

test('tick direction matches Uniswap (1.0001^tick)', () => {
  assert.ok(priceFromTick(10000) > 2.7 && priceFromTick(10000) < 2.8);
  assert.ok(priceFromTick(-10000) > 0.36 && priceFromTick(-10000) < 0.37);
});

test('token ordering flips the arithmetic', () => {
  // At tick 0 the price is 1, so 1 ETH buys 1 token whichever side we are on.
  const asToken0 = estimateTokensOut({ amountInWei: eth(1), initialTick: 0, token: LOW, pairToken: HIGH });
  const asToken1 = estimateTokensOut({ amountInWei: eth(1), initialTick: 0, token: HIGH, pairToken: LOW });
  assert.equal(asToken0, 1);
  assert.equal(asToken1, 1);

  // Away from tick 0 the two sides must move in OPPOSITE directions — this is
  // the mistake that would silently misprice a whole bundle.
  const t0 = estimateTokensOut({ amountInWei: eth(1), initialTick: 10000, token: LOW, pairToken: HIGH });
  const t1 = estimateTokensOut({ amountInWei: eth(1), initialTick: 10000, token: HIGH, pairToken: LOW });
  assert.ok(t0 < 1, 'as token0 a positive tick means fewer tokens per ETH');
  assert.ok(t1 > 1, 'as token1 a positive tick means more tokens per ETH');
});

test('bad input yields 0 rather than NaN', () => {
  assert.equal(estimateTokensOut({ amountInWei: 0n, initialTick: 0, token: LOW, pairToken: HIGH }), 0);
  assert.equal(estimateTokensOut({ amountInWei: eth(1), initialTick: 9e9, token: LOW, pairToken: HIGH }), 0);
});

// A supply of 1,000,000 tokens priced at tick 0: 1 ETH buys 1 token = 1 bps.
const cfg = {
  supply: (1_000_000n * 10n ** 18n).toString(),
  initialTick: 0,
  pairToken: HIGH,
  maxWalletBps: 500, // 5%
  maxTxBps: 550, // 5.5%
};

test('a buy under the caps is not flagged', () => {
  const r = capCheck({ amountInWei: eth(1000), launchConfig: cfg, token: LOW });
  assert.equal(Math.round(r.estBps), 10); // 1000 of 1,000,000 tokens
  assert.equal(r.exceedsWallet, false);
  assert.equal(r.exceedsTx, false);
});

test('a buy over the wallet cap is flagged before it can revert', () => {
  // 60,000 tokens of 1,000,000 = 6%, past the 5% wallet cap but under 5.5% tx.
  const r = capCheck({ amountInWei: eth(60000), launchConfig: cfg, token: LOW });
  assert.equal(Math.round(r.estBps), 600);
  assert.equal(r.exceedsWallet, true);
  assert.equal(r.exceedsTx, true);
});

test('a cap check on nonsense config degrades quietly', () => {
  const r = capCheck({ amountInWei: eth(1), launchConfig: { ...cfg, supply: '0' }, token: LOW });
  assert.equal(r.estBps, 0);
  assert.equal(r.exceedsWallet, false);
});
