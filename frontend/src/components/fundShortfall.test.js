import test from 'node:test';
import assert from 'node:assert/strict';

import { fundShortfall, topUpPlan, WRITE_PLACES } from './fundShortfall.js';

// The run this whole file exists for: 31 wallets, the dev wallet got 7 transfers
// out and then the run threw. Scaled down to what a test can read.
const bundle = (spec) =>
  spec.map(([id, balanceEth]) => ({ id, address: `0x${id}`, role: 'bundle', balanceEth }));
const funds = (spec) => Object.fromEntries(spec.map(([id, fund]) => [id, { fund }]));

// ── the arithmetic ───────────────────────────────────────────────────────────

test('short is need minus have, per wallet, and never negative', () => {
  const b = bundle([
    ['a', '0.02'], // paid in full
    ['b', '0.005'], // partially funded
    ['c', '0'], // never got anything
    ['d', '0.5'], // holds far more than it was asked for
  ]);
  const r = fundShortfall(b, funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02'], ['d', '0.02']]));

  assert.deepEqual(
    r.rows.map((x) => [x.walletId, x.short, x.state]),
    [
      ['a', '0', 'funded'],
      ['b', '0.015', 'partial'],
      ['c', '0.02', 'waiting'],
      ['d', '0', 'funded'],
    ]
  );
  assert.equal(r.funded, 2);
  assert.equal(r.short, 2);
  assert.equal(r.shortTotal, '0.035');
  assert.equal(r.needTotal, '0.08');
});

test('compared as scaled integers, because a float comparison is blind at 18 places', () => {
  // Exactly enough is not short, however long the string it arrived as.
  const exact = fundShortfall(bundle([['a', '0.029125000000000000']]), funds([['a', '0.029125']]));
  assert.equal(exact.rows[0].state, 'funded');
  assert.equal(exact.shortTotal, '0');

  // ONE WEI SHORT IS SHORT. `Number('0.019999999999999999') >= Number('0.02')` is
  // TRUE — both sides round to the same double — so a float comparison calls this
  // wallet funded and leaves it unable to pay for what it was sized for. Balances
  // arrive formatted from wei, at exactly this many places, every time.
  const wei = fundShortfall(bundle([['a', '0.019999999999999999']]), funds([['a', '0.02']]));
  assert.equal(wei.rows[0].state, 'partial');
  assert.equal(wei.rows[0].short, '0.000000000000000001');

  // And the totals are an integer sum: 0.1 + 0.1 + 0.1 is 0.3, not
  // 0.30000000000000004 — this figure is read as "what the run will send".
  const three = fundShortfall(
    bundle([['a', '0'], ['b', '0'], ['c', '0']]),
    funds([['a', '0.1'], ['b', '0.1'], ['c', '0.1']])
  );
  assert.equal(three.shortTotal, '0.3');
  assert.equal(three.needTotal, '0.3');
  assert.equal(topUpPlan(bundle([['a', '0'], ['b', '0'], ['c', '0']]), funds([['a', '0.1'], ['b', '0.1'], ['c', '0.1']])).sendAfter, '0.3');
});

test('a wallet with no Fund amount is not in the question at all', () => {
  const b = bundle([['a', '0'], ['b', '0']]);
  const r = fundShortfall(b, funds([['a', ''], ['b', '0']]));
  assert.deepEqual(r.rows, []);
  assert.equal(r.targets, 0);
  assert.equal(r.shortTotal, '0');
});

test('an UNREAD balance is not zero-held: reported, never counted short, never patched', () => {
  const b = bundle([['a', null], ['b', '0']]);
  const r = fundShortfall(b, funds([['a', '0.02'], ['b', '0.02']]));

  assert.equal(r.unread, 1);
  assert.equal(r.rows[0].state, 'unread');
  assert.equal(r.rows[0].short, null);
  // It is still OWED — the target counts — but nothing is claimed about it.
  assert.equal(r.needTotal, '0.04');
  assert.equal(r.haveTotal, '0');
  assert.equal(r.shortTotal, '0.02');

  const plan = topUpPlan(b, funds([['a', '0.02'], ['b', '0.02']]));
  assert.equal(plan.patches.a, undefined, 'an unread wallet must keep its Fund amount');
  assert.deepEqual(plan.patches.b, { fund: '0.02' });
  assert.deepEqual(plan.unread, [{ walletId: 'a', address: '0xa', need: '0.02' }]);
  // And its live amount is still part of what the run would send.
  assert.equal(plan.sendAfter, '0.04');
});

// ── rounding, and the direction it has to go ─────────────────────────────────

test('the written figure rounds UP, so it is never below the true shortfall', () => {
  // need - have = 0.0000005 exactly: at six places the only safe answer is the
  // one ABOVE it. Rounding down leaves the wallet short and preflight drops it.
  const b = bundle([['a', '0.0199995']]);
  const plan = topUpPlan(b, funds([['a', '0.02']]));
  assert.deepEqual(plan.patches.a, { fund: '0.000001' });
});

test('rounding up is never more than one unit above the truth', () => {
  const b = bundle([['a', '0.0000000000001']]); // a dust balance, 13 places down
  const plan = topUpPlan(b, funds([['a', '1']]));
  const written = Number(plan.patches.a.fund);
  const truth = 1 - 0.0000000000001;
  assert.ok(written >= truth, 'must never be under');
  assert.ok(written - truth <= 10 ** -WRITE_PLACES, 'must never be over by more than a unit');
});

test('a shortfall that fits exactly in six places is written exactly', () => {
  const b = bundle([['a', '0.005']]);
  assert.deepEqual(topUpPlan(b, funds([['a', '0.02']])).patches.a, { fund: '0.015' });
});

// ── the order-of-operations trap ─────────────────────────────────────────────

test('every figure comes from the column AS IT STANDS, returned as one patch map', () => {
  const b = bundle([['a', '0.02'], ['b', '0.005'], ['c', '0']]);
  const rows = funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]);
  const plan = topUpPlan(b, rows);

  // One object, every affected wallet in it — there is no per-wallet call for a
  // caller to interleave with its own writes.
  assert.deepEqual(plan.patches, {
    a: { fund: '0' },
    b: { fund: '0.015' },
    c: { fund: '0.02' },
  });
  // And the reading it was derived from is untouched by it.
  assert.deepEqual(rows, funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]));
});

test('the BEFORE total is the pre-write column, not the one the plan produces', () => {
  const b = bundle([['a', '0.02'], ['b', '0.005'], ['c', '0']]);
  const plan = topUpPlan(b, funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]));
  assert.equal(plan.sendBefore, '0.06');
  assert.equal(plan.sendAfter, '0.035');
  assert.equal(plan.saved, '0.025');
  assert.equal(plan.zeroed, 1);
  assert.equal(plan.carrying, 2);
  assert.equal(plan.changed, 2, 'c already carried its own shortfall and does not change');
});

test('applying the patches one at a time gives what the one-shot plan promised', () => {
  // The trap: a control that rewrote Fund wallet-by-wallet would be measuring
  // later wallets against a column it had already mutated. Applying this plan in
  // any order lands the same column, because every figure was fixed before the
  // first write.
  const b = bundle([['a', '0.02'], ['b', '0.005'], ['c', '0']]);
  const rows = funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]);
  const plan = topUpPlan(b, rows);

  const live = structuredClone(rows);
  for (const id of ['c', 'a', 'b']) live[id] = { ...live[id], ...plan.patches[id] };

  assert.deepEqual(live, funds([['a', '0'], ['b', '0.015'], ['c', '0.02']]));
});

// ── pressing it twice ────────────────────────────────────────────────────────

test('re-planning with nextTarget reproduces the SAME column, however many presses', () => {
  const b = bundle([['a', '0.02'], ['b', '0.005'], ['c', '0']]);
  let rows = funds([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]);
  let targetFund = {};

  for (let press = 0; press < 4; press += 1) {
    const plan = topUpPlan(b, rows, { targetFund });
    rows = Object.fromEntries(
      Object.entries(rows).map(([id, row]) => [id, { ...row, ...(plan.patches[id] || {}) }])
    );
    targetFund = { ...targetFund, ...plan.nextTarget };
    assert.deepEqual(rows, funds([['a', '0'], ['b', '0.015'], ['c', '0.02']]), `press ${press + 1}`);
  }
});

test('without the remembered target a second pass would UNDER-fund — which is why it is carried', () => {
  // Pinned as the reason `nextTarget` exists: the column no longer holds the
  // target after one application, so subtracting the balance from it again takes
  // the wallet's own 0.005 off a second time.
  const b = bundle([['b', '0.005']]);
  const once = topUpPlan(b, funds([['b', '0.02']]));
  assert.equal(once.patches.b.fund, '0.015');

  const naive = topUpPlan(b, funds([['b', once.patches.b.fund]]));
  assert.equal(naive.patches.b.fund, '0.01', 'the trap this argument closes');

  const safe = topUpPlan(b, funds([['b', once.patches.b.fund]]), { targetFund: once.nextTarget });
  assert.equal(safe.patches.b.fund, '0.015');
});

test('a target the operator has since retyped is honoured, not overridden', () => {
  // Forgetting the remembered figure is how a hand-edited Fund amount takes
  // effect — the panel drops the entry as the field is typed in.
  const b = bundle([['b', '0.005']]);
  const plan = topUpPlan(b, funds([['b', '0.05']]), { targetFund: {} });
  assert.equal(plan.patches.b.fund, '0.045');
});

// ── after the resumed run ────────────────────────────────────────────────────

test('once the remainder has landed every wallet reads funded and the column is 0', () => {
  const b = bundle([['a', '0.02'], ['b', '0.02'], ['c', '0.02']]);
  const rows = funds([['a', '0'], ['b', '0.015'], ['c', '0.02']]);
  const targetFund = { a: '0.02', b: '0.02', c: '0.02' };

  const plan = topUpPlan(b, rows, { targetFund });
  assert.deepEqual(plan.patches, { a: { fund: '0' }, b: { fund: '0' }, c: { fund: '0' } });
  assert.equal(plan.sendAfter, '0');
  assert.equal(plan.zeroed, 3);
  assert.equal(plan.carrying, 0);
  assert.equal(plan.reading.funded, 3);
});

test('a wallet drained since the amounts were typed needs MORE, and says so', () => {
  const b = bundle([['a', '0']]);
  const plan = topUpPlan(b, funds([['a', '0.005']]), { targetFund: { a: '0.02' } });
  assert.equal(plan.patches.a.fund, '0.02');
  assert.equal(plan.sendBefore, '0.005');
  assert.equal(plan.sendAfter, '0.02');
  assert.equal(plan.saved, '-0.015');
});

test('an empty bundle plans nothing and claims nothing', () => {
  const plan = topUpPlan([], {});
  assert.deepEqual(plan.patches, {});
  assert.equal(plan.sendBefore, '0');
  assert.equal(plan.sendAfter, '0');
  assert.equal(plan.reading.targets, 0);
});
