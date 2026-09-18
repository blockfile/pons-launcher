import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  quoteCurveSell,
  curveSellGross,
  applyCurveSell,
  curveReservesAfterAny,
  curveSellWorst,
} from './curveMath.js';

// Test-only: the backend's live-verified function is the oracle (Task 4).
const require = createRequire(import.meta.url);
const { _private } = require('../../../../backend/src/tp/quote.js');
const { curveSellOut } = _private;

// A real CurveSell on chain 4663 (backend/src/tp/quote.test.js, LIVE): curve
// 0xEBfCaFE39ED532cfBaB07FC53c8A26AFC77f0C76, block 66473033, tx
// 0xce7c9da9ecf4c695ae252116a1bd28fa3eb66b588346c806136bd31ad900a8f6.
const LIVE = {
  before: { quoteReserve: 15686659869309136435n, tokenReserve: 345972825901495681386889301n },
  after: { quoteReserve: 15209419520723626568n, tokenReserve: 356828742645022267089198202n },
  curveFeeBps: 100,
  creatorTaxBps: 100,
  tokensIn: 10855916743526585702308901n,
  quoteOut: 467695541613799671n,
};

// Deterministic 64-bit xorshift over BigInt, so a failure is reproducible.
function rng(seed) {
  let s = BigInt(seed) & ((1n << 64n) - 1n);
  const MASK = (1n << 64n) - 1n;
  return function next() {
    s ^= (s << 13n) & MASK;
    s ^= s >> 7n;
    s ^= (s << 17n) & MASK;
    return s;
  };
}

/** A uniform-ish BigInt in [lo, hi]. */
function between(next, lo, hi) {
  const span = hi - lo + 1n;
  return lo + (((next() << 64n) | next()) % span);
}

/** Every ordering of 0..n-1. */
function permutations(n) {
  if (n === 1) return [[0]];
  const out = [];
  for (const p of permutations(n - 1)) {
    for (let i = 0; i <= p.length; i += 1) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  }
  return out;
}

test('reproduces the LIVE CurveSell to the wei, and the reserves it left behind', () => {
  const r = { ...LIVE.before, curveFeeBps: LIVE.curveFeeBps, creatorTaxBps: LIVE.creatorTaxBps };
  assert.equal(quoteCurveSell(r, LIVE.tokensIn), LIVE.quoteOut);
  const after = applyCurveSell(r, LIVE.tokensIn);
  assert.equal(after.quoteReserve, LIVE.after.quoteReserve, 'the quote reserve falls by the GROSS');
  assert.equal(after.tokenReserve, LIVE.after.tokenReserve);
  assert.equal(after.curveFeeBps, 100);
  assert.equal(after.creatorTaxBps, 100);
  assert.equal(LIVE.before.quoteReserve - after.quoteReserve, curveSellGross(r, LIVE.tokensIn));
});

test('matches backend/src/tp/quote.js curveSellOut (out AND gross) over 200 seeded cases', () => {
  const next = rng(0x5eed2026n);
  let nonZero = 0;
  for (let i = 0; i < 200; i += 1) {
    const quoteReserve = between(next, 10n ** 12n, 10n ** 26n);
    const tokenReserve = between(next, 10n ** 15n, 10n ** 27n);
    const tokensIn = between(next, 0n, 10n ** 26n);
    const curveFeeBps = Number(between(next, 0n, 300n));
    const creatorTaxBps = Number(between(next, 0n, 500n));
    const theirs = curveSellOut({ tokensIn, quoteReserve, tokenReserve, feeBps: curveFeeBps, creatorTaxBps });
    const r = { quoteReserve, tokenReserve, curveFeeBps, creatorTaxBps };
    const label = `case ${i}: q=${quoteReserve} t=${tokenReserve} in=${tokensIn} fee=${curveFeeBps}+${creatorTaxBps}`;
    assert.equal(quoteCurveSell(r, tokensIn), theirs.out, label);
    assert.equal(curveSellGross(r, tokensIn), theirs.gross, label);
    if (theirs.out > 0n) nonZero += 1;
  }
  assert.ok(nonZero > 150, `the cases must mostly quote real output (got ${nonZero} non-zero)`);
});

test('accepts decimal strings exactly as the wire carries them', () => {
  const r = {
    quoteReserve: String(LIVE.before.quoteReserve),
    tokenReserve: String(LIVE.before.tokenReserve),
    curveFeeBps: 100,
    creatorTaxBps: 100,
  };
  assert.equal(quoteCurveSell(r, String(LIVE.tokensIn)), LIVE.quoteOut);
});

test('the fee fields are required and bounded; zero or negative input quotes zero', () => {
  const r = { quoteReserve: 10n ** 18n, tokenReserve: 10n ** 27n, curveFeeBps: 100, creatorTaxBps: 0 };
  assert.equal(quoteCurveSell(r, 0n), 0n);
  assert.equal(quoteCurveSell(r, -5n), 0n);
  assert.throws(() => quoteCurveSell({ quoteReserve: 1n, tokenReserve: 1n, feeBps: 200 }, 1n), /separately/);
  assert.throws(() => quoteCurveSell({ ...r, curveFeeBps: 1.5 }, 1n), /curveFeeBps/);
  assert.throws(() => quoteCurveSell({ ...r, curveFeeBps: 6000, creatorTaxBps: 5000 }, 1n), /exceed/);
});

test('each later identical sell fills worse, and the walk keeps the fees', () => {
  const r = { quoteReserve: 10n ** 18n, tokenReserve: 10n ** 27n, curveFeeBps: 100, creatorTaxBps: 50 };
  const first = quoteCurveSell(r, 10n ** 24n);
  const after = applyCurveSell(r, 10n ** 24n);
  assert.equal(after.quoteReserve, 10n ** 18n - curveSellGross(r, 10n ** 24n));
  assert.equal(after.tokenReserve, 10n ** 27n + 10n ** 24n);
  assert.ok(quoteCurveSell(after, 10n ** 24n) < first);
});

test('curveReservesAfterAny is a floor on the quote reserve after the same sells in ANY order', () => {
  const next = rng(0xc0ffeen);
  for (let round = 0; round < 20; round += 1) {
    const start = {
      quoteReserve: between(next, 10n ** 17n, 10n ** 22n),
      tokenReserve: between(next, 10n ** 25n, 10n ** 27n),
      curveFeeBps: 100,
      creatorTaxBps: 100,
    };
    const sells = [0, 1, 2, 3].map(() => between(next, 1n, 10n ** 25n));
    const total = sells.reduce((a, b) => a + b, 0n);
    const bound = curveReservesAfterAny(start, total);
    for (const order of permutations(sells.length)) {
      let r = start;
      for (const i of order) r = applyCurveSell(r, sells[i]);
      assert.equal(r.tokenReserve, bound.tokenReserve, 'the token reserve is exact');
      assert.ok(r.quoteReserve >= bound.quoteReserve, `round ${round}: order ${order} left less than the floor`);
      assert.ok(r.quoteReserve - bound.quoteReserve <= BigInt(sells.length), 'and within one wei per sell of it');
    }
  }
  const same = curveReservesAfterAny({ quoteReserve: 7n, tokenReserve: 9n }, 0n);
  assert.deepEqual([same.quoteReserve, same.tokenReserve], [7n, 9n]);
});

test('curveSellWorst: a sell landing after any subset of the others, in any order, pays at least it', () => {
  const next = rng(0xfeedn);
  for (let round = 0; round < 10; round += 1) {
    const start = {
      quoteReserve: between(next, 10n ** 17n, 10n ** 21n),
      tokenReserve: between(next, 10n ** 25n, 10n ** 27n),
      curveFeeBps: Number(between(next, 0n, 300n)),
      creatorTaxBps: Number(between(next, 0n, 500n)),
    };
    const sells = [0, 1, 2, 3].map(() => between(next, 10n ** 18n, 10n ** 26n));
    const total = sells.reduce((a, b) => a + b, 0n);
    const worst = sells.map((a) => curveSellWorst(start, a, total - a));
    for (const order of permutations(sells.length)) {
      // Every prefix of an order is "a subset of the others landed first".
      let r = start;
      for (const i of order) {
        assert.ok(quoteCurveSell(r, sells[i]) >= worst[i], `round ${round}: wallet ${i} in order ${order}`);
        r = applyCurveSell(r, sells[i]);
      }
    }
    // Landing last is tight: the worst case is at most 1 wei + rounding under what it really pays.
    const last = [1, 2, 3].reduce((r, i) => applyCurveSell(r, sells[i]), start);
    const paid = quoteCurveSell(last, sells[0]);
    assert.ok(paid - worst[0] <= 1n + BigInt(sells.length), `round ${round}: the bound is tight (${paid - worst[0]} wei)`);
  }
});
