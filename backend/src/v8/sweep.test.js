'use strict';

// Unit tests for V8's sweep. Offline: the keystore, the provider, the fees, the activity
// log and the Relay primitive are injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAddress, parseEther, formatEther } = require('ethers');

const sweep = require('./sweep');
const relayTransfer = require('./relayTransfer');

const MAIN = getAddress('0x' + 'a1'.repeat(20));
const B = (n) => getAddress('0x' + String(n).padStart(40, '0'));

// gasCost at these fees over the 50k deposit limit = 50_000 * 1 gwei = 0.00005 ETH.
const FEES = async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
const GAS = 50_000n * 1_000_000_000n;

function fakeKs({ count = 3, main = { id: 'm1', role: 'v8main', address: MAIN } } = {}) {
  const wallets = [
    ...(main ? [main] : []),
    ...Array.from({ length: count }, (_, i) => ({ id: `b${i + 1}`, role: 'v8bundle', address: B(i + 1) })),
  ];
  return {
    wallets,
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
}

function harness(over = {}) {
  const orders = [];
  const logged = [];
  const balances = over.balances || { [B(1)]: parseEther('1'), [B(2)]: parseEther('2'), [B(3)]: parseEther('3') };
  const ks = over.keystore || fakeKs(over.ks);
  const deps = {
    keystoreForFn: () => ks,
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    rpc: { getBalance: async (addr) => balances[getAddress(addr)] ?? 0n },
    getFeesFn: FEES,
    relay: {
      relayOnce:
        over.relayOnce ||
        (async ({ fromWallet, toAddress, amountWei }) => {
          orders.push({ from: getAddress(fromWallet.address), to: getAddress(toAddress), amountWei });
          return { hash: `hash:${fromWallet.id}`, requestId: '0xreq', depositAddress: B(99) };
        }),
    },
  };
  return { deps, orders, logged, ks };
}

/** What plan() should compute for a balance: (balance − gas) × 97%. */
const expectedSend = (balanceEth) => ((parseEther(balanceEth) - GAS) * 97n) / 100n;

test('the sweep requires an explicit confirm — it empties every bundle wallet', async () => {
  const { deps, orders } = harness();
  await assert.rejects(() => sweep.run('u1', {}, deps), /requires \{ confirm: true \}/);
  await assert.rejects(() => sweep.run('u1', { confirm: 'yes' }, deps), /requires \{ confirm: true \}/);
  assert.equal(orders.length, 0);
});

test('every wallet goes through RELAY — there is no direct path in this module', async () => {
  const { deps, orders } = harness();
  const out = await sweep.run('u1', { confirm: true }, deps);
  assert.equal(out.route, 'relay');
  assert.equal(orders.length, 3);
  for (const o of orders) assert.equal(o.to, MAIN, 'everything lands in the main wallet');
  assert.deepEqual(
    orders.map((o) => o.from),
    [B(1), B(2), B(3)]
  );
  // The module exposes nothing that could send directly.
  assert.equal(typeof sweep.direct, 'undefined');
  assert.equal(Object.keys(sweep).some((k) => /direct/i.test(k)), false);
});

test('it sends the real balance MINUS its own gas and Relay’s fee, not the whole balance', async () => {
  const { deps, orders } = harness();
  const out = await sweep.run('u1', { confirm: true }, deps);
  assert.deepEqual(
    orders.map((o) => o.amountWei),
    [expectedSend('1'), expectedSend('2'), expectedSend('3')]
  );
  for (const o of orders) assert.ok(o.amountWei < parseEther('1') * 3n, 'never asks for more than is there');
  assert.equal(out.totals.sent, 3);
  assert.equal(out.totals.failed, 0);
  assert.equal(
    out.totals.eth,
    formatEther(expectedSend('1') + expectedSend('2') + expectedSend('3'))
  );
});

// ── the gas skip ─────────────────────────────────────────────────────────────

test('a wallet that cannot cover its own send is SKIPPED AND NAMED, never attempted', async () => {
  const { deps, orders } = harness({
    balances: {
      [B(1)]: parseEther('1'), // fine
      [B(2)]: GAS / 2n, // cannot even pay its own gas
      [B(3)]: 0n, // empty
    },
  });
  const out = await sweep.run('u1', { confirm: true }, deps);

  assert.equal(orders.length, 1, 'only the wallet that can pay was attempted');
  assert.equal(orders[0].from, B(1));

  assert.equal(out.skipped.length, 2);
  const byId = Object.fromEntries(out.skipped.map((s) => [s.walletId, s]));
  assert.match(byId.b2.reason, /cannot cover its own gas/);
  assert.match(byId.b3.reason, /nothing to sweep/);
  for (const s of out.skipped) assert.ok(s.address, 'a skipped wallet is named, not silently dropped');
  assert.equal(out.totals.skipped, 2);
});

test('dust below the floor is skipped and named rather than rerouted to a direct send', async () => {
  const { deps, orders } = harness({
    balances: { [B(1)]: parseEther('0.0009'), [B(2)]: parseEther('1'), [B(3)]: parseEther('0.0015') },
  });
  const out = await sweep.run('u1', { confirm: true }, deps);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].from, B(2));
  assert.deepEqual(
    out.skipped.map((s) => s.walletId),
    ['b1', 'b3']
  );
  for (const s of out.skipped) assert.match(s.reason, /too small for a Relay order/);
});

test('the dust floor is tunable per request', async () => {
  const { deps, orders } = harness({
    balances: { [B(1)]: parseEther('0.0015'), [B(2)]: parseEther('1'), [B(3)]: 0n },
  });
  const out = await sweep.run('u1', { confirm: true, minSweepEth: '0.001' }, deps);
  assert.equal(orders.length, 2, 'a lower floor lets the 0.0015 wallet through');
  assert.equal(out.skipped.length, 1);
  assert.equal(sweep.DEFAULT_MIN_SWEEP_ETH, '0.002');
});

// ── isolation ────────────────────────────────────────────────────────────────

test('one wallet failing does not stop the sweep, and every wallet is reported', async () => {
  const { deps, orders } = harness({
    relayOnce: async ({ fromWallet, toAddress, amountWei }) => {
      if (fromWallet.id === 'b2') throw new Error('Relay refused this order');
      orders.push?.({});
      return { hash: `hash:${fromWallet.id}`, requestId: '0xreq', depositAddress: B(99), to: toAddress, amountWei };
    },
  });
  const out = await sweep.run('u1', { confirm: true }, deps);

  assert.equal(out.results.length, 3);
  assert.equal(out.results[0].status, 'sent');
  assert.equal(out.results[1].status, 'failed');
  assert.match(out.results[1].error, /Relay refused this order/);
  assert.equal(out.results[2].status, 'sent', 'the sweep carried on past the failure');
  assert.equal(out.totals.sent, 2);
  assert.equal(out.totals.failed, 1);
  // The failed wallet's ETH is still counted as un-moved.
  assert.equal(out.totals.eth, formatEther(expectedSend('1') + expectedSend('3')));
});

test('an empty tab sweeps nothing and says so, rather than throwing', async () => {
  const { deps } = harness({ ks: { count: 0 }, balances: {} });
  const out = await sweep.run('u1', { confirm: true }, deps);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.skipped, []);
  assert.equal(out.totals.sent, 0);
});

test('with no main wallet there is nowhere to sweep TO, and it says which wallet is missing', async () => {
  const { deps } = harness({ ks: { main: null } });
  await assert.rejects(() => sweep.run('u1', { confirm: true }, deps), /no v8main wallet/);
});

// ── preview ──────────────────────────────────────────────────────────────────

test('preview reads the same plan without moving anything', async () => {
  const { deps, orders } = harness();
  const out = await sweep.preview('u1', {}, deps);
  assert.equal(orders.length, 0, 'a preview signs nothing');
  assert.equal(out.route, 'relay');
  assert.equal(out.walletCount, 3);
  assert.equal(out.destination.address, MAIN);
  assert.deepEqual(
    out.wallets.map((w) => w.sendEth),
    [formatEther(expectedSend('1')), formatEther(expectedSend('2')), formatEther(expectedSend('3'))]
  );
});

test('the sweep is logged with its totals and its skipped wallets', async () => {
  const { deps, logged } = harness({ balances: { [B(1)]: parseEther('1'), [B(2)]: 0n, [B(3)]: parseEther('1') } });
  await sweep.run('u1', { confirm: true }, deps);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, 'sweep');
  assert.match(logged[0].summary, /swept 2\/2 wallet\(s\) back to main through Relay/);
  assert.match(logged[0].summary, /1 skipped as dust/);
  assert.equal(logged[0].detail.route, 'relay');
  assert.equal(logged[0].detail.skipped.length, 1);
});

// The sweep is built on the same primitive the fan-out is, rather than a second copy of
// the quote/verify/sign discipline.
test('the sweep uses relayTransfer.relayOnce, not a private send of its own', () => {
  assert.equal(typeof relayTransfer.relayOnce, 'function');
  assert.equal(sweep.RELAY_FEE_PCT, 3);
});
