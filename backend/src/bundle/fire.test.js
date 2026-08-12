'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fire } = require('./fire');

function fakeProvider({ failOn = [], blockOf = () => 10 } = {}) {
  const order = [];
  const warmed = [];
  return {
    order,
    // The real warmPool opens sockets with a raw send; without this the tests
    // would silently exercise its failure path instead of the real one.
    warmed,
    async send(method) {
      warmed.push(method);
      return '0x1';
    },
    async broadcastTransaction(raw) {
      order.push(raw);
      if (failOn.includes(raw)) throw new Error(`rejected ${raw}`);
      return {
        hash: `hash:${raw}`,
        async wait() {
          return { status: 1, blockNumber: blockOf(raw) };
        },
      };
    },
    async waitForTransaction(hash) {
      return { status: 1, blockNumber: blockOf(hash.replace('hash:', '')) };
    },
  };
}

const plan = {
  token: '0xtoken',
  launch: { address: '0xdev', raw: 'LAUNCH', devBuyEth: '0.05' },
  buys: [
    { walletId: 'a', address: '0xa', amountEth: '0.1', raw: 'BUY_A' },
    { walletId: 'b', address: '0xb', amountEth: '0.2', raw: 'BUY_B' },
  ],
};

// The chain's block.number advances about every 16 seconds, and a buy landing
// in the launch block reverts with LaunchBlockBuyBlocked. These tests pin the
// wait that keeps the bundle out of that block.
function blockTicker(sequence) {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

test('holds the buys until block.number passes the launch block', async () => {
  const rpc = fakeProvider();
  // Reads: the pre-launch read, then two polls still in the launch block,
  // then the tick.
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    evmBlockNumber: blockTicker([100n, 100n, 100n, 101n]),
    sleep: async () => {},
    warmPool: async () => {},
  });

  assert.equal(rpc.order[0], 'LAUNCH', 'the launch still goes first');
  assert.deepEqual(rpc.order.slice(1).sort(), ['BUY_A', 'BUY_B']);
  assert.equal(res.launchBlockNumber, '100');
  assert.notEqual(res.waitedMs, null, 'it must record that it waited');
});

test('a bundle is never fired in the launch block', async () => {
  let current = 100n; // the block the launch executes in
  const firedAt = [];

  // Records block.number at the exact moment each buy is offered — the only
  // assertion that actually proves the wait works.
  const rpc = {
    async broadcastTransaction(raw) {
      if (raw.startsWith('BUY')) firedAt.push(current);
      return { hash: `hash:${raw}`, async wait() { return { status: 1, blockNumber: 10 }; } };
    },
    async waitForTransaction() {
      return { status: 1, blockNumber: 10 };
    },
  };

  let polls = 0;
  await fire(plan, {
    provider: rpc,
    dryRun: false,
    evmBlockNumber: async () => current,
    sleep: async () => {
      if (++polls >= 2) current = 101n; // the chain ticks on the second poll
    },
    warmPool: async () => {},
  });

  assert.equal(firedAt.length, plan.buys.length, 'every buy should have been offered');
  for (const at of firedAt) {
    assert.equal(at, 101n, 'a buy offered at block 100 would revert LaunchBlockBuyBlocked');
  }
});

test('records when each buy was accepted, so a spread can be attributed', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    waitForLaunchBlock: false,
    warmPool: async () => {},
  });

  // Without this there is no way to tell a slow burst from slow inclusion.
  for (const b of res.buys) {
    assert.equal(typeof b.sentMs, 'number', `${b.address} should record when it was sent`);
    assert.ok(b.sentMs >= 0);
  }
  assert.equal(typeof res.burstMs, 'number');
});

test('an unreadable block.number does not stop the launch', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    evmBlockNumber: async () => {
      throw new Error('multicall missing');
    },
    sleep: async () => {},
    warmPool: async () => {},
  });

  // Better a bundle that fires late than a launch that never happens.
  assert.equal(rpc.order[0], 'LAUNCH');
  assert.equal(res.buys.filter((b) => b.status === 'confirmed').length, 2);
  assert.equal(res.launchBlockNumber, null);
  assert.equal(res.waitedMs, null);
});

test('the wait can be switched off', async () => {
  const rpc = fakeProvider();
  let read = false;
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    waitForLaunchBlock: false,
    evmBlockNumber: async () => {
      read = true;
      return 100n;
    },
    warmPool: async () => {},
  });
  assert.equal(read, false, 'it should not even ask for the block number');
  assert.equal(res.waitedMs, null);
});

test('warms the connection pool before anything is broadcast', async () => {
  const rpc = fakeProvider();
  let warmedWith = null;
  await fire(plan, {
    provider: rpc,
    dryRun: false,
    warmPool: async (n) => {
      warmedWith = n;
      rpc.order.push('WARM');
    },
  });

  // One socket per buy, opened before the burst rather than during it: a cold
  // pool costs a TLS handshake per transaction at the worst possible moment.
  assert.equal(warmedWith, plan.buys.length);
  assert.equal(rpc.order[0], 'WARM', 'the pool must be warm before the launch goes out');
});

test('a failed warm-up never blocks the launch', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    warmPool: async () => {
      throw new Error('rpc refused the warm-up');
    },
  });

  assert.equal(rpc.order[0], 'LAUNCH');
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.buys.filter((b) => b.status === 'confirmed').length, 2);
});

test('a dry run does not open sockets it will never use', async () => {
  const rpc = fakeProvider();
  let warmed = false;
  await fire(plan, { provider: rpc, dryRun: true, warmPool: async () => { warmed = true; } });
  assert.equal(warmed, false);
});

test('broadcasts the launch before any buy', async () => {
  const rpc = fakeProvider();
  await fire(plan, { provider: rpc, dryRun: false });
  // The default warm-up ran for real against the fake: one socket per buy.
  assert.equal(rpc.warmed.length, plan.buys.length);
  assert.equal(rpc.order[0], 'LAUNCH', 'the launch must go out first');
  assert.deepEqual(rpc.order.slice(1).sort(), ['BUY_A', 'BUY_B']);
});

test('a rejected buy does not abort the rest of the bundle', async () => {
  const rpc = fakeProvider({ failOn: ['BUY_A'] });
  const res = await fire(plan, { provider: rpc, dryRun: false });

  const a = res.buys.find((b) => b.walletId === 'a');
  const b = res.buys.find((b) => b.walletId === 'b');
  assert.equal(a.status, 'rejected');
  assert.match(a.error, /rejected BUY_A/);
  assert.equal(b.status, 'confirmed');
  assert.equal(res.launch.status, 'confirmed');
});

test('counts the buys that landed in the launch block', async () => {
  // BUY_B slips a block late; BUY_A rides along with the launch.
  const rpc = fakeProvider({ blockOf: (raw) => (raw === 'BUY_B' ? 11 : 10) });
  const res = await fire(plan, { provider: rpc, dryRun: false });
  assert.equal(res.launch.block, 10);
  assert.equal(res.sameBlock, 1);
});

// ── timing ─────────────────────────────────────────────────────────────────
// Two launches were lost by about one RPC block between block.number ticking
// and the first buy reaching the wire. These pin the instrumentation that says
// where that time went, all of it on an injected clock so nothing waits.

test('reports where the milliseconds went, from the tick to the wire', async () => {
  let t = 0;
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    now: () => t,
    // Two polls in the launch block, then the tick.
    evmBlockNumber: async () => {
      t += 6; // the read costs a round trip
      return t >= 120 ? 101n : 100n;
    },
    sleep: async (delay) => {
      t += delay;
    },
    warmPool: async () => {
      t += 12;
    },
    poolStats: () => ({ free: 2, active: 0 }),
    pollMs: 50,
  });

  const { timing } = res;
  assert.equal(timing.warm.tookMs, 12, 'the warm-up is timed');
  assert.equal(timing.launchBlockRead.rttMs, 6, 'the pre-launch read is timed');
  assert.ok(timing.launchBroadcast.issuedMs >= timing.launchBlockRead.returnedMs);
  assert.equal(timing.wait.reason, 'ticked');
  assert.ok(timing.wait.pollCount >= 1);
  assert.ok(timing.wait.detectionLagMs !== null, 'how late we noticed the tick');

  // The headline: tick observed → first buy out of this process. It is the only
  // part of the gap this code owns, so it must be reported on its own.
  assert.equal(typeof timing.tickToWireMs, 'number');
  assert.ok(timing.tickToWireMs >= 0);
  assert.ok(timing.tickToLastAckMs >= timing.tickToWireMs);
});

test('separates the time we cost from the time the network costs', async () => {
  let t = 0;
  const rpc = {
    async broadcastTransaction(raw) {
      t += 30; // a round trip to the sequencer
      return { hash: `hash:${raw}`, async wait() { return { status: 1, blockNumber: 10 }; } };
    },
    async waitForTransaction() {
      return { status: 1, blockNumber: 10 };
    },
  };

  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    waitForLaunchBlock: false,
    warmPool: async () => {},
    now: () => t,
  });

  // Issuing is ours, acking is the wire's. A fix aimed at the wrong one is
  // wasted, so the two are never reported as a single number.
  for (const b of res.buys) {
    assert.equal(typeof b.issuedMs, 'number');
    assert.ok(b.issuedMs <= b.sentMs, 'a buy cannot be acknowledged before it was issued');
  }
  assert.ok(res.timing.burst.issued.max <= res.timing.burst.acked.max);
  assert.equal(res.timing.burst.acked.n, plan.buys.length);
});

test('checks whether the pool was still warm when the burst went out', async () => {
  // warmPool opens sockets before the launch, but the burst does not go out
  // until block.number ticks — up to sixteen seconds later. Whether those
  // sockets survived is a measurement, not an assumption.
  const rpc = fakeProvider();
  const counts = [{ free: 32, active: 0 }, { free: 1, active: 0 }];
  let call = 0;
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    waitForLaunchBlock: false,
    warmPool: async () => {},
    poolStats: () => counts[Math.min(call++, counts.length - 1)],
  });

  assert.deepEqual(res.timing.sockets.afterWarm, { free: 32, active: 0 });
  assert.deepEqual(res.timing.sockets.beforeBurst, { free: 1, active: 0 });
});

test('says it does not know rather than reporting a lateness it cannot measure', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    evmBlockNumber: async () => {
      throw new Error('multicall missing');
    },
    sleep: async () => {},
    warmPool: async () => {},
  });

  assert.equal(res.timing.wait, null, 'no launch block was read, so there was no wait to time');
  assert.equal(res.timing.tickToWireMs, null);
  assert.equal(res.timing.tickToLastAckMs, null);
});

test('the whole result survives being written to the launch history', async () => {
  // The wait carries bigint block numbers internally. One escaping into the
  // result would throw on JSON.stringify and take the launch response with it.
  const rpc = fakeProvider();
  const res = await fire(plan, {
    provider: rpc,
    dryRun: false,
    evmBlockNumber: blockTicker([100n, 101n]),
    sleep: async () => {},
    warmPool: async () => {},
  });
  assert.doesNotThrow(() => JSON.stringify(res));
});

test('dry run broadcasts nothing at all', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, { provider: rpc, dryRun: true });
  assert.equal(rpc.order.length, 0, 'dry run must not touch the provider');
  assert.equal(res.simulated, true);
  assert.ok(res.buys.every((b) => b.status === 'simulated' && b.hash === null));
});
