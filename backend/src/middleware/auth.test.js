'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-auth-'));
process.env.USERS_PATH = path.join(dir, 'users.json');

const users = require('../users/users');
const { identify, DEFAULT_USER } = require('./auth');

function fakeReq(key) {
  return { get: (h) => (h.toLowerCase() === 'x-api-key' ? key : undefined), query: {} };
}
function fakeRes() {
  const res = { code: null, body: null };
  res.status = (c) => ((res.code = c), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}
function run(key) {
  const req = fakeReq(key);
  const res = fakeRes();
  let nexted = false;
  identify(req, res, () => (nexted = true));
  return { req, res, nexted };
}

test('with no users file every request is the default user', () => {
  const { req, nexted } = run(undefined);
  assert.equal(nexted, true);
  assert.deepEqual(req.user, DEFAULT_USER);
});

test('the default user cannot be mutated into someone else', () => {
  const first = run(undefined);
  first.req.user.id = 'attacker';
  const second = run(undefined);
  assert.equal(second.req.user.id, 'default');
});

test('once a user exists a valid key resolves to them', () => {
  const { key } = users.create('ivan');
  const { req, nexted } = run(key);
  assert.equal(nexted, true);
  assert.equal(req.user.id, 'ivan');
});

test('a wrong key is refused rather than falling back to default', () => {
  const { res, nexted, req } = run('not-a-real-key');
  assert.equal(nexted, false);
  assert.equal(res.code, 401);
  assert.match(res.body.error, /invalid or missing/i);
  // The dangerous failure would be silently becoming someone.
  assert.equal(req.user, undefined);
});

test('a missing key is refused once users exist', () => {
  const { res, nexted } = run(undefined);
  assert.equal(nexted, false);
  assert.equal(res.code, 401);
});

test('one user cannot present another user key and become them', () => {
  const { key: aliceKey } = users.create('alice');
  const { req } = run(aliceKey);
  assert.equal(req.user.id, 'alice');
  assert.notEqual(req.user.id, 'ivan');
});
