'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fireV2 } = require('./fireV2');

// A plan as prepareV2 produces it: the launch is signed, the buys are not,
// because the curve address does not exist until the launch is mined.
const plan = {
  protocol: 'v2',
  token: null,
  curve: null,
  pairToken: '0x0000000000000000000000000000000000000000',
  launch: { address: '0xdev', raw: 'LAUNCH' },
  buys: [
    { walletId: 'a', address: '0xa', amountEth: '0.1', amountIn: '100000000000000000', nonce: 1 },
    { walletId: 'b', address: '0xb', amountEth: '0.2', amountIn: '200000000000000000', nonce: 3 },
  ],
  fees: { type: 2, maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n },
  buyGas: '400000',
  chainId: '4663',
};

const CURVE = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

function fakeProvider({ launchStatus = 1, blockOf = () => 10 } = {}) {
  const order = [];
  return {
    order,
    async send() {
      return '0x1';
    },
    async broadcastTransaction(raw) {
      order.push(raw);
      return {
        hash: `hash:${raw}`,
        async wait() {
          return { status: launchStatus, blockNumber: blockOf(raw), logs: [] };
        },
      };
    },
    async waitForTransaction(hash) {
      return { status: 1, blockNumber: blockOf(hash.replace('hash:', '')) };
    },
  };
}

const fakeKeystore = {
  signer: (walletId) => ({
    async signTransaction(tx) {
      return `SIGNED:${walletId}:${tx.to}:${tx.nonce}`;
    },
  }),
};

const deps = (over = {}) => ({
  dryRun: false,
  keystore: fakeKeystore,
  warmPool: async () => {},
  parseLaunch: () => ({ token: TOKEN, curve: CURVE, pairToken: plan.pairToken }),
  buildBuyTx: async ({ curveAddress, amountIn, recipient }) => ({
    to: curveAddress,
    data: '0xbuy',
    value: amountIn,
    _recipient: recipient,
  }),
  ...over,
});

test('buys are signed against the curve from the receipt, not a guess', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  assert.equal(rpc.order[0], 'LAUNCH', 'the launch goes first');
  assert.equal(res.curve, CURVE);
  assert.equal(res.token, TOKEN);
  // Every buy must be addressed to the curve the launch actually produced.
  for (const raw of rpc.order.slice(1)) {
    assert.match(raw, new RegExp(`^SIGNED:[ab]:${CURVE}:`), `buy signed to the wrong target: ${raw}`);
  }
  assert.equal(res.buys.length, 2);
  assert.equal(res.buys.filter((b) => b.status === 'confirmed').length, 2);
});

test('a reverted launch buys nothing at all', async () => {
  const rpc = fakeProvider({ launchStatus: 0 });
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  assert.equal(res.launch.status, 'reverted');
  assert.equal(rpc.order.length, 1, 'only the launch should ever have been broadcast');
  assert.ok(res.buys.every((b) => b.status === 'skipped'));
  assert.match(res.buys[0].error, /launch reverted/);
});

test('a missing TokenLaunched event never becomes a guessed curve', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, { provider: rpc, ...deps({ parseLaunch: () => null }) });

  // Buying a guessed address would spend real money on someone else's token.
  assert.equal(res.curve, null);
  assert.equal(rpc.order.length, 1);
  assert.ok(res.buys.every((b) => b.status === 'skipped'));
  assert.match(res.buys[0].error, /TokenLaunched/);
});

test('each buy keeps its own wallet and nonce', async () => {
  const rpc = fakeProvider();
  await fireV2(plan, { provider: rpc, ...deps() });
  const buys = rpc.order.slice(1).sort();
  assert.deepEqual(buys, [`SIGNED:a:${CURVE}:1`, `SIGNED:b:${CURVE}:3`]);
});

test('a dry run broadcasts nothing', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, { provider: rpc, ...deps({ dryRun: true }) });
  assert.equal(rpc.order.length, 0);
  assert.equal(res.simulated, true);
  assert.ok(res.buys.every((b) => b.status === 'simulated'));
});
