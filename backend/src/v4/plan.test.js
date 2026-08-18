'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const plan = require('./plan');
const rng = require('./rng');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T00:00:00.000Z');

function wallets(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    address: `0x${String(i + 1).padStart(40, '0')}`,
  }));
}

function build(n, overrides = {}, seed = 'a'.repeat(32)) {
  const ws = wallets(n);
  return plan.generate({
    walletIds: ws.map((w) => w.id),
    addresses: Object.fromEntries(ws.map((w) => [w.id, w.address])),
    params: plan.normaliseParams({ ...overrides }),
    seed,
    now: NOW,
  });
}

test('the same seed and params give the same plan', () => {
  // days is passed explicitly rather than leaning on DEFAULTS: the default is
  // now 3, and these two tests are about determinism, not about whatever the
  // default happens to be this month. 300 wallets over 20 days sits inside
  // 10-30/day with room either side.
  const a = build(300, { days: 20 });
  const b = build(300, { days: 20 });
  assert.deepEqual(a.transfers, b.transfers);
});

test('a different seed gives a different plan', () => {
  const a = build(300, { days: 20 }, 'a'.repeat(32));
  const b = build(300, { days: 20 }, 'b'.repeat(32));
  assert.notDeepEqual(a.transfers, b.transfers);
});

test('every wallet is funded exactly once', () => {
  const out = build(400, { days: 20 });
  assert.equal(out.transfers.length, 400);
  assert.equal(new Set(out.transfers.map((t) => t.walletId)).size, 400);
});

test('feasibility refuses too many wallets for the days, naming the ceiling', () => {
  const check = plan.feasible(700, plan.normaliseParams({ days: 20 }));
  assert.equal(check.ok, false);
  assert.equal(check.max, 600);
  assert.match(check.reason, /600/);
});

test('feasibility refuses too few wallets for the days, naming the floor', () => {
  const check = plan.feasible(50, plan.normaliseParams({ days: 20 }));
  assert.equal(check.ok, false);
  assert.equal(check.min, 200);
});

test('generate throws rather than silently funding a subset', () => {
  assert.throws(() => build(700, { days: 20 }), /600/);
});

test('days is a parameter, not a constant', () => {
  const out = build(21, { days: 3, perDayMin: 5, perDayMax: 10 });
  assert.equal(out.byDay.length, 3);
  assert.equal(out.transfers.length, 21);
});

test('per-day counts stay inside the configured range', () => {
  const out = build(400, { days: 20, perDayMin: 10, perDayMax: 30 });
  for (const day of out.byDay) {
    assert.ok(day.count >= 10 && day.count <= 30, `day ${day.day} had ${day.count}`);
  }
});

test('amounts sit inside the range at six decimals, and are not round', () => {
  const out = build(400, { days: 20 });
  const seen = new Set();
  for (const t of out.transfers) {
    const n = Number(t.amountEth);
    assert.ok(n >= 0.0031 && n <= 0.0089, `${t.amountEth} out of range`);
    // Six decimals is the point: a two-decimal range has nine possible values,
    // and round numbers are themselves a pattern.
    assert.match(t.amountEth, /^\d+\.\d{6}$/);
    seen.add(t.amountEth);
  }
  assert.ok(seen.size > 300, `only ${seen.size} distinct amounts across 400 transfers`);
});

test('transfers are ordered by due time and none share a moment', () => {
  const out = build(400, { days: 20 });
  for (let i = 1; i < out.transfers.length; i++) {
    assert.ok(out.transfers[i].dueAt > out.transfers[i - 1].dueAt);
  }
});

test('every gap respects the configured minimum', () => {
  const out = build(400, { days: 20, gapMinMs: 20 * 60_000, gapMaxMs: 4 * 3_600_000 });
  for (let i = 1; i < out.transfers.length; i++) {
    const gap = out.transfers[i].dueAt - out.transfers[i - 1].dueAt;
    assert.ok(gap >= 20 * 60_000, `gap of ${gap}ms is under the floor`);
  }
});

test('the whole campaign fits inside its days', () => {
  // Two weaknesses in a single fixed check on the campaign's global last
  // transfer: (1) it only catches the LAST day spilling into a hypothetical
  // day 21 — an earlier day spilling into the next day's window never
  // becomes the campaign's overall maximum dueAt, so it passes unnoticed;
  // (2) the day-boundary gap-squeeze logic that has to keep each day inside
  // its window only gets exercised hard when a day is packed at perDayMax,
  // and whether a given seed makes that happen is chance. So: force every
  // day to run at the daily maximum (the densest, most collision-prone
  // schedule) and check every day's own transfers against that day's own
  // window, across many seeds.
  const days = 20;
  const perDayMax = plan.DEFAULTS.perDayMax;
  const n = days * perDayMax;
  for (let s = 0; s < 40; s++) {
    const out = build(n, { days, perDayMin: perDayMax, perDayMax }, `fits-${s}`);
    for (const day of out.byDay) {
      const dayStart = NOW + (day.day - 1) * DAY_MS;
      for (const t of out.transfers.filter((x) => x.day === day.day)) {
        assert.ok(
          t.dueAt >= dayStart && t.dueAt < dayStart + DAY_MS,
          `seed fits-${s} day ${day.day}: dueAt ${t.dueAt} outside [${dayStart}, ${dayStart + DAY_MS})`
        );
      }
    }
  }
});

test('a transfer starts pending with no attempts', () => {
  const [t] = build(30, { days: 2, perDayMin: 10, perDayMax: 20 }).transfers;
  assert.equal(t.status, 'pending');
  assert.deepEqual(t.attempts, []);
  assert.equal(t.hash, null);
});

test('cost includes relay fees and gas, not just the amounts', () => {
  const out = build(400, { days: 20 });
  const cost = plan.estimateCost(out.transfers, { feePct: 3, gasWei: 50_000n * 2_000_000_000n });
  const deposits = cost.depositsWei;
  assert.ok(cost.totalWei > deposits, 'total must exceed the bare deposits');
  assert.ok(cost.feesWei > 0n && cost.gasWei > 0n);
});

test('promptStart drops the wait before the first send, and only when asked', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const addresses = Object.fromEntries(ids.map((w, i) => [w, `0x${String(i + 1).padStart(40, '0')}`]));
  const shape = { days: 1, perDayMin: 20, perDayMax: 20, gapMinMs: 600_000, gapMaxMs: 3_600_000 };
  const now = Date.parse('2026-09-01T00:00:00.000Z');

  // The default keeps the offset: a seasoning campaign starting at the same
  // hour every day is a column a filter could group by.
  let sawAWait = false;
  for (let s = 0; s < 40; s++) {
    const out = plan.generate({
      walletIds: ids,
      addresses,
      params: plan.normaliseParams(shape),
      seed: `off-${s}`,
      now,
    });
    if (out.transfers[0].dueAt - now > 2 * 3_600_000) sawAWait = true;
  }
  assert.ok(sawAWait, 'without promptStart some seed should wait hours before the first send');

  // With it, the first send is one gap away — never more — on EVERY seed. This
  // is the property a split needs: it fills plumbing, and sitting idle for
  // twenty-two hours before paying the first wallet is pure cost.
  for (let s = 0; s < 40; s++) {
    const out = plan.generate({
      walletIds: ids,
      addresses,
      params: plan.normaliseParams({ ...shape, promptStart: true }),
      seed: `on-${s}`,
      now,
    });
    const wait = out.transfers[0].dueAt - now;
    assert.ok(wait <= shape.gapMaxMs, `first send waited ${wait}ms, more than one gap`);
    assert.ok(wait >= shape.gapMinMs, `first send came ${wait}ms in, sooner than the gap floor`);
  }

  // A JSON round-trip between preview and commit must not turn it on or off.
  assert.equal(plan.normaliseParams({ ...shape }).promptStart, false);
  assert.equal(plan.normaliseParams({ ...shape, promptStart: 'false' }).promptStart, false);
  assert.equal(plan.normaliseParams({ ...shape, promptStart: true }).promptStart, true);
});

test('normaliseParams refuses a zero-day campaign and a backwards range', () => {
  assert.throws(() => plan.normaliseParams({ days: 0 }), /days/);
  assert.throws(() => plan.normaliseParams({ days: 200 }), /days/);
  assert.throws(() => plan.normaliseParams({ perDayMin: 30, perDayMax: 10 }), /per-day/);
  assert.throws(() => plan.normaliseParams({ amountMinEth: '0.9', amountMaxEth: '0.1' }), /amount/);
  assert.throws(() => plan.normaliseParams({ gapMinMs: 0 }), /gap/);
});

test('normaliseParams refuses an amount minimum that the six-decimal quantiser rounds to zero', () => {
  // parseEther('0.0000001') > 0n, so the "must be positive" guard passes it —
  // and then amountFor()'s .toFixed(6) quantises EVERY draw to '0.000000'.
  // The damage is entirely silent until day one: the cost preview reads 0 ETH
  // on the very screen the preview/commit contract exists to make
  // trustworthy, the pre-flight `balance < totalWei` check can never fail
  // against a zero total, and then parseEther('0.000000') === 0n makes
  // v4/relay.js throw "transfer needs a positive amount" on every single
  // send. Three in a row halts the campaign, unattended, with an error
  // naming nothing the operator typed.
  assert.throws(
    () => plan.normaliseParams({ amountMinEth: '0.0000001', amountMaxEth: '0.002' }),
    (err) => {
      // The refusal has to name the field and the minimum, or the operator is
      // told a number is wrong without being told which one or what would be
      // right.
      assert.match(err.message, /amountMinEth/);
      assert.match(err.message, /0\.000001/);
      return true;
    }
  );

  // Both sides of the line, so the guard cannot be "reject everything small".
  assert.throws(() => plan.normaliseParams({ amountMinEth: '0.0000004', amountMaxEth: '0.002' }), /amountMinEth/);
  assert.doesNotThrow(() =>
    plan.normaliseParams({ amountMinEth: plan.MIN_AMOUNT_ETH, amountMaxEth: '0.002' })
  );

  // Zero is still caught by the older, blunter guard — and must keep its own
  // message, which routes/v4.test.js pins.
  assert.throws(() => plan.normaliseParams({ amountMinEth: '0' }), /amount minimum must be positive/);
});

test('an accepted amount range can never generate a zero-value transfer', () => {
  // The property the guard above exists to hold, asserted against the real
  // generator rather than against the guard's own arithmetic.
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const out = plan.generate({
    walletIds: ids,
    addresses: Object.fromEntries(ids.map((w, i) => [w, `0x${String(i + 1).padStart(40, '0')}`])),
    params: plan.normaliseParams({
      days: 1,
      perDayMin: 20,
      perDayMax: 20,
      amountMinEth: plan.MIN_AMOUNT_ETH,
      amountMaxEth: '0.00001',
    }),
    seed: 'fixed-seed',
    now: 0,
  });
  for (const t of out.transfers) {
    assert.ok(parseEther(t.amountEth) > 0n, `${t.amountEth} would be refused by v4/relay.js at send time`);
  }
  // And the cost preview reads as something rather than as free — the reading
  // that made the pre-flight balance check unfalsifiable.
  const cost = plan.estimateCost(out.transfers);
  assert.ok(cost.totalWei > 0n, 'the campaign previewed as costing nothing');
});

test('the per-day/gap-floor guard sits exactly at its boundary, not somewhere near it', () => {
  // 68 * 20min = 81,600,000ms, just inside DAY_MS * 0.95 = 82,080,000ms.
  // 69 * 20min = 82,800,000ms, just past it. This guard is now the only
  // thing standing between a caller and the day-boundary overflow bug fixed
  // in this task, so both sides of the line need to be pinned: accepting
  // one fewer send than the day can hold would silently make legal
  // campaigns impossible, and accepting one more reopens the overflow.
  assert.doesNotThrow(() => plan.normaliseParams({ perDayMin: 1, perDayMax: 68, gapMinMs: 20 * 60_000 }));
  assert.throws(
    () => plan.normaliseParams({ perDayMin: 1, perDayMax: 69, gapMinMs: 20 * 60_000 }),
    /gap/
  );
});

test('generate refuses a hand-built params object that skips normaliseParams and cannot fit its own gap floor', () => {
  // generate() is exported and callable on its own — nothing forces a caller
  // to route params through normaliseParams first. Without generate's own
  // re-check, this exact shape reproduces the day-boundary overflow bug:
  // 100 sends a day at a 15-minute floor cannot fit inside one day, so
  // dayTimes would silently push transfers past their day's end.
  const ws = wallets(15);
  const badParams = {
    days: 1,
    perDayMin: 15,
    perDayMax: 100,
    amountMinEth: '0.001',
    amountMaxEth: '0.002',
    gapMinMs: 15 * 60_000,
    gapMaxMs: 15 * 60_000,
  };
  assert.throws(
    () =>
      plan.generate({
        walletIds: ws.map((w) => w.id),
        addresses: Object.fromEntries(ws.map((w) => [w.id, w.address])),
        params: badParams,
        seed: 'z'.repeat(32),
        now: NOW,
      }),
    /gap/
  );
});

test('rng is deterministic and stays in range', () => {
  const a = rng.make('seed-one');
  const b = rng.make('seed-one');
  for (let i = 0; i < 100; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
  const r = rng.make('x');
  for (let i = 0; i < 200; i++) {
    const n = r.int(5, 9);
    assert.ok(Number.isInteger(n) && n >= 5 && n <= 9);
  }
});
