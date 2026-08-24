'use strict';

// shareV2 against a NON-NATIVE quote asset. The curve arithmetic is unchanged —
// it is integer x*y=k and does not care about decimals — so what these check is
// the EDGES: that amounts typed by the operator are parsed at the pair asset's
// decimals, that every quote-denominated figure is formatted at those decimals,
// and that a 6-decimal asset (USDG) is not silently treated as 18.
//
// The failure these guard against is concrete: parse "1000" USDG as 1000e18
// against a phantomQuote of 5000e6 and the buy swallows essentially the whole
// supply (≈100%); parse it correctly as 1000e6 and it is ~16.5%. Twelve orders
// of magnitude is not a rounding error, it is a different launch.

const test = require('node:test');
const assert = require('node:assert');

const { shareV2, bundleShare, parseAmount, formatUnitsStr } = require('./bundleShare');

// A launched token is minted at 18 decimals whatever it is priced in.
const SUPPLY = (1_000_000_000n * 10n ** 18n).toString(); // 1e27

// ── USDG: a 6-decimal quote asset ───────────────────────────────────────────
// phantomQuote 5,000 USDG, threshold 20,000 USDG, both in 6-dec base units.
const USDG = {
  supply: SUPPLY,
  phantomQuote: (5000n * 10n ** 6n).toString(), // 5,000 USDG
  graduationThreshold: (20000n * 10n ** 6n).toString(), // 20,000 USDG
  curveFeeBps: 100,
  enabled: true,
};

test('parseAmount / formatUnitsStr respect the asset decimals', () => {
  assert.equal(parseAmount('1000', 6), 1000n * 10n ** 6n);
  assert.equal(parseAmount('1000', 18), 1000n * 10n ** 18n);
  assert.equal(parseAmount('0.5', 6), 500000n);
  assert.equal(formatUnitsStr(1000n * 10n ** 6n, 6), '1000.000000');
  assert.equal(formatUnitsStr(5n * 10n ** 6n, 6), '5.000000');
  // A 6-dec amount read as 18-dec is where the bug would show: 5,000 USDG
  // collapses to a near-zero figure instead of five thousand.
  assert.equal(formatUnitsStr(5000n * 10n ** 6n, 6), '5000.000000');
  assert.equal(formatUnitsStr(5000n * 10n ** 6n, 18), '0.000000');
});

test('a USDG buy is sized and priced at 6 decimals, not 18', () => {
  const share = shareV2({
    launchConfig: USDG,
    pairDecimals: 6,
    pairSymbol: 'USDG',
    buys: [{ key: 'a', amountEth: '1000' }], // 1,000 USDG
  });

  // The buy amount echoes back in USDG, at 6 decimals.
  assert.equal(share.buys[0].amountEth, '1000.000000');

  // 1,000 USDG net of 1% into a 5,000 USDG phantom reserve is ~16.5% of supply.
  // If "1000" had been parsed as 1000e18 against a 5000e6 reserve, this would be
  // ~9,999 bps (the whole curve). The correct 6-dec parse is ~1,653 bps.
  assert.ok(
    share.buys[0].estBps > 1600 && share.buys[0].estBps < 1700,
    `expected ~1653 bps, got ${share.buys[0].estBps}`
  );

  // Market cap opens at the phantom quote itself: 5,000 USDG. At 18 decimals this
  // would misformat to 0.000005.
  assert.equal(share.marketCap.openingEth, '5000.000000');
  assert.ok(Number(share.marketCap.finalEth) > 5000, 'the buy raises the cap');

  // Descriptors travel out so the console can label the column.
  assert.equal(share.pairSymbol, 'USDG');
  assert.equal(share.pairDecimals, 6);
  assert.equal(share.isNative, false);
});

test('a USDG raw amountWei is taken as-is (preflight already scaled it)', () => {
  // preflight passes base units, not a typed string. 1,000 USDG = 1,000e6.
  const share = shareV2({
    launchConfig: USDG,
    pairDecimals: 6,
    pairSymbol: 'USDG',
    buys: [{ key: 'a', amountWei: 1000n * 10n ** 6n }],
  });
  assert.equal(share.buys[0].amountEth, '1000.000000');
  assert.ok(share.buys[0].estBps > 1600 && share.buys[0].estBps < 1700);
});

test('a USDG bundle graduates against the pair-token threshold', () => {
  // 20,000 USDG threshold. Five buys of 5,000 USDG each raise 25,000 gross,
  // ~24,750 net — over the threshold.
  const share = shareV2({
    launchConfig: USDG,
    pairDecimals: 6,
    pairSymbol: 'USDG',
    buys: Array.from({ length: 5 }, (_, i) => ({ key: `w${i}`, amountEth: '5000' })),
  });
  assert.equal(share.graduation.thresholdEth, '20000.000000');
  assert.equal(share.graduation.crosses, true);
  assert.ok(share.graduation.crossesAt, 'the wallet that tips it over is named');
});

// ── SPCX: an 18-decimal quote asset behaves like ETH ────────────────────────
const SPCX = {
  supply: SUPPLY,
  phantomQuote: (168n * 10n ** 16n).toString(), // 1.68
  graduationThreshold: (42n * 10n ** 17n).toString(), // 4.2
  curveFeeBps: 100,
  enabled: true,
};

test('an 18-decimal pair is priced exactly like native ETH, only labelled differently', () => {
  const asSpcx = shareV2({
    launchConfig: SPCX,
    pairDecimals: 18,
    pairSymbol: 'SPCX',
    buys: [{ key: 'a', amountEth: '0.2' }],
  });
  const asNative = shareV2({
    launchConfig: SPCX,
    buys: [{ key: 'a', amountEth: '0.2' }],
  });

  // Same arithmetic, different label.
  assert.equal(asSpcx.buys[0].estBps, asNative.buys[0].estBps);
  assert.equal(asSpcx.buys[0].amountEth, asNative.buys[0].amountEth);
  assert.equal(asSpcx.marketCap.openingEth, asNative.marketCap.openingEth);
  assert.equal(asSpcx.pairSymbol, 'SPCX');
  assert.equal(asSpcx.isNative, false);
  assert.equal(asNative.pairSymbol, 'ETH');
  assert.equal(asNative.isNative, true);
});

test('the native default is byte-identical in its numbers to before', () => {
  // No pairDecimals/pairSymbol passed → 18/ETH, and every existing figure the
  // old shareV2 produced is unchanged. (bundleShare.test.js pins the values; this
  // only asserts the new descriptors do not disturb them.)
  const share = bundleShare({
    protocol: 'v2',
    launchConfig: SPCX,
    creatorTaxBps: 50,
    devBuyEth: '0.05',
    buys: [{ key: 'a', amountEth: '0.05' }],
  });
  assert.equal(share.pairSymbol, 'ETH');
  assert.equal(share.pairDecimals, 18);
  assert.equal(share.isNative, true);
  assert.doesNotThrow(() => JSON.stringify(share));
});
