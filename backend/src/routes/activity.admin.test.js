'use strict';

// The admin view over other users' activity logs, tested at the route — the
// query string is where the untrusted id arrives, so that is where the rules
// about it are worth asserting.
//
// No network and no listening socket: the handlers are pulled off the router
// and called with plain objects, the way middleware/auth.test.js does. Every
// file this reads lives in a temp directory created below.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-activity-admin-'));
process.env.HISTORY_PATH = path.join(dir, 'launches.json');
process.env.USERS_PATH = path.join(dir, 'users.json');
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
// Explicitly empty rather than merely absent, so the "nobody is an admin"
// case is the same whatever the machine running the suite has in its own env.
process.env.ADMIN_USERS = '';

const config = require('../config');
const users = require('../users/users');
const { activityFor, _reset } = require('../store/activity');
const router = require('./wallets');
// Requiring the app builds the routing table and binds nothing — server.js only
// listens when it is the entry point.
const app = require('../../server');

/**
 * The final handler registered for a route. Express keeps its routing table on
 * the router, so this exercises the real wiring — the same function the server
 * would call — without binding a port.
 */
function handlerFor(method, routePath) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method]
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} route`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { code: 200, body: undefined };
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}

/** GET /api/activity as `callerId`, with whatever query the caller sent. */
function getActivity(callerId, query = {}) {
  const res = fakeRes();
  handlerFor('get', '/activity')({ user: { id: callerId }, query }, res, (err) => {
    throw err;
  });
  return res;
}

/** GET /api/users as `callerId`. */
function getUsers(callerId) {
  const res = fakeRes();
  handlerFor('get', '/users')({ user: { id: callerId }, query: {} }, res, (err) => {
    throw err;
  });
  return res;
}

/** Admin is environment-granted; this is that environment, for one test. */
function admins(...ids) {
  config.adminUsers.length = 0;
  config.adminUsers.push(...ids);
}

/** GET /api/health, straight off the app, for whoever holds `key`. */
function getHealth(key) {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/health');
  assert.ok(layer, 'no GET /api/health route');
  const res = fakeRes();
  layer.route.stack[0].handle(
    { get: (h) => (h.toLowerCase() === 'x-api-key' ? key : undefined), query: {} },
    res
  );
  return res.body;
}

const summaries = (res) => res.body.map((e) => e.summary);

// The keys users.create returns once. Held only so the health route can be
// asked a question as a real caller.
const keys = {};

test.beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true });
  _reset();
  users._reset();
  admins();

  keys.ivan = users.create('ivan').key;
  keys.alice = users.create('alice').key;
  activityFor('ivan').record('fund', 'ivan funded 3');
  activityFor('alice').record('fund', 'alice funded 5');
});

test('ADMIN_USERS unset means nobody is an admin', () => {
  assert.deepEqual(config.adminUsers, []);
  assert.equal(users.isAdmin('ivan'), false);
  assert.equal(users.isAdmin('default'), false);
});

test('a non-admin asking for someone else gets their OWN log', () => {
  const res = getActivity('ivan', { user: 'alice' });
  // Not an error. An error would confirm that admins exist and let a caller
  // holding a stolen key work out who they are.
  assert.equal(res.code, 200);
  assert.deepEqual(summaries(res), ['ivan funded 3']);
});

test('a non-admin probing leaves no trace in anyone\'s log', () => {
  getActivity('ivan', { user: 'alice' });
  assert.deepEqual(summaries(getActivity('ivan')), ['ivan funded 3']);
  assert.deepEqual(summaries(getActivity('alice')), ['alice funded 5']);
});

test('an admin gets the log they asked for', () => {
  admins('ivan');
  const res = getActivity('ivan', { user: 'alice' });
  assert.deepEqual(summaries(res), ['alice funded 5']);
});

test('an admin still defaults to their own log', () => {
  admins('ivan');
  assert.deepEqual(summaries(getActivity('ivan')), ['ivan funded 3']);
});

test('an unknown user id is an empty log, not a crash', () => {
  admins('ivan');
  const res = getActivity('ivan', { user: 'nobody-by-that-name' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, []);
});

test('an id that is not a real user never becomes a filename', () => {
  admins('ivan');
  const escape = '../../../../etc/passwd';
  assert.deepEqual(getActivity('ivan', { user: escape }).body, []);
  // Nothing was created anywhere near the data directory, and nothing was read
  // from outside it — the id is matched against the user list before it is
  // used, so a traversal attempt is just an unknown user.
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['activity.alice.json', 'activity.ivan.json', 'users.json']
  );
});

test('a repeated ?user= parameter cannot smuggle an id past the check', () => {
  admins('ivan');
  // Express turns ?user=a&user=b into an array. A non-string is not an id.
  assert.deepEqual(summaries(getActivity('ivan', { user: ['alice', 'alice'] })), ['ivan funded 3']);
});

test('the admin\'s read is recorded in the ADMIN\'s log', () => {
  admins('ivan');
  getActivity('ivan', { user: 'alice' });

  const own = activityFor('ivan').list();
  assert.equal(own[0].kind, 'admin');
  assert.equal(own[0].summary, "viewed alice's activity");
  assert.equal(own[0].viewed, 'alice');
  // Someone who can read everyone invisibly is worse than someone whose
  // looking is itself on the record.
  assert.equal(own[1].summary, 'ivan funded 3');
});

test('the admin\'s read is NOT recorded in the viewed user\'s log', () => {
  admins('ivan');
  getActivity('ivan', { user: 'alice' });

  // It was not alice's action, and a log she cannot explain is worse than no
  // line at all.
  assert.deepEqual(summaries(getActivity('alice')), ['alice funded 5']);
});

test('an admin reading their own log records nothing', () => {
  admins('ivan');
  getActivity('ivan', { user: 'ivan' });
  assert.deepEqual(summaries(getActivity('ivan')), ['ivan funded 3']);
});

test('reading the same log twice in a sitting does not flood the record', () => {
  admins('ivan');
  getActivity('ivan', { user: 'alice' });
  getActivity('ivan', { user: 'alice' });
  getActivity('ivan', { user: 'alice' });

  // One line per sitting, not one per filter click: the admin's own log is
  // capped, and self-inflicted noise would push their funding and exports off
  // the end of it.
  const viewed = activityFor('ivan').list().filter((e) => e.kind === 'admin');
  assert.equal(viewed.length, 1);
});

test('viewing a different user is always its own line', () => {
  admins('ivan');
  users.create('carol');
  activityFor('carol').record('fund', 'carol funded 1');

  getActivity('ivan', { user: 'alice' });
  getActivity('ivan', { user: 'carol' });
  getActivity('ivan', { user: 'alice' });

  assert.deepEqual(
    activityFor('ivan').list().filter((e) => e.kind === 'admin').map((e) => e.viewed),
    ['alice', 'carol', 'alice']
  );
});

test('the filters still apply to the log being viewed', () => {
  admins('ivan');
  activityFor('alice').record('export', 'alice exported a key');

  const res = getActivity('ivan', { user: 'alice', kind: 'export' });
  assert.deepEqual(summaries(res), ['alice exported a key']);
});

test('health tells the caller whether they are an admin', () => {
  admins('ivan');
  assert.equal(getHealth(keys.ivan).admin, true);
  assert.equal(getHealth(keys.alice).admin, false);
  // Nobody at all, and no crash on a key that resolves to no user.
  assert.equal(getHealth('not-a-real-key').admin, false);
});

test('health reports no admin when ADMIN_USERS is empty', () => {
  assert.equal(getHealth(keys.ivan).admin, false);
});

test('GET /api/users is refused to a non-admin', () => {
  const res = getUsers('ivan');
  assert.equal(res.code, 403);
  assert.match(res.body.error, /not permitted/i);
});

test('an admin gets id and name for every user, and nothing else', () => {
  admins('ivan');
  const res = getUsers('ivan');
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, [
    { id: 'ivan', name: 'ivan' },
    { id: 'alice', name: 'alice' },
  ]);
  // No key hashes, ever.
  for (const u of res.body) assert.deepEqual(Object.keys(u).sort(), ['id', 'name']);
});
