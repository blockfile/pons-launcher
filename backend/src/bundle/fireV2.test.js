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

// ── THE NATIVE LAUNCH IS AWAITED. THIS IS THE LINE THAT MUST NOT MOVE. ──────
//
// On the PAIRED path the launch's acknowledgement was taken out of the critical
// path: the send is issued and the buys follow without waiting for the answer,
// because a paired buy carries `value: 0` and a buy that overtakes the launch
// calls a codeless address, moves nothing and costs gas and a nonce.
//
// A NATIVE buy carries its ETH as value. The identical overtake pays that ETH
// into an address with no contract, the call SUCCEEDS, and the ETH is gone —
// 1.798 ETH on 2026-08-13. So the native launch is awaited, always, and the
// switch is not consulted here at all. These fail the moment that stops being
// true, including if someone wires the paired flag through by hand.

/** A provider that records the launch's send at once but answers it only on release. */
function gatedNativeProvider({ order = [] } = {}) {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  return {
    order,
    release: () => release(),
    async broadcastTransaction(raw) {
      order.push(raw);
      if (raw === 'LAUNCH') await gate;
      return { hash: `hash:${raw}` };
    },
    async getTransactionReceipt(hash) {
      return { status: 1, blockNumber: 10, index: 0, logs: [], hash };
    },
  };
}

test('NOT ONE native buy is issued until the launch has been acknowledged', async () => {
  const order = [];
  const rpc = gatedNativeProvider({ order });
  // The paired switch is turned ON explicitly, and the lead removed, so this
  // proves the native path ignores both rather than merely defaulting away.
  const run = fireV2(plan, {
    provider: rpc,
    ...deps({ asyncPairedLaunch: true, launchLeadMs: 0 }),
  });
  run.catch(() => {});

  try {
    // Half a second — five blocks — with the launch unanswered.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(
      order,
      ['LAUNCH'],
      'a native buy on the wire before the launch is acknowledged is how 1.798 ETH was lost on 2026-08-13'
    );
  } finally {
    rpc.release();
  }

  const res = await run;
  assert.equal(res.launchAsync, false, 'the native path never runs the async ordering');
  assert.equal(res.launchAckMs, undefined, 'there is no deferred acknowledgement to report');
  assert.deepEqual(order.slice(1).sort(), ['BUY_A', 'BUY_B']);
  assert.equal(res.confirmed, 2);
});

test('a native launch that will not broadcast takes no buy with it', async () => {
  const order = [];
  const rpc = {
    order,
    async broadcastTransaction(raw) {
      if (raw === 'LAUNCH') throw new Error('launch rejected');
      order.push(raw);
      return { hash: `hash:${raw}` };
    },
    async getTransactionReceipt() {
      return { status: 1, blockNumber: 10, logs: [] };
    },
  };
  // The raw RPC error surfaces exactly as it always has — no approves went out,
  // so there is nothing to add to it.
  await assert.rejects(
    () => fireV2(plan, { provider: rpc, ...deps({ asyncPairedLaunch: true }) }),
    /launch rejected/
  );
  assert.equal(order.length, 0, 'no ETH-carrying buy may chase a launch that never went out');
});

// ── the overtake accounting, on the path where an overtake is a loss ────────

test('a native buy sequenced ahead of the launch is called what it is: ETH gone', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, {
    provider: rpc,
    ...deps({
      waitForReceipt: async (_rpc, hash) =>
        hash === 'hash:LAUNCH'
          ? { status: 1, blockNumber: 10, index: 5 }
          : { status: 1, blockNumber: 9, index: 0 },
    }),
  });

  assert.equal(res.overtook, 2);
  assert.match(res.overtake, /sequenced AHEAD of the launch/);
  assert.match(res.overtake, /UNRECOVERABLE/);
  assert.ok(res.buys.every((b) => b.strandSuspected), 'every overtaking native buy is flagged');
  assert.ok(res.buys.every((b) => b.blocksAfterLaunch === -1));
  assert.ok(res.buys.every((b) => b.vsLaunch === 'ahead'));
});

test('a native bundle in the launch block reports the +0/+1 landing, not an overtake', async () => {
  const rpc = fakeProvider();
  const res = await fireV2(plan, {
    provider: rpc,
    ...deps({
      waitForReceipt: async (_rpc, hash) =>
        hash === 'hash:LAUNCH'
          ? { status: 1, blockNumber: 10, index: 0 }
          : { status: 1, blockNumber: 10, index: 3 },
    }),
  });
  assert.equal(res.overtook, 0);
  assert.equal(res.overtake, undefined);
  assert.equal(res.withinOneBlock, 2);
  assert.ok(res.buys.every((b) => b.vsLaunch === 'behind'));
});
