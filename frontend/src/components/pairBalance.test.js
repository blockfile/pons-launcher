import test from 'node:test';
import assert from 'node:assert/strict';

import { toUnits, fromUnits, pairStatus, pairShortfall, balanceFill } from './pairBalance.js';

// ── parsing: a figure that cannot be read is not zero ────────────────────────

test('a decimal string becomes an exact scaled integer, whatever its length', () => {
  assert.equal(toUnits('1'), 10n ** 18n);
  assert.equal(toUnits('0.029125'), 29125000000000000n);
  assert.equal(toUnits('12.5'), 12500000000000000000n);
  assert.equal(toUnits('0.000000000000000001'), 1n);
});

test('anything that is not a plain decimal is UNKNOWN, never 0', () => {
  // Zero is a claim — that the wallet is empty — and it must not be made about a
  // balance that was simply not read.
  for (const v of [null, undefined, '', '  ', 'abc', '-1', '1e-7', '1,000', NaN]) {
    assert.equal(toUnits(v), null, `${String(v)} must not parse`);
  }
});

test('fromUnits is the exact inverse and drops trailing zeros', () => {
  assert.equal(fromUnits(toUnits('12.5')), '12.5');
  assert.equal(fromUnits(toUnits('0.029125')), '0.029125');
  assert.equal(fromUnits(0n), '0');
});

// ── the four states ──────────────────────────────────────────────────────────

test('a balance that was not read is UNKNOWN, and is never drawn as short', () => {
  assert.equal(pairStatus(undefined, '1'), 'unknown');
  assert.equal(pairStatus(null, '1'), 'unknown');
  assert.equal(pairShortfall(null, '1'), null);
});

test('a wallet with nothing asked of it has no target, whatever it holds', () => {
  assert.equal(pairStatus('0', ''), 'no-target');
  assert.equal(pairStatus('5', '0'), 'no-target');
  // "all − gas" resolves its amount server-side, so the row names no requirement.
  assert.equal(pairStatus('5', undefined), 'no-target');
  assert.equal(pairStatus('0', null), 'no-target');
});

test('holding at least the buy amount is OK; a wei less is SHORT', () => {
  assert.equal(pairStatus('0.029125', '0.029125'), 'ok');
  assert.equal(pairStatus('0.029126', '0.029125'), 'ok');
  assert.equal(pairStatus('0.029124', '0.029125'), 'short');
  assert.equal(pairStatus('0', '0.029125'), 'short');
});

test('exact equality is OK, and is decided as integers rather than as floats', () => {
  // 0.1 + 0.2 !== 0.3 in a float, and "short" is the state preflight drops a
  // wallet for — it must not be a rounding artefact.
  assert.equal(pairStatus('0.3', '0.30000000000000004'), 'short');
  assert.equal(pairStatus('0.30000000000000004', '0.3'), 'ok');
  assert.equal(pairStatus('1000000.000000000000000001', '1000000'), 'ok');
});

test('the shortfall is a subtraction in ONE asset, exact to the last place', () => {
  assert.equal(pairShortfall('0.029124', '0.029125'), '0.000001');
  assert.equal(pairShortfall('0', '12.5'), '12.5');
  assert.equal(pairShortfall('12.5', '12.5'), null, 'a wallet that has enough is owed nothing');
  assert.equal(pairShortfall('99', '12.5'), null);
  assert.equal(pairShortfall('5', ''), null);
});

// ── applying the "use available ETH" plan ────────────────────────────────────

const plan = {
  pairSymbol: 'NVDA',
  results: [
    { walletId: 'a', address: '0xaa', status: 'ok', buyPair: '0.029125' },
    { walletId: 'b', address: '0xbb', status: 'skipped-no-eth', buyPair: null, reason: 'holds 0.001 ETH' },
    { walletId: 'c', address: '0xcc', status: 'ok', buyPair: '0.0184' },
    { walletId: 'd', address: '0xdd', status: 'skipped-impact', buyPair: null, reason: 'pool too thin' },
    { walletId: 'e', address: '0xee', status: 'failed', buyPair: null, reason: 'rpc hiccup' },
  ],
};

test('only an OK row gets an amount, and it gets the backend string verbatim', () => {
  const { patches, filled } = balanceFill(plan);
  assert.equal(filled, 2);
  // Verbatim: not re-rounded, not re-scaled. The conservative figure is only a
  // guarantee if it is the figure that is written.
  assert.deepEqual(patches.a, { mode: 'fixed', buy: '0.029125' });
  assert.deepEqual(patches.c, { mode: 'fixed', buy: '0.0184' });
  assert.equal(patches.b, undefined);
  assert.equal(patches.d, undefined);
  assert.equal(patches.e, undefined);
});

test('every wallet left alone is NAMED, and none is given a zero', () => {
  const { patches, skipped } = balanceFill(plan);
  assert.equal(skipped.length, 3);
  assert.deepEqual(
    skipped.map((s) => s.walletId),
    ['b', 'd', 'e']
  );
  assert.ok(skipped.every((s) => s.address && s.reason));
  assert.ok(Object.values(patches).every((p) => Number(p.buy) > 0), 'a zero reads as a decision');
});

test('an OK row with no amount is treated as skipped rather than written as blank', () => {
  const { patches, skipped } = balanceFill({ results: [{ walletId: 'x', address: '0xx', status: 'ok', buyPair: null }] });
  assert.deepEqual(patches, {});
  assert.equal(skipped.length, 1);
});

test('no plan at all is an empty fill, not a crash', () => {
  assert.deepEqual(balanceFill(null), { patches: {}, filled: 0, skipped: [] });
  assert.deepEqual(balanceFill({}), { patches: {}, filled: 0, skipped: [] });
});
