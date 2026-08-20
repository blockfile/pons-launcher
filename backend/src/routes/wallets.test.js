'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mirrors routes/v4.test.js: both config.js and the store/keystore modules
// compute their file paths once, at first require, so these env vars must be
// set before requiring './wallets' (which pulls in '../config',
// '../wallets/keystore' and '../v4/store' transitively) or every other test
// in this process would be pointed at the real on-disk keystore instead of
// this throwaway temp one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallets-routes-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-wallets-route-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./wallets');
const { keystoreFor } = require('../wallets/keystore');
const { storeFor } = require('../v4/store');

// These are unit tests over the route module's own handlers, not an HTTP
// harness — the repo has no supertest dependency. The handler is pulled
// directly off the mounted router's own stack and called with fake req/res
// objects, against a real (temp-dir) keystore and campaign store —
// seasoned.available()/claim() read both for real, not through doubles.

function findRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
  // requireApiKey sits ahead of the handler in the route's own middleware
  // stack; the handler itself is always last.
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

// Seeds a v4seed wallet funded well past the 24h gate, via a real campaign in
// the v4 seasoning store. Mirrors the setup in v4.test.js's
// "GET /v4/seasoned returns the seed wallets aged past the gate" test.
function seedAgedWallet(ks, store, { userTag, campaignId }) {
  const [seed] = ks.generate(1, { role: 'v4seed', label: `seed-${userTag}` });
  const sentAt = new Date(Date.now() - 3 * 24 * 3600_000).toISOString(); // 3 days ago
  store.create({
    id: campaignId,
    name: `season ${userTag}`,
    status: 'complete',
    kind: 'season',
    masterWalletId: 'm1',
    seed: 'x',
    params: {},
    transfers: [
      {
        id: `t-${campaignId}`,
        walletId: seed.id,
        address: seed.address,
        amountEth: '0.004',
        status: 'sent',
        sentAt,
        attempts: [],
      },
    ],
    createdAt: sentAt,
  });
  return seed;
}

test('POST /wallets/claim-seasoned claims the aged seeds into v1 bundle and reports the shortfall', async () => {
  const userId = 'claim-seasoned-1';
  const ks = keystoreFor(userId);
  const store = storeFor(userId);

  const seed1 = seedAgedWallet(ks, store, { userTag: 'a', campaignId: 'c1' });
  const seed2 = seedAgedWallet(ks, store, { userTag: 'b', campaignId: 'c2' });

  const handler = findRouteHandler('post', '/wallets/claim-seasoned');
  const req = { user: { id: userId }, body: { count: 5 } };
  const res = fakeRes();
  await handler(req, res, (err) => {
    if (err) throw err;
  });

  assert.equal(res.body.claimed.length, 2);
  assert.equal(res.body.available, 2);
  assert.equal(res.body.shortfall, 3);

  const claimedAddresses = res.body.claimed.map((w) => w.address).sort();
  assert.deepEqual(claimedAddresses, [seed1.address, seed2.address].sort());

  const bundleWallets = keystoreFor(userId).walletsWithRole('bundle');
  const bundleAddresses = bundleWallets.map((w) => w.address).sort();
  assert.deepEqual(bundleAddresses, [seed1.address, seed2.address].sort());
});

test('POST /wallets/claim-seasoned refuses when the bundle role is already at the 31-wallet cap', async () => {
  const userId = 'claim-seasoned-2';
  const ks = keystoreFor(userId);
  const store = storeFor(userId);

  // Put the bundle role at the cap first.
  ks.generate(31, { label: 'bundle', role: 'bundle' });

  // At least one aged seed available to claim.
  seedAgedWallet(ks, store, { userTag: 'cap', campaignId: 'c1' });

  const handler = findRouteHandler('post', '/wallets/claim-seasoned');
  const req = { user: { id: userId }, body: { count: 1 } };
  const res = fakeRes();
  let caught = null;
  await handler(req, res, (err) => {
    caught = err;
  });

  assert.ok(caught, 'expected the route to pass an error to next()');
  // The exact wording assertBundleRoom produces (routes/wallets.js).
  assert.match(caught.message, /a launch exempts at most 31 bundle wallets/);

  // Refused BEFORE any re-role: the seed wallet must still be a v4seed, not bundle.
  assert.equal(ks.walletsWithRole('bundle').length, 31);
});

test('POST /wallets/claim-seasoned answers cleanly when nothing is available to claim', async () => {
  const userId = 'claim-seasoned-3';
  const ks = keystoreFor(userId);
  const store = storeFor(userId);

  // A seed wallet that exists but is not aged past the gate — still counts as
  // "nothing available", not a claimable one.
  const [young] = ks.generate(1, { role: 'v4seed', label: 'young' });
  const sentAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
  store.create({
    id: 'c1',
    name: 'season young',
    status: 'running',
    kind: 'season',
    masterWalletId: 'm1',
    seed: 'x',
    params: {},
    transfers: [
      {
        id: 't1',
        walletId: young.id,
        address: young.address,
        amountEth: '0.004',
        status: 'sent',
        sentAt,
        attempts: [],
      },
    ],
    createdAt: sentAt,
  });

  const handler = findRouteHandler('post', '/wallets/claim-seasoned');
  const req = { user: { id: userId }, body: { count: 3 } };
  const res = fakeRes();
  await handler(req, res, (err) => {
    if (err) throw err;
  });

  assert.deepEqual(res.body.claimed, []);
  assert.equal(res.body.available, 0);
  assert.equal(res.body.shortfall, 3);

  // Nothing was re-roled: no bundle wallets exist, and the seed is still a seed.
  assert.equal(ks.walletsWithRole('bundle').length, 0);
  assert.equal(ks.walletsWithRole('v4seed').length, 1);
});
