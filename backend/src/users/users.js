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
// Windows reserves these as device names regardless of extension. Not
// currently reachable through Task 3's `wallets.<id>.keystore.json` template
// (the id is never the leading dot-segment), but the guarantee should not
// depend on a template that lives in a different file.
//
// 'default' is reserved too: it is the pre-multi-user single-tenant
// namespace that keystoreFor/historyFor bind to config.keystorePath /
// config.historyPath directly. A user named "default" would silently
// inherit whatever wallets and history already exist there, with no
// --adopt step and no way to adopt afterward (adoptLegacy refuses 'default').
const RESERVED = /^(default|con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

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
  if (RESERVED.test(s)) throw new Error(`invalid name "${name}" — reserved`);
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

/**
 * Resolve a presented key to a user. Timing is not a concern here: the
 * compared value is a SHA-256 of a 256-bit random key, so there is nothing
 * an attacker could learn from how long the lookup takes.
 */
function findByKey(key) {
  // Express turns ?key=a&key=b into an array, so this is reachable from a
  // request. An identity check must never coerce its way to a match.
  if (typeof key !== 'string' || !key) return null;
  const h = hash(key);
  const found = load().users.find((u) => u.keyHash === h);
  return found ? publicView(found) : null;
}

/** Test seam — drops the in-memory cache. */
function _reset() {
  cache = null;
}

module.exports = { enabled, create, list, remove, findByKey, slug, _reset };
