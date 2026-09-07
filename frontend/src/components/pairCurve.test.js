import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequire } from 'node:module';
import { shareInputs, ethEquivalent, isNativeLaunch, pairPerEthFrom } from './pairCurve.js';

// The SAME module the backend preflight requires. Not a copy of its behaviour —
// the file itself — because the whole point of this seam is that the figure on
// screen and the figure that stops a launch come from one implementation.
const require_ = createRequire(import.meta.url);
const { pairedLaunchConfig, hasPairEconomics } = require_('../../../shared/bundleShare.js');
const { bundleShare } = require_('../../../shared/bundleShare.js');

const deps = { pairedLaunchConfig, hasPairEconomics };

// Launch config #0 and pairTokenEconomics, both read live off the v2 factory on
// Robinhood Chain at block 56,972,301. See shared/bundleShare.pair.test.js.
const V2 = {
  id: 0,
  supply: '1000000000000000000000000000',
  curveFeeBps: 100,
  phantomQuote: '1680000000000000000', // 1.68 ETH
  graduationThreshold: '4200000000000000000', // 4.2 ETH
  enabled: true,
};
const NVDA = {
  symbol: 'NVDA',
  address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
  decimals: 18,
  phantomQuote: '16640000000000000000', // 16.64 NVDA
  graduationThreshold: '41600000000000000000', // 41.6 NVDA
};
const USDG = {
  symbol: 'USDG',
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  decimals: 6,
  phantomQuote: '3236000000', // 3,236 USDG
  graduationThreshold: '8090000000',
};

// ── isNativeLaunch ───────────────────────────────────────────────────────────
test('a launch is native when there is no pair, and only then', () => {
  assert.equal(isNativeLaunch(null), true);
  assert.equal(isNativeLaunch(undefined), true);
  assert.equal(isNativeLaunch({}), true);
  assert.equal(isNativeLaunch(NVDA), false);
});

// ── shareInputs: NATIVE IS UNTOUCHED ─────────────────────────────────────────
//
// This is the assertion the whole change is allowed to exist under. Every native
// path — v1, v2-with-ETH, and the moment before a quote asset has been picked —
// must hand bundleShare exactly what it handed it before this file existed.

test('NATIVE: the launch config comes back as the identical object', () => {
  for (const protocol of ['v1', 'v2']) {
    for (const pair of [null, undefined]) {
      const out = shareInputs({ protocol, launchConfig: V2, pair, ...deps });
      assert.equal(out.launchConfig, V2, 'a copy is not good enough — it must be the same object');
      assert.equal(out.pairDecimals, 18);
      assert.equal(out.pairSymbol, 'ETH');
      assert.equal(out.blocked, null);
    }
  }
});

test('NATIVE: the share object is byte-identical to the pre-change call', () => {
  const buys = [
    { key: 'w1', amountEth: '0.05' },
    { key: 'w2', amountEth: '0.12' },
    { key: 'w3', amountEth: '0.004' },
  ];
  // THE ORACLE — App.jsx's bundleShare() argument object, transcribed verbatim
  // from before this change. No pairDecimals, no pairSymbol, the sizing's own
  // launchConfig straight through.
  const legacy = bundleShare({
    protocol: 'v2',
    launchConfig: V2,
    creatorTaxBps: 250,
    devBuyEth: '0.05',
    buys,
  });

  const inputs = shareInputs({ protocol: 'v2', launchConfig: V2, pair: null, ...deps });
  const now = bundleShare({
    protocol: 'v2',
    launchConfig: inputs.launchConfig,
    creatorTaxBps: 250,
    devBuyEth: '0.05',
    pairDecimals: inputs.pairDecimals,
    pairSymbol: inputs.pairSymbol,
    buys,
  });

  assert.deepEqual(now, legacy);
  // Serialised too: deepEqual would forgive a key that gained a value of
  // undefined, and the console renders from these fields by name.
  assert.equal(JSON.stringify(now), JSON.stringify(legacy));
});

test('NATIVE v1: the estimate is unchanged and takes no quote asset', () => {
  const V1 = { supply: '1000000000000000000000000000', initialTick: -204200, maxWalletBps: 500, maxTxBps: 550 };
  const buys = [{ key: 'w', amountEth: '0.003' }];
  const legacy = bundleShare({ protocol: 'v1', launchConfig: V1, creatorTaxBps: 0, devBuyEth: '', buys });
  const inputs = shareInputs({ protocol: 'v1', launchConfig: V1, pair: null, ...deps });
  const now = bundleShare({
    protocol: 'v1',
    launchConfig: inputs.launchConfig,
    creatorTaxBps: 0,
    devBuyEth: '',
    pairDecimals: inputs.pairDecimals,
    pairSymbol: inputs.pairSymbol,
    buys,
  });
  assert.equal(JSON.stringify(now), JSON.stringify(legacy));
  assert.equal(now.exact, false);
});

test('a v1 launch ignores a pair even if one is somehow set', () => {
  // Belt and braces: LaunchForm only hands a pair up for v2, but v1 has no quote
  // asset at all and must never be re-based onto one.
  const out = shareInputs({ protocol: 'v1', launchConfig: V2, pair: NVDA, ...deps });
  assert.equal(out.launchConfig, V2);
  assert.equal(out.pairSymbol, 'ETH');
});

// ── shareInputs: PAIRED ──────────────────────────────────────────────────────

test('PAIRED: the curve is the pair’s own, in the pair’s own units', () => {
  const out = shareInputs({ protocol: 'v2', launchConfig: V2, pair: NVDA, ...deps });
  assert.equal(out.blocked, null);
  assert.equal(out.pairSymbol, 'NVDA');
  assert.equal(out.pairDecimals, 18);
  assert.equal(out.launchConfig.phantomQuote, '16640000000000000000');
  assert.equal(out.launchConfig.graduationThreshold, '41600000000000000000');
  // Everything else on the config is the launch's, whatever it is priced in.
  assert.equal(out.launchConfig.supply, V2.supply);
  assert.equal(out.launchConfig.curveFeeBps, 100);
});

test('PAIRED: a 6-decimal quote asset carries its own decimals', () => {
  const out = shareInputs({ protocol: 'v2', launchConfig: V2, pair: USDG, ...deps });
  assert.equal(out.pairDecimals, 6);
  assert.equal(out.pairSymbol, 'USDG');
  assert.equal(out.launchConfig.phantomQuote, '3236000000');
});

test('THE LIVE SCREEN: 2.974657 NVDA behind a 0.05 dev buy', () => {
  const buys = [{ key: 'w', amountEth: '2.974657' }];
  const wrong = bundleShare({ protocol: 'v2', launchConfig: V2, devBuyEth: '0.05', buys });
  const inputs = shareInputs({ protocol: 'v2', launchConfig: V2, pair: NVDA, ...deps });
  const right = bundleShare({
    protocol: 'v2',
    launchConfig: inputs.launchConfig,
    devBuyEth: '0.05',
    pairDecimals: inputs.pairDecimals,
    pairSymbol: inputs.pairSymbol,
    buys,
  });
  // What the panel drew, and what the curve does.
  assert.equal((wrong.bundle.bps / 100).toFixed(2), '61.20');
  assert.equal((right.bundle.bps / 100).toFixed(2), '14.95');
  assert.equal(right.marketCap.finalEth, '23.167672'); // NVDA, not ETH
  assert.equal(right.pairSymbol, 'NVDA');
});

// ── shareInputs: WHEN IT CANNOT BE COMPUTED ──────────────────────────────────

test('a pair with no economics BLOCKS the share and says so — it never falls back', () => {
  for (const broken of [
    { symbol: 'NVDA', address: NVDA.address, decimals: 18 },
    { symbol: 'NVDA', address: NVDA.address, decimals: 18, phantomQuote: '0' },
    { symbol: 'NVDA', address: NVDA.address, decimals: 18, phantomQuote: null },
  ]) {
    const out = shareInputs({ protocol: 'v2', launchConfig: V2, pair: broken, ...deps });
    assert.equal(out.launchConfig, null, 'a blocked share must have no config to walk');
    assert.match(out.blocked, /NVDA/);
    assert.match(out.blocked, /nothing is shown/);
    // The one thing it must never do.
    assert.notEqual(out.launchConfig, V2);
  }
});

test('no launch config yet is not an error and not a block — there is just nothing to say', () => {
  const out = shareInputs({ protocol: 'v2', launchConfig: null, pair: NVDA, ...deps });
  assert.equal(out.launchConfig, null);
  assert.equal(out.blocked, null);
});

// ── the unit label every panel prints beside a share figure ─────────────────
//
// Three places cannot be reached by an SSR render — they are inside a Modal that
// only opens on a click (LaunchForm's "Dev buy" and "Predicted MC" facts, and its
// graduation warning). All three print `share.pairSymbol || 'ETH'`, so what they
// draw on a native launch is settled here instead.

test('NATIVE: the unit label every panel prints resolves to exactly "ETH"', () => {
  const buys = [{ key: 'w', amountEth: '0.05' }];
  const inputs = shareInputs({ protocol: 'v2', launchConfig: V2, pair: null, ...deps });
  const v2Share = bundleShare({
    protocol: 'v2',
    launchConfig: inputs.launchConfig,
    devBuyEth: '0.05',
    pairDecimals: inputs.pairDecimals,
    pairSymbol: inputs.pairSymbol,
    buys,
  });
  assert.equal(v2Share.pairSymbol, 'ETH');
  assert.equal(v2Share.pairSymbol || 'ETH', 'ETH');
  assert.equal(v2Share.isNative, true);

  // v1 has no quote asset at all, so the field is absent and the fallback fires.
  const V1 = { supply: '1000000000000000000000000000', initialTick: -204200, maxWalletBps: 500, maxTxBps: 550 };
  const v1Share = bundleShare({ protocol: 'v1', launchConfig: V1, buys });
  assert.equal(v1Share.pairSymbol, undefined);
  assert.equal(v1Share.pairSymbol || 'ETH', 'ETH');
});

test('PAIRED: the same label is the pair, so a figure can never be mis-named', () => {
  const inputs = shareInputs({ protocol: 'v2', launchConfig: V2, pair: NVDA, ...deps });
  const share = bundleShare({
    protocol: 'v2',
    launchConfig: inputs.launchConfig,
    devBuyEth: '0.529695',
    pairDecimals: inputs.pairDecimals,
    pairSymbol: inputs.pairSymbol,
    buys: [{ key: 'w', amountEth: '2.974657' }],
  });
  assert.equal(share.pairSymbol || 'ETH', 'NVDA');
  assert.equal(share.isNative, false);
  // The label and the arithmetic come from the SAME object, which is the point:
  // they cannot drift apart the way a hardcoded "ETH" did.
  assert.equal(share.marketCap.finalEth, '24.301940');
  assert.equal(share.graduation.thresholdEth, '41.600000');
});

// ── ethEquivalent ────────────────────────────────────────────────────────────

test('NATIVE: the amount is returned unchanged, as the very string it came in as', () => {
  const amount = '13.006019';
  assert.equal(ethEquivalent(amount, { isNative: true, pairPerEth: null }), amount);
  assert.equal(ethEquivalent(amount, { isNative: true, pairPerEth: 10.594 }), amount);
  // Nothing is re-derived, so nothing can round differently.
  assert.equal(ethEquivalent('0.000001', { isNative: true }), '0.000001');
});

test('PAIRED: the pair figure is divided by the live rate', () => {
  // 24.30194 NVDA at 10.5939 NVDA per ETH.
  const out = ethEquivalent('24.301940', { isNative: false, pairPerEth: 10.5939 });
  assert.ok(Math.abs(Number(out) - 2.29399) < 1e-4, out);
});

test('PAIRED with no usable rate is NULL, never the pair number wearing an ETH label', () => {
  for (const rate of [null, undefined, 0, -1, NaN, 'nope', '']) {
    assert.equal(ethEquivalent('24.30194', { isNative: false, pairPerEth: rate }), null, String(rate));
  }
});

test('an absent or unusable amount is null on either kind of launch', () => {
  for (const amount of [null, undefined, '']) {
    assert.equal(ethEquivalent(amount, { isNative: true }), null);
    assert.equal(ethEquivalent(amount, { isNative: false, pairPerEth: 10 }), null);
  }
  assert.equal(ethEquivalent('0', { isNative: false, pairPerEth: 10 }), null);
  assert.equal(ethEquivalent('oops', { isNative: false, pairPerEth: 10 }), null);
});

// ── pairPerEthFrom ───────────────────────────────────────────────────────────

test('the rate is the probe’s answer scaled to one ETH', () => {
  assert.equal(pairPerEthFrom({ pairOut: '0.0105939' }, '0.001'), 10.5939);
  assert.equal(pairPerEthFrom({ pairOut: '2.536000' }, '0.001'), 2536);
});

test('an unusable quote yields no rate at all — there is no fallback', () => {
  assert.equal(pairPerEthFrom(null, '0.001'), null);
  assert.equal(pairPerEthFrom({}, '0.001'), null);
  assert.equal(pairPerEthFrom({ pairOut: '0' }, '0.001'), null);
  assert.equal(pairPerEthFrom({ pairOut: 'x' }, '0.001'), null);
  assert.equal(pairPerEthFrom({ pairOut: '1' }, '0'), null);
});
