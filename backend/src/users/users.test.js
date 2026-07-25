'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-users-'));
process.env.USERS_PATH = path.join(dir, 'users.json');

const users = require('./users');

test('no users file means single-tenant', () => {
  assert.equal(users.enabled(), false);
  assert.deepEqual(users.list(), []);
});

test('slug makes a filename-safe id and refuses anything else', () => {
  assert.equal(users.slug('Ivan'), 'ivan');
  assert.equal(users.slug('Alice Smith'), 'alice-smith');
  // The id becomes part of a path. Traversal and separators must not survive.
  assert.throws(() => users.slug('../../etc/passwd'), /invalid name/);
  assert.throws(() => users.slug(''), /invalid name/);
  assert.throws(() => users.slug('!!!'), /invalid name/);
  // Windows reserves these regardless of extension.
  assert.throws(() => users.slug('CON'), /invalid name/);
  // 'default' is the legacy single-tenant namespace, not just a nice name —
  // a user with this id would silently inherit the pre-existing keystore.
  assert.throws(() => users.slug('default'), /invalid name/);
  assert.throws(() => users.slug('Default'), /invalid name/);
});

test('create returns a key once and stores only its hash', () => {
  const { user, key } = users.create('ivan');

  assert.equal(user.id, 'ivan');
  assert.equal(user.name, 'ivan');
  assert.match(key, /^[0-9a-f]{64}$/);

  const onDisk = fs.readFileSync(process.env.USERS_PATH, 'utf8');
  assert.ok(!onDisk.includes(key), 'the raw key must never reach the disk');
  assert.ok(onDisk.includes('keyHash'));
  assert.equal(users.enabled(), true);
});

test('findByKey resolves the right user and rejects anything else', () => {
  const { key } = users.create('alice');

  assert.equal(users.findByKey(key).name, 'alice');
  assert.equal(users.findByKey('nope'), null);
  assert.equal(users.findByKey(''), null);
  assert.equal(users.findByKey(undefined), null);

  // Express turns ?key=a&key=b into an array — a non-string must never
  // authenticate, even one carrying the real key.
  assert.equal(users.findByKey([key]), null);
  assert.equal(users.findByKey({ toString: () => key }), null);
  assert.equal(users.findByKey(12345), null);
  assert.equal(users.findByKey(null), null);
});

test('list exposes no key material', () => {
  const listed = users.list();
  assert.ok(listed.length >= 2);
  for (const u of listed) {
    assert.deepEqual(Object.keys(u).sort(), ['createdAt', 'id', 'name']);
  }
});

test('duplicate names are refused', () => {
  assert.throws(() => users.create('ivan'), /already exists/);
});

test('remove drops the user and their key stops working', () => {
  const { key } = users.create('bob');
  assert.equal(users.findByKey(key).name, 'bob');

  users.remove('bob');
  assert.equal(users.findByKey(key), null);
  assert.ok(!users.list().some((u) => u.name === 'bob'));
  assert.throws(() => users.remove('bob'), /no user/);
});
