'use strict';

const test = require('node:test');
const assert = require('node:assert');
const routes = require('./v6');

const { feasibilityOf, selectBackupWallets } = routes._private;

const RUN = {
  token: '0x1111111111111111111111111111111111111111',
  pool: { poolKey: {}, poolId: '0xpid', hook: '0xhook' },
  bigBuyWei: 1_000_000n,
  targets: [{ walletId: 'a', address: '0x2222222222222222222222222222222222222222' }],
};

const FEES = { getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }) };
const revertingSell = () => {
  const e = new Error('execution reverted (unknown custom error)');
  e.data = '0x6190b2b0000000';
  throw e;
};

// A reverting SELL QUOTE is NOT proof of a honeypot — the letscash quoter reverts on
// sells even for sellable tokens. Only a pool with NO sell in its history is blocked.
test('sell quote reverts AND no sell has ever landed → honeypot, feasible=false', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: revertingSell,
    hasRecentSell: async () => false, // buys but never a sell
  };
  const feas = await feasibilityOf(RUN, { trade, ...FEES });
  assert.equal(feas.sellsRevert, true);
  assert.equal(feas.reason, 'sells-revert');
  assert.equal(feas.feasible, false);
  assert.equal(feas.sellError, '0x6190b2b0');
  assert.equal(feas.positionWei, 0n);
});

test('sell quote reverts BUT sells have landed → sellable, estimated pricing, NOT blocked', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: revertingSell,
    hasRecentSell: async () => true, // sells DO land on this pool
  };
  const feas = await feasibilityOf(RUN, { trade, ...FEES });
  assert.equal(feas.sellsRevert, false, 'a token that sells on-chain is never blocked as a honeypot');
  assert.equal(feas.pricingEstimated, true);
  assert.equal(feas.sellError, '0x6190b2b0');
  assert.equal(feas.positionWei, RUN.bigBuyWei, 'position estimated as roughly the ETH put in');
});

test('feasibilityOf reads the selector from an ethers info.error.data shape too', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: async () => {
      const e = new Error('execution reverted');
      e.info = { error: { data: '0xdeadbeef11' } };
      throw e;
    },
    hasRecentSell: async () => false,
  };
  const feas = await feasibilityOf(RUN, { trade, ...FEES });
  assert.equal(feas.sellsRevert, true);
  assert.equal(feas.sellError, '0xdeadbeef');
});

test('a normally-quotable sell is priced with no estimate and no block', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: async () => 900_000n, // sells quote fine → a real position value
    hasRecentSell: async () => { throw new Error('should not be called when the quote works'); },
  };
  const feas = await feasibilityOf(RUN, { trade, ...FEES });
  assert.equal(feas.sellsRevert, false);
  assert.equal(feas.pricingEstimated, false);
  assert.equal(feas.positionWei, 900_000n);
});

test('sell quote reverts and the sellability scan is INCONCLUSIVE (throws) → allowed, sellUnverified', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: revertingSell,
    hasRecentSell: async () => { throw new Error('the node refused the range'); },
  };
  const feas = await feasibilityOf(RUN, { trade, ...FEES });
  assert.equal(feas.sellsRevert, false, 'an inconclusive scan never blocks');
  assert.equal(feas.sellUnverified, true);
  assert.equal(feas.pricingEstimated, true);
});

// ── _private.selectBackupWallets — the OPTIONAL role / walletIds backup filter ──
// The list handed in is already gated to V6's own roles; these check that a
// filter only ever NARROWS it, and that an absent filter is a no-op (the plain
// "Download backup" must stay byte-identical).
const V6_WALLETS = [
  { id: 'a', role: 'v6dev', address: '0xdev' },
  { id: 'b', role: 'v6main', address: '0xmain' },
  { id: 'c', role: 'v6bundle', address: '0xb1' },
  { id: 'd', role: 'v6bundle', address: '0xb2' },
];

test('selectBackupWallets with no filter returns the whole list unchanged', () => {
  assert.deepEqual(selectBackupWallets(V6_WALLETS, {}), V6_WALLETS);
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { walletIds: [] }), V6_WALLETS, 'an empty id array is not a filter');
});

test('selectBackupWallets walletIds keeps exactly the named wallets', () => {
  assert.deepEqual(
    selectBackupWallets(V6_WALLETS, { walletIds: ['c', 'd'] }).map((w) => w.id),
    ['c', 'd']
  );
});

test('selectBackupWallets walletIds coerces ids to strings and ignores ids V6 does not own', () => {
  assert.deepEqual(
    selectBackupWallets([{ id: '5', role: 'v6bundle' }], { walletIds: [5] }).map((w) => w.id),
    ['5'],
    'a numeric id matches its string id'
  );
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { walletIds: ['zzz'] }), [], 'an unknown id matches nothing');
});

test('selectBackupWallets role keeps only that V6 role', () => {
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { role: 'v6bundle' }).map((w) => w.id), ['c', 'd']);
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { role: 'v6dev' }).map((w) => w.id), ['a']);
});

test('selectBackupWallets role and walletIds combine as an intersection', () => {
  assert.deepEqual(
    selectBackupWallets(V6_WALLETS, { role: 'v6bundle', walletIds: ['c'] }).map((w) => w.id),
    ['c']
  );
});

test('selectBackupWallets ignores an unknown or foreign role (never widens the set)', () => {
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { role: 'nope' }), V6_WALLETS, 'an unknown role is not a filter');
  assert.deepEqual(selectBackupWallets(V6_WALLETS, { role: 'v7bundle' }), V6_WALLETS, "another tab's role is not V6's");
});
