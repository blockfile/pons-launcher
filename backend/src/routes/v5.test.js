'use strict';

// POST /v5/wallets/backup — the v5-scoped key export. The properties that matter:
// it refuses without an explicit confirm, it exports V5's OWN roles ONLY (never
// another tab's keys), and an explicit walletIds set narrows the file to exactly
// those wallets — a per-section export that still cannot reach a non-v5 wallet
// because the v5-role filter runs first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway keystore, so the backup handler can export real, decryptable keys
// without touching the operator's on-disk one. config.js and wallets/keystore.js
// each compute their file paths once, at first require, so these env vars must be
// set BEFORE requiring './v5' (which pulls in '../config' and '../wallets/keystore'
// transitively) or the whole process would be pointed at the real keystore.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-routes-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-v5-route-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./v5');
const { keystoreFor } = require('../wallets/keystore');

// The repo has no supertest dependency; these pull the handler straight off the
// mounted router's own stack and call it with fake req/res against a real
// (temp-dir) keystore — the same seam v4.test.js uses. requireApiKey and
// requireAuthConfigured sit ahead of the handler in the route's middleware stack;
// the handler itself is always last, so grabbing the last entry runs the handler
// alone (the two guards are exercised by the middleware's own tests).
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

// Run the handler and hand back { res, err } — err is whatever it passed to next().
async function invoke(handler, req) {
  const res = fakeRes();
  let err;
  await handler(req, res, (e) => {
    err = e;
  });
  return { res, err };
}

test('POST /v5/wallets/backup requires an explicit confirm', async () => {
  const handler = findRouteHandler('post', '/v5/wallets/backup');
  const { res, err } = await invoke(handler, { user: { id: 'v5-backup-confirm' }, body: {} });
  assert.ok(err, 'a backup without confirm must fail');
  assert.match(err.message, /confirm/);
  assert.equal(res.body, undefined, 'no keys are written when confirm is missing');
});

test("POST /v5/wallets/backup exports V5 keys only, never another tab's", async () => {
  const userId = 'v5-backup-scope';
  const ks = keystoreFor(userId);
  const [dev] = ks.generate(1, { role: 'v5dev', label: 'launcher' });
  const bundle = ks.generate(2, { role: 'v5bundle', label: 'bundle' });
  // Foreign wallets that must NEVER appear in a v5 backup.
  const v1 = ks.generate(1, { role: 'bundle', label: 'v1' });
  const v3 = ks.generate(1, { role: 'v3bundle', label: 'v3' });

  const handler = findRouteHandler('post', '/v5/wallets/backup');
  const { res, err } = await invoke(handler, { user: { id: userId }, body: { confirm: true } });
  assert.ifError(err);

  const ids = res.body.wallets.map((w) => w.id).sort();
  assert.deepEqual(ids, [dev.id, ...bundle.map((w) => w.id)].sort());
  assert.equal(res.body.count, 3);
  assert.equal(res.body.selected, null, 'a full backup reports no selection');

  // The foreign keys are absent, and every exported wallet carries a real,
  // decryptable private key (an export that omitted the keys would be useless).
  const exported = new Set(res.body.wallets.map((w) => w.id));
  assert.equal(exported.has(v1[0].id), false, 'a v1 wallet is never in a v5 backup');
  assert.equal(exported.has(v3[0].id), false, 'a v3 wallet is never in a v5 backup');
  for (const w of res.body.wallets) assert.match(w.privateKey, /^0x[0-9a-fA-F]{64}$/);
});

test('POST /v5/wallets/backup honors an explicit walletIds subset', async () => {
  const userId = 'v5-backup-subset';
  const ks = keystoreFor(userId);
  const [dev] = ks.generate(1, { role: 'v5dev', label: 'launcher' });
  const bundle = ks.generate(3, { role: 'v5bundle', label: 'bundle' });

  const handler = findRouteHandler('post', '/v5/wallets/backup');
  const { res, err } = await invoke(handler, {
    user: { id: userId },
    body: { confirm: true, walletIds: [bundle[0].id, bundle[2].id] },
  });
  assert.ifError(err);

  // Exactly the two NAMED bundle wallets — the un-named one and the launcher (never
  // named) are both left out. This is what makes "Export selected" export only the
  // ticked rows.
  const ids = res.body.wallets.map((w) => w.id).sort();
  assert.deepEqual(ids, [bundle[0].id, bundle[2].id].sort());
  assert.equal(res.body.wallets.some((w) => w.id === bundle[1].id), false);
  assert.equal(res.body.wallets.some((w) => w.id === dev.id), false);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.selected, 2, 'a subset export reports how many were selected');
});

test('POST /v5/wallets/backup with walletIds can never reach a non-v5 wallet', async () => {
  const userId = 'v5-backup-subset-foreign';
  const ks = keystoreFor(userId);
  const bundle = ks.generate(1, { role: 'v5bundle', label: 'bundle' });
  const v4 = ks.generate(1, { role: 'v4seed', label: 'v4' });

  const handler = findRouteHandler('post', '/v5/wallets/backup');
  // Asked DIRECTLY for a v4 wallet's id: the v5-role filter runs first, so the
  // requested set intersects nothing and the file is empty.
  const foreign = await invoke(handler, {
    user: { id: userId },
    body: { confirm: true, walletIds: [v4[0].id] },
  });
  assert.ifError(foreign.err);
  assert.equal(foreign.res.body.count, 0);
  assert.deepEqual(foreign.res.body.wallets, []);

  // And the v5 wallet is reachable when it is the one named.
  const own = await invoke(handler, {
    user: { id: userId },
    body: { confirm: true, walletIds: [bundle[0].id] },
  });
  assert.ifError(own.err);
  assert.equal(own.res.body.count, 1);
  assert.equal(own.res.body.wallets[0].id, bundle[0].id);
});
