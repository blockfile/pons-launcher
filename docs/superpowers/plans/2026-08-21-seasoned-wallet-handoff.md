# Seasoned-wallet handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let V1 and V3 claim V4's finished-seasoning wallets as pre-aged, pre-funded bundle wallets.

**Architecture:** V4 funds each seed wallet exactly once, so a funded seed aged ≥24h is *done* and safe to hand off. A read-only helper (`v4/seasoned.js`) computes that available set and performs a claim by re-roling the wallet into the consuming tab's bundle role and recording it in a V4 "graduated" registry. Each consuming tab owns its own claim endpoint (isolation rule); both read availability through the one helper. No two tabs ever hold the live wallet at once, so it cannot nonce-collide.

**Tech Stack:** Node 20 CommonJS, Express, ethers v6, `node:test`. Backend tests only (the frontend has no component test harness — frontend tasks are build-verified).

## Global Constraints

- V4's seasoning engine, the launch (V1) and chain (V3) trading math, and v2 are NOT modified.
- Roles: `v4seed` (V4 seed), `bundle` (V1 bundle), `v3bundle` (V3 bundle). Re-roling uses the existing `keystore.setRole(id, role)`.
- The keystore and V4 store are per-user via `keystoreFor(userId)` / `storeFor(userId)`.
- `SEASONED_MIN_HOURS` default is `24`.
- Deterministic tests: pass `now` (ms) explicitly; never call `Date.now()` inside a helper.
- Commit messages end with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## File structure

- Create `backend/src/v4/seasoned.js` — availability + claim helper (pure over ks/store/now).
- Create `backend/src/v4/seasoned.test.js` — its tests.
- Modify `backend/src/v4/store.js` — add `recordGraduated`/`graduated` + `graduated: []` in load defaults.
- Modify `backend/src/v4/store.test.js` — graduated round-trip test.
- Modify `backend/src/config.js` — add `seasonedMinHours`.
- Modify `backend/.env.example` — document `SEASONED_MIN_HOURS`.
- Modify `backend/src/routes/v4.js` — `GET /api/v4/seasoned`.
- Modify `backend/src/routes/wallets.js` — `POST /api/wallets/claim-seasoned` (V1).
- Modify `backend/src/routes/v3.js` — `POST /api/v3/wallets/claim-seasoned` (V3).
- Modify `backend/src/routes/v4.test.js`, `routes/v3.test.js` — route tests.
- Modify `frontend/src/components/WalletsPanel.jsx`, `frontend/src/v3/V3BundlePanel.jsx`, `frontend/src/v4/V4SeedPanel.jsx`, `frontend/src/api.js` — UI + fetch.

---

### Task 1: V4 store — graduated registry

**Files:**
- Modify: `backend/src/v4/store.js`
- Test: `backend/src/v4/store.test.js`

**Interfaces:**
- Produces: `store.recordGraduated(entries)` where `entries` is `[{ id, address, toTab, at }]`; `store.graduated()` → array newest-first.

- [ ] **Step 1: Write the failing test** (append to `store.test.js`)

```js
test('recordGraduated persists and graduated() returns newest first', () => {
  store._reset();
  const s = require('./store').storeFor('grad-test');
  s.recordGraduated([{ id: 'a', address: '0xA', toTab: 'v3', at: '2026-08-21T00:00:00Z' }]);
  s.recordGraduated([{ id: 'b', address: '0xB', toTab: 'v1', at: '2026-08-21T01:00:00Z' }]);
  s._reset();
  const g = s.graduated();
  assert.equal(g.length, 2);
  assert.equal(g[0].id, 'b', 'newest first');
  assert.equal(g[1].toTab, 'v3');
});
```

- [ ] **Step 2: Run it, expect FAIL** — `node --test src/v4/store.test.js` → `store.recordGraduated is not a function`.

- [ ] **Step 3: Implement.** In `store.js`, add `graduated: []` to BOTH `load()` default shapes (the no-file branch and the parsed branch: `graduated: parsed.graduated || []`). Add before `_reset`:

```js
  /** Record wallets handed off to another tab, and read them back newest-first. */
  function recordGraduated(entries) {
    const store = load();
    store.graduated.unshift(...entries.map((e) => ({ ...e })));
    persist();
  }

  function graduated() {
    return load().graduated.slice();
  }
```

Add `recordGraduated, graduated,` to the returned object.

- [ ] **Step 4: Run it, expect PASS** — `node --test src/v4/store.test.js`.

- [ ] **Step 5: Commit** — `git add backend/src/v4/store.js backend/src/v4/store.test.js && git commit` (`feat: v4 store graduated registry`).

---

### Task 2: `seasoned.available()` + config

**Files:**
- Create: `backend/src/v4/seasoned.js`
- Create: `backend/src/v4/seasoned.test.js`
- Modify: `backend/src/config.js`, `backend/.env.example`

**Interfaces:**
- Consumes: `v4roles.ROLES.seed`, `keystore.walletsWithRole`, `store.campaigns()`.
- Produces: `available(ks, store, now, { minHours = config.seasonedMinHours } = {})` → `[{ id, address, label, fundedAt, hoursSinceFunded }]`, most-aged first. (No balance — the helper stays pure over ks/store/now; a claim decision does not need it.)

- [ ] **Step 1: config.** In `config.js`, beside the other `num(...)` entries, add:

```js
  // A V4 seed wallet is claimable by V1/V3 once it has been funded and has aged
  // at least this many hours — the "done seasoning" gate. 24h by default.
  seasonedMinHours: num(process.env.SEASONED_MIN_HOURS, 24),
```

In `.env.example`, add under a heading:

```
# How long a funded V4 seed must age before V1/V3 may claim it as a bundle wallet.
SEASONED_MIN_HOURS=24
```

- [ ] **Step 2: Write the failing test** (`seasoned.test.js`)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const seasoned = require('./seasoned');

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-21T12:00:00Z');

// A fake keystore holding seeds + one non-seed, and a fake store of campaigns.
function fakeKs(wallets) {
  return { walletsWithRole: (role) => wallets.filter((w) => w.role === role) };
}
function fakeStore(transfers) {
  return { campaigns: () => [{ id: 'c1', kind: 'season', transfers }] };
}

test('available includes a funded seed aged past the gate, excludes a young one', () => {
  const ks = fakeKs([
    { id: 's1', role: 'v4seed', address: '0x1', label: 'seed-1' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'seed-2' },
    { id: 'm1', role: 'v4master', address: '0x9', label: 'master' },
  ]);
  const store = fakeStore([
    { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
    { walletId: 's2', status: 'sent', sentAt: new Date(NOW - 10 * HOUR).toISOString() },
  ]);
  const out = seasoned.available(ks, store, NOW, { minHours: 24 });
  assert.deepEqual(out.map((w) => w.id), ['s1'], 'only the 30h-old seed qualifies');
  assert.equal(out[0].hoursSinceFunded, 30);
});

test('available excludes never-funded seeds and non-seed roles, and sorts most-aged first', () => {
  const ks = fakeKs([
    { id: 's1', role: 'v4seed', address: '0x1', label: 'a' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'b' },
    { id: 's3', role: 'v4seed', address: '0x3', label: 'c' },
  ]);
  const store = fakeStore([
    { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
    { walletId: 's3', status: 'sent', sentAt: new Date(NOW - 50 * HOUR).toISOString() },
    // s2 has no sent transfer → never funded
    { walletId: 's2', status: 'pending', sentAt: null },
  ]);
  const out = seasoned.available(ks, store, NOW, { minHours: 24 });
  assert.deepEqual(out.map((w) => w.id), ['s3', 's1'], 'most-aged first, s2 absent');
});
```

- [ ] **Step 3: Run it, expect FAIL** — `node --test src/v4/seasoned.test.js`.

- [ ] **Step 4: Implement `seasoned.js`.**

```js
'use strict';

const config = require('../config');
const roles = require('./roles');

const HOUR_MS = 3600_000;

// When each funded seed last received its single seasoning transfer. Mirrors the
// 'sent' derivation in routes/v4.js fundingFacts, kept dependency-light here so
// this helper stays pure over (ks, store, now) and needs no RPC.
function fundedAtByWallet(store) {
  const byWallet = new Map();
  for (const c of store.campaigns()) {
    for (const t of c.transfers || []) {
      if (t.status !== 'sent' || !t.sentAt) continue;
      byWallet.set(t.walletId, t.sentAt);
    }
  }
  return byWallet;
}

/**
 * The V4 seed wallets V1/V3 may claim: funded, and aged at least `minHours`.
 * Most-aged first. Pure over its inputs — pass `now` in ms.
 */
function available(ks, store, now, { minHours = config.seasonedMinHours } = {}) {
  const fundedAt = fundedAtByWallet(store);
  return ks
    .walletsWithRole(roles.ROLES.seed)
    .map((w) => {
      const at = fundedAt.get(w.id);
      if (!at) return null;
      const hoursSinceFunded = Math.floor((now - Date.parse(at)) / HOUR_MS);
      return hoursSinceFunded >= minHours
        ? { id: w.id, address: w.address, label: w.label, fundedAt: at, hoursSinceFunded }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.hoursSinceFunded - a.hoursSinceFunded);
}

module.exports = { available, HOUR_MS, _private: { fundedAtByWallet } };
```

- [ ] **Step 5: Run it, expect PASS** — `node --test src/v4/seasoned.test.js`.

- [ ] **Step 6: Commit** — `feat: v4 seasoned.available + SEASONED_MIN_HOURS`.

---

### Task 3: `seasoned.claim()`

**Files:**
- Modify: `backend/src/v4/seasoned.js`, `backend/src/v4/seasoned.test.js`

**Interfaces:**
- Consumes: `available` (Task 2), `keystore.setRole(id, role)`, `store.recordGraduated(entries)`.
- Produces: `claim(ks, store, ids, { toRole, toTab, now, minHours })` → `{ claimed: [{ id, address, label }], graduatedAt }`. Throws naming the first id that is not currently claimable. All-or-nothing: validates every id before the first `setRole`.

- [ ] **Step 1: Write the failing test** (append)

```js
function claimKs(wallets, roleLog) {
  return {
    walletsWithRole: (role) => wallets.filter((w) => w.role === role),
    setRole: (id, role) => {
      const w = wallets.find((x) => x.id === id);
      w.role = role;
      roleLog.push({ id, role });
    },
  };
}

test('claim re-roles available seeds and records them graduated, all-or-nothing', () => {
  const wallets = [
    { id: 's1', role: 'v4seed', address: '0x1', label: 'a' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'b' },
  ];
  const log = [];
  const ks = claimKs(wallets, log);
  const graduated = [];
  const store = {
    campaigns: () => [{ id: 'c', kind: 'season', transfers: [
      { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
      { walletId: 's2', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
    ]}],
    recordGraduated: (e) => graduated.push(...e),
  };
  const out = seasoned.claim(ks, store, ['s1', 's2'], { toRole: 'v3bundle', toTab: 'v3', now: NOW, minHours: 24 });
  assert.equal(out.claimed.length, 2);
  assert.deepEqual(log.map((x) => x.role), ['v3bundle', 'v3bundle']);
  assert.equal(graduated.length, 2);
  assert.equal(graduated[0].toTab, 'v3');
});

test('claim refuses an id that is not currently claimable and re-roles nothing', () => {
  const wallets = [{ id: 's1', role: 'v4seed', address: '0x1', label: 'a' }];
  const log = [];
  const ks = claimKs(wallets, log);
  const store = {
    campaigns: () => [{ id: 'c', kind: 'season', transfers: [
      { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
    ]}],
    recordGraduated: () => {},
  };
  assert.throws(
    () => seasoned.claim(ks, store, ['s1', 'ghost'], { toRole: 'v3bundle', toTab: 'v3', now: NOW, minHours: 24 }),
    /ghost/
  );
  assert.equal(log.length, 0, 'nothing re-roled when one id is bad');
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement — add `claim` to `seasoned.js` and export it.**

```js
function claim(ks, store, ids, { toRole, toTab, now, minHours = config.seasonedMinHours }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids[] is required');
  const byId = new Map(available(ks, store, now, { minHours }).map((w) => [w.id, w]));
  const picked = ids.map((id) => {
    const w = byId.get(id);
    if (!w) throw new Error(`wallet ${id} is not a claimable seasoned wallet`);
    return w;
  });
  const graduatedAt = new Date(now).toISOString();
  for (const w of picked) ks.setRole(w.id, toRole);
  store.recordGraduated(picked.map((w) => ({ id: w.id, address: w.address, toTab, at: graduatedAt })));
  return { claimed: picked.map((w) => ({ id: w.id, address: w.address, label: w.label })), graduatedAt };
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `feat: v4 seasoned.claim`.

---

### Task 4: `GET /api/v4/seasoned`

**Files:**
- Modify: `backend/src/routes/v4.js`, `backend/src/routes/v4.test.js`

**Interfaces:**
- Produces: `GET /api/v4/seasoned` → `{ count, minHours, wallets: [{ id, address, label, fundedAt, hoursSinceFunded }] }`.

- [ ] **Step 1: Route.** In `routes/v4.js`, require the helper at top (`const seasoned = require('../v4/seasoned');`) and add (place near the other read routes; use the file's own `now = Date.now()` pattern):

```js
// GET /api/v4/seasoned — the seed wallets aged enough for V1/V3 to claim.
router.get('/v4/seasoned', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const wallets = seasoned.available(ks, store, Date.now());
    res.json({ count: wallets.length, minHours: config.seasonedMinHours, wallets });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Test** (add to `v4.test.js`, following its existing route-test harness — build a keystore with a funded+aged seed via the store, hit the handler, assert `count === 1`). Use the same request/response fakes already used by other tests in that file.

- [ ] **Step 3: Run** `node --test src/routes/v4.test.js`, expect PASS.

- [ ] **Step 4: Commit** — `feat: GET /api/v4/seasoned`.

---

### Task 5: V1 claim endpoint

**Files:**
- Modify: `backend/src/routes/wallets.js`, add a test to the file's suite.

**Interfaces:**
- Produces: `POST /api/wallets/claim-seasoned` body `{ count }` → `{ claimed: [...], available, shortfall }`. Honors `assertBundleRoom(ks, 'bundle', n)`.

- [ ] **Step 1: Route.** In `routes/wallets.js` require `seasoned` and `storeFor`, then:

```js
// POST /api/wallets/claim-seasoned — pull N of V4's finished-seasoning wallets
// into V1's bundle role, most-aged first. They arrive pre-aged and pre-funded.
router.post('/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    assertBundleRoom(ks, 'bundle', take.length); // refuses before any re-role
    const out = seasoned.claim(ks, store, take.map((w) => w.id), { toRole: 'bundle', toTab: 'v1', now: Date.now() });
    activityFor(req.user.id).record('wallets', `claimed ${out.claimed.length} seasoned wallet(s) into v1 bundle`, {
      count: out.claimed.length,
    });
    res.json({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2: Test** — construct a keystore + store with 2 funded+aged seeds, POST `{ count: 5 }`, assert 2 claimed + `shortfall === 3` and both are now role `bundle`. Add a case that exceeds the 31-cap and asserts the refusal message.

- [ ] **Step 3: Run** the wallets route tests, expect PASS.

- [ ] **Step 4: Commit** — `feat: V1 claim-seasoned`.

---

### Task 6: V3 claim endpoint

**Files:**
- Modify: `backend/src/routes/v3.js`, `backend/src/routes/v3.test.js`

**Interfaces:**
- Produces: `POST /api/v3/wallets/claim-seasoned` body `{ count }` → `{ claimed, available, shortfall }`. Refused mid-run.

- [ ] **Step 1: Route.** In `routes/v3.js` require `seasoned` and `storeFor`, then:

```js
// POST /api/v3/wallets/claim-seasoned — pull N finished-seasoning wallets into
// V3's bundle role. Refused mid-run: the engine resolves wallets by id per cycle.
router.post('/v3/wallets/claim-seasoned', requireApiKey, (req, res, next) => {
  try {
    if (engine.isRunning(req.user.id)) {
      throw new Error('a v3 run is in progress — stop it before claiming wallets');
    }
    const ks = keystoreFor(req.user.id);
    const store = storeFor(req.user.id);
    const want = Math.max(1, Math.round(Number((req.body || {}).count) || 0));
    const pool = seasoned.available(ks, store, Date.now());
    const take = pool.slice(0, want);
    const out = seasoned.claim(ks, store, take.map((w) => w.id), { toRole: v3roles.ROLES.bundle, toTab: 'v3', now: Date.now() });
    activityFor(req.user.id).record('v3', `[v3] claimed ${out.claimed.length} seasoned wallet(s) into the bundle`, {
      count: out.claimed.length,
    });
    res.json(jsonSafe({ claimed: out.claimed, available: pool.length, shortfall: Math.max(0, want - take.length) }));
  } catch (err) {
    next(err);
  }
});
```

Note: `storeFor` is `require('../v4/store').storeFor` — add the import.

- [ ] **Step 2: Test** — funded+aged seeds, POST `{ count: 2 }`, assert claimed + role `v3bundle`; a second test with `engine.isRunning` stubbed true asserts the mid-run refusal.

- [ ] **Step 3: Run** `node --test src/routes/v3.test.js`, expect PASS.

- [ ] **Step 4: Commit** — `feat: V3 claim-seasoned`.

---

### Task 7: Frontend — claim controls + graduated view (build-verified)

**Files:**
- Modify: `frontend/src/api.js` (nothing new needed — uses `api()`), `frontend/src/components/WalletsPanel.jsx`, `frontend/src/v3/V3BundlePanel.jsx`, `frontend/src/v4/V4SeedPanel.jsx`.

No component test harness exists; verify with `cd frontend && npm run build`.

- [ ] **Step 1: Shared availability read.** In each consuming panel, on mount/reload fetch `api('/v4/seasoned')` into state `{ count }` (guard errors quietly like other background reads).

- [ ] **Step 2: V1 control** (`WalletsPanel.jsx`, beside Generate): a number input + `Use N seasoned wallets` Busy button calling `api('/wallets/claim-seasoned', 'POST', { count })` then reloading. Show `{count} seasoned ready` when >0; disable at 0. On success `report()` the claimed count and shortfall.

- [ ] **Step 3: V3 control** (`V3BundlePanel.jsx`, beside Generate/import, `disabled={locked}`): same, calling `/v3/wallets/claim-seasoned`.

- [ ] **Step 4: V4 graduated view** (`V4SeedPanel.jsx`): fetch `api('/v4/seasoned')` for the ready count, and a read-only line/list of graduated wallets — add `GET /api/v4/graduated` (Task 4 sibling: one line in routes/v4.js returning `store.graduated()`), fetched and rendered as "N handed off" with address · tab · date. (If you prefer, fold the graduated list into the `/v4/seasoned` response as `graduated: store.graduated()` instead of a second route — pick one and keep the frontend matching.)

- [ ] **Step 5: Build** — `cd frontend && npm run build`, expect success.

- [ ] **Step 6: Commit** — `feat: seasoned-wallet claim UI + v4 graduated view`.

---

### Task 8: Full backend suite + docs

- [ ] **Step 1:** `cd backend && node --test 'src/**/*.test.js'` — expect all pass.
- [ ] **Step 2:** Confirm `.env.example` documents `SEASONED_MIN_HOURS` and the spec matches what shipped; note any deviation (e.g. `available()` returns no balance) in the spec.
- [ ] **Step 3: Commit** any doc touch-ups — `docs: reconcile seasoned-handoff spec with implementation`.

---

## Self-review

- **Spec coverage:** availability gate (Task 2), claim/re-role (Task 3), graduated registry (Task 1), GET availability (Task 4), V1 claim + 31-cap (Task 5), V3 claim + mid-run refusal (Task 6), UI + graduated view (Task 7), balance handling (documented, no code — per spec), config 24h (Task 2). All covered.
- **Deviation from spec:** `available()` returns no `balanceEth` (would require RPC and break purity); the claim decision does not need it. Recorded in Task 8.
- **Type consistency:** `available()` → `{id,address,label,fundedAt,hoursSinceFunded}` used identically in `claim`, the routes, and the GET response. `claim()` → `{claimed:[{id,address,label}], graduatedAt}` consumed the same way in both route tasks. `recordGraduated(entries)` shape `{id,address,toTab,at}` matches what `claim` passes and `graduated()` returns.
