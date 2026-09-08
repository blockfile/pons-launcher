import test from 'node:test';
import assert from 'node:assert/strict';

import { splitTotal, pairedFunds, pairedReserveEth, fillAction, FILL_BASES } from './autoFill.js';

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

// ── WHICH BASIS IS ACTIVE, AND WHETHER ITS ONE ACTION CAN DO ANYTHING ────────
// The panel used to stack three controls that all wrote the Buy column: a total
// in the pair token, a converter with its own "use as total", and a fill from
// the ETH the wallets already hold. They are one question — WHAT DECIDES THE
// SIZE OF THE BUYS — and this is the function that answers it.

const paired = { paired: true, symbol: 'NVDA', bundleCount: 31 };

test('a native launch has exactly one basis, whatever is asked for', () => {
  for (const basis of ['pair', 'eth', 'held', 'nonsense', undefined]) {
    const act = fillAction({ basis, paired: false, bundleCount: 5, totalBuy: '1' });
    assert.equal(act.basis, 'pair', `${basis} leaked a paired basis onto a native launch`);
    assert.equal(act.unit, 'ETH');
  }
});

test('an unknown basis on a paired launch falls back rather than leaving no state', () => {
  const act = fillAction({ ...paired, basis: 'wat', totalBuy: '12' });
  assert.equal(act.basis, 'pair');
  assert.equal(act.enabled, true);
});

test('the pair basis is dead until a total is typed, and says so', () => {
  const empty = fillAction({ ...paired, basis: 'pair', totalBuy: '' });
  assert.equal(empty.enabled, false);
  assert.match(empty.why, /NVDA/);
  assert.match(empty.label, /31 wallets/);

  const zero = fillAction({ ...paired, basis: 'pair', totalBuy: '0' });
  assert.equal(zero.enabled, false);

  const typed = fillAction({ ...paired, basis: 'pair', totalBuy: '12' });
  assert.equal(typed.enabled, true);
  assert.equal(typed.why, null);
  assert.equal(typed.unit, 'NVDA');
});

test('the ETH basis arms only on a quote that is about what is TYPED', () => {
  const nothing = fillAction({ ...paired, basis: 'eth', ethTotal: '' });
  assert.equal(nothing.enabled, false);

  // The read is debounced: a figure typed but not yet priced must not arm a
  // button labelled with the previous answer.
  const pricing = fillAction({ ...paired, basis: 'eth', ethTotal: '0.5', quotedPair: null });
  assert.equal(pricing.enabled, false);
  assert.match(pricing.why, /Pricing 0\.5 ETH/);

  const quoted = fillAction({ ...paired, basis: 'eth', ethTotal: '0.5', quotedPair: 12.345678 });
  assert.equal(quoted.enabled, true);
  // The figure it will write is ON the button — a conversion becomes a written
  // number only by a press, and the press names the number.
  assert.match(quoted.label, /12\.345678 NVDA/);
});

test('the held basis is dead when no wallet holds any ETH, and names the fix', () => {
  const broke = fillAction({ ...paired, basis: 'held', fundedCount: 0 });
  assert.equal(broke.enabled, false);
  assert.match(broke.why, /not? bundle wallet is holding any ETH/i);

  const funded = fillAction({ ...paired, basis: 'held', fundedCount: 7 });
  assert.equal(funded.enabled, true);
  // It PRICES. The write is a second, separate press.
  assert.match(funded.label, /Price/);
});

test('no bundle wallets is the first refusal, before any basis has an opinion', () => {
  for (const basis of ['pair', 'eth', 'held']) {
    const act = fillAction({ ...paired, bundleCount: 0, basis, totalBuy: '12', ethTotal: '1', quotedPair: 3, fundedCount: 4 });
    assert.equal(act.enabled, false, basis);
    assert.match(act.why, /No bundle wallets/);
  }
});

test('the label counts the wallets it will split across, singular and plural', () => {
  assert.match(fillAction({ paired: false, bundleCount: 1, totalBuy: '1' }).label, /1 wallet$/);
  assert.match(fillAction({ paired: false, bundleCount: 2, totalBuy: '1' }).label, /2 wallets$/);
});

test('every basis is one FILL_BASES knows', () => {
  for (const basis of FILL_BASES) {
    assert.equal(fillAction({ ...paired, basis, totalBuy: '1', ethTotal: '1', fundedCount: 1 }).basis, basis);
  }
});
