'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseEther } = require('ethers');
const sweep = require('./sweep');

const A = {
  m1: '0x1111111111111111111111111111111111111111',
  m2: '0x2222222222222222222222222222222222222222',
  super: '0x3333333333333333333333333333333333333333',
  s1: '0x4444444444444444444444444444444444444444',
  s2: '0x5555555555555555555555555555555555555555',
};

const MASTERS = [
  { id: 'm1', address: A.m1, role: 'v4master' },
  { id: 'm2', address: A.m2, role: 'v4master' },
  { id: 'super', address: A.super, role: 'v4master' }, // the destination
];
const SEEDS = [
  { id: 's1', address: A.s1, role: 'v4seed' },
  { id: 's2', address: A.s2, role: 'v4seed' },
];

function fakeKs() {
  return {
    walletsWithRole: (r) => (r === 'v4master' ? MASTERS : r === 'v4seed' ? SEEDS : []),
    walletWithRole: () => null,
  };
}

function fakeStore({ withdrawn = [], campaigns = [] } = {}) {
  return {
    withdrawnSeedIds: () => new Set(withdrawn),
    campaigns: () => campaigns,
  };
}

function harness(overrides = {}) {
  const balances = overrides.balances || {};
  const transfers = [];
  const deps = {
    keystoreForFn: () => fakeKs(),
    storeForFn: () => fakeStore(overrides.store || {}),
    activityForFn: () => ({ record() {} }),
    rpc: { getBalance: async (a) => BigInt(balances[a] ?? 0n) },
    relay: {
      transfer: async ({ fromWallet, toAddress, amountWei }) => {
        transfers.push({ from: fromWallet.id, to: toAddress, amountWei });
        return { hash: '0xh', requestId: '0xr' };
      },
    },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
  };
  return { deps, transfers };
}

// ── resolveSources ──────────────────────────────────────────────────────────

test('resolveSources: funding excludes the destination and busy funders; seeds+withdrawn dedupe', () => {
  const out = sweep._private.resolveSources(fakeKs(), fakeStore({ withdrawn: ['s1'] }), {
    categories: ['funding', 'seeds', 'withdrawn'],
    destinationId: 'super',
    busyMasterIds: new Set(['m2']),
  });
  // funding: m1 only (m2 busy, super is the destination); seeds: s1,s2; withdrawn: s1 (already seen)
  assert.deepEqual(out.map((w) => w.id).sort(), ['m1', 's1', 's2']);
});

test('resolveSources with only funding never returns a seed', () => {
  const out = sweep._private.resolveSources(fakeKs(), fakeStore(), { categories: ['funding'], destinationId: 'super' });
  assert.deepEqual(out.map((w) => w.id).sort(), ['m1', 'm2']);
});

// ── plan ──────────────────────────────────────────────────────────────────────

test('plan skips balances under the dust floor and empty wallets', async () => {
  const { deps } = harness({
    balances: { [A.m1]: parseEther('0.5'), [A.s1]: parseEther('0.0005') }, // m2, s2 => 0
  });
  const p = await sweep._private.plan('u', { destinationId: 'super', categories: ['funding', 'seeds'], minSweepEth: '0.002' }, deps);
  assert.deepEqual(p.wallets.map((x) => x.wallet.id), ['m1'], 'only the funded wallet clears the floor');
  assert.ok(p.skipped.some((s) => s.walletId === 's1' && /floor/.test(s.reason)), 's1 is dust');
  assert.ok(p.skipped.some((s) => s.walletId === 's2' && /nothing/.test(s.reason)), 's2 is empty');
});

test('plan refuses a destination that is not a funding wallet', async () => {
  const { deps } = harness();
  await assert.rejects(
    () => sweep._private.plan('u', { destinationId: 'nope', categories: ['funding'] }, deps),
    /funding wallet/
  );
});

test('plan refuses when no valid category is given', async () => {
  const { deps } = harness();
  await assert.rejects(
    () => sweep._private.plan('u', { destinationId: 'super', categories: ['bogus'] }, deps),
    /categories/
  );
});

// ── run ─────────────────────────────────────────────────────────────────────

test('run requires confirm and moves every wallet through RELAY, never direct', async () => {
  const { deps, transfers } = harness({ balances: { [A.m1]: parseEther('0.5') } });
  await assert.rejects(() => sweep.run('u', { destinationId: 'super', categories: ['funding'] }, deps), /confirm/);

  const out = await sweep.run('u', { destinationId: 'super', categories: ['funding'], confirm: true }, deps);
  assert.equal(out.route, 'relay');
  assert.equal(transfers.length, 1, 'one Relay order');
  assert.equal(transfers[0].from, 'm1');
  assert.equal(transfers[0].to, A.super, 'sent to the destination super-main');
  assert.equal(out.totals.sent, 1);
});

test('a funder mid-campaign is never gathered (it would starve the campaign)', async () => {
  const { deps, transfers } = harness({
    balances: { [A.m1]: parseEther('0.5'), [A.m2]: parseEther('0.5') },
    store: { campaigns: [{ status: 'running', masterWalletId: 'm2' }] },
  });
  const out = await sweep.run('u', { destinationId: 'super', categories: ['funding'], confirm: true }, deps);
  assert.deepEqual(transfers.map((t) => t.from), ['m1'], 'm2 is held back');
  assert.ok(out.wallets.every((w) => w.walletId !== 'm2'));
});

test('run refuses when nothing clears the floor', async () => {
  const { deps } = harness({ balances: { [A.s1]: parseEther('0.0005') } });
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'super', categories: ['seeds'], confirm: true }, deps),
    /nothing to gather/
  );
});
