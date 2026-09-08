'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedFundingManager } = require('./timedFunding');

const DEV = { id: 'dev', role: 'v2dev', address: '0xc19e243Ad62840678e4167f16D1E2C3FaCC65fb3' };
const B1 = { id: 'b1', role: 'v2bundle', address: '0x95bFA9Ed2816eB8136E29a44e9041dF053A0395b' };
const B2 = { id: 'b2', role: 'v2bundle', address: '0xd091B95ABF1Bb7D49DBbdfD0c9747248f3E396c4' };
const V1 = { id: 'v1', role: 'bundle', address: '0x448E390A87730f8E346C8A467B46d97AbcCCE512' };

// A wider bundle, for the batched ticks. Repeated-nibble addresses carry no
// checksum case, so getAddress() accepts them as written.
const PACK = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => ({
  id,
  role: 'v2bundle',
  address: `0x${String(i + 1).repeat(40)}`,
}));

function ks() {
  return {
    walletWithRole: (role) => (role === 'v2dev' ? DEV : null),
    walletsWithRole: (role) => (role === 'v2bundle' ? [B1, B2, ...PACK] : []),
    devWallet: () => null,
    bundleWallets: () => [V1],
  };
}

// `n` bundle wallets out of PACK, as start() takes them.
function pack(n) {
  return PACK.slice(0, n).map((w, i) => ({ walletId: w.id, amountEth: `0.0${i + 1}` }));
}

function manager({ relayFund, now = 1_000_000, minIntervalMs = 0, perTickGapMs, onGap } = {}) {
  const timers = [];
  const cleared = [];
  const logs = [];
  // The gap between wallets inside a tick, recorded rather than waited out.
  const gaps = [];
  let id = 0;
  let clock = now;
  const mgr = createTimedFundingManager({
    relayFund:
      relayFund ||
      (async ([target]) => ({
        protocol: 'v2',
        mode: 'relay-solver',
        from: DEV.address,
        totalDepositEth: target.amountEth,
        results: [
          {
            walletId: target.walletId,
            address: target.walletId === 'b1' ? B1.address : B2.address,
            amountEth: target.amountEth,
            requestId: `0x${target.walletId === 'b1' ? '1' : '2'.repeat(64)}`.padEnd(66, '1'),
            depositAddress: '0x02DEFcdc31CD87FEF634a9Ac08fA8513b5165AEd',
            depositEth: target.amountEth,
            hash: `0x${String(target.walletId).padEnd(64, 'a').slice(0, 64)}`,
          },
        ],
      })),
    keystoreForFn: () => ks(),
    activityForFn: () => ({
      record(kind, summary, detail) {
        logs.push({ kind, summary, detail });
      },
    }),
    setTimeoutFn: (fn, delay) => {
      const handle = { id: ++id, fn, delay, unref() {} };
      timers.push(handle);
      return handle;
    },
    clearTimeoutFn: (handle) => cleared.push(handle.id),
    nowFn: () => clock,
    idFn: () => 'job-1',
    minIntervalMs,
    ...(perTickGapMs === undefined ? {} : { perTickGapMs }),
    sleepFn: async (ms) => {
      gaps.push(ms);
      if (onGap) await onGap(gaps.length);
    },
  });
  return {
    mgr,
    timers,
    cleared,
    logs,
    gaps,
    setNow: (next) => {
      clock = next;
    },
  };
}

test('timed funding sends one v2 Relay order immediately, then schedules the next wallet', async () => {
  const sent = [];
  const { mgr, timers } = manager({
    relayFund: async ([target]) => {
      sent.push(target.walletId);
      return {
        protocol: 'v2',
        mode: 'relay-solver',
        from: DEV.address,
        totalDepositEth: target.amountEth,
        results: [{ walletId: target.walletId, address: B1.address, amountEth: target.amountEth, hash: '0xabc' }],
      };
    },
  });

  const started = mgr.start(
    'alice',
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.02' },
    ],
    { intervalMinutes: 30 }
  );

  assert.equal(started.status, 'running');
  assert.equal(started.total, 2);
  assert.equal(timers[0].delay, 0);

  await timers.shift().fn();
  const afterFirst = mgr.status('alice');
  assert.deepEqual(sent, ['b1']);
  assert.equal(afterFirst.completed, 1);
  assert.equal(afterFirst.remaining, 1);
  assert.equal(afterFirst.results[0].status, 'sent');
  assert.equal(timers[0].delay, 30 * 60_000);

  await timers.shift().fn();
  const done = mgr.status('alice');
  assert.deepEqual(sent, ['b1', 'b2']);
  assert.equal(done.status, 'complete');
  assert.equal(done.completed, 2);
  assert.equal(done.remaining, 0);
  assert.equal(done.nextRunAt, null);
});

test('stop cancels the future timer and resume keeps the original due time', async () => {
  const { mgr, timers, cleared, setNow } = manager();
  mgr.start(
    'alice',
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.02' },
    ],
    { intervalMinutes: 30 }
  );

  await timers.shift().fn();
  const scheduled = timers[0];
  const nextRunAt = mgr.status('alice').nextRunAt;

  const stopped = mgr.stop('alice');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.nextRunAt, nextRunAt);
  assert.ok(cleared.includes(scheduled.id));

  setNow(Date.parse(nextRunAt) - 60_000);
  const resumed = mgr.resume('alice');
  assert.equal(resumed.status, 'running');
  assert.equal(timers.at(-1).delay, 60_000);
});

test('start rejects non-v2 bundle wallets before scheduling anything', () => {
  const { mgr, timers } = manager();
  assert.throws(
    () => mgr.start('alice', [{ walletId: 'v1', amountEth: '0.01' }], { intervalMinutes: 30 }),
    /not a v2 bundle wallet/
  );
  assert.equal(timers.length, 0);
});

test('a failed wallet is recorded and the schedule continues', async () => {
  const { mgr, timers } = manager({
    relayFund: async ([target]) => {
      if (target.walletId === 'b1') throw new Error('quote unavailable');
      return {
        protocol: 'v2',
        mode: 'relay-solver',
        from: DEV.address,
        totalDepositEth: target.amountEth,
        results: [{ walletId: target.walletId, address: B2.address, amountEth: target.amountEth, hash: '0xdef' }],
      };
    },
  });

  mgr.start(
    'alice',
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.02' },
    ],
    { intervalMinutes: 30 }
  );

  await timers.shift().fn();
  const afterFailure = mgr.status('alice');
  assert.equal(afterFailure.results[0].status, 'failed');
  assert.match(afterFailure.results[0].error, /quote unavailable/);
  assert.equal(timers[0].delay, 30 * 60_000);

  await timers.shift().fn();
  const done = mgr.status('alice');
  assert.equal(done.status, 'complete');
  assert.equal(done.failed, 1);
  assert.equal(done.sent, 1);
});

// ── batched ticks ────────────────────────────────────────────────────────────
//
// One wallet a minute meant 31 minutes for a 31-wallet bundle. A tick may now
// cover several wallets — but it is still ONE fundV2Bundle() call per wallet,
// and `currentIndex` is still the only thing standing between a resumed job and
// a second deposit into a wallet that already got one.

test('a tick funds several wallets, one Relay order each, and schedules one next tick', async () => {
  const calls = [];
  const { mgr, timers, gaps } = manager({
    perTickGapMs: 4000,
    relayFund: async (targets) => {
      calls.push(targets.map((t) => t.walletId));
      return {
        protocol: 'v2',
        mode: 'relay-solver',
        from: DEV.address,
        totalDepositEth: targets[0].amountEth,
        results: [{ walletId: targets[0].walletId, amountEth: targets[0].amountEth, hash: '0xaaa' }],
      };
    },
  });

  const started = mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 3 });
  assert.equal(started.walletsPerTick, 3);
  assert.equal(started.maxWalletsPerTick, 4);

  await timers.shift().fn();

  // Three wallets, three SEPARATE single-target calls — never one call with an
  // array, which is the long-POST shape this scheduler exists to avoid.
  assert.deepEqual(calls, [['p1'], ['p2'], ['p3']]);
  // Gaps go BETWEEN wallets: two for three wallets, none after the last.
  assert.deepEqual(gaps, [4000, 4000]);

  const after = mgr.status('alice');
  assert.equal(after.currentIndex, 3);
  assert.equal(after.completed, 3);
  assert.equal(after.remaining, 3);
  assert.equal(after.sent, 3);
  assert.deepEqual(
    after.results.map((r) => r.index),
    [0, 1, 2]
  );
  // The per-target states the console draws still mean what they meant.
  assert.deepEqual(
    after.targets.map((t) => t.state),
    ['done', 'done', 'done', 'next', 'pending', 'pending']
  );
  // ONE next tick, not one per wallet.
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);

  await timers.shift().fn();
  const done = mgr.status('alice');
  assert.deepEqual(calls, [['p1'], ['p2'], ['p3'], ['p4'], ['p5'], ['p6']]);
  assert.equal(done.status, 'complete');
  assert.equal(done.sent, 6);
  assert.equal(timers.length, 0);
});

test('walletsPerTick above the Relay cap is refused, with the reason, before anything is scheduled', () => {
  const { mgr, timers } = manager();
  assert.throws(
    () => mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 20 }),
    /walletsPerTick must be 4 or less[\s\S]*quotes a minute/
  );
  assert.throws(
    () => mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 0 }),
    /whole number of at least 1/
  );
  assert.throws(
    () => mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 2.5 }),
    /whole number of at least 1/
  );
  assert.equal(timers.length, 0);
  assert.equal(mgr.status('alice').status, 'idle');
});

test('the default is still exactly one wallet per tick', async () => {
  const calls = [];
  const { mgr, timers, gaps } = manager({
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });

  const started = mgr.start('alice', pack(4), { intervalMinutes: 30 });
  assert.equal(started.walletsPerTick, 1);

  await timers.shift().fn();
  assert.deepEqual(calls, ['p1']);
  assert.deepEqual(gaps, []);
  assert.equal(mgr.status('alice').currentIndex, 1);
  assert.equal(timers[0].delay, 30 * 60_000);
});

test('a wallet failing mid-batch is recorded, the batch continues, and every index is attempted exactly once', async () => {
  const calls = [];
  const { mgr, timers } = manager({
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      if (targets[0].walletId === 'p2') throw new Error('quote unavailable');
      // A deposit Relay quoted but the send refused: recorded, not thrown.
      if (targets[0].walletId === 'p3') {
        return { results: [{ walletId: 'p3', error: 'replacement underpriced' }] };
      }
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });

  mgr.start('alice', pack(4), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  const done = mgr.status('alice');
  assert.deepEqual(calls, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(done.currentIndex, 4);
  assert.deepEqual(
    done.results.map((r) => r.index),
    [0, 1, 2, 3]
  );
  assert.deepEqual(
    done.results.map((r) => r.status),
    ['sent', 'failed', 'failed', 'sent']
  );
  assert.match(done.results[1].error, /quote unavailable/);
  assert.equal(done.failed, 2);
  assert.equal(done.sent, 2);
  assert.equal(done.status, 'complete');
});

test('stop pressed mid-batch leaves currentIndex on the first unattempted wallet, and resume funds it once', async () => {
  const calls = [];
  let mgrRef = null;
  const h = manager({
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      // Stop lands while the second wallet's order is in flight.
      if (targets[0].walletId === 'p2') mgrRef.stop('alice');
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });
  mgrRef = h.mgr;
  const { mgr, timers } = h;

  mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  const stopped = mgr.status('alice');
  assert.deepEqual(calls, ['p1', 'p2'], 'the batch stops before spending on the third wallet');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.currentIndex, 2, 'currentIndex sits on the first UNATTEMPTED wallet');
  assert.equal(stopped.completed, 2);
  assert.equal(stopped.remaining, 4);
  assert.equal(timers.length, 0, 'a stopped job schedules no further tick');

  const resumed = mgr.resume('alice');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.currentIndex, 2);
  await timers.pop().fn();

  // No wallet appears twice: the two already attempted are not re-funded.
  assert.deepEqual(calls, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(mgr.status('alice').status, 'complete');
});

test('stop during the gap between wallets stops the batch before the next wallet spends', async () => {
  const calls = [];
  let mgrRef = null;
  const h = manager({
    onGap: (n) => {
      if (n === 1) mgrRef.stop('alice');
    },
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });
  mgrRef = h.mgr;
  const { mgr, timers } = h;

  mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  assert.deepEqual(calls, ['p1']);
  const stopped = mgr.status('alice');
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.currentIndex, 1);
  assert.equal(timers.length, 0);
});

test('an unexpected throw between wallets still leaves currentIndex on the first unattempted wallet', async () => {
  const calls = [];
  const { mgr, timers } = manager({
    onGap: () => {
      throw new Error('scheduler blew up between wallets');
    },
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });

  mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  assert.deepEqual(calls, ['p1']);
  const job = mgr.status('alice');
  assert.equal(job.status, 'stopped');
  assert.equal(job.currentIndex, 1, 'the attempted wallet is behind us, the unattempted one is not');
  assert.equal(job.completed, 1);

  // And a resume re-funds nobody it already paid.
  mgr.resume('alice');
  await timers.pop().fn();
  assert.equal(calls[1], 'p2');
});

test('a batch that runs out of targets completes without a further tick or a trailing gap', async () => {
  const calls = [];
  const { mgr, timers, gaps } = manager({
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });

  mgr.start('alice', pack(3), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  assert.deepEqual(calls, ['p1', 'p2', 'p3']);
  assert.equal(gaps.length, 2, 'no gap is spent after the last wallet of the run');
  const done = mgr.status('alice');
  assert.equal(done.status, 'complete');
  assert.equal(done.currentIndex, 3);
  assert.equal(done.remaining, 0);
  assert.equal(done.nextRunAt, null);
  assert.equal(timers.length, 0);
});

test('a running job is not re-entered mid-batch by a second tick', async () => {
  // A stray tick arriving while the batch is between wallets must be a no-op.
  // If it is allowed in, it runs its OWN batch inside this one and schedules its
  // OWN next tick — leaving two live timers, which doubles the quote rate the
  // whole per-tick cap exists to hold down.
  const calls = [];
  let mgrRef = null;
  const h = manager({
    onGap: async (n) => {
      if (n === 1) await mgrRef._runNext('alice');
    },
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });
  mgrRef = h.mgr;
  const { mgr, timers } = h;

  mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 2 });
  await timers.shift().fn();

  assert.deepEqual(calls, ['p1', 'p2'], 'the tick funds its two wallets and no more');
  assert.equal(mgr.status('alice').currentIndex, 2);
  assert.equal(timers.length, 1, 'exactly one next tick is armed, never two');
});

test('stop is noticed between wallets even with no gap configured between them', async () => {
  // With perTickGapMs 0 the batch has no pause to check during, so the check at
  // the TOP of each wallet is the only thing keeping a stopped job from spending
  // on the next one.
  const calls = [];
  let mgrRef = null;
  const h = manager({
    perTickGapMs: 0,
    relayFund: async (targets) => {
      calls.push(targets[0].walletId);
      if (targets[0].walletId === 'p2') mgrRef.stop('alice');
      return { results: [{ walletId: targets[0].walletId, hash: '0xaaa' }] };
    },
  });
  mgrRef = h.mgr;
  const { mgr, timers, gaps } = h;

  mgr.start('alice', pack(6), { intervalMinutes: 1, walletsPerTick: 4 });
  await timers.shift().fn();

  assert.deepEqual(gaps, [], 'no gap was configured, so none was taken');
  assert.deepEqual(calls, ['p1', 'p2']);
  assert.equal(mgr.status('alice').currentIndex, 2);
  assert.equal(timers.length, 0);
});
