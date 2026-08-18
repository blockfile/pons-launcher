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

test('kind defaults to season and refuses anything it does not know', () => {
  // Absent means season, because every campaign written before splits existed
  // had no kind and every one of them was a season. A default of anything else
  // would change what those stored campaigns mean.
  assert.equal(guards.resolveKind({}), 'season');
  assert.equal(guards.resolveKind({ kind: 'season' }), 'season');
  assert.equal(guards.resolveKind({ kind: 'split' }), 'split');
  assert.throws(() => guards.resolveKind({ kind: 'seed' }), /season.*split/);
  assert.throws(() => guards.resolveKind({ kind: 'SPLIT' }), /season.*split/);
});

test('a split refuses to pay its own source', () => {
  // Relaying a wallet to itself burns a fee and a gas payment to move ETH in a
  // circle. The source dropdown and the target list are drawn from the same
  // set of wallets, so this is an easy mistake to make and a silent one to
  // suffer — the campaign would look like it worked.
  assert.throws(() => guards.assertNotSelfFunding(['m1', 'm2'], 'm1'), /m1/);
  assert.throws(() => guards.assertNotSelfFunding(['m1', 'm2'], 'm1'), /itself|cannot Relay to itself/i);
  assert.doesNotThrow(() => guards.assertNotSelfFunding(['m2', 'm3'], 'm1'));
  // Empty targets are somebody else's error to report, not this guard's.
  assert.doesNotThrow(() => guards.assertNotSelfFunding([], 'm1'));
});

test('import accepts a funding wallet and refuses a seed', () => {
  // The whole reason the import route checks a role. A seed wallet earns its
  // value by having no history before the transfer that funds it; an imported
  // key has one already, and no amount of sitting afterwards gives it back the
  // property it never had. Funders are plumbing and may be imported.
  assert.doesNotThrow(() => guards.assertImportRole('v4master'));
  assert.throws(() => guards.assertImportRole('v4seed'), /v4seed/);
  // The refusal has to say WHY, or the obvious next move is to import the seed
  // under the funding role and move it across with setRole.
  assert.throws(() => guards.assertImportRole('v4seed'), /history/i);
  // Roles belonging to other tabs are refused by the same gate, not silently
  // coerced into a funding wallet.
  for (const other of ['bundle', 'v2bundle', 'v3main', 'dev']) {
    assert.throws(() => guards.assertImportRole(other), /v4master/);
  }
});

test('the backup gate refuses a campaign whose wallets have no backup', () => {
  // Strengthened from the brief's own `/s2|backup/i`: that regex is satisfied
  // by the literal word "backup" alone, so it passed even when the message
  // named nothing. Requiring the wallet id itself is what actually pins "it
  // names the ones that do not," which is the file's own header claim.
  assert.throws(
    () => guards.assertBackedUp(['s1', 's2'], () => ['s2']),
    /s2/
  );
  assert.doesNotThrow(() => guards.assertBackedUp(['s1'], () => []));
});

test('the backup gate names every unprotected wallet, not just a count', () => {
  assert.throws(() => guards.assertBackedUp(['s1', 's2', 's3'], () => ['s2', 's3']), (err) => {
    assert.match(err.message, /s2/);
    assert.match(err.message, /s3/);
    assert.doesNotMatch(err.message, /\bs1\b/);
    return true;
  });
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

test('assertGenerateCount caps well below where keystore.persist() would stall the shared event loop', () => {
  // keystore.generate(n) rewrites the WHOLE keystore file on every one of its
  // n add() calls, so a single call is O(n^2) in bytes written and runs on
  // the one event loop the runner's timers and every other tab share. 1000
  // measured at ~10s of blocked event loop from an empty keystore.
  assert.doesNotThrow(() => guards.assertGenerateCount(1));
  assert.doesNotThrow(() => guards.assertGenerateCount(guards.MAX_GENERATE_COUNT));
  assert.throws(
    () => guards.assertGenerateCount(guards.MAX_GENERATE_COUNT + 1),
    new RegExp(`count must be between 1 and ${guards.MAX_GENERATE_COUNT}`)
  );
  assert.throws(() => guards.assertGenerateCount(1000), /count must be between/);
  assert.throws(() => guards.assertGenerateCount(0), /count must be between/);
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

// ── withMasterBalance: an unreadable chain must not hide the wallets ───────

test('withMasterBalance reports the funding wallet balance in ETH', async () => {
  const row = await guards.withMasterBalance({ id: 'm1', address: '0xabc' }, {
    getBalance: async () => parseEther('1.5'),
  });
  assert.equal(row.balanceEth, '1.5');
  assert.equal(row.id, 'm1');
});

test('withMasterBalance reports null rather than throwing when the RPC is down', async () => {
  // null, and deliberately not 0: GET /v4/wallets is what draws the whole tab,
  // and a wallet shown empty when it holds two ETH is the reading that has
  // somebody fund it twice.
  const row = await guards.withMasterBalance({ id: 'm1', address: '0xabc' }, {
    getBalance: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.equal(row.balanceEth, null);
  assert.equal(row.id, 'm1');
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

test('resolveWalletIds deduplicates an explicit list, so one request cannot fund the same wallet twice', () => {
  const ks = fakeKs({ seeds: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] });
  assert.deepEqual(guards.resolveWalletIds({ walletIds: ['s1', 's1', 's1'] }, ks), ['s1']);
  // Order-preserving and mixed with real duplicates elsewhere in the list.
  assert.deepEqual(guards.resolveWalletIds({ walletIds: ['s2', 's1', 's2', 's3'] }, ks), ['s2', 's1', 's3']);
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

test('duplicate walletIds in one request produce exactly one transfer per distinct wallet', () => {
  const ks = fakeKs({ seeds: seedWallets(3) });
  // s1 named three times. Without dedup this is 3 transfers to the same
  // address from one funding wallet — one plan giving a wallet two funding
  // edges, which assertUnclaimed's own error message exists to prevent, and
  // which assertUnclaimed cannot see because it only checks OTHER campaigns.
  const out = guards.buildCampaignPreview(
    { params: BASE_PARAMS, walletIds: ['s1', 's1', 's1'] },
    ks,
    { nowFn: () => 0 }
  );
  assert.equal(out.feasible.ok, true);
  assert.equal(out.walletIds.length, 1);
  assert.equal(out.transfers.length, 1);
  assert.equal(out.transfers[0].walletId, 's1');
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
