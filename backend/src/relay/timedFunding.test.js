'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedFundingManager } = require('./timedFunding');

const DEV = { id: 'dev', role: 'v2dev', address: '0xc19e243Ad62840678e4167f16D1E2C3FaCC65fb3' };
const B1 = { id: 'b1', role: 'v2bundle', address: '0x95bFA9Ed2816eB8136E29a44e9041dF053A0395b' };
const B2 = { id: 'b2', role: 'v2bundle', address: '0xd091B95ABF1Bb7D49DBbdfD0c9747248f3E396c4' };
const V1 = { id: 'v1', role: 'bundle', address: '0x448E390A87730f8E346C8A467B46d97AbcCCE512' };

function ks() {
  return {
    walletWithRole: (role) => (role === 'v2dev' ? DEV : null),
    walletsWithRole: (role) => (role === 'v2bundle' ? [B1, B2] : []),
    devWallet: () => null,
    bundleWallets: () => [V1],
  };
}

function manager({ relayFund, now = 1_000_000, minIntervalMs = 0 } = {}) {
  const timers = [];
  const cleared = [];
  const logs = [];
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
  });
  return {
    mgr,
    timers,
    cleared,
    logs,
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
