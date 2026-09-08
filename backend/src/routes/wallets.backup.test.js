'use strict';

// POST /api/wallets/backup — the v1/v2-scoped key export.
//
// This route used to answer with `ks.exportAll()`: every private key in the
// keystore, from a button beside the v1/v2 bundle. A backup taken to move one
// bundle carried the operator's V3, V4, V5, V6, V7 and V8 keys as well. The
// properties these tests pin are the ones that made that a security bug rather
// than a UX one:
//
//   * a backup covers ONE launcher's own two roles and nothing else — a v1
//     request never carries v2's keys, and neither ever carries another tab's;
//   * `role` narrows to one tier (the bundle wallets, or the dev wallet);
//   * `walletIds` narrows to exactly the rows named, and cannot reach past the
//     tab's floor even when a foreign id is passed on purpose;
//   * the two locks are still on the route, and an unconfirmed request is still
//     refused before any key is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway keystore, so the backup handler can export real, decryptable keys
// without touching the operator's on-disk one. config.js and wallets/keystore.js
// each compute their file paths once, at first require, so these env vars must be
// set BEFORE requiring './wallets' or the whole process would be pointed at the
// real keystore. Mirrors routes/v5.test.js.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallets-backup-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-wallets-backup-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');

const router = require('./wallets');
const { keystoreFor } = require('../wallets/keystore');
const { requireApiKey, requireAuthConfigured } = require('../middleware/auth');

const ROUTE = '/wallets/backup';

// The repo has no supertest dependency; these pull the handler straight off the
// mounted router's own stack and call it with fake req/res against a real
// (temp-dir) keystore — the same seam v4/v5's route tests use.
function layerFor(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
  return layer;
}

function findRouteHandler(method, routePath) {
  const layer = layerFor(method, routePath);
  // The guards sit ahead of the handler in the route's own middleware stack; the
  // handler itself is always last, so this runs the handler alone (the guards are
  // exercised by the middleware's own tests, and by the stack test below).
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
async function invoke(req) {
  const handler = findRouteHandler('post', ROUTE);
  const res = fakeRes();
  let err;
  await handler(req, res, (e) => {
    err = e;
  });
  return { res, err };
}

// One keystore per test, seeded with BOTH launchers and a wallet from every other
// tab — so "never another tab's keys" is asserted against wallets that really exist
// beside the ones being exported, not against an empty keystore.
function seed(userId) {
  const ks = keystoreFor(userId);
  const [dev] = ks.generate(1, { role: 'dev', label: 'v1-dev' });
  const bundle = ks.generate(3, { role: 'bundle', label: 'v1-bundle' });
  const [v2dev] = ks.generate(1, { role: 'v2dev', label: 'v2-dev' });
  const v2bundle = ks.generate(2, { role: 'v2bundle', label: 'v2-bundle' });
  const foreign = [
    ks.generate(1, { role: 'v3bundle', label: 'v3' })[0],
    ks.generate(1, { role: 'v4seed', label: 'v4' })[0],
    ks.generate(1, { role: 'v5bundle', label: 'v5' })[0],
    ks.generate(1, { role: 'v6bundle', label: 'v6' })[0],
    ks.generate(1, { role: 'v7bundle', label: 'v7' })[0],
    ks.generate(1, { role: 'v8bundle', label: 'v8' })[0],
  ];
  return { ks, dev, bundle, v2dev, v2bundle, foreign };
}

const idsOf = (res) => res.body.wallets.map((w) => w.id).sort();

test('POST /wallets/backup is still behind the API key AND a configured credential', () => {
  // Both guards, in that order, ahead of the handler. This is the route that puts
  // PLAINTEXT PRIVATE KEYS on the wire: requireAuthConfigured is what stops a
  // keyless deployment from serving them, and dropping either is silent.
  const stack = layerFor('post', ROUTE).route.stack.map((l) => l.handle);
  assert.equal(stack.length, 3, 'two guards plus the handler');
  assert.equal(stack[0], requireApiKey);
  assert.equal(stack[1], requireAuthConfigured);
});

test('POST /wallets/backup requires an explicit confirm', async () => {
  const { res, err } = await invoke({ user: { id: 'backup-confirm' }, body: {} });
  assert.ok(err, 'a backup without confirm must fail');
  assert.match(err.message, /confirm/);
  assert.equal(res.body, undefined, 'no keys are written when confirm is missing');
});

test('POST /wallets/backup refuses a confirm that is merely truthy', async () => {
  const { res, err } = await invoke({ user: { id: 'backup-confirm-truthy' }, body: { confirm: 'yes' } });
  assert.ok(err, 'only confirm === true opens this route');
  assert.equal(res.body, undefined);
});

test("POST /wallets/backup exports V1's own wallets only — never v2's, never another tab's", async () => {
  const userId = 'backup-v1-scope';
  const { dev, bundle, v2dev, v2bundle, foreign } = seed(userId);

  const { res, err } = await invoke({ user: { id: userId }, body: { confirm: true, variant: 'v1' } });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), [dev.id, ...bundle.map((w) => w.id)].sort());
  assert.equal(res.body.count, 4);
  assert.equal(res.body.variant, 'v1');
  assert.equal(res.body.scope, 'all');

  const exported = new Set(res.body.wallets.map((w) => w.id));
  assert.equal(exported.has(v2dev.id), false, "v2's dev wallet is never in a v1 backup");
  for (const w of v2bundle) assert.equal(exported.has(w.id), false, "v2's bundle is never in a v1 backup");
  for (const w of foreign) assert.equal(exported.has(w.id), false, `${w.role} is never in a v1 backup`);

  // An export with no usable keys in it would be worse than no export at all.
  for (const w of res.body.wallets) assert.match(w.privateKey, /^0x[0-9a-fA-F]{64}$/);
});

test("POST /wallets/backup exports V2's own wallets only — never v1's", async () => {
  const userId = 'backup-v2-scope';
  const { dev, bundle, v2dev, v2bundle, foreign } = seed(userId);

  const { res, err } = await invoke({ user: { id: userId }, body: { confirm: true, variant: 'v2' } });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), [v2dev.id, ...v2bundle.map((w) => w.id)].sort());
  assert.equal(res.body.count, 3);
  assert.equal(res.body.variant, 'v2');

  const exported = new Set(res.body.wallets.map((w) => w.id));
  assert.equal(exported.has(dev.id), false, "v1's dev wallet is never in a v2 backup");
  for (const w of bundle) assert.equal(exported.has(w.id), false, "v1's bundle is never in a v2 backup");
  for (const w of foreign) assert.equal(exported.has(w.id), false, `${w.role} is never in a v2 backup`);
});

test('POST /wallets/backup with no variant is v1, not the whole keystore', async () => {
  // The pre-scoping body shape. It must not resolve to "everything" — that is the
  // bug this route was fixed for.
  const userId = 'backup-default-variant';
  const { dev, bundle, v2dev, foreign } = seed(userId);

  const { res, err } = await invoke({ user: { id: userId }, body: { confirm: true } });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), [dev.id, ...bundle.map((w) => w.id)].sort());
  const exported = new Set(res.body.wallets.map((w) => w.id));
  assert.equal(exported.has(v2dev.id), false);
  for (const w of foreign) assert.equal(exported.has(w.id), false);
});

test("POST /wallets/backup with role exports ONE tier — the bundle without the dev wallet", async () => {
  const userId = 'backup-role-bundle';
  const { dev, bundle } = seed(userId);

  const { res, err } = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', role: 'bundle' },
  });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), bundle.map((w) => w.id).sort());
  assert.equal(res.body.count, 3);
  assert.equal(res.body.scope, 'bundle');
  assert.equal(
    res.body.wallets.some((w) => w.id === dev.id),
    false,
    'the dev wallet is not in a bundle-only export'
  );
});

test('POST /wallets/backup with role exports ONE tier — the dev wallet alone', async () => {
  const userId = 'backup-role-dev';
  const { dev, bundle } = seed(userId);

  const { res, err } = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', role: 'dev' },
  });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), [dev.id]);
  assert.equal(res.body.count, 1);
  const exported = new Set(res.body.wallets.map((w) => w.id));
  for (const w of bundle) assert.equal(exported.has(w.id), false, 'no bundle key in a dev-only export');
});

test("POST /wallets/backup refuses a role the named variant does not own", async () => {
  const userId = 'backup-role-foreign';
  seed(userId);

  // v2's own bundle role, asked for on a v1 backup: refused outright rather than
  // quietly answered with an empty (or worse, a v2) file.
  const cross = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', role: 'v2bundle' },
  });
  assert.ok(cross.err);
  assert.match(cross.err.message, /role must be one of/);
  assert.equal(cross.res.body, undefined);

  // Another tab's role, likewise.
  const foreign = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', role: 'v4seed' },
  });
  assert.ok(foreign.err);
  assert.equal(foreign.res.body, undefined);
});

test('POST /wallets/backup refuses a variant that is not v1 or v2', async () => {
  const userId = 'backup-variant-foreign';
  seed(userId);

  for (const variant of ['v5', 'v4', 'nonsense']) {
    const { res, err } = await invoke({ user: { id: userId }, body: { confirm: true, variant } });
    assert.ok(err, `${variant} must be refused — it has its own backup route`);
    assert.match(err.message, /variant must be one of/);
    assert.equal(res.body, undefined, `${variant} must write no keys`);
  }
});

test('POST /wallets/backup with walletIds exports exactly the rows named', async () => {
  const userId = 'backup-selected';
  const { dev, bundle } = seed(userId);

  const { res, err } = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', walletIds: [bundle[0].id, bundle[2].id] },
  });
  assert.ifError(err);

  assert.deepEqual(idsOf(res), [bundle[0].id, bundle[2].id].sort());
  assert.equal(res.body.count, 2);
  assert.equal(res.body.scope, 'selected');
  const exported = new Set(res.body.wallets.map((w) => w.id));
  assert.equal(exported.has(bundle[1].id), false, 'an un-ticked bundle wallet stays out');
  assert.equal(exported.has(dev.id), false, 'the dev wallet is never added to a selection');
});

test('POST /wallets/backup with walletIds can never reach past the tab, even when asked directly', async () => {
  const userId = 'backup-selected-foreign';
  const { bundle, v2bundle, foreign } = seed(userId);

  // Every foreign id in the keystore, named on purpose, alongside one real one.
  const { res, err } = await invoke({
    user: { id: userId },
    body: {
      confirm: true,
      variant: 'v1',
      walletIds: [bundle[0].id, v2bundle[0].id, ...foreign.map((w) => w.id)],
    },
  });
  assert.ifError(err);

  // The tab's floor runs first, so the foreign ids intersect nothing.
  assert.deepEqual(idsOf(res), [bundle[0].id]);
  assert.equal(res.body.count, 1);
});

test('POST /wallets/backup with an empty walletIds writes nothing, rather than everything', async () => {
  const userId = 'backup-selected-empty';
  seed(userId);

  const { res, err } = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', walletIds: [] },
  });
  assert.ifError(err);
  assert.equal(res.body.count, 0);
  assert.deepEqual(res.body.wallets, []);
});

test('POST /wallets/backup names its scope in the file itself', async () => {
  const userId = 'backup-note';
  const { bundle } = seed(userId);

  const whole = await invoke({ user: { id: userId }, body: { confirm: true, variant: 'v2' } });
  assert.ifError(whole.err);
  assert.match(whole.res.body.note, /Every V2 wallet/);
  assert.match(whole.res.body.warning, /V2's wallets only/);

  const picked = await invoke({
    user: { id: userId },
    body: { confirm: true, variant: 'v1', walletIds: [bundle[0].id] },
  });
  assert.ifError(picked.err);
  // A file opened months later has to say which button produced it: "1 of 4", not
  // a bare list of keys that looks identical to a whole-tab backup.
  assert.match(picked.res.body.note, /1 of 4/);
});
