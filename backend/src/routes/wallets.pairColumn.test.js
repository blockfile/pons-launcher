'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Same reason as routes/wallets.test.js: config.js and the keystore compute
// their paths once at first require, so these must be set before './wallets'
// is pulled in or this suite would point at the real on-disk keystore.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallets-paircol-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-pair-column-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./wallets');
const funding = require('../wallets/funding');
const pairQuote = require('../bundle/pairQuote');

const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const NATIVE = '0x0000000000000000000000000000000000000000';

function findRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

/**
 * Swap the two collaborators the listing handler reaches for and record what it
 * asked them. Restores both, so the suites sharing this process are unaffected.
 */
function spy({ approved = null, approvedThrows = null } = {}) {
  const realBalances = funding.balances;
  const realApproved = pairQuote.approvedPair;
  const calls = { balances: [], approvedPair: [] };

  funding.balances = async (opts) => {
    calls.balances.push(opts);
    return [{ id: 'b1', role: 'bundle', address: '0x22', balanceEth: '0.03' }];
  };
  pairQuote.approvedPair = async (token) => {
    calls.approvedPair.push(token);
    if (approvedThrows) throw new Error(approvedThrows);
    return approved;
  };

  return {
    calls,
    restore() {
      funding.balances = realBalances;
      pairQuote.approvedPair = realApproved;
    },
  };
}

const listing = findRouteHandler('get', '/wallets');
const req = (query = {}) => ({ user: { id: 'default' }, query });

test('a listing with no pairToken resolves nothing and asks for no pair', async () => {
  const s = spy();
  try {
    const res = fakeRes();
    await listing(req(), res, (e) => assert.fail(e));
    assert.equal(s.calls.approvedPair.length, 0, 'no approval read on a native launch');
    assert.equal(s.calls.balances[0].pair, null);
  } finally {
    s.restore();
  }
});

test('the native sentinel is treated as "no pair", not as an address to look up', async () => {
  // The console's picker sends address(0) as a real value rather than omitting
  // the parameter, so this is the path a native launch actually takes.
  const s = spy();
  try {
    await listing(req({ pairToken: NATIVE }), fakeRes(), (e) => assert.fail(e));
    assert.equal(s.calls.approvedPair.length, 0);
    assert.equal(s.calls.balances[0].pair, null);
  } finally {
    s.restore();
  }
});

test('an approved pair is resolved once and handed to the listing', async () => {
  const s = spy({ approved: { address: NVDA, symbol: 'NVDA', decimals: 18 } });
  try {
    await listing(req({ pairToken: NVDA }), fakeRes(), (e) => assert.fail(e));
    assert.deepEqual(s.calls.approvedPair, [NVDA]);
    assert.deepEqual(s.calls.balances[0].pair, { address: NVDA, symbol: 'NVDA', decimals: 18 });
  } finally {
    s.restore();
  }
});

test('a pair the factory does not approve is IGNORED, and the listing still answers', async () => {
  // A listing the whole console depends on must not 400 because the picker is
  // momentarily out of step with the factory.
  const s = spy({ approvedThrows: 'not an approved pair token right now' });
  try {
    const res = fakeRes();
    await listing(req({ pairToken: '0xdead' }), res, (e) => assert.fail(e));
    assert.equal(s.calls.balances[0].pair, null);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, 1);
  } finally {
    s.restore();
  }
});

test('the two read-only pricing routes exist as GETs and take no launch lock', () => {
  // withLaunchLock wraps a handler; these two are registered bare, which is what
  // keeps "price this" from answering "a launch is already in progress".
  for (const p of ['/wallets/pair-quote', '/wallets/pair-from-balance']) {
    const layer = router.stack.find((l) => l.route && l.route.path === p);
    assert.ok(layer, `no route for ${p}`);
    assert.ok(layer.route.methods.get, `${p} must be a GET — it reads and nothing else`);
    assert.ok(!layer.route.methods.post, `${p} must not accept a POST`);
  }
});
