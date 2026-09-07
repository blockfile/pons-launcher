import test from 'node:test';
import assert from 'node:assert/strict';

import { splitTotal, pairedFunds, pairedReserveEth } from './autoFill.js';

// A deterministic Math.random stand-in, so the split under test and the oracle
// below are fed the identical sequence.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * THE ORACLE — the exact expression WalletsPanel's distribute() ran before this
 * module existed, transcribed unchanged. It is what the NATIVE path must still
 * produce to the last decimal: same jitter, same normalisation, same drift onto
 * the last wallet. If splitTotal ever drifts from it, a native launch's numbers
 * have changed, and that is the one thing this refactor was not allowed to do.
 */
function legacySplit(count, total, random) {
  const bundle = Array.from({ length: count });
  const weights = bundle.map(() => 1 + (random() - 0.5) * 0.6);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const amounts = bundle.map((_, i) => Math.round((weights[i] / wsum) * total * 1e6) / 1e6);
  const drift = Math.round((total - amounts.reduce((a, b) => a + b, 0)) * 1e6) / 1e6;
  amounts[amounts.length - 1] = Math.round((amounts[amounts.length - 1] + drift) * 1e6) / 1e6;
  return amounts;
}

// ── splitTotal ───────────────────────────────────────────────────────────────
test('splitTotal is byte-identical to the split the native path has always used', () => {
  for (const count of [1, 2, 5, 7, 20, 31]) {
    for (const total of [0.5, 1, 0.123456, 3.7, 12]) {
      for (let seed = 1; seed <= 40; seed++) {
        const mine = splitTotal(count, total, { random: seeded(seed) });
        const legacy = legacySplit(count, total, seeded(seed));
        assert.deepEqual(mine, legacy, `count=${count} total=${total} seed=${seed}`);
      }
    }
  }
});

test('the sum is exactly the total that was typed', () => {
  for (const count of [1, 3, 31]) {
    for (const total of [0.5, 1, 2.345678, 100]) {
      for (let seed = 1; seed <= 50; seed++) {
        const amounts = splitTotal(count, total, { random: seeded(seed) });
        const sum = Math.round(amounts.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
        assert.equal(sum, Math.round(total * 1e6) / 1e6, `count=${count} total=${total} seed=${seed}`);
      }
    }
  }
});

test('every wallet gets a positive share inside the ±30% jitter band', () => {
  const count = 31;
  const total = 10;
  for (let seed = 1; seed <= 50; seed++) {
    const amounts = splitTotal(count, total, { random: seeded(seed) });
    const equal = total / count;
    for (const a of amounts) {
      assert.ok(a > 0, `${a} is not positive`);
      // weight ∈ [0.7, 1.3] and wsum ∈ [0.7n, 1.3n], so a share cannot leave
      // [0.7/1.3, 1.3/0.7] × equal — plus a hair for the drift on the last one.
      assert.ok(a >= equal * (0.7 / 1.3) - 1e-6, `${a} below the band`);
      assert.ok(a <= equal * (1.3 / 0.7) + 1e-6, `${a} above the band`);
    }
  }
});

test('no two wallets are handed the same amount (that is the point of the jitter)', () => {
  const amounts = splitTotal(31, 10, { random: seeded(7) });
  assert.equal(new Set(amounts).size, amounts.length);
});

test('places rounds to the quote asset — a 2-decimal pair token gets 2-decimal amounts', () => {
  const amounts = splitTotal(5, 10, { places: 2, random: seeded(3) });
  for (const a of amounts) {
    assert.equal(a, Math.round(a * 100) / 100, `${a} has more than 2 decimals`);
  }
  assert.equal(Math.round(amounts.reduce((x, y) => x + y, 0) * 100) / 100, 10);
});

test('no wallets is an empty split, not a crash', () => {
  assert.deepEqual(splitTotal(0, 1), []);
});

// ── pairedReserveEth ─────────────────────────────────────────────────────────
test('the paired reserve is the dry run’s own figure plus gas for the sells', () => {
  // 0.00185 is the endpoint's reserve at 1 gwei; 0.0007 is one sell.
  assert.equal(pairedReserveEth('0.00185', '0.0007', 10), 0.00185 + 0.007);
  assert.equal(pairedReserveEth(undefined, undefined, 10), 0, 'a missing figure is 0, never NaN');
});

// ── pairedFunds ──────────────────────────────────────────────────────────────
const plan = (results) => ({ results });

test('fund is the swap’s ETH plus the reserve — never the pair amount', () => {
  const out = pairedFunds(
    plan([
      { walletId: 'w1', status: 'skipped-short', swapEth: '0.250000000000000000', needPair: '3' },
      { walletId: 'w2', status: 'would-swap', swapEth: '0.100000000000000000', needPair: '1' },
    ]),
    0.00885
  );
  assert.deepEqual(out.funds, { w1: '0.258850', w2: '0.108850' });
  assert.deepEqual(out.unpriced, []);
  assert.ok(Math.abs(out.totalEth - 0.3677) < 1e-9);
});

test('a wallet already holding the pair token needs the reserve and no swap', () => {
  const out = pairedFunds(
    plan([{ walletId: 'w1', status: 'skipped-already-funded', swapEth: null, needPair: '3' }]),
    0.00885
  );
  assert.deepEqual(out.funds, { w1: '0.008850' });
  assert.deepEqual(out.unpriced, []);
});

test('a wallet with no price gets NO fund figure — it is reported, not guessed', () => {
  const out = pairedFunds(
    plan([
      { walletId: 'w1', status: 'failed', swapEth: null, reason: 'no route' },
      { walletId: 'w2', status: 'would-swap', swapEth: '0.1' },
    ]),
    0.001
  );
  assert.deepEqual(Object.keys(out.funds), ['w2']);
  assert.deepEqual(out.unpriced, ['w1']);
});

test('an unparseable price is unpriced rather than NaN in the Fund column', () => {
  const out = pairedFunds(plan([{ walletId: 'w1', status: 'would-swap', swapEth: 'oops' }]), 0.001);
  assert.deepEqual(out.funds, {});
  assert.deepEqual(out.unpriced, ['w1']);
});

test('an absent plan is an empty fill, not a crash', () => {
  assert.deepEqual(pairedFunds(null, 0.001), { funds: {}, unpriced: [], totalEth: 0 });
});
