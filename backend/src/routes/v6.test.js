'use strict';

const test = require('node:test');
const assert = require('node:assert');
const routes = require('./v6');

const { feasibilityOf } = routes._private;

const RUN = {
  token: '0x1111111111111111111111111111111111111111',
  pool: { poolKey: {}, poolId: '0xpid', hook: '0xhook' },
  bigBuyWei: 1_000_000n,
  targets: [{ walletId: 'a', address: '0x2222222222222222222222222222222222222222' }],
};

// A reverting SELL quote is the exit-side honeypot signal: the token buys but cannot be
// sold, so feasibilityOf must FAIL the run (not crash) and carry the selector through.
test('feasibilityOf flags a reverting sell quote as sells-revert, not a crash', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: async () => {
      const e = new Error('execution reverted (unknown custom error)');
      e.data = '0x6190b2b0000000';
      throw e;
    },
  };
  const feas = await feasibilityOf(RUN, { trade });
  assert.equal(feas.sellsRevert, true);
  assert.equal(feas.reason, 'sells-revert');
  assert.equal(feas.feasible, false);
  assert.equal(feas.sellError, '0x6190b2b0', 'the 4-byte selector is surfaced');
  assert.equal(feas.positionWei, 0n, 'a token that cannot be sold is worth 0 to this run');
});

test('feasibilityOf reads the selector from an ethers info.error.data shape too', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: async () => {
      const e = new Error('execution reverted');
      e.info = { error: { data: '0xdeadbeef11' } };
      throw e;
    },
  };
  const feas = await feasibilityOf(RUN, { trade });
  assert.equal(feas.sellsRevert, true);
  assert.equal(feas.sellError, '0xdeadbeef');
});

test('a sellable token is priced normally (sells-revert false)', async () => {
  const trade = {
    quoteBuyOut: async () => 500n,
    quoteSellOut: async () => 900_000n, // sells fine → a real position value
  };
  const feas = await feasibilityOf(RUN, {
    trade,
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
  });
  assert.equal(feas.sellsRevert, false);
  assert.notEqual(feas.reason, 'sells-revert');
  assert.equal(feas.positionWei, 900_000n);
});
