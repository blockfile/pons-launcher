'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fireV2 } = require('./fireV2');

const CURVE = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';

// A plan as prepareV2 now produces it: everything signed, including the buys,
// because the curve address is predicted from the salt before anything is sent.
const plan = {
  protocol: 'v2',
  mode: 'presigned',
  token: TOKEN,
  curve: CURVE,
  pairToken: '0x0000000000000000000000000000000000000000',
  launch: { address: '0xdev', raw: 'LAUNCH' },
  buys: [
    { walletId: 'a', address: '0xa', amountEth: '0.1', nonce: 1, exempt: true, raw: 'BUY_A' },
    { walletId: 'b', address: '0xb', amountEth: '0.2', nonce: 3, exempt: true, raw: 'BUY_B' },
  ],
  fees: { type: 2, maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n },
  buyGas: '400000',
  chainId: '4663',
};

function fakeProvider({ launchStatus = 1, block = 10, order = [] } = {}) {
  return {
    order,
    async broadcastTransaction(raw) {
      order.push(raw);
      return { hash: `hash:${raw}` };
    },
    async getTransactionReceipt(hash) {
      const raw = String(hash).replace('hash:', '');
      return { status: raw === 'LAUNCH' ? launchStatus : 1, blockNumber: block, logs: [] };
    },
  };
}

const deps = (over = {}) => ({
  dryRun: false,
  warmPool: async () => {},
  parseLaunch: () => ({ token: TOKEN, curve: CURVE, pairToken: plan.pairToken }),
  ...over,
});

test('the launch goes out first, then every pre-signed buy', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  assert.equal(rpc.order[0], 'LAUNCH');
  assert.deepEqual(rpc.order.slice(1).sort(), ['BUY_A', 'BUY_B']);
  assert.equal(res.confirmed, 2);
  assert.equal(res.sameBlock, 2);
});

test('no receipt is awaited before the buys are broadcast', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  await fireV2(plan, {
    provider: rpc,
    ...deps({
      waitForReceipt: async (_rpc, hash) => {
        order.push(`RECEIPT:${hash}`);
        return { status: 1, blockNumber: 10, logs: [] };
      },
    }),
  });

  // Waiting first is exactly what the old reactive flow did, and removing it is
  // the whole point of predicting the curve address.
  const firstReceipt = order.findIndex((o) => o.startsWith('RECEIPT:'));
  assert.ok(order.indexOf('BUY_A') < firstReceipt, 'BUY_A must precede any receipt');
  assert.ok(order.indexOf('BUY_B') < firstReceipt, 'BUY_B must precede any receipt');
});

test('an unsigned buy is refused rather than signed late', async () => {
  const rpc = fakeProvider();
  const halfSigned = { ...plan, buys: [plan.buys[0], { ...plan.buys[1], raw: undefined }] };

  // Signing here would put key derivation back in the critical path.
  await assert.rejects(
    () => fireV2(halfSigned, { provider: rpc, ...deps() }),
    /1 buy\(s\) are unsigned/
  );
  assert.equal(rpc.order.length, 0, 'nothing may be broadcast once the plan is known to be bad');
});

test('a curve that does not match the prediction is reported, not hidden', async () => {
  const rpc = fakeProvider();
  const OTHER = '0x9999999999999999999999999999999999999999';
  const res = await fireV2(plan, {
    provider: rpc,
    ...deps({ parseLaunch: () => ({ token: TOKEN, curve: OTHER, pairToken: plan.pairToken }) }),
  });

  // The buys are already spent by this point. Saying so plainly beats leaving
  // it to be worked out from a balance that never arrives.
  assert.match(res.mismatch, /launch created curve 0x9999/);
  assert.match(res.mismatch, /signed against 0x1111/);
});

test('a reverted launch is reported with the buys that already went out', async () => {
  const rpc = fakeProvider({ launchStatus: 0 });
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  // Unlike the old flow there is no holding the buys back — they are broadcast
  // before the launch result is known. Pretending otherwise would be a lie.
  assert.equal(res.launch.status, 'reverted');
  assert.equal(res.buys.length, 2);
  assert.equal(res.mismatch, undefined);
});

test('a broadcast failure fails only its own wallet', async () => {
  const rpc = fakeProvider();
  const flaky = {
    ...rpc,
    async broadcastTransaction(raw) {
      if (raw === 'BUY_A') throw new Error('nonce too low');
      return rpc.broadcastTransaction(raw);
    },
  };
  const res = await fireV2(plan, { provider: flaky, ...deps() });

  const a = res.buys.find((b) => b.walletId === 'a');
  const b = res.buys.find((b) => b.walletId === 'b');
  assert.equal(a.status, 'failed');
  assert.match(a.error, /nonce too low/);
  assert.equal(b.status, 'confirmed');
});

test('a dry run broadcasts nothing', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, { provider: rpc, ...deps({ dryRun: true }) });
  assert.equal(rpc.order.length, 0);
  assert.equal(res.simulated, true);
  assert.equal(res.curve, CURVE, 'a dry run still reports where the buys would go');
  assert.ok(res.buys.every((b) => b.status === 'simulated'));
});

// ── the native path is not the paired one, and must not drift into it ──────
//
// On the paired path every approve now goes out BEFORE the launch, so the
// post-launch burst is buys only. None of that applies here: a native buy
// carries its ETH as value, and a buy that lands before the launch pays into an
// address with no contract, SUCCEEDS on the EVM and keeps the money — 1.798 ETH
// on 2026-08-13. These pin the native ordering so a later change to the paired
// path cannot quietly take this one with it.

test('NOTHING is broadcast before the launch on the native path', async () => {
  const rpc = fakeProvider();
  await fireV2(plan, { provider: rpc, ...deps() });

  assert.equal(rpc.order[0], 'LAUNCH', 'the launch is the first thing on the wire');
  assert.equal(rpc.order.length, 3, 'one launch and two buys, nothing else');
  assert.deepEqual(rpc.order.slice(1).sort(), ['BUY_A', 'BUY_B']);
});

test('a native plan has no approves to pin, and the salt pin does not run', async () => {
  // No salt, no curve, no approves — a native plan as prepareV2 builds it. The
  // pin must not refuse it: it guards approves broadcast ahead of a launch, and
  // this path broadcasts none.
  const rpc = fakeProvider();
  const noSalt = { ...plan, salt: undefined };
  const res = await fireV2(noSalt, {
    provider: rpc,
    ...deps({
      saltFromLaunch: () => {
        throw new Error('the salt pin must never run on the native path');
      },
    }),
  });
  assert.equal(res.confirmed, 2);
  assert.equal(rpc.order[0], 'LAUNCH');
});

test('the pool is warmed for one socket per buy plus the launch', async () => {
  let count = 'never called';
  let gotRpc = null;
  const rpc = fakeProvider();
  await fireV2(plan, {
    provider: rpc,
    ...deps({
      warmPool: async (n, r) => {
        count = n;
        gotRpc = r;
      },
    }),
  });
  // Two buys, one transaction each, plus the launch. A native buy signs no
  // approve, so there is no second socket per wallet.
  assert.equal(count, 3);
  assert.equal(gotRpc, rpc);
});

test('a warm-up that throws never stops a native launch', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, {
    provider: rpc,
    ...deps({
      warmPool: async () => {
        throw new Error('socket storm');
      },
    }),
  });
  assert.equal(res.confirmed, 2);
  assert.equal(rpc.order[0], 'LAUNCH');
});
