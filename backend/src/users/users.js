'use strict';

// Who is calling. One key per user; only its hash is ever stored, so a stolen
// users.json cannot be used to act as anyone.
//
// The absence of this file is meaningful: it means the deployment is
// single-tenant, and every request resolves to the 'default' user reading the
// original keystore path. That is what keeps existing installs working.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const VERSION = 1;
// The id becomes part of a filename. Anything outside this alphabet — a slash,
// a dot, a null — must never reach the filesystem.
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

let cache = null;

function slug(name) {
  const s = String(name || '')
    .trim()
    .toLowerCase()
    // Only whitespace is folded into a dash. Anything else that isn't
    // already in the allowed alphabet — slashes, dots, punctuation — must
    // fail validation below rather than be silently stripped into a
    // path-traversal-looking string that happens to pass.
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!ID.test(s)) throw new Error(`invalid name "${name}" — use letters, numbers and dashes`);
  return s;
}

function hash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function load() {
  if (cache) return cache;
  if (!fs.existsSync(config.usersPath)) {
    cache = { version: VERSION, users: [] };
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(config.usersPath, 'utf8'));
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(config.usersPath), { recursive: true });
  fs.writeFileSync(config.usersPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function publicView(u) {
  return { id: u.id, name: u.name, createdAt: u.createdAt };
}

/** True once at least one user exists — the switch into multi-user mode. */
function enabled() {
  return load().users.length > 0;
}

/**
 * Create a user and return their key ONCE. Nothing anywhere stores the raw
 * key, so a lost key is replaced rather than recovered.
 */
function create(name) {
  const id = slug(name);
  const store = load();
  if (store.users.some((u) => u.id === id)) throw new Error(`user "${id}" already exists`);

  const key = crypto.randomBytes(32).toString('hex');
  const user = { id, name: id, keyHash: hash(key), createdAt: new Date().toISOString() };
  store.users.push(user);
  persist();
  return { user: publicView(user), key };
}

function list() {
  return load().users.map(publicView);
}

function remove(name) {
  const id = slug(name);
  const store = load();
  const before = store.users.length;
  store.users = store.users.filter((u) => u.id !== id);
  if (store.users.length === before) throw new Error(`no user "${id}"`);
  persist();
  return { removed: id };
}

/** Resolve a presented key to a user. Constant work, no early return on length. */
function findByKey(key) {
  if (!key) return null;
  const h = hash(key);
  const found = load().users.find((u) => u.keyHash === h);
  return found ? publicView(found) : null;
}

/** Test seam — drops the in-memory cache. */
function _reset() {
  cache = null;
}

module.exports = { enabled, create, list, remove, findByKey, slug, _reset };
