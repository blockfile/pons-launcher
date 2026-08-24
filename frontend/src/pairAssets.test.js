import test from 'node:test';
import assert from 'node:assert/strict';

import { NATIVE_PAIR, isNativePair, pairOptions, selectedPair, bodyPairToken } from './pairAssets.js';

// The shape /api/v2/configs returns on this branch: native ETH first (address(0),
// flagged native), then the approved ERC-20 quote assets enriched by the backend.
const SPCX = '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const CONFIG = {
  pairTokens: [
    { symbol: 'ETH', address: NATIVE_PAIR, decimals: 18, native: true },
    { symbol: 'SPCX', address: SPCX, decimals: 18 },
    { symbol: 'USDG', address: USDG, decimals: 6 },
  ],
};

test('native ETH is the default selection and sends the zero-address sentinel', () => {
  // With nothing picked, the picker resolves to native and the body carries the
  // exact value the backend defaults to — a native launch is unchanged.
  const sel = selectedPair(CONFIG, undefined);
  assert.equal(sel.symbol, 'ETH');
  assert.equal(isNativePair(sel.address), true);
  assert.equal(bodyPairToken(sel.address), NATIVE_PAIR);
});

test('selecting SPCX puts its address into the launch body', () => {
  const sel = selectedPair(CONFIG, SPCX);
  assert.equal(sel.symbol, 'SPCX');
  assert.equal(isNativePair(sel.address), false);
  // Byte-for-byte the selected address, so prepareV2 gates on and prices against
  // the SPCX pair rather than native.
  assert.equal(bodyPairToken(sel.address), SPCX);
});

test('a 6-decimal RWA reports its own decimals for the copy', () => {
  assert.equal(selectedPair(CONFIG, USDG).decimals, 6);
});

test('a stale selection that is no longer approved falls back to native', () => {
  const gone = '0x00000000000000000000000000000000deadbeef';
  const sel = selectedPair(CONFIG, gone);
  assert.equal(sel.symbol, 'ETH');
  assert.equal(bodyPairToken(sel.address), NATIVE_PAIR);
});

test('a missing or empty pairTokens list falls back to native-only, never empty', () => {
  for (const bad of [null, {}, { pairTokens: [] }, { pairTokens: 'nope' }]) {
    const options = pairOptions(bad);
    assert.equal(options.length, 1);
    assert.equal(options[0].symbol, 'ETH');
    assert.equal(isNativePair(options[0].address), true);
  }
});

test('native is guaranteed first even if the backend omits it', () => {
  const options = pairOptions({ pairTokens: [{ symbol: 'SPCX', address: SPCX, decimals: 18 }] });
  assert.equal(options[0].symbol, 'ETH');
  assert.equal(isNativePair(options[0].address), true);
  assert.ok(options.some((t) => t.symbol === 'SPCX'));
});

test('isNativePair is case-insensitive and null-safe', () => {
  assert.equal(isNativePair(NATIVE_PAIR.toUpperCase()), true);
  assert.equal(isNativePair(''), true);
  assert.equal(isNativePair(undefined), true);
  assert.equal(isNativePair(SPCX), false);
});
