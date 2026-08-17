'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

// These are unit tests over the route module's exported guards and pure
// helpers, not an HTTP harness — the repo has no supertest dependency and
// this plan does not add one.
const guards = require('./v4')._private;

// ── the brief's required tests, verbatim ────────────────────────────────────

test('generate refuses a role V4 does not own', () => {
  assert.throws(() => guards.assertV4Role('v3bundle'), /v4master|v4seed/);
  assert.throws(() => guards.assertV4Role('bundle'), /v4master|v4seed/);
  assert.doesNotThrow(() => guards.assertV4Role('v4seed'));
});

test('the backup gate refuses a campaign whose wallets have no backup', () => {
  assert.throws(
    () => guards.assertBackedUp(['s1', 's2'], () => ['s2']),
    /s2|backup/i
  );
  assert.doesNotThrow(() => guards.assertBackedUp(['s1'], () => []));
});

test('a campaign refuses a seed wallet another campaign already claimed', () => {
  assert.throws(
    () => guards.assertUnclaimed(['s1', 's9'], new Set(['s9'])),
    /s9|claimed/i
  );
  // The brief's own test only exercises the throwing direction — a mutant
  // that always throws (e.g. `if (walletIds.length)` instead of checking
  // `claimed`) would pass it trivially. This pins the other direction: no
  // wallet in the set is actually claimed, so nothing should throw.
  assert.doesNotThrow(() => guards.assertUnclaimed(['s1', 's2'], new Set(['s9'])));
});

test('a campaign refuses a funding wallet that is not a v4master', () => {
  assert.throws(() => guards.assertMaster('m1', []), /v4master/);
  assert.doesNotThrow(() => guards.assertMaster('m1', [{ id: 'm1', role: 'v4master' }]));
});

test('backup requires an explicit confirm', () => {
  assert.throws(() => guards.assertConfirmed({}), /confirm/);
  assert.throws(() => guards.assertConfirmed({ confirm: 'yes' }), /confirm/);
  assert.doesNotThrow(() => guards.assertConfirmed({ confirm: true }));
});

// ── onlyV4Wallets: never another tab's keys out of a V4 route ──────────────

test('onlyV4Wallets keeps v4master and v4seed and drops every other role', () => {
  const wallets = [
    { id: 'a', role: 'dev' },
    { id: 'b', role: 'bundle' },
    { id: 'c', role: 'v3main' },
    { id: 'd', role: 'v3bundle' },
    { id: 'e', role: 'v4master' },
    { id: 'f', role: 'v4seed' },
  ];
  const kept = guards.onlyV4Wallets(wallets);
  assert.deepEqual(
    kept.map((w) => w.id).sort(),
    ['e', 'f']
  );
});

// ── resolveWalletIds ─────────────────────────────────────────────────────

function fakeKs({ masters = [], seeds = [] } = {}) {
  return {
    walletsWithRole: (role) => {
      if (role === 'v4master') return masters;
      if (role === 'v4seed') return seeds;
      return [];
    },
  };
}

test('resolveWalletIds defaults to every v4seed wallet when none are named', () => {
  const ks = fakeKs({ seeds: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
  assert.deepEqual(guards.resolveWalletIds({}, ks), ['s1', 's2', 's3']);
});

test('resolveWalletIds accepts an explicit subset and refuses an id that is not a v4seed wallet', () => {
  const ks = fakeKs({ seeds: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
  assert.deepEqual(guards.resolveWalletIds({ walletIds: ['s2'] }, ks), ['s2']);
  assert.throws(() => guards.resolveWalletIds({ walletIds: ['s2', 'not-a-seed'] }, ks), /not-a-seed/);
});

// ── buildCampaignPreview: routes params through normaliseParams ────────────

const BASE_PARAMS = {
  days: 1,
  perDayMin: 1,
  perDayMax: 2,
  amountMinEth: '0.001',
  amountMaxEth: '0.002',
  gapMinMs: 60_000,
  gapMaxMs: 120_000,
};

function seedWallets(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    address: `0x${String(i + 1).padStart(40, '0')}`,
  }));
}

test('buildCampaignPreview reports infeasible without throwing, and a full schedule when it fits', () => {
  const ks = fakeKs({ seeds: seedWallets(5) });

  // 5 wallets, but perDayMax 2 over 1 day tops out at 2 — infeasible.
  const tooMany = guards.buildCampaignPreview({ params: BASE_PARAMS }, ks, { nowFn: () => 0 });
  assert.equal(tooMany.feasible.ok, false);
  assert.deepEqual(tooMany.transfers, []);
  assert.equal(tooMany.totalEth, '0');

  const fits = guards.buildCampaignPreview(
    { params: BASE_PARAMS, walletIds: ['s1', 's2'] },
    ks,
    { nowFn: () => 0, newSeedFn: () => 'fixed-seed' }
  );
  assert.equal(fits.feasible.ok, true);
  assert.equal(fits.transfers.length, 2);
  assert.equal(fits.seed, 'fixed-seed');
});

test('buildCampaignPreview reuses a posted-back seed instead of minting a new one', () => {
  const ks = fakeKs({ seeds: seedWallets(2) });
  const out = guards.buildCampaignPreview(
    { params: BASE_PARAMS, seed: 'operator-seed' },
    ks,
    { nowFn: () => 0 }
  );
  assert.equal(out.seed, 'operator-seed');
});

test('buildCampaignPreview refuses a params object that only normaliseParams would catch', () => {
  // amountMinEth of 0 is never checked by plan.generate()/feasible() — it is
  // caught ONLY inside normaliseParams. A route that hand-built its params
  // object instead of calling normaliseParams would let this through.
  const ks = fakeKs({ seeds: seedWallets(2) });
  assert.throws(
    () => guards.buildCampaignPreview({ params: { ...BASE_PARAMS, amountMinEth: '0' } }, ks),
    /amount minimum must be positive/
  );
});

// ── resolveCampaignStart: the guard order, the normaliseParams routing, and
//    the balance check ──────────────────────────────────────────────────────

function fakeStore({ claimed = new Set(), missingBackup = [] } = {}) {
  return {
    claimedSeedIds: () => claimed,
    backedUp: (ids) => ids.filter((id) => missingBackup.includes(id)),
  };
}

const MASTER = { id: 'm1', role: 'v4master', address: '0x1111111111111111111111111111111111111111' };

function richDeps(overrides = {}) {
  return {
    getFeesFn: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    rpc: { getBalance: async () => parseEther('100') },
    nowFn: () => 0,
    ...overrides,
  };
}

test('resolveCampaignStart routes params through normaliseParams rather than hand-building them', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  const store = fakeStore();
  const body = {
    name: 'camp',
    masterWalletId: 'm1',
    seed: 'x',
    // Only normaliseParams checks this bound; plan.generate() and
    // plan.feasible() have no equivalent — a hand-built params object would
    // sail straight through and produce zero-value transfers instead of
    // refusing.
    params: { ...BASE_PARAMS, amountMinEth: '0' },
  };
  await assert.rejects(
    () => guards.resolveCampaignStart(body, ks, store, richDeps()),
    /amount minimum must be positive/
  );
});

test('resolveCampaignStart runs assertMaster before assertUnclaimed, assertBackedUp and feasibility', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  // Both wallets are claimed AND unbacked, so if the master check were not
  // first, one of those errors would surface instead.
  const store = fakeStore({ claimed: new Set(['s1', 's2']), missingBackup: ['s1', 's2'] });
  const body = { name: 'camp', masterWalletId: 'not-a-master', seed: 'x', params: BASE_PARAMS };
  await assert.rejects(() => guards.resolveCampaignStart(body, ks, store, richDeps()), /v4master/);
});

test('resolveCampaignStart runs assertUnclaimed before assertBackedUp', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  // s1 is claimed; s2 has no backup. Unclaimed must be checked first.
  const store = fakeStore({ claimed: new Set(['s1']), missingBackup: ['s2'] });
  const body = { name: 'camp', masterWalletId: 'm1', seed: 'x', params: BASE_PARAMS, walletIds: ['s1', 's2'] };
  await assert.rejects(() => guards.resolveCampaignStart(body, ks, store, richDeps()), /claimed/i);
});

test('resolveCampaignStart checks feasibility only after unclaimed and backup pass', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(1) });
  const store = fakeStore(); // nothing claimed, nothing missing a backup
  // perDayMin 5 over 1 day needs 5 wallets; only 1 is offered — infeasible.
  const body = {
    name: 'camp',
    masterWalletId: 'm1',
    seed: 'x',
    params: { ...BASE_PARAMS, perDayMin: 5, perDayMax: 5 },
  };
  await assert.rejects(() => guards.resolveCampaignStart(body, ks, store, richDeps()), /below the floor/);
});

test('resolveCampaignStart refuses to start when the funding wallet cannot cover the plan', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  const store = fakeStore();
  const body = { name: 'camp', masterWalletId: 'm1', seed: 'x', params: BASE_PARAMS };
  const deps = richDeps({ rpc: { getBalance: async () => 0n } });
  await assert.rejects(() => guards.resolveCampaignStart(body, ks, store, deps), /fund it first/);
});

test('resolveCampaignStart requires a posted-back seed rather than minting its own', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  const store = fakeStore();
  const body = { name: 'camp', masterWalletId: 'm1', params: BASE_PARAMS };
  await assert.rejects(() => guards.resolveCampaignStart(body, ks, store, richDeps()), /seed is required/);
});

test('resolveCampaignStart succeeds and regenerates the exact plan a matching preview would', async () => {
  const ks = fakeKs({ masters: [MASTER], seeds: seedWallets(2) });
  const store = fakeStore();
  const body = { name: 'camp', masterWalletId: 'm1', seed: 'fixed', params: BASE_PARAMS };

  const preview = guards.buildCampaignPreview(body, ks, { nowFn: () => 0 });
  const started = await guards.resolveCampaignStart(body, ks, store, richDeps());

  assert.equal(started.master.id, 'm1');
  assert.equal(started.result.seed, 'fixed');
  assert.deepEqual(started.result.transfers, preview.transfers);
  assert.deepEqual(started.walletIds, preview.walletIds);
});
