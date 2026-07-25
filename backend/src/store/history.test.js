'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-history-'));
process.env.HISTORY_PATH = path.join(dir, 'launches.json');

const { historyFor } = require('./history');

// A minimal but shape-accurate plan/result, covering everything record() reads.
function fakePlanAndResult() {
  const plan = {
    dryRun: true,
    token: '0xTokenAddress',
    salt: '0xsalt',
    params: { name: 'X', symbol: 'X' },
    launchConfigId: 0,
    dexId: 0,
    launch: { devBuyEth: '0.01' },
    totalBuyEth: '0.05',
  };
  const result = {
    launch: { hash: '0xlaunchhash' },
    buys: [{ hash: '0xbuyhash' }],
    sameBlock: 1,
  };
  return { plan, result };
}

test('one user cannot read another user history', () => {
  const alice = historyFor('alice');
  const bob = historyFor('bob');

  const { plan, result } = fakePlanAndResult();
  alice.record({ plan, result });

  assert.equal(bob.list().length, 0, "bob must not see alice's launches");

  const aliceList = alice.list();
  assert.equal(aliceList.length, 1);
  assert.equal(aliceList[0].token, plan.token);
  assert.equal(aliceList[0].totalBuyEth, plan.totalBuyEth);
});
