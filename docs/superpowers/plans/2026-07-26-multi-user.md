# Per-user Wallets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let several operators share one deployment, each with their own wallets, funding and launch history, with no way to see or spend another's.

**Architecture:** A per-user API key is the identity. `users.json` stores only the SHA-256 of each key; a CLI creates users and prints the key once. Requests resolve to a user, and every piece of state — keystore and history — is a separate file per user, so isolation is structural rather than a permission check that can be forgotten. With no `users.json`, everything resolves to a `default` user reading today's exact file paths, so existing deployments are unchanged.

**Tech Stack:** Node 20 CommonJS, Express 4, `node:test`, `node:crypto`. No new dependencies.

## Global Constraints

- **No new npm dependencies.**
- Backend is CommonJS (`'use strict';`, `require`, `module.exports`). Comments explain *why*, matching the surrounding files.
- **The existing test suite must pass unchanged at every task.** It exercises the single-tenant path; if it breaks, the `default` fallback is wrong.
- **A user id is used as a filename component.** It must match `/^[a-z0-9][a-z0-9-]{0,31}$/` — validated on creation and never taken from a request. This is the path-traversal boundary.
- Raw API keys are **never** written to disk, logged, or returned by any route. Only `sha256(key)` is stored, and the key is printed once at creation.
- Tests are plain `node:test` with hand-rolled fakes, run with `npm test --workspace backend`.
- This repo has **no configured git identity** — commit with
  `git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "…"`.

---

### Task 1: Users store and CLI

**Files:**
- Create: `backend/src/users/users.js`
- Create: `backend/src/users/users.test.js`
- Create: `backend/scripts/user.js`
- Modify: `backend/package.json` (scripts block, lines 8-12)
- Modify: `backend/src/config.js` (add `usersPath` beside `keystorePath`)

**Interfaces:**
- Consumes: `config.keystorePath` (existing), to derive the data directory.
- Produces:
  - `enabled(): boolean` — true when `users.json` exists and has at least one user.
  - `create(name: string): { user, key }` — `key` is the raw key, returned once.
  - `list(): Array<{id, name, createdAt}>` — never includes keys or hashes.
  - `remove(name: string): { removed: string }`
  - `findByKey(key: string): {id, name, createdAt} | null`
  - `slug(name: string): string` — the id derivation, exported for testing.
  - `_reset(): void` — test seam, drops the cache.

- [ ] **Step 1: Add the config path**

In `backend/src/config.js`, directly after the `historyPath` entry:

```js
  // Beside the keystore: one users file for the whole deployment. Absent means
  // single-tenant, which is what every existing install is.
  usersPath: process.env.USERS_PATH || path.join(__dirname, '..', 'data', 'users.json'),
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/users/users.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --workspace backend`
Expected: FAIL — `Cannot find module './users'`.

- [ ] **Step 4: Write the implementation**

Create `backend/src/users/users.js`:

```js
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
    .replace(/[^a-z0-9]+/g, '-')
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace backend`
Expected: PASS — 7 new tests, and every pre-existing test still passing.

- [ ] **Step 6: Write the CLI**

Create `backend/scripts/user.js`:

```js
'use strict';

// User administration is a shell job, deliberately. There is no admin role, so
// there is no one the app could authorise to create users over HTTP — whoever
// can create users can create themselves.

const users = require('../src/users/users');

const [, , command, name, ...flags] = process.argv;

function usage() {
  console.log(`
usage:
  npm run user:add -- <name>            create a user and print their key once
  npm run user:add -- <name> --adopt    …and hand them the existing wallets
  npm run user:list                     names and creation dates
  npm run user:remove -- <name>         revoke a user (their keystore stays on disk)
`);
}

try {
  if (command === 'add') {
    const { user, key } = users.create(name);
    if (flags.includes('--adopt')) {
      const { adoptLegacy } = require('../src/wallets/keystore');
      const moved = adoptLegacy(user.id);
      console.log(moved ? `adopted the existing keystore as ${user.id}` : 'no existing keystore to adopt');
    }
    console.log(`\nuser:  ${user.name}`);
    console.log(`key:   ${key}`);
    console.log('\nThis key is shown once and is not stored anywhere. Save it now.\n');
  } else if (command === 'list') {
    const all = users.list();
    if (!all.length) return console.log('no users — this deployment is single-tenant');
    for (const u of all) console.log(`${u.id.padEnd(20)} created ${u.createdAt.slice(0, 10)}`);
  } else if (command === 'remove') {
    console.log(users.remove(name).removed + ' removed');
  } else {
    usage();
    process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
```

- [ ] **Step 7: Add the npm scripts**

In `backend/package.json`, replace the `scripts` block with:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test",
    "user:add": "node scripts/user.js add",
    "user:list": "node scripts/user.js list",
    "user:remove": "node scripts/user.js remove"
  },
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/users backend/scripts backend/package.json backend/src/config.js
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: per-user API keys, stored as hashes only"
```

Note: `npm run user:add -- <name> --adopt` calls `adoptLegacy`, which Task 3 adds. Running `--adopt` before Task 3 throws; plain `add` works now.

---

### Task 2: Resolve the caller

**Files:**
- Modify: `backend/src/middleware/auth.js` (whole file)
- Create: `backend/src/middleware/auth.test.js`
- Modify: `backend/server.js:29-40` (health payload, and mount `identify`)

**Interfaces:**
- Consumes: `users.enabled()`, `users.findByKey(key)` from Task 1.
- Produces:
  - `identify(req, res, next)` — sets `req.user = { id, name }`; 401s in multi-user mode without a valid key. Mounted on all `/api` routes.
  - `requireApiKey(req, res, next)` — unchanged signature, still guards mutating routes in single-tenant mode.
  - `DEFAULT_USER = { id: 'default', name: 'default' }`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/middleware/auth.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace backend`
Expected: FAIL — `identify is not a function`.

- [ ] **Step 3: Write the implementation**

Replace `backend/src/middleware/auth.js` with:

```js
'use strict';

const config = require('../config');
const users = require('../users/users');

// A deployment with no users.json is single-tenant: every request is this one
// user, reading the original keystore path.
const DEFAULT_USER = { id: 'default', name: 'default' };

function presentedKey(req) {
  return req.get('x-api-key') || req.query.key;
}

/**
 * Attach the caller. Mounted on every /api route, because in multi-user mode
 * even a read has to know whose wallets it is reading — an unscoped GET would
 * leak the whole point of the feature.
 *
 * Once users exist, config.API_KEY is ignored entirely. Two competing notions
 * of "the key" is a way to have one of them be wrong.
 */
function identify(req, res, next) {
  if (!users.enabled()) {
    req.user = DEFAULT_USER;
    return next();
  }
  const user = users.findByKey(presentedKey(req));
  if (!user) return res.status(401).json({ error: 'invalid or missing API key' });
  req.user = { id: user.id, name: user.name };
  return next();
}

/**
 * Gate for mutating routes in single-tenant mode. In multi-user mode identify
 * has already refused anyone without a valid key, so this is a no-op.
 */
function requireApiKey(req, res, next) {
  if (users.enabled()) return next();
  if (!config.apiKey) return next();
  if (presentedKey(req) === config.apiKey) return next();
  return res.status(401).json({ error: 'invalid or missing API key' });
}

module.exports = { identify, requireApiKey, DEFAULT_USER };
```

- [ ] **Step 4: Mount it and report it**

In `backend/server.js`, add the import beside the route requires:

```js
const { identify } = require('./src/middleware/auth');
```

Mount it immediately before the two route routers:

```js
app.use('/api', identify);
app.use('/api', walletRoutes);
app.use('/api', launchRoutes);
```

`/api/health` must stay reachable without a key, so move it **below** those lines or leave it above the `identify` mount — it is currently registered before them, which is correct. Extend its payload so the console can tell what mode it is in and who it is:

```js
app.get('/api/health', (req, res) => {
  const user = users.enabled() ? users.findByKey(req.get('x-api-key') || req.query.key) : null;
  res.json({
    name: 'pons-launcher',
    dryRun: config.dryRun,
    chainId: config.chainId,
    factory: config.factoryAddress,
    explorer: config.explorerUrl,
    apiKeyRequired: users.enabled() || Boolean(config.apiKey),
    multiUser: users.enabled(),
    user: user ? user.name : null,
  });
});
```

with `const users = require('./src/users/users');` added to server.js's requires.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace backend`
Expected: PASS — 5 new tests plus everything before.

- [ ] **Step 6: Commit**

```bash
git add backend/src/middleware backend/server.js
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: resolve every request to a user"
```

---

### Task 3: Per-user keystore and history

The largest task, and the one that touches the launch path. The safeguard is that the existing suite must pass untouched.

**Files:**
- Modify: `backend/src/wallets/keystore.js` (whole file — module state becomes per-user instances)
- Modify: `backend/src/store/history.js` (whole file, same shape)
- Modify: `backend/src/wallets/keystore.test.js` (append isolation tests only; do not alter existing ones)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (deliberately — this layer does not know what a user is beyond an id string).
- Produces:
  - `keystoreFor(userId: string)` → object with the existing API: `list, generate, importKeys, remove, signer, exportKey, exportAll, devWallet, bundleWallets`.
  - `adoptLegacy(userId: string): boolean` — renames the legacy keystore to that user's path; false when there is nothing to adopt.
  - The module keeps exporting `list`, `generate`, … bound to `keystoreFor('default')`, so every existing caller and test is unaffected.
  - `historyFor(userId: string)` → `{ record, list }`, with `record`/`list` still exported bound to `default`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/wallets/keystore.test.js`:

```js
test('two users cannot see each other wallets', () => {
  const a = keystore.keystoreFor('alice');
  const b = keystore.keystoreFor('bob');

  const [aw] = a.generate(1, { role: 'dev' });
  const [bw] = b.generate(1, { role: 'dev' });

  assert.ok(a.list().some((w) => w.id === aw.id));
  assert.ok(!a.list().some((w) => w.id === bw.id));
  assert.ok(!b.list().some((w) => w.id === aw.id));

  // The isolation is structural: a foreign id is simply not in this store.
  assert.throws(() => a.signer(bw.id), /no wallet/);
  assert.throws(() => a.exportKey(bw.id), /no wallet/);
  assert.throws(() => a.remove(bw.id), /no wallet/);
});

test('each user gets their own dev wallet', () => {
  // The "only one dev wallet" rule is per user, not per deployment.
  const a = keystore.keystoreFor('alice');
  assert.throws(() => a.generate(1, { role: 'dev' }), /already exists/);
  assert.equal(keystore.keystoreFor('carol').generate(1, { role: 'dev' }).length, 1);
});

test('the default user reads the original path', () => {
  const legacy = keystore.keystoreFor('default');
  assert.deepEqual(
    legacy.list().map((w) => w.id).sort(),
    keystore.list().map((w) => w.id).sort()
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace backend`
Expected: FAIL — `keystore.keystoreFor is not a function`.

- [ ] **Step 3: Refactor keystore.js into instances**

Wrap the existing module state in a factory. The bodies of `encrypt`, `decrypt`, `publicView`, `list`, `get`, `add`, `generate`, `importKeys`, `remove`, `signer`, `exportKey`, `exportAll`, `devWallet`, `bundleWallets` are unchanged — they move inside the closure and read `state` instead of module-level `cache` / `derivedKey`.

Replace the top-of-file state and the exports with:

```js
const DEFAULT_ID = 'default';
const instances = new Map();

/** Where a user's keystore lives. 'default' keeps the original path exactly. */
function pathFor(userId) {
  if (userId === DEFAULT_ID) return config.keystorePath;
  const dir = path.dirname(config.keystorePath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  return path.join(dir, `wallets.${userId}.keystore.json`);
}

function build(userId) {
  const file = pathFor(userId);
  let cache = null;
  let derivedKey = null;

  // …every existing function, unchanged, closing over cache/derivedKey/file…

  return { list, generate, importKeys, remove, signer, exportKey, exportAll, devWallet, bundleWallets, _reset };
}

function keystoreFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

/**
 * Hand the pre-multi-user keystore to a named user, so an existing deployment's
 * wallets are not stranded under 'default' the moment users are created.
 */
function adoptLegacy(userId) {
  const from = config.keystorePath;
  const to = pathFor(userId);
  if (userId === DEFAULT_ID || !fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.renameSync(from, to);
  instances.clear();
  return true;
}

const def = () => keystoreFor(DEFAULT_ID);

module.exports = {
  keystoreFor,
  adoptLegacy,
  // Bound to the default user so every existing caller keeps working.
  list: (...a) => def().list(...a),
  generate: (...a) => def().generate(...a),
  importKeys: (...a) => def().importKeys(...a),
  remove: (...a) => def().remove(...a),
  signer: (...a) => def().signer(...a),
  exportKey: (...a) => def().exportKey(...a),
  exportAll: (...a) => def().exportAll(...a),
  devWallet: (...a) => def().devWallet(...a),
  bundleWallets: (...a) => def().bundleWallets(...a),
  _reset: () => instances.clear(),
};
```

Inside `build`, every `config.keystorePath` becomes `file`, and `_reset` clears that instance's `cache`/`derivedKey`.

- [ ] **Step 4: Refactor history.js the same way**

```js
function pathFor(userId) {
  if (userId === 'default') return config.historyPath;
  const dir = path.dirname(config.historyPath);
  return path.join(dir, `launches.${userId}.json`);
}

function historyFor(userId = 'default') { /* returns { record, list } bound to pathFor(userId) */ }

module.exports = {
  historyFor,
  record: (...a) => historyFor('default').record(...a),
  list: (...a) => historyFor('default').list(...a),
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace backend`
Expected: PASS — the 3 new isolation tests, and **every pre-existing keystore test unchanged**. If any pre-existing test needed editing, the default binding is wrong; fix the binding, not the test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/wallets/keystore.js backend/src/wallets/keystore.test.js backend/src/store/history.js
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: one keystore and history per user"
```

---

### Task 4: Thread the caller through the routes

**Files:**
- Modify: `backend/src/wallets/funding.js` (`balances`, `disperse`, `sweep` signatures)
- Modify: `backend/src/bundle/prepare.js:47` (signature) and its keystore calls
- Modify: `backend/src/routes/wallets.js` (every handler)
- Modify: `backend/src/routes/launch.js` (`/preflight`, `/launch`, `/launches`)
- Create: `backend/src/bundle/prepare.isolation.test.js`

**Interfaces:**
- Consumes: `keystoreFor(id)` / `historyFor(id)` (Task 3), `req.user` (Task 2).
- Produces: no new exports. Every existing signature gains a trailing options object that **defaults to the current behaviour**:
  - `balances({ keystore } = {})`
  - `disperse(targets, { keystore } = {})`
  - `sweep({ includeTokens, tokenAddress } = {}, { keystore } = {})`
  - `prepare(input, { keystore } = {})`

- [ ] **Step 1: Write the failing test**

Create `backend/src/bundle/prepare.isolation.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-prepare-iso-'));
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'isolation test passphrase';

const keystore = require('../wallets/keystore');
const { prepare } = require('./prepare');

test('a launch cannot sign with another user wallet', async () => {
  const alice = keystore.keystoreFor('alice');
  const bob = keystore.keystoreFor('bob');
  alice.generate(1, { role: 'dev' });
  const [bobBundle] = bob.generate(1, { role: 'bundle' });

  // Alice launches, naming one of Bob's wallet ids. It must be rejected as
  // unknown — never silently signed with.
  await assert.rejects(
    () =>
      prepare(
        {
          params: { name: 'X', symbol: 'X', logo: 'ipfs://x' },
          launchConfigId: 0,
          dexId: 0,
          wallets: [{ walletId: bobBundle.id, mode: 'fixed', amountEth: '0.01' }],
        },
        { keystore: alice }
      ),
    /no wallet/
  );
});

test('a launch with no dev wallet of its own is refused', async () => {
  const carol = keystore.keystoreFor('carol-empty');
  await assert.rejects(
    () =>
      prepare(
        { params: { name: 'X', symbol: 'X', logo: 'ipfs://x' }, launchConfigId: 0, dexId: 0, wallets: [] },
        { keystore: carol }
      ),
    /no dev wallet/
  );
});
```

Both assertions fail before the chain is reached, so this test needs no RPC.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace backend`
Expected: FAIL — `prepare` ignores the second argument and uses the default keystore.

- [ ] **Step 3: Thread it through prepare.js**

Change the signature at line 47 and the three keystore call sites:

```js
async function prepare(input, { keystore: ks = keystore } = {}) {
```

then replace `keystore.devWallet()` with `ks.devWallet()`, `keystore.signer(...)` with `ks.signer(...)`, and `keystore.list()` with `ks.list()`. Nothing else in the function changes.

- [ ] **Step 4: Thread it through funding.js**

```js
async function balances({ keystore: ks = keystore } = {}) { … ks.list() … }
async function disperse(targets, { keystore: ks = keystore } = {}) { … ks.devWallet(), ks.signer(), ks.list() … }
async function sweep({ includeTokens = false, tokenAddress = null } = {}, { keystore: ks = keystore } = {}) { … ks.devWallet(), ks.bundleWallets(), ks.signer() … }
```

- [ ] **Step 5: Use the caller in every route**

In `backend/src/routes/wallets.js`, add at the top:

```js
const { keystoreFor } = require('../wallets/keystore');
```

and open every handler with:

```js
    const ks = keystoreFor(req.user.id);
```

replacing `keystore.x(...)` with `ks.x(...)` and passing `{ keystore: ks }` into `funding.balances`, `funding.disperse` and `funding.sweep`. The wallet-id routes (`DELETE /wallets/:id`, `/wallets/export`) resolve the id **through `ks`**, which is what makes a foreign id a "no wallet" error rather than someone else's key.

In `backend/src/routes/launch.js`:

```js
const { keystoreFor } = require('../wallets/keystore');
const { historyFor } = require('../store/history');
…
router.post('/preflight', requireApiKey, async (req, res, next) => {
  try {
    res.json(publicPlan(await prepare(req.body || {}, { keystore: keystoreFor(req.user.id) })));
  } catch (err) { next(err); }
});

router.post('/launch', requireApiKey, async (req, res, next) => {
  try {
    const plan = await prepare(req.body || {}, { keystore: keystoreFor(req.user.id) });
    const result = await fire(plan);
    const entry = historyFor(req.user.id).record({ plan, result });
    res.json({ plan: publicPlan(plan), result, recorded: entry.at });
  } catch (err) { next(err); }
});

router.get('/launches', (req, res, next) => {
  try {
    res.json(historyFor(req.user.id).list(Number(req.query.limit) || 50));
  } catch (err) { next(err); }
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace backend`
Expected: PASS — the 2 isolation tests plus everything before, unchanged.

- [ ] **Step 7: Verify by hand that two users are actually separate**

```bash
cd backend
rm -rf /tmp/mu && mkdir -p /tmp/mu
USERS_PATH=/tmp/mu/users.json KEYSTORE_PATH=/tmp/mu/w.json KEYSTORE_PASSPHRASE=x npm run user:add -- alice
USERS_PATH=/tmp/mu/users.json KEYSTORE_PATH=/tmp/mu/w.json KEYSTORE_PASSPHRASE=x npm run user:add -- bob
# start with those same env vars, then:
curl -s -X POST localhost:3100/api/wallets/generate -H 'x-api-key: <alice key>' \
  -H 'content-type: application/json' -d '{"count":2,"role":"bundle"}' >/dev/null
curl -s localhost:3100/api/wallets -H 'x-api-key: <alice key>' | grep -c address   # 2
curl -s localhost:3100/api/wallets -H 'x-api-key: <bob key>'   | grep -c address   # 0
curl -s localhost:3100/api/wallets                                                  # 401
```

Record the actual output. The third line returning anything but 0 is a failed isolation guarantee and must block the task.

- [ ] **Step 8: Commit**

```bash
git add backend/src/wallets/funding.js backend/src/bundle/prepare.js backend/src/bundle/prepare.isolation.test.js backend/src/routes
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: scope every route to the calling user"
```

---

### Task 5: Console, nginx and docs

**Files:**
- Modify: `frontend/src/App.jsx` (strip: show the signed-in user; hide the key field when it is not needed)
- Modify: `deploy/nginx-rhbond.conf` (the `map` block and `proxy_set_header`)
- Modify: `README.md` (a "Multiple operators" section after "Config")

**Interfaces:**
- Consumes: `/api/health` fields `multiUser: boolean` and `user: string|null` from Task 2.
- Produces: no new interfaces.

- [ ] **Step 1: Show who you are, and only ask when it matters**

In `frontend/src/App.jsx`, inside the strip, replace the readout block with:

```jsx
        {health && (
          <div className="readout">
            <span>
              chain <b>{health.chainId}</b>
            </span>
            {health.multiUser && (
              <span>
                signed in as <b>{health.user || 'nobody'}</b>
              </span>
            )}
          </div>
        )}
```

and render the key input only when the server has not already resolved a user — nginx injects it in the normal case, so the field should not be there to confuse anyone:

```jsx
        {health && health.apiKeyRequired && !health.user && (
          <input
            type="password"
            placeholder="API key"
            autoComplete="off"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setApiKey(e.target.value);
            }}
          />
        )}
```

`/api/health` is unauthenticated, so `health.user` is only non-null when the request already carried a valid key — which is exactly the "nginx injected it" case.

- [ ] **Step 2: Map each login to their key in nginx**

In `deploy/nginx-rhbond.conf`, above the first `server` block:

```nginx
# Each basic-auth login is handed its own API key, so nobody types one and the
# app still learns who is calling. Keys live here, in a root-only file, rather
# than in someone's password manager.
map $remote_user $user_key {
    default "";
    # ivan  "<ivan's key from: npm run user:add -- ivan>";
    # alice "<alice's key>";
}
```

and inside the `rhbond.xyz` `location /` block only:

```nginx
        # Replaces anything the client sent — a browser cannot present someone
        # else's key by hand.
        proxy_set_header x-api-key $user_key;
```

The `api.rhbond.xyz` block gets neither: callers there present their own key, which is the point of having one.

- [ ] **Step 3: Document it**

Add to `README.md` after the Config table:

```markdown
## Multiple operators

By default the deployment is single-tenant: one keystore, one dev wallet,
shared by anyone who can log in.

Create users and each gets their own wallets, funding and history, invisible to
the others:

    npm run user:add -- alice          # prints the key once — save it
    npm run user:add -- ivan --adopt   # …and takes over the existing wallets
    npm run user:list
    npm run user:remove -- alice

The key IS the identity, so each user needs their own. Map each nginx login to
their key (see `deploy/nginx-rhbond.conf`) and nobody has to type one.

There is no admin: no account can read another's wallets or keys. Recovery of a
lost key means shell access to the server, not a support request.
```

- [ ] **Step 4: Verify in a browser**

Run `npm run build` from the repo root, then start the API with `USERS_PATH` pointing at a users file containing two users. Open the console with no key: the field is present and the wallet list is empty. Enter alice's key: the strip reads `signed in as alice` and only alice's wallets appear. Swap to bob's key and confirm the table changes completely.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx deploy/nginx-rhbond.conf README.md
git -c user.name="Ivan" -c user.email="ivanrenz0708@gmail.com" commit -m "feat: show the signed-in operator, map nginx logins to keys"
```

---

## Self-Review

**Spec coverage:** users.json + hashed keys + CLI → Task 1. `resolveUser`/`identify` + health fields → Task 2. Per-user keystore and history paths, `default` legacy mapping, `--adopt` → Tasks 1 and 3. Route scoping and the wallet-id trust boundary → Task 4. Frontend, nginx map, README → Task 5. Every spec section maps to a task.

**Type consistency:** `keystoreFor(userId)` and `historyFor(userId)` are named identically in Tasks 3, 4 and the CLI. `{ keystore }` is the option key in `prepare`, `disperse`, `sweep` and `balances` alike. `req.user.id` is the only thing routes pass. `adoptLegacy(userId)` is defined in Task 3 and called in Task 1's CLI — noted there as a forward dependency.

**Known ordering wrinkle:** Task 1's CLI references `adoptLegacy`, added in Task 3. `npm run user:add -- <name>` works from Task 1; the `--adopt` flag only works after Task 3. Called out in Task 1 Step 8 rather than reordered, because splitting the CLI across two tasks would leave neither independently testable.
