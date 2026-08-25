'use strict';

// Unit tests for the v5 Relay-funding PACING scheduler. Fully offline: fundOne,
// the keystore, activity, timers, clock, id and RNG are all injected, so the
// state machine and the 8-9s gap logic are exercised with no chain and no waiting.

const test = require('node:test');
const assert = require('node:assert');

const { createV5RelayFundManager } = require('./relayFundJob');

// A controllable timer queue: setTimeout captures {fn, delay}; runOne() runs the
// next scheduled callback (awaiting its async body); the manager drives itself by
// scheduling the next tick from inside each tick.
function fakeTimers() {
  const q = [];
  return {
    q,
    setTimeoutFn: (fn, delay) => {
      const t = { fn, delay, unref() {} };
      q.push(t);
      return t;
    },
    clearTimeoutFn: (t) => {
      const i = q.indexOf(t);
      if (i >= 0) q.splice(i, 1);
    },
    async runOne() {
      const t = q.shift();
      if (t) await t.fn();
    },
  };
}

function monotonic(start = 1000) {
  let t = start;
  return () => (t += 1);
}

function mgrWith(over = {}) {
  const funded = [];
  const timers = fakeTimers();
  const mgr = createV5RelayFundManager({
    fundOne:
      over.fundOne ||
      (async (t) => {
        funded.push(t.walletId);
        return { walletId: t.walletId, address: `0xaddr_${t.walletId}`, amountEth: String(t.amountEth), hash: `h:${t.walletId}`, requestId: `req:${t.walletId}` };
      }),
    planTargets: (targets) => targets.map((t) => ({ walletId: t.walletId, address: `0xaddr_${t.walletId}`, amountEth: String(t.amountEth) })),
    keystoreForFn: () => ({}),
    activityForFn: () => ({ record() {} }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: monotonic(),
    idFn: () => 'job1',
    randFn: over.randFn || (() => 0.5), // gap = 8000 + 0.5*1000 = 8500
  });
  return { mgr, timers, funded };
}

const TWO = [
  { walletId: 'b1', amountEth: '0.01' },
  { walletId: 'b2', amountEth: '0.02' },
];

test('funds wallets one at a time, ~8.5s apart, and completes', async () => {
  const { mgr, timers, funded } = mgrWith();
  const started = mgr.start('u', TWO);
  assert.equal(started.status, 'running');
  assert.equal(started.total, 2);
  assert.equal(timers.q[0].delay, 0, 'the first wallet fires immediately');

  await timers.runOne(); // fund b1
  assert.deepEqual(funded, ['b1']);
  let st = mgr.status('u');
  assert.equal(st.completed, 1);
  assert.equal(st.results[0].hash, 'h:b1');
  assert.equal(st.status, 'running');
  assert.equal(timers.q[0].delay, 8500, 'the next wallet is scheduled 8-9s later');

  await timers.runOne(); // fund b2
  assert.deepEqual(funded, ['b1', 'b2']);
  st = mgr.status('u');
  assert.equal(st.status, 'complete');
  assert.equal(st.sent, 2);
  assert.equal(st.failed, 0);
  assert.equal(st.remaining, 0);
  assert.equal(timers.q.length, 0, 'nothing is scheduled after the last wallet');
});

test('the gap stays in the 8-9s band across the random range', async () => {
  const lows = mgrWith({ randFn: () => 0 });
  lows.mgr.start('u', TWO);
  await lows.timers.runOne();
  assert.equal(lows.timers.q[0].delay, 8000, 'rand=0 → floor 8000');

  const highs = mgrWith({ randFn: () => 1 });
  highs.mgr.start('u', TWO);
  await highs.timers.runOne();
  assert.equal(highs.timers.q[0].delay, 9000, 'rand=1 → ceiling 9000');
});

test('refuses a second concurrent job for the same account', () => {
  const { mgr } = mgrWith();
  mgr.start('u', TWO);
  assert.throws(() => mgr.start('u', TWO), /already running/);
});

test('stop halts the run and leaves the rest pending; nothing more is scheduled', async () => {
  const { mgr, timers, funded } = mgrWith();
  mgr.start('u', TWO);
  await timers.runOne(); // fund b1
  const st = mgr.stop('u');
  assert.equal(st.status, 'stopped');
  assert.equal(st.completed, 1);
  assert.equal(st.remaining, 1);
  assert.equal(timers.q.length, 0, 'the pending next-wallet timer was cleared');
  assert.deepEqual(funded, ['b1']);
});

test('a fundOne error is recorded as failed and the run continues to the next wallet', async () => {
  let n = 0;
  const { mgr, timers } = mgrWith({
    fundOne: async (t) => {
      n += 1;
      if (t.walletId === 'b1') return { walletId: 'b1', address: '0x', amountEth: t.amountEth, error: 'deposit reverted' };
      return { walletId: t.walletId, address: '0x', amountEth: t.amountEth, hash: `h:${t.walletId}` };
    },
  });
  mgr.start('u', TWO);
  await timers.runOne(); // b1 fails
  let st = mgr.status('u');
  assert.equal(st.results[0].status, 'failed');
  assert.equal(st.status, 'running', 'a failure does not stop the run');
  await timers.runOne(); // b2 succeeds
  st = mgr.status('u');
  assert.equal(st.status, 'complete');
  assert.equal(st.sent, 1);
  assert.equal(st.failed, 1);
});

test('a requested gap below the 8s floor is clamped up', () => {
  const { mgr } = mgrWith();
  const st = mgr.start('u', TWO, { minGapMs: 1000, maxGapMs: 2000 });
  assert.equal(st.minGapMs, 8000, 'never below the rate-limit-safe floor');
  assert.ok(st.maxGapMs >= 8000);
});

test('status is idle before any job, and a thrown planTargets rejects the start', () => {
  const { mgr } = mgrWith();
  assert.equal(mgr.status('nobody').status, 'idle');
  const bad = createV5RelayFundManager({
    planTargets: () => { throw new Error('no v5dev launcher wallet'); },
    keystoreForFn: () => ({}),
    activityForFn: () => ({ record() {} }),
  });
  assert.throws(() => bad.start('u', TWO), /no v5dev launcher/);
});
