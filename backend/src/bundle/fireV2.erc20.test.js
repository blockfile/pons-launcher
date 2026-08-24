'use strict';

// fireV2 broadcasting an ERC-20 pair launch.
//
// The native path is one transaction per wallet. The ERC-20 path is two — an
// approve then the action — for the dev (approve the forwarder, then
// launchAndBuy) and for every bundle wallet (approve the curve, then buy),
// exactly like the sell burst. These assert that shape, that the dev approve
// leads the launch, that the fire-time re-estimate is skipped (it would falsely
// revert on the not-yet-mined allowance), and that a wallet whose approve will
// not broadcast does not send its buy into a nonce gap.

const test = require('node:test');
const assert = require('node:assert');
const { fireV2 } = require('./fireV2');

const CURVE = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

const plan = {
  protocol: 'v2',
  mode: 'presigned',
  token: TOKEN,
  curve: CURVE,
  pairToken: USDG,
  pairSymbol: 'USDG',
  pairDecimals: 6,
  launch: {
    address: '0xdev',
    raw: 'LAUNCH',
    needsApprove: true,
    approve: { nonce: 4, spender: '0xforwarder', raw: 'DEV_APPROVE' },
  },
  buys: [
    {
      walletId: 'a',
      address: '0xa',
      amountEth: '5.0',
      nonce: 1,
      exempt: true,
      approve: { nonce: 0, spender: CURVE, raw: 'APPROVE_A' },
      raw: 'BUY_A',
    },
    {
      walletId: 'b',
      address: '0xb',
      amountEth: '5.0',
      nonce: 3,
      exempt: true,
      approve: { nonce: 2, spender: CURVE, raw: 'APPROVE_B' },
      raw: 'BUY_B',
    },
  ],
  fees: { type: 2, maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n },
  buyGas: '400000',
  chainId: '4663',
};

function fakeProvider({ order = [], failApprove = null } = {}) {
  return {
    order,
    async broadcastTransaction(raw) {
      if (failApprove && raw === failApprove) throw new Error('approve rejected');
      order.push(raw);
      return { hash: `hash:${raw}` };
    },
    // If the fire-time re-estimate ran it would land here; a definite revert
    // would abort the launch. needsApprove must keep it from running at all.
    async estimateGas() {
      const err = new Error('execution reverted: ERC20InsufficientAllowance');
      err.code = 'CALL_EXCEPTION';
      throw err;
    },
  };
}

const deps = (over = {}) => ({
  dryRun: false,
  warmPool: async () => {},
  parseLaunch: () => ({ token: TOKEN, curve: CURVE, pairToken: USDG }),
  waitForReceipt: async () => ({ status: 1, blockNumber: 10, logs: [] }),
  ...over,
});

test('the dev approve leads the launch, then every wallet approves before it buys', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  // The dev approve is first, the launch second. The re-estimate did NOT abort
  // the launch even though estimateGas throws CALL_EXCEPTION — it was skipped.
  assert.equal(order[0], 'DEV_APPROVE');
  assert.equal(order[1], 'LAUNCH');

  // Within each wallet, the approve precedes the buy.
  assert.ok(order.indexOf('APPROVE_A') < order.indexOf('BUY_A'), 'A approves before it buys');
  assert.ok(order.indexOf('APPROVE_B') < order.indexOf('BUY_B'), 'B approves before it buys');

  // Everything went out.
  assert.equal(order.length, 6);
  assert.equal(res.confirmed, 2);
  assert.equal(res.launch.status, 'confirmed');
  assert.ok(res.launch.approve, 'the dev approve is reported on the launch');
});

test('a wallet whose approve will not broadcast does not send its buy into a gap', async () => {
  const order = [];
  const rpc = fakeProvider({ order, failApprove: 'APPROVE_A' });
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  // A's buy is never broadcast — a tx at n+1 behind a missing n would hang.
  assert.ok(!order.includes('BUY_A'), "A's buy must not be sent");
  const a = res.buys.find((b) => b.walletId === 'a');
  assert.equal(a.status, 'failed');
  assert.equal(a.approve.status, 'failed');
  assert.match(a.error, /approve rejected/);

  // B is untouched.
  const b = res.buys.find((b) => b.walletId === 'b');
  assert.equal(b.status, 'confirmed');
  assert.ok(order.includes('APPROVE_B') && order.includes('BUY_B'));
});

test('an unsigned approve is refused rather than broadcast', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const bad = {
    ...plan,
    buys: [plan.buys[0], { ...plan.buys[1], approve: { ...plan.buys[1].approve, raw: undefined } }],
  };
  await assert.rejects(() => fireV2(bad, { provider: rpc, ...deps() }), /unsigned/);
  assert.equal(order.length, 0, 'nothing is broadcast once the plan is known to be bad');
});

test('a dev approve that will not broadcast aborts before the launch', async () => {
  const order = [];
  const rpc = fakeProvider({ order, failApprove: 'DEV_APPROVE' });
  await assert.rejects(
    () => fireV2(plan, { provider: rpc, ...deps() }),
    /dev approve .* failed to broadcast/
  );
  assert.ok(!order.includes('LAUNCH'), 'the launch must not go out behind a missing approve');
});

test('a dry run broadcasts nothing and still shows the approve shape', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const res = await fireV2(plan, { provider: rpc, ...deps({ dryRun: true }) });
  assert.equal(order.length, 0);
  assert.equal(res.simulated, true);
  assert.ok(res.buys.every((b) => b.approve && b.approve.status === 'simulated'));
});
