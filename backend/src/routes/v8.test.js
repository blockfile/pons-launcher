'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');

// Mirrors routes/wallets.test.js: config.js and the keystore/store modules compute their
// file paths once, at first require, so these env vars must be set BEFORE requiring
// './v8' — otherwise this test would be pointed at the real on-disk keystore.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-routes-'));
process.env.KEYSTORE_PATH = path.join(tmpDir, 'v8.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-v8-route-tests';
process.env.HISTORY_PATH = path.join(tmpDir, 'launches.json');
process.env.V4_STORE_PATH = path.join(tmpDir, 'v4.json');

const router = require('./v8');
const { keystoreFor } = require('../wallets/keystore');
const { storeFor } = require('../v4/store');

// Unit tests over the route module's own handlers — the repo has no HTTP harness. The
// handler is pulled off the mounted router's stack and called with fake req/res/next,
// against a real (temp-dir) keystore.
function handlerFor(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
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

/** Call a handler and return { res, err } — errors go to next(), as express expects. */
async function call(handler, req) {
  const res = fakeRes();
  let err = null;
  await handler({ params: {}, body: {}, ...req }, res, (e) => {
    err = e;
  });
  return { res, err };
}

let userSeq = 0;
function freshUser() {
  userSeq += 1;
  return `v8user${userSeq}`;
}

const keys = (n) => Array.from({ length: n }, () => Wallet.createRandom().privateKey);

// ── the no-cap property, end to end ─────────────────────────────────────────

test('NO CAP: importing 55 v8bundle wallets in one call succeeds', async () => {
  const user = freshUser();
  const { res, err } = await call(handlerFor('post', '/v8/wallets/import'), {
    user: { id: user },
    body: { privateKeys: keys(55), role: 'v8bundle', label: 'fan' },
  });
  assert.equal(err, null);
  assert.equal(res.body.length, 55);
  assert.equal(keystoreFor(user).walletsWithRole('v8bundle').length, 55);
});

test('NO CAP: repeated imports accumulate past 31 — the launch limit does not apply here', async () => {
  const user = freshUser();
  const handler = handlerFor('post', '/v8/wallets/import');
  for (let i = 0; i < 3; i += 1) {
    const { err } = await call(handler, { user: { id: user }, body: { privateKeys: keys(20), role: 'v8bundle' } });
    assert.equal(err, null, `import round ${i + 1} was refused`);
  }
  assert.equal(keystoreFor(user).walletsWithRole('v8bundle').length, 60);
});

test('NO CAP: generating bundle wallets is not bounded by a total either', async () => {
  const user = freshUser();
  const handler = handlerFor('post', '/v8/wallets/generate');
  await call(handler, { user: { id: user }, body: { count: 40, role: 'v8bundle' } });
  const { err } = await call(handler, { user: { id: user }, body: { count: 40, role: 'v8bundle' } });
  assert.equal(err, null);
  assert.equal(keystoreFor(user).walletsWithRole('v8bundle').length, 80);
});

// ── role gating ─────────────────────────────────────────────────────────────

test('generate and import refuse any role this tab does not own', async () => {
  const user = freshUser();
  for (const role of ['v3bundle', 'v7bundle', 'bundle', 'v4seed', undefined, 'v8']) {
    const g = await call(handlerFor('post', '/v8/wallets/generate'), {
      user: { id: user },
      body: { count: 1, role },
    });
    assert.match(g.err.message, /role must be one of v8main, v8bundle/);
    const i = await call(handlerFor('post', '/v8/wallets/import'), {
      user: { id: user },
      body: { privateKeys: keys(1), role },
    });
    assert.match(i.err.message, /role must be one of v8main, v8bundle/);
  }
});

test('the main wallet is a singleton — a second one is refused by the keystore', async () => {
  const user = freshUser();
  const handler = handlerFor('post', '/v8/wallets/generate');
  const first = await call(handler, { user: { id: user }, body: { count: 1, role: 'v8main' } });
  assert.equal(first.err, null);
  const second = await call(handler, { user: { id: user }, body: { count: 1, role: 'v8main' } });
  assert.ok(second.err, 'a second v8main must not be creatable');
  assert.equal(keystoreFor(user).walletsWithRole('v8main').length, 1);
});

test('generate bounds one REQUEST, not the tab', async () => {
  const user = freshUser();
  const handler = handlerFor('post', '/v8/wallets/generate');
  for (const count of [0, -1, 1.5, 101, 'lots']) {
    const { err } = await call(handler, { user: { id: user }, body: { count, role: 'v8bundle' } });
    assert.match(err.message, /count must be between 1 and 100/);
  }
});

// ── delete ──────────────────────────────────────────────────────────────────

test('delete removes a v8 wallet and answers { deleted: true }', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  const [w] = ks.generate(1, { role: 'v8bundle' });
  const { res, err } = await call(handlerFor('delete', '/v8/wallets/:id'), {
    user: { id: user },
    params: { id: w.id },
  });
  assert.equal(err, null);
  assert.deepEqual(res.body, { deleted: true });
  assert.equal(ks.list().some((x) => x.id === w.id), false);
});

test('delete refuses another tab’s wallet and an id that does not exist', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  const [other] = ks.generate(1, { role: 'v3bundle' });
  const handler = handlerFor('delete', '/v8/wallets/:id');

  const foreign = await call(handler, { user: { id: user }, params: { id: other.id } });
  assert.match(foreign.err.message, /is not a v8 wallet — delete it from its own tab/);
  assert.ok(ks.list().some((x) => x.id === other.id), 'the other tab’s wallet is still there');

  const missing = await call(handler, { user: { id: user }, params: { id: 'nope' } });
  assert.match(missing.err.message, /no wallet nope/);
});

// ── backup ──────────────────────────────────────────────────────────────────

test('backup requires confirm, and returns the documented shape', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  ks.generate(1, { role: 'v8main' });
  ks.generate(3, { role: 'v8bundle' });
  const handler = handlerFor('post', '/v8/wallets/backup');

  const unconfirmed = await call(handler, { user: { id: user }, body: {} });
  assert.match(unconfirmed.err.message, /requires \{ confirm: true \}/);

  const { res, err } = await call(handler, { user: { id: user }, body: { confirm: true } });
  assert.equal(err, null);
  for (const key of ['exportedAt', 'chainId', 'count', 'note', 'warning', 'wallets']) {
    assert.ok(key in res.body, `backup response is missing ${key}`);
  }
  assert.equal(res.body.count, 4);
  assert.equal(res.body.wallets.length, 4);
  assert.ok(res.body.wallets.every((w) => w.privateKey), 'a backup carries the keys');
});

test('backup NEVER returns another tab’s wallets, whatever is asked for', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  ks.generate(2, { role: 'v8bundle' });
  const [v3] = ks.generate(1, { role: 'v3bundle' });
  const [v7] = ks.generate(1, { role: 'v7bundle' });
  const handler = handlerFor('post', '/v8/wallets/backup');

  const all = await call(handler, { user: { id: user }, body: { confirm: true } });
  assert.equal(all.res.body.count, 2, 'only the v8 wallets');
  const ids = all.res.body.wallets.map((w) => w.id);
  assert.equal(ids.includes(v3.id), false);
  assert.equal(ids.includes(v7.id), false);

  // walletIds can only ever NARROW — naming another tab's wallet exports nothing extra.
  const widened = await call(handler, {
    user: { id: user },
    body: { confirm: true, walletIds: [v3.id, v7.id] },
  });
  assert.equal(widened.res.body.count, 0);
});

test('backup narrows by walletIds and by role', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  const [main] = ks.generate(1, { role: 'v8main' });
  const bundle = ks.generate(3, { role: 'v8bundle' });
  const handler = handlerFor('post', '/v8/wallets/backup');

  const byRole = await call(handler, { user: { id: user }, body: { confirm: true, role: 'v8bundle' } });
  assert.equal(byRole.res.body.count, 3);
  assert.match(byRole.res.body.note, /Partial V8 export/);

  const byId = await call(handler, {
    user: { id: user },
    body: { confirm: true, walletIds: [bundle[0].id, main.id] },
  });
  assert.equal(byId.res.body.count, 2);

  const badRole = await call(handler, { user: { id: user }, body: { confirm: true, role: 'v3bundle' } });
  assert.match(badRole.err.message, /role must be one of v8main, v8bundle/);
});

// ── transfer + sweep guards ─────────────────────────────────────────────────

test('POST /v8/transfer refuses a target that is not a v8bundle wallet, before any network call', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  ks.generate(1, { role: 'v8main' });
  const [mine] = ks.generate(1, { role: 'v8bundle' });
  const [foreign] = ks.generate(1, { role: 'v3bundle' });

  const handler = handlerFor('post', '/v8/transfer');
  const ghost = await call(handler, {
    user: { id: user },
    body: { targets: [{ walletId: mine.id, amountEth: '0.01' }, { walletId: foreign.id, amountEth: '0.01' }] },
  });
  assert.match(ghost.err.message, /is not a v8bundle wallet/);

  const empty = await call(handler, { user: { id: user }, body: { targets: [] } });
  assert.match(empty.err.message, /targets\[\] is required/);
});

test('POST /v8/transfer names the missing main wallet rather than failing obscurely', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  const [b] = ks.generate(1, { role: 'v8bundle' });
  const { err } = await call(handlerFor('post', '/v8/transfer'), {
    user: { id: user },
    body: { targets: [{ walletId: b.id, amountEth: '0.01' }] },
  });
  assert.match(err.message, /no v8main wallet/);
});

test('POST /v8/sweep requires confirm', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  ks.generate(1, { role: 'v8main' });
  const { err } = await call(handlerFor('post', '/v8/sweep'), { user: { id: user }, body: {} });
  assert.match(err.message, /requires \{ confirm: true \}/);
});

test('the timed endpoints report an idle job before anything is started', async () => {
  const user = freshUser();
  const { res, err } = await call(handlerFor('get', '/v8/transfer/timed'), { user: { id: user } });
  assert.equal(err, null);
  assert.equal(res.body.status, 'idle');
  assert.equal(res.body.running, false);

  const resumed = await call(handlerFor('post', '/v8/transfer/timed/resume'), { user: { id: user } });
  assert.match(resumed.err.message, /no v8 timed transfer job to resume/);
});

// ── claim-seasoned ──────────────────────────────────────────────────────────

test('claim-seasoned re-roles aged v4 seeds into v8bundle and records the tab', async () => {
  const user = freshUser();
  const ks = keystoreFor(user);
  const store = storeFor(user);

  // A real seasoning campaign, three days old — seasoned.available() reads it for real.
  const seeds = ks.generate(2, { role: 'v4seed', label: 'seed' });
  const sentAt = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
  store.create({
    id: 'c1',
    name: 'season',
    status: 'complete',
    kind: 'season',
    masterWalletId: 'm1',
    seed: 'x',
    params: {},
    transfers: seeds.map((s, i) => ({
      id: `t${i}`,
      walletId: s.id,
      address: s.address,
      amountEth: '0.004',
      status: 'sent',
      sentAt,
      attempts: [],
    })),
    createdAt: sentAt,
  });

  const { res, err } = await call(handlerFor('post', '/v8/wallets/claim-seasoned'), {
    user: { id: user },
    body: { count: 2 },
  });
  assert.equal(err, null);
  assert.equal(res.body.claimed.length, 2);
  assert.equal(ks.walletsWithRole('v8bundle').length, 2);
  assert.equal(ks.walletsWithRole('v4seed').length, 0);
  assert.ok(
    store.graduated().every((g) => g.toTab === 'v8'),
    'the hand-off record says which tab took them'
  );
});

test('claim-seasoned with an empty pool answers the shortfall instead of throwing', async () => {
  const user = freshUser();
  const { res, err } = await call(handlerFor('post', '/v8/wallets/claim-seasoned'), {
    user: { id: user },
    body: { count: 5 },
  });
  assert.equal(err, null);
  assert.deepEqual(res.body, { claimed: [], available: 0, shortfall: 5 });
});
