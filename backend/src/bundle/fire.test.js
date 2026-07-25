'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fire } = require('./fire');

function fakeProvider({ failOn = [], blockOf = () => 10 } = {}) {
  const order = [];
  return {
    order,
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
