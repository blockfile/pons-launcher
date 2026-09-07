'use strict';

// fireV2 broadcasting an ERC-20 pair launch.
//
// The native path is one transaction per wallet. The ERC-20 path is two — an
// approve then the action — for the dev (approve the forwarder, then
// launchAndBuy) and for every bundle wallet (approve the curve, then buy).
//
// WHAT CHANGED, AND WHY THESE TESTS ARE SHAPED THIS WAY. The approves used to
// go out AFTER the launch, one per wallet, each costing a full round trip
// (~250ms, 2-3 blocks at 0.101s) before that wallet's buy could be sent. The
// opening snipe tax steps on whole wall-clock seconds — 99.00% at 0s, 6.18% at
// 1s — so a quarter-second of approve traffic between the launch and the buys
// is the difference between the 99% tier and the 6% one. Every approve now
// leads the launch and the post-launch burst carries buys and nothing else.
//
// That reordering is only safe if the approves and the launch share one salt:
// an approve names the PREDICTED CURVE as its spender, and that address exists
// only as a function of the salt the launch carries. So the salt pin is tested
// as hard as the ordering is, against a REAL encoded launch transaction whose
// salt is read back out of its own bytes.

const test = require('node:test');
const assert = require('node:assert');
const { Interface, Transaction, Wallet } = require('ethers');
const { fireV2 } = require('./fireV2');
const { FACTORY_V2_ABI } = require('../evm/v2/abi');

const CURVE = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const FACTORY = '0x' + 'fa'.repeat(20);
const DEV = '0x' + '11'.repeat(20);

const SALT = '0x' + 'ab'.repeat(32);
const OTHER_SALT = '0x' + 'cd'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);

const factoryIface = new Interface(FACTORY_V2_ABI);
// The overloaded launchToken — the four-argument form with the exemption list,
// which is the one a bundle launch always uses.
const LAUNCH_SIG =
  'launchToken(tuple(string,string,string,string,tuple(string,string,string,string,string),' +
  'address,uint16,bool,bytes32,bytes32),uint256,address,address[])';

function launchData(salt) {
  const params = ['Nvidia', 'NVDA', 'ipfs://logo', '', ['', '', '', '', ''], DEV, 0, false, ZERO32, salt];
  return factoryIface.encodeFunctionData(LAUNCH_SIG, [params, 0, USDG, []]);
}

/** A serialized launch transaction really carrying `salt` in its calldata. */
function launchRaw(salt) {
  return Transaction.from({
    to: FACTORY,
    data: launchData(salt),
    value: 1_000_000n,
    chainId: 4663,
    nonce: 5,
    gasLimit: 3_000_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  }).unsignedSerialized;
}

const LAUNCH_RAW = launchRaw(SALT);
// The broadcast log reads better with a name than with 300 bytes of hex.
const label = (raw) => (raw === LAUNCH_RAW ? 'LAUNCH' : raw);

const plan = {
  protocol: 'v2',
  mode: 'presigned',
  token: TOKEN,
  curve: CURVE,
  salt: SALT,
  pairToken: USDG,
  pairSymbol: 'USDG',
  pairDecimals: 6,
  launch: {
    address: DEV,
    raw: LAUNCH_RAW,
    salt: SALT,
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
      approve: { nonce: 0, spender: CURVE, salt: SALT, raw: 'APPROVE_A' },
      raw: 'BUY_A',
    },
    {
      walletId: 'b',
      address: '0xb',
      amountEth: '5.0',
      nonce: 3,
      exempt: true,
      approve: { nonce: 2, spender: CURVE, salt: SALT, raw: 'APPROVE_B' },
      raw: 'BUY_B',
    },
  ],
  fees: { type: 2, maxFeePerGas: 1000n, maxPriorityFeePerGas: 10n },
  buyGas: '400000',
  chainId: '4663',
};

function fakeProvider({ order = [], failApprove = null, failLaunch = false } = {}) {
  return {
    order,
    async broadcastTransaction(raw) {
      if (failApprove && raw === failApprove) throw new Error('approve rejected');
      if (failLaunch && raw === LAUNCH_RAW) throw new Error('launch rejected');
      order.push(label(raw));
      return { hash: `hash:${label(raw)}` };
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

// ── ordering: the whole point of the change ────────────────────────────────

test('every approve leads the launch, and the post-launch burst is buys only', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const res = await fireV2(plan, { provider: rpc, ...deps() });

  const launchAt = order.indexOf('LAUNCH');
  assert.notEqual(launchAt, -1, 'the launch was broadcast');

  // Nothing but approves before the launch...
  assert.deepEqual(order.slice(0, launchAt).sort(), ['APPROVE_A', 'APPROVE_B', 'DEV_APPROVE']);
  // ...and nothing but buys after it. This is the assertion the sniper cost the
  // operator 2.96M tokens over: the wallets were already sequenced ahead of him
  // and spent their slot on `approve`.
  assert.deepEqual(order.slice(launchAt + 1).sort(), ['BUY_A', 'BUY_B']);

  assert.equal(order.length, 6);
  assert.equal(res.confirmed, 2);
  assert.equal(res.launch.status, 'confirmed');
  assert.ok(res.launch.approve, 'the dev approve is reported on the launch');
  assert.ok(res.buys.every((b) => b.approve.status === 'confirmed'));
  // The pre-launch phase is measured and reported, so the record shows what the
  // burst cost and what it did not.
  assert.equal(typeof res.approveMs, 'number');
});

test('the re-estimate is skipped on the dev-buy path rather than aborting a good launch', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  // estimateGas throws CALL_EXCEPTION — a definite revert. needsApprove must
  // keep the fire-time re-check from ever calling it.
  const res = await fireV2(plan, { provider: rpc, ...deps() });
  assert.equal(res.launch.status, 'confirmed');
});

// ── the salt pin ───────────────────────────────────────────────────────────

test('a launch carrying a different salt than the approves is REFUSED, not broadcast', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  // Exactly the accident the pin exists for: prepareV2 mints a fresh salt on
  // every call, so a launch rebuilt after the approves were signed names a
  // curve that will never exist.
  const drifted = { ...plan, launch: { ...plan.launch, raw: launchRaw(OTHER_SALT) } };
  await assert.rejects(() => fireV2(drifted, { provider: rpc, ...deps() }), /SALT MISMATCH/);
  assert.equal(order.length, 0, 'not one approve reached the wire');
});

test('an approve built against a different salt is REFUSED', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const bad = {
    ...plan,
    buys: [plan.buys[0], { ...plan.buys[1], approve: { ...plan.buys[1].approve, salt: OTHER_SALT } }],
  };
  await assert.rejects(() => fireV2(bad, { provider: rpc, ...deps() }), /SALT MISMATCH/);
  assert.equal(order.length, 0);
});

test('an approve naming a spender other than the predicted curve is REFUSED', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const bad = {
    ...plan,
    buys: [
      plan.buys[0],
      { ...plan.buys[1], approve: { ...plan.buys[1].approve, spender: '0x' + '99'.repeat(20) } },
    ],
  };
  await assert.rejects(() => fireV2(bad, { provider: rpc, ...deps() }), /names spender/);
  assert.equal(order.length, 0);
});

test('a plan with no salt at all is REFUSED — a salt is never guessed', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const bad = { ...plan, salt: undefined };
  await assert.rejects(() => fireV2(bad, { provider: rpc, ...deps() }), /no 32-byte salt/);
  assert.equal(order.length, 0);
});

test('a launch whose bytes cannot be read back as a v2 launch is REFUSED', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const bad = { ...plan, launch: { ...plan.launch, raw: 'LAUNCH' } };
  await assert.rejects(
    () => fireV2(bad, { provider: rpc, ...deps() }),
    /cannot be read back as a pons v2 launch/
  );
  assert.equal(order.length, 0);
});

test('the salt is read out of a genuinely SIGNED launch, not from a field beside it', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const wallet = Wallet.createRandom();
  const signedRaw = await wallet.signTransaction({
    to: FACTORY,
    data: launchData(SALT),
    value: 1_000_000n,
    chainId: 4663,
    nonce: 5,
    gasLimit: 3_000_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  });
  // No decoder is injected here: this exercises the real ethers-level decode of
  // a real signature, which is what production runs.
  const signedPlan = { ...plan, launch: { ...plan.launch, raw: signedRaw } };
  const res = await fireV2(signedPlan, { provider: rpc, ...deps() });
  assert.equal(res.confirmed, 2);

  // And the same transaction, signed just as truly, with the wrong salt inside.
  const wrongRaw = await wallet.signTransaction({
    to: FACTORY,
    data: launchData(OTHER_SALT),
    value: 1_000_000n,
    chainId: 4663,
    nonce: 5,
    gasLimit: 3_000_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  });
  const order2 = [];
  await assert.rejects(
    () => fireV2({ ...plan, launch: { ...plan.launch, raw: wrongRaw } },
      { provider: fakeProvider({ order: order2 }), ...deps() }),
    /SALT MISMATCH/
  );
  assert.equal(order2.length, 0);
});

// ── failure handling around the reordered approves ─────────────────────────

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

  // B is untouched, and the launch still went out for it.
  const b = res.buys.find((x) => x.walletId === 'b');
  assert.equal(b.status, 'confirmed');
  assert.ok(order.includes('APPROVE_B') && order.includes('BUY_B'));
  assert.ok(order.indexOf('APPROVE_B') < order.indexOf('LAUNCH'));
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

test('a launch that will not broadcast says the approves already went out', async () => {
  const order = [];
  const rpc = fakeProvider({ order, failLaunch: true });
  await assert.rejects(
    () => fireV2(plan, { provider: rpc, ...deps() }),
    /approve\(s\) were already sent/
  );
  // Gas only, nothing stranded — but the operator has to know the nonces moved.
  assert.ok(!order.includes('BUY_A') && !order.includes('BUY_B'), 'no buy chases a missing launch');
});

// ── the warm-up (it opened zero sockets) ───────────────────────────────────

test('the pool is warmed for every socket the burst needs, on the burst provider', async () => {
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
  // 2 wallets × (approve + buy) + the dev approve + the launch.
  assert.equal(count, 6);
  assert.equal(gotRpc, rpc, 'the sockets warmed must be the ones the burst broadcasts on');
});

test('a warm-up that throws never stops a launch', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const res = await fireV2(plan, {
    provider: rpc,
    ...deps({
      warmPool: async () => {
        throw new Error('socket storm');
      },
    }),
  });
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.confirmed, 2);
});

test('a dry run broadcasts nothing and still shows the approve shape', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const res = await fireV2(plan, { provider: rpc, ...deps({ dryRun: true }) });
  assert.equal(order.length, 0);
  assert.equal(res.simulated, true);
  assert.ok(res.buys.every((b) => b.approve && b.approve.status === 'simulated'));
});

// A paired launch with no dev buy signs no dev approve, but every bundle wallet
// still does — the pin and the reordering must not depend on the forwarder path.
test('a paired launch without a dev buy still puts its approves in front', async () => {
  const order = [];
  const rpc = fakeProvider({ order });
  const noDevBuy = {
    ...plan,
    launch: { address: DEV, raw: LAUNCH_RAW, salt: SALT },
  };
  const res = await fireV2(noDevBuy, {
    provider: rpc,
    ...deps({ skipRecheck: true }),
  });
  const launchAt = order.indexOf('LAUNCH');
  assert.deepEqual(order.slice(0, launchAt).sort(), ['APPROVE_A', 'APPROVE_B']);
  assert.deepEqual(order.slice(launchAt + 1).sort(), ['BUY_A', 'BUY_B']);
  assert.equal(res.confirmed, 2);
  assert.equal(res.launch.approve, undefined);
});
