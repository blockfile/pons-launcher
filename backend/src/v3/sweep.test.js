'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const sweep = require('./sweep');

const USER = 'u1';
const TREASURY = { id: 'tr', role: 'v3dev', address: '0x00000000000000000000000000000000000000d1' };
const MAIN = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const W1 = { id: 'w1', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b2' };
const W3 = { id: 'w3', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b3' };
const OTHER = { id: 'v2b', role: 'v2bundle', address: '0x00000000000000000000000000000000000000c1' };

function harness({
  balances = {
    [MAIN.address]: parseEther('2'),
    [W1.address]: parseEther('1'),
    [W2.address]: parseEther('0.5'),
    [W3.address]: parseEther('0.25'),
    [OTHER.address]: parseEther('9'),
  },
  failFor = [],
} = {}) {
  const sent = [];
  const logged = [];
  const wallets = [TREASURY, MAIN, W1, W2, W3, OTHER];

  return {
    sent,
    logged,
    deps: {
      keystoreForFn: () => ({
        walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
        walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      }),
      activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
      rpc: { getBalance: async (a) => balances[a] ?? 0n },
      getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
      relay: {
        transfer: async ({ fromWallet, toAddress, amountWei }) => {
          sent.push({ from: fromWallet.id, to: toAddress, amountWei });
          if (failFor.includes(fromWallet.id)) throw new Error('relay refused');
          return { hash: `0x${fromWallet.id}`, requestId: `0xreq${fromWallet.id}`, depositAddress: '0xdep' };
        },
      },
    },
  };
}

const run = (h, over = {}) => sweep.run(USER, { destination: 'main', confirm: true, ...over }, h.deps);

test('it sweeps every bundle wallet to the main wallet', async () => {
  const h = harness();
  const out = await run(h);
  assert.deepEqual(h.sent.map((s) => s.from).sort(), ['w1', 'w2', 'w3']);
  assert.ok(h.sent.every((s) => s.to === MAIN.address));
  assert.equal(out.totals.sent, 3);
});

test('it goes through Relay, never a direct transfer', async () => {
  // A direct sweep would link every buyer to the destination and undo the whole
  // run. There is no direct path in this module at all, and this is the test
  // that says so.
  const h = harness();
  await run(h);
  assert.equal(h.sent.length, 3, 'every wallet must go through the relay helper');
});

test('the main wallet is swept too when the destination is the treasury', async () => {
  const h = harness();
  await run(h, { destination: 'treasury' });
  assert.deepEqual(h.sent.map((s) => s.from).sort(), ['main', 'w1', 'w2', 'w3']);
  assert.ok(h.sent.every((s) => s.to === TREASURY.address));
});

test('the main wallet is never swept into itself', async () => {
  const h = harness();
  await run(h, { destination: 'main' });
  assert.ok(!h.sent.some((s) => s.from === 'main'));
});

test('it never touches another launchers wallets', async () => {
  const h = harness();
  await run(h);
  assert.ok(!h.sent.some((s) => s.from === 'v2b'));
});

test('each wallet sends its balance less gas and a relay allowance', async () => {
  const h = harness();
  await run(h);
  const one = h.sent.find((s) => s.from === 'w1');
  assert.ok(one.amountWei < parseEther('1'), 'gas and the relay fee must be held back');
  assert.ok(one.amountWei > parseEther('0.95'), `held back too much: ${one.amountWei}`);
});

test('a wallet holding nothing is skipped rather than attempted', async () => {
  const h = harness({ balances: { [W1.address]: parseEther('1'), [W2.address]: 0n, [W3.address]: 0n } });
  const out = await run(h);
  assert.deepEqual(h.sent.map((s) => s.from), ['w1']);
  assert.equal(out.skipped.length, 2);
  assert.match(out.skipped[0].reason, /nothing to sweep/);
});

test('dust worth less than the fee to move it is skipped, and named', async () => {
  // Sweeping 100 wei through a solver costs more than 100 wei. Attempting it
  // burns gas to move nothing.
  const h = harness({
    balances: { [W1.address]: parseEther('1'), [W2.address]: 1000n, [W3.address]: parseEther('0.3') },
  });
  const out = await run(h);
  assert.deepEqual(h.sent.map((s) => s.from).sort(), ['w1', 'w3']);
  assert.match(out.skipped.find((s) => s.walletId === 'w2').reason, /too small/);
});

test('the dust floor is adjustable', async () => {
  const h = harness();
  const out = await run(h, { minSweepEth: '0.6' });
  // Only w1 (1 ETH) clears a 0.6 floor; w2 (0.5) and w3 (0.25) do not.
  assert.deepEqual(h.sent.map((s) => s.from), ['w1']);
  assert.equal(out.skipped.length, 2);
});

test('one wallets failure does not stop the others', async () => {
  const h = harness({ failFor: ['w2'] });
  const out = await run(h);
  assert.equal(h.sent.length, 3, 'every wallet is still attempted');
  assert.equal(out.totals.failed, 1);
  assert.equal(out.totals.sent, 2);
  assert.match(out.wallets.find((w) => w.walletId === 'w2').error, /relay refused/);
});

test('it refuses without confirm', async () => {
  const h = harness();
  await assert.rejects(() => sweep.run(USER, { destination: 'main' }, h.deps), /confirm/);
  assert.equal(h.sent.length, 0);
});

test('it refuses an unknown destination', async () => {
  const h = harness();
  await assert.rejects(() => run(h, { destination: 'elsewhere' }), /destination/);
});

test('it refuses when there is nothing worth sweeping', async () => {
  const h = harness({ balances: {} });
  await assert.rejects(() => run(h), /nothing to sweep/);
});

test('totals report what moved', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(out.totals.wallets, 3);
  assert.equal(out.totals.sent, 3);
  assert.equal(out.totals.failed, 0);
  // 1.75 ETH of balances, less gas and the 3% relay allowance.
  assert.ok(Number(out.totals.eth) > 1.69, `only ${out.totals.eth} accounted for`);
  assert.ok(Number(out.totals.eth) < 1.75, "the allowance must actually be held back");
});

test('the sweep is written to the activity log', async () => {
  const h = harness();
  await run(h);
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].kind, 'v3');
  assert.match(h.logged[0].summary, /swept/);
});

test('preview says what would move, and sends nothing', async () => {
  const h = harness();
  const out = await sweep.preview(USER, { destination: 'main' }, h.deps);
  assert.equal(h.sent.length, 0);
  assert.equal(out.wallets.length, 3);
  assert.equal(out.destination.address, MAIN.address);
  assert.ok(Number(out.totalEth) > 1.69);
});

test('preview marks the skipped without refusing to answer', async () => {
  const h = harness({ balances: { [W1.address]: parseEther('1') } });
  const out = await sweep.preview(USER, { destination: 'main' }, h.deps);
  assert.equal(out.wallets.length, 1);
  assert.equal(out.skipped.length, 2);
});

test('no field of the result is a BigInt', async () => {
  const h = harness();
  assert.ok(JSON.stringify(await run(h)).length > 0);
  assert.ok(JSON.stringify(await sweep.preview(USER, { destination: 'main' }, h.deps)).length > 0);
});
