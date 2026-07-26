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

test('dry run broadcasts nothing at all', async () => {
  const rpc = fakeProvider();
  const res = await fire(plan, { provider: rpc, dryRun: true });
  assert.equal(rpc.order.length, 0, 'dry run must not touch the provider');
  assert.equal(res.simulated, true);
  assert.ok(res.buys.every((b) => b.status === 'simulated' && b.hash === null));
});
