'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

// --- cross-process visibility (the Critical fix) ---------------------------
//
// The admin CLI (backend/scripts/user.js) is a separate OS process from the
// running server. It writes users.json directly with fs.writeFileSync, with
// no IPC to tell the server's in-memory cache to drop. These tests simulate
// that by bypassing the `users` module entirely — writing the file by hand —
// and proving the *same* long-lived module instance (no _reset()) still
// notices, the way a running server would on its next request.

let carolKey;

test('a user written to users.json by another process is visible without _reset()', () => {
  const before = users.list().length;

  const raw = JSON.parse(fs.readFileSync(process.env.USERS_PATH, 'utf8'));
  carolKey = crypto.randomBytes(32).toString('hex');
  raw.users.push({
    id: 'carol',
    name: 'carol',
    keyHash: crypto.createHash('sha256').update(carolKey).digest('hex'),
    createdAt: new Date().toISOString(),
  });
  // Deliberately NOT going through users.create()/persist() — this is the
  // CLI-in-another-process case, not an in-process write.
  fs.writeFileSync(process.env.USERS_PATH, JSON.stringify(raw, null, 2));

  assert.equal(users.enabled(), true);
  assert.equal(users.findByKey(carolKey).name, 'carol');
  assert.equal(users.list().length, before + 1);
});

test('repeated list() calls do not re-read an unchanged file', () => {
  // Prime the cache against the file's current stamp.
  users.list();

  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(...args) {
    reads += 1;
    return original.apply(fs, args);
  };
  try {
    for (let i = 0; i < 5; i += 1) users.list();
  } finally {
    fs.readFileSync = original;
  }

  assert.equal(reads, 0, 'an unchanged file must not be re-read on every call');
});

test('deleting users.json after users existed does not disable enabled()', () => {
  assert.equal(users.enabled(), true);

  fs.unlinkSync(process.env.USERS_PATH);

  // Falling back to "no users" here is the same zero-auth hole from the
  // other direction — reachable by deleting a file, not just failing to
  // move fast enough after the CLI writes one.
  assert.equal(users.enabled(), true, 'must stay enabled once users have existed');
  assert.equal(users.findByKey(carolKey).name, 'carol', 'the last known set keeps being enforced');
  assert.throws(() => users.remove('nonexistent-user'), /no user/);
});
