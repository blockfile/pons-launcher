'use strict';

// Unit tests for V8's server-held paced fan-out. The timer, the clock, the id source, the
// keystore, the activity log and the money path are all injected, so the state machine
// runs instantly and offline.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTimedTransferManager, MIN_INTERVAL_MS } = require('./timedTransfer');

const USER = 'u1';
const A = (n) => '0x' + String(n).padStart(40, '0');

// A hand-cranked timer: schedule() hands the callback here and a test fires it when it
// wants the next tick to happen.
function fakeTimers() {
  const t = { scheduled: [], pending: null, cleared: 0 };
  t.setTimeoutFn = (fn, ms) => {
    t.scheduled.push(ms);
    t.pending = fn;
    return { unref() {} };
  };
  t.clearTimeoutFn = () => {
    t.cleared += 1;
    t.pending = null;
  };
  t.fire = async () => {
    const fn = t.pending;
    t.pending = null;
    if (!fn) throw new Error('nothing scheduled');
    await fn();
  };
  return t;
}

function harness(over = {}) {
  const timers = fakeTimers();
  const logged = [];
  const calls = [];
  let now = 1_700_000_000_000;

  const transferFn =
    over.transferFn ||
    (async (targets) => {
      calls.push(targets);
      return {
        mode: 'relay-solver',
        from: A(1),
        totalDepositEth: '0.01',
        results: [
          {
            walletId: targets[0].walletId,
            address: A(2),
            amountEth: targets[0].amountEth,
            requestId: '0xreq',
            depositAddress: A(3),
            hash: `hash:${targets[0].walletId}`,
            error: null,
          },
        ],
      };
    });

  const mgr = createTimedTransferManager({
    transferFn,
    planTargetsFn:
      over.planTargetsFn ||
      ((targets) =>
        targets.map((t, i) => ({
          walletId: t.walletId,
          address: A(10 + i),
          amountWei: 1n,
          amountEth: String(t.amountEth),
        }))),
    keystoreForFn: () => ({ id: USER }),
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: () => now,
    idFn: () => 'job-1',
    ...(over.minIntervalMs !== undefined ? { minIntervalMs: over.minIntervalMs } : {}),
  });

  return { mgr, timers, logged, calls, tick: (ms) => (now += ms), nowOf: () => now };
}

const THREE = [
  { walletId: 'b1', amountEth: '0.01' },
  { walletId: 'b2', amountEth: '0.02' },
  { walletId: 'b3', amountEth: '0.03' },
];

test('status is idle before anything starts', () => {
  const { mgr } = harness();
  assert.deepEqual(mgr.status(USER), {
    protocol: 'v8',
    mode: 'relay-transfer-timed',
    status: 'idle',
    running: false,
  });
});

test('start validates every target up front and schedules the first immediately', () => {
  const { mgr, timers } = harness();
  const job = mgr.start(USER, THREE, { intervalMinutes: 5 });
  assert.equal(job.status, 'running');
  assert.equal(job.total, 3);
  assert.equal(job.intervalMinutes, 5);
  assert.deepEqual(timers.scheduled, [0], 'the first wallet goes at once');
  assert.deepEqual(
    job.targets.map((t) => t.state),
    ['next', 'pending', 'pending']
  );
});

test('one target per interval: each tick sends exactly one and schedules the next', async () => {
  const { mgr, timers, calls } = harness();
  mgr.start(USER, THREE, { intervalMinutes: 5 });

  await timers.fire();
  assert.deepEqual(calls, [[{ walletId: 'b1', amountEth: '0.01' }]], 'one wallet per tick, never a burst');
  let s = mgr.status(USER);
  assert.equal(s.currentIndex, 1);
  assert.equal(s.sent, 1);
  assert.equal(s.remaining, 2);
  assert.deepEqual(timers.scheduled, [0, 5 * 60_000], 'the next tick is one interval away');

  await timers.fire();
  await timers.fire();
  s = mgr.status(USER);
  assert.equal(s.status, 'complete');
  assert.equal(s.sent, 3);
  assert.equal(s.failed, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c[0].walletId),
    ['b1', 'b2', 'b3']
  );
});

test('the job is server-held: nothing about it needs the caller to stay connected', async () => {
  const { mgr, timers } = harness();
  mgr.start(USER, THREE, { intervalMinutes: 30 });
  await timers.fire();
  // No request, no socket, no browser — just the next scheduled callback.
  await timers.fire();
  assert.equal(mgr.status(USER).completed, 2);
});

test('a wallet that fails is recorded against itself and the cadence carries on', async () => {
  let n = 0;
  const { mgr, timers } = harness({
    transferFn: async (targets) => {
      n += 1;
      if (n === 2) throw new Error('Relay rate limit');
      return {
        results: [{ walletId: targets[0].walletId, hash: `hash:${n}`, error: null }],
      };
    },
  });
  mgr.start(USER, THREE, { intervalMinutes: 5 });
  await timers.fire();
  await timers.fire();
  await timers.fire();

  const s = mgr.status(USER);
  assert.equal(s.status, 'complete');
  assert.equal(s.completed, 3, 'every wallet is reported, failed or not');
  assert.equal(s.failed, 1);
  assert.equal(s.sent, 2);
  assert.equal(s.results[1].status, 'failed');
  assert.match(s.results[1].error, /Relay rate limit/);
  assert.equal(s.results[2].walletId, 'b3', 'the run did not stop at the failure');
});

test('a per-target error returned (not thrown) by the money path is counted as failed', async () => {
  const { mgr, timers } = harness({
    transferFn: async (targets) => ({
      results: [{ walletId: targets[0].walletId, hash: null, error: 'quote refused' }],
    }),
  });
  mgr.start(USER, [THREE[0]], { intervalMinutes: 5 });
  await timers.fire();
  const s = mgr.status(USER);
  assert.equal(s.failed, 1);
  assert.equal(s.results[0].status, 'failed');
});

test('stop halts the schedule and keeps what was already sent', async () => {
  const { mgr, timers } = harness();
  mgr.start(USER, THREE, { intervalMinutes: 5 });
  await timers.fire();

  const stopped = mgr.stop(USER);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.running, false);
  assert.equal(stopped.sent, 1, 'what was sent stays sent, and stays in the status');
  assert.equal(stopped.remaining, 2);
  assert.equal(timers.pending, null, 'no further tick is armed');
});

test('resume picks up where it stopped and never re-sends a wallet already paid', async () => {
  const { mgr, timers, calls } = harness();
  mgr.start(USER, THREE, { intervalMinutes: 5 });
  await timers.fire();
  mgr.stop(USER);

  const resumed = mgr.resume(USER);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.currentIndex, 1);

  await timers.fire();
  await timers.fire();
  assert.deepEqual(
    calls.map((c) => c[0].walletId),
    ['b1', 'b2', 'b3'],
    'b1 was paid once and only once'
  );
  assert.equal(mgr.status(USER).status, 'complete');
});

test('resume refuses when there is nothing to resume, and when the job is finished', async () => {
  const { mgr, timers } = harness();
  assert.throws(() => mgr.resume(USER), /no v8 timed transfer job to resume/);

  mgr.start(USER, [THREE[0]], { intervalMinutes: 5 });
  await timers.fire();
  assert.equal(mgr.status(USER).status, 'complete');
  assert.throws(() => mgr.resume(USER), /already complete/);
});

test('a second job for the same account is refused while one is running', () => {
  const { mgr } = harness();
  mgr.start(USER, THREE, { intervalMinutes: 5 });
  assert.throws(() => mgr.start(USER, THREE, { intervalMinutes: 5 }), /already running for this account/);
});

test('the interval is bounded: below the floor, above a day, or not a number is refused', () => {
  const { mgr } = harness();
  assert.throws(() => mgr.start(USER, THREE, { intervalMinutes: 0.5 }), /at least 1/);
  assert.throws(() => mgr.start(USER, THREE, { intervalMinutes: 0 }), /positive number/);
  assert.throws(() => mgr.start(USER, THREE, { intervalMinutes: 'soon' }), /positive number/);
  assert.throws(() => mgr.start(USER, THREE, { intervalMinutes: 2000 }), /1440 or less/);
  assert.equal(MIN_INTERVAL_MS, 60_000);
});

test('a bad target list is refused at start, and no job is left behind', () => {
  const { mgr, timers } = harness({
    planTargetsFn: () => {
      throw new Error('ghost is not a v8bundle wallet');
    },
  });
  assert.throws(() => mgr.start(USER, [{ walletId: 'ghost', amountEth: '1' }]), /is not a v8bundle wallet/);
  assert.equal(mgr.status(USER).status, 'idle');
  assert.deepEqual(timers.scheduled, []);
});

test('isRunning is what the routes use to refuse a delete or a sweep mid-run', async () => {
  const { mgr, timers } = harness();
  assert.equal(mgr.isRunning(USER), false);
  mgr.start(USER, THREE, { intervalMinutes: 5 });
  assert.equal(mgr.isRunning(USER), true);
  await timers.fire();
  mgr.stop(USER);
  assert.equal(mgr.isRunning(USER), false);
});

test('each account holds its own job', async () => {
  const { mgr, timers } = harness();
  mgr.start('alice', THREE, { intervalMinutes: 5 });
  assert.equal(mgr.status('bob').status, 'idle');
  assert.equal(mgr.isRunning('bob'), false);
  await timers.fire();
  assert.equal(mgr.status('alice').sent, 1);
});

test('every transition is written to the activity log', async () => {
  const { mgr, timers, logged } = harness();
  mgr.start(USER, [THREE[0]], { intervalMinutes: 5 });
  await timers.fire();
  const summaries = logged.map((l) => l.summary);
  assert.ok(summaries.some((s) => /timed Relay transfer started/.test(s)));
  assert.ok(summaries.some((s) => /timed Relay transfer 1\/1/.test(s)));
  assert.ok(summaries.some((s) => /timed Relay transfer complete/.test(s)));
  for (const l of logged) assert.equal(l.kind, 'v8');
});
