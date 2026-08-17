'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plan = require('./plan');

/** A controllable clock and timer table. No real time passes in this file. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return { id, unref() {} };
    },
    clearTimeout: (h) => h && timers.delete(h.id),
    /** Advance to the next due timer and run it. Returns false when idle. */
    async tick() {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return false;
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.at);
      await timer.fn();
      return true;
    },
    async drain(max = 500) {
      let n = 0;
      while (n < max && (await this.tick())) n++;
      return n;
    },
    pending: () => timers.size,
  };
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4run-'));
  process.env.HISTORY_PATH = path.join(dir, 'launches.json');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./runner')];
  const store = require('./store');
  store._reset();
  return { store, dir };
}

function makeCampaign(store, { id = 'c1', masterWalletId = 'm1', count = 4, now = 1_000_000 } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `s${i}`);
  const built = plan.generate({
    walletIds: ids,
    addresses: Object.fromEntries(ids.map((w, i) => [w, `0x${String(i + 1).padStart(40, '0')}`])),
    params: plan.normaliseParams({ days: 1, perDayMin: count, perDayMax: count }),
    seed: 'fixed-seed',
    now,
  });
  const campaign = {
    id,
    name: id,
    status: 'running',
    seed: built.seed,
    createdAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    haltedAt: null,
    haltReason: null,
    masterWalletId,
    params: built.params,
    transfers: built.transfers,
    consecutiveFailures: 0,
  };
  store.storeFor('u').create(campaign);
  return campaign;
}

function runnerWith(store, clock, transfer) {
  const { createRunner } = require('./runner');
  return createRunner({
    storeForFn: store.storeFor,
    transferFn: transfer,
    keystoreForFn: () => ({ list: () => [], signer: () => ({}) }),
    activityForFn: () => ({ record() {} }),
    rolesResolve: () => ({ id: 'm1', address: '0x' + '1'.repeat(40) }),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    nowFn: clock.now,
  });
}

test('a campaign sends every transfer and completes', async () => {
  const { store } = env();
  const clock = fakeClock();
  const sent = [];
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    sent.push(toAddress);
    return { hash: '0x' + 'a'.repeat(64), requestId: null, depositAddress: '0x' + 'b'.repeat(40) };
  });

  makeCampaign(store);
  runner.resumeAll();
  await clock.drain();

  assert.equal(sent.length, 4);
  assert.equal(store.storeFor('u').get('c1').status, 'complete');
});

test('a failed transfer is re-slotted and retried, not abandoned at once', async () => {
  const { store } = env();
  const clock = fakeClock();
  let calls = 0;
  const runner = runnerWith(store, clock, async () => {
    calls++;
    if (calls === 1) throw new Error('relay hiccup');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 2 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'complete');
  const retried = c.transfers.find((t) => t.attempts.length > 0);
  assert.equal(retried.attempts.length, 1);
  assert.equal(retried.status, 'sent');
});

test('three consecutive failures halt the campaign', async () => {
  const { store } = env();
  const clock = fakeClock();
  let calls = 0;
  const runner = runnerWith(store, clock, async () => {
    calls++;
    throw new Error('relay is down');
  });

  makeCampaign(store, { count: 10 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'halted');
  assert.match(c.haltReason, /relay is down/);
  // THREE, not "eventually". A campaign that halts on the fourth or the tenth
  // failure has already spent slots it cannot get back — every extra attempt
  // against a systemic fault (Relay down, funding wallet dry) burns a wallet's
  // scheduled slot for nothing. Asserting only "it halted" passes an
  // implementation with any threshold at all, so pin the number itself.
  assert.equal(calls, 3, 'the campaign halted after the wrong number of failures');
  assert.equal(c.consecutiveFailures, 3);
  assert.equal(
    c.transfers.reduce((n, t) => n + t.attempts.length, 0),
    3,
    'a halted campaign recorded more attempts than the threshold allows'
  );
  // It must stop, not burn the remaining slots.
  assert.ok(c.transfers.filter((t) => t.status === 'pending').length > 0);
});

test('a success resets the consecutive-failure counter', async () => {
  const { store } = env();
  const clock = fakeClock();
  let n = 0;
  // fail, fail, succeed, fail, fail, succeed … never three in a row
  const runner = runnerWith(store, clock, async () => {
    n++;
    if (n % 3 !== 0) throw new Error('flaky');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.notEqual(store.storeFor('u').get('c1').status, 'halted');
});

test('a transfer is abandoned after three attempts, and the campaign goes on', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    // Only the first wallet ever fails, so failures are never consecutive.
    if (toAddress.endsWith('1')) throw new Error('this one is cursed');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 8 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  const cursed = c.transfers.find((t) => t.address.endsWith('1'));
  assert.equal(cursed.status, 'abandoned');
  assert.equal(cursed.attempts.length, 3);
  assert.equal(c.status, 'complete');
});

test('a restart re-arms from disk and does not fire a burst', async () => {
  const { store } = env();
  const clock = fakeClock();
  const times = [];
  const runner = runnerWith(store, clock, async () => {
    times.push(clock.now());
    return { hash: '0x' + 'a'.repeat(64) };
  });

  // Every transfer is already overdue — the shape of a six-hour outage.
  makeCampaign(store, { count: 5, now: clock.now() - 10 * 60 * 60 * 1000 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(times.length, 5);
  // Re-slotted, not bunched: no two sends land in the same instant.
  assert.equal(new Set(times).size, 5, 'overdue transfers were fired as a burst');
});

test('two campaigns on two funding wallets run in parallel', async () => {
  const { store } = env();
  const clock = fakeClock();
  const byCampaign = { c1: 0, c2: 0 };
  const runner = runnerWith(store, clock, async ({ campaignId }) => {
    byCampaign[campaignId]++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3 });
  makeCampaign(store, { id: 'c2', masterWalletId: 'm2', count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(byCampaign.c1, 3);
  assert.equal(byCampaign.c2, 3);
});

test('a campaign refuses to start on a funding wallet already running', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1' });
  runner.resumeAll();

  assert.throws(
    () => runner.start('u', { id: 'c2', masterWalletId: 'm1', status: 'running', transfers: [], consecutiveFailures: 0 }),
    /m1|already/
  );
});

test('pause stops the clock and resume picks up where it stopped', async () => {
  const { store } = env();
  const clock = fakeClock();
  let sends = 0;
  const runner = runnerWith(store, clock, async () => {
    sends++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 6 });
  runner.resumeAll();
  await clock.tick();
  runner.pause('u', 'c1');
  const afterPause = sends;
  await clock.drain();
  assert.equal(sends, afterPause, 'a paused campaign kept sending');

  runner.resume('u', 'c1');
  await clock.drain();
  assert.equal(sends, 6);
});

test('cancel is final — resume refuses it', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));
  makeCampaign(store);
  runner.resumeAll();
  runner.cancel('u', 'c1');
  assert.equal(store.storeFor('u').get('c1').status, 'cancelled');
  assert.throws(() => runner.resume('u', 'c1'), /cancelled/);
});
