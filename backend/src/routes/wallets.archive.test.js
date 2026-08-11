'use strict';

// The archive's HTTP surface, which is that it has none.
//
// Listing, restoring and purging archived wallets were three routes; they are
// `npm run archive:*` on the server now, and the point of the change is that an
// attacker holding the API key cannot reach the recovery path for the wallets
// they may just have deleted. A route that quietly came back — or a new one
// spelled slightly differently — would undo that silently, so this asserts on
// the router's own table rather than on a list of paths kept somewhere else.
//
// What DOES stay on the API is the delete, and with it the one thing in this
// change that destroys a key: past the cap, a delete evicts the oldest archived
// wallet. The activity line that records it is asserted here, because that line
// may be the only remaining evidence the key existed.
//
// No network and no listening socket: handlers are pulled off the router and
// called with plain objects, the way activity.admin.test.js does. Every file
// this touches is in a temp directory created below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-archive-routes-'));
// Set before config.js is first required — it reads process.env at load time.
// Nothing here may touch backend/data.
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
process.env.HISTORY_PATH = path.join(dir, 'launches.json');
process.env.USERS_PATH = path.join(dir, 'users.json');
process.env.KEYSTORE_PASSPHRASE = 'correct horse battery staple';

const keystore = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const router = require('./wallets');

/** Every path the wallets router answers, as "method path". */
function routes() {
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) =>
      Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`)
    );
}

/** The final handler for a route, or undefined if nothing is registered. */
function handlerFor(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  return layer && layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const res = { code: 200, body: undefined };
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

/** DELETE /api/wallets/:id as `userId`, through the real handler. */
function deleteWallet(userId, id) {
  const res = fakeRes();
  handlerFor('delete', '/wallets/:id')({ user: { id: userId }, params: { id }, body: {} }, res, (err) => {
    throw err;
  });
  return res;
}

const summaries = (userId) => activityFor(userId).list({ limit: 500 }).map((e) => e.summary);
const keyFor = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

test('the archive has no routes at all — not listing, not restore, not purge', () => {
  const all = routes();

  // The three that were removed. An unmatched path is what makes these 404:
  // GET /api/wallets/archive has no GET /wallets/:id to fall into, and the two
  // /archive/:id paths are two segments where DELETE /wallets/:id takes one.
  assert.ok(!all.includes('GET /wallets/archive'));
  assert.ok(!all.includes('POST /wallets/archive/:id/restore'));
  assert.ok(!all.includes('DELETE /wallets/archive/:id'));
  assert.equal(handlerFor('get', '/wallets/archive'), undefined);
  assert.equal(handlerFor('post', '/wallets/archive/:id/restore'), undefined);
  assert.equal(handlerFor('delete', '/wallets/archive/:id'), undefined);

  // And nothing else on this router mentions the archive either — a renamed or
  // re-added route is the failure this is really watching for.
  assert.deepEqual(all.filter((r) => /archive/i.test(r)), []);
});

test('deleting a wallet is still on the API, and still archives the key', () => {
  const ks = keystore.keystoreFor('ivan');
  const [w] = ks.importKeys([keyFor(11)], { role: 'bundle' });

  const res = deleteWallet('ivan', w.id);
  assert.equal(res.code, 200);
  assert.equal(res.body.archived, true);
  assert.equal(res.body.address, w.address);

  // In the archive, out of the live store — the behaviour that stays.
  assert.ok(ks.archived().some((e) => e.id === w.id));
  assert.ok(!ks.list().some((x) => x.id === w.id));
  assert.match(summaries('ivan')[0], new RegExp(`archived wallet ${w.address}`));
});

test('the 101st delete evicts the oldest, logs it by address, and leaves 100', () => {
  const ks = keystore.keystoreFor('capper');
  const made = ks.importKeys(
    Array.from({ length: 101 }, (_, i) => keyFor(1000 + i)),
    { role: 'bundle' }
  );

  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const w of made) assert.equal(deleteWallet('capper', w.id).code, 200);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(ks.archived().length, 100, 'exactly the cap, after 101 deletes');

  // The evicted key gets its OWN line, naming the address. Not a count, and not
  // folded into the line about the wallet the operator actually deleted: this
  // is a different wallet, destroyed by a request that was about another one.
  const evictions = activityFor('capper')
    .list({ limit: 500 })
    .filter((e) => /evicted/.test(e.summary));
  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].address, made[0].address);
  assert.equal(evictions[0].reason, 'archive full');
  assert.match(evictions[0].summary, /its key is destroyed/);
  assert.match(evictions[0].summary, new RegExp(made[0].address));

  // The log line is all that is left of it — nothing here can bring it back.
  assert.ok(!ks.archived().some((e) => e.id === made[0].id));
  assert.throws(() => ks.restore(made[0].id), /no archived wallet/);

  // Never key material, in the log least of all.
  const raw = fs.readFileSync(activityFor('capper')._path(), 'utf8');
  assert.ok(!raw.includes(keyFor(1000)), 'the activity log must never hold a private key');

  // The 100 deletes before it evicted nothing, so there is exactly one such
  // line — a cap that logged on every delete would be noise nobody reads.
  assert.equal(summaries('capper').filter((s) => /evicted/.test(s)).length, 1);
});

test('one user filling their archive never touches another user\'s', () => {
  // The eviction picks its victim inside the caller's own archive, the same way
  // every other archive operation resolves ids — there is no shared list to
  // spill over.
  const ks = keystore.keystoreFor('alice');
  const [w] = ks.importKeys([keyFor(99)], { role: 'bundle' });
  deleteWallet('alice', w.id);

  assert.equal(keystore.keystoreFor('alice').archived().length, 1);
  assert.equal(keystore.keystoreFor('capper').archived().length, 100);
  assert.deepEqual(summaries('alice').filter((s) => /evicted/.test(s)), []);
});
