'use strict';

// End-to-end proof that the re-check is actually wired into fireV2: a real
// signed launch tx is parsed, re-estimated, and — when it reverts — the whole
// bundle is aborted with NOTHING broadcast. Uses a real Wallet to produce a
// parseable raw so Transaction.from() succeeds inside fireV2.

const test = require('node:test');
const assert = require('node:assert');
const { Wallet } = require('ethers');
const { fireV2 } = require('./fireV2');

async function signedPlan() {
  const w = Wallet.createRandom();
  const raw = await w.signTransaction({
    to: '0x' + '33'.repeat(20),
    data: '0xabcd',
    value: 0n,
    nonce: 0,
    gasLimit: 6_000_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    chainId: 4663,
  });
  return {
    protocol: 'v2',
    mode: 'presigned',
    token: '0x' + 'aa'.repeat(20),
    curve: '0x' + 'bb'.repeat(20),
    launch: { address: w.address, raw },
    buys: [{ walletId: 'b1', address: '0x' + 'cc'.repeat(20), raw: '0xsignedbuy', nonce: 0 }],
  };
}

test('aborts the bundle and broadcasts NOTHING when the re-check reverts', async () => {
  const plan = await signedPlan();
  let broadcasts = 0;
  const rpc = {
    estimateGas: async () => {
      throw { data: '0x021c0d43' }; // ExemptionListTooLong
    },
    broadcastTransaction: async () => {
      broadcasts++;
      return { hash: '0x' + '00'.repeat(32) };
    },
  };

  await assert.rejects(
    () => fireV2(plan, { provider: rpc, dryRun: false, warmPool: async () => {}, explainRevert: () => 'ExemptionListTooLong' }),
    /nothing was broadcast/
  );
  assert.equal(broadcasts, 0, 'no launch and no buys may be broadcast when the re-check reverts');
});

test('flags a STRAND when the launch reverts but buys confirmed', async () => {
  // The catastrophic case: launch reverts at inclusion (after passing the
  // recheck), the pre-signed buys land against the codeless curve and "succeed".
  // The result must say so loudly, not report the buys as plain confirmed.
  const plan = await signedPlan();
  const LAUNCH_HASH = '0x' + 'aa'.repeat(32);
  let n = 0;
  const rpc = {
    estimateGas: async () => 500000n,
    broadcastTransaction: async () => ({ hash: n++ === 0 ? LAUNCH_HASH : '0x' + n.toString(16).padStart(64, '0') }),
  };
  const res = await fireV2(plan, {
    provider: rpc,
    dryRun: false,
    warmPool: async () => {},
    // launch reverted, the buy "succeeded" against a curve that never existed
    waitForReceipt: async (_rpc, hash) =>
      hash === LAUNCH_HASH ? { status: 0, blockNumber: 5 } : { status: 1, blockNumber: 5 },
    parseLaunch: () => null,
  });
  assert.equal(res.launch.status, 'reverted');
  assert.ok(res.strand, 'a reverted launch with landed buys must raise a strand warning');
  assert.match(res.strand, /stranded/i);
  assert.ok(res.buys.some((b) => b.strandSuspected), 'the exposed buys must be flagged');
});

test('broadcasts the bundle when the re-check passes', async () => {
  const plan = await signedPlan();
  const broadcast = [];
  const rpc = {
    estimateGas: async () => 500000n, // launch simulates fine
    broadcastTransaction: async (raw) => {
      broadcast.push(raw);
      return { hash: '0x' + broadcast.length.toString(16).padStart(64, '0') };
    },
  };

  const res = await fireV2(plan, {
    provider: rpc,
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: async () => null, // pending; we only care that broadcast happened
    parseLaunch: () => null,
  });
  assert.equal(broadcast.length, 2, 'launch + one buy should broadcast');
  assert.equal(res.launch.hash, broadcast[0] && res.launch.hash);
});
