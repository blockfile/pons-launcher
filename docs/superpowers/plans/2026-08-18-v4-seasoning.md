# V4 Seasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth tab that funds fresh wallets through Relay over weeks rather than minutes, running several campaigns in parallel — one per funding wallet — and surviving server restarts.

**Architecture:** Every dice is rolled once at campaign start and the whole schedule is persisted to disk; the runner reads that plan rather than accumulating state. Timers are keyed by campaign, not by user, so campaigns run in parallel — bounded by one running campaign per funding wallet, because two sends from one address would collide on the pending nonce. Everything lives in `backend/src/v4/` and `frontend/src/v4/`.

**Tech Stack:** Node 20 CommonJS, `node --test`, ethers v6, Express 4, React 18 + Vite.

## Global Constraints

- **ISOLATION IS THE FIRST REQUIREMENT.** No function in `v1`, `v2`, `v3` or the distributor is modified. Task 1 is the single exception and is explicitly approved: it makes a shared write *safer* without changing its semantics.
- Only three files outside `src/v4/` and `frontend/src/v4/` are edited, all **additive**: `wallets/keystore.js` (two strings into a Set), `server.js` (mount + boot resume), `App.jsx` (one tab button + one branch).
- V4 does **not** import from `src/v3/`, `src/relay/`, `src/bundle/` or `routes/`. It may import `config`, `evm/provider`, `evm/fees`, `evm/errors`, `wallets/keystore`, `store/activity`, `middleware/auth` — the shared infrastructure every tab already reads.
- Role strings: `v4master`, `v4seed`. These appear in `v4/roles.js` and in the `ROLES` set in `keystore.js`, nowhere else. `v4master` must **not** be added to `SINGLETON_ROLES`.
- Both Relay ends are `config.chainId`. No second provider, no cross-chain.
- Tests run with `npm test --workspace backend`. Test files sit beside their source as `*.test.js`.
- No test may touch the network, the real clock, or the real keystore path.

---

### Task 1: Make the keystore write atomic

**Files:**
- Modify: `backend/src/wallets/keystore.js:195-199`
- Test: `backend/src/wallets/keystore.atomic.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces: nothing new — `persist()` keeps its exact signature and semantics

This is the one shared-code change in the plan, approved separately because it protects v1/v2/v3 keys rather than endangering them. Generating 400 wallets calls `persist()` 400 times, and each call rewrites the entire keystore. A crash mid-write truncates the file holding every key in the deployment.

- [ ] **Step 1: Write the failing test**

Create `backend/src/wallets/keystore.atomic.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The guarantee: after persist(), no partially-written file is ever visible at
// the keystore path. We prove it by asserting the temp file is gone and the
// real file parses — a plain writeFileSync of a large object can leave the
// second untrue if the process dies, and leaves no temp file at all.
test('persist writes through a temp file and leaves no debris', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  process.env.KEYSTORE_PASSPHRASE = 'test-passphrase';
  process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');

  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./keystore')];
  const { keystoreFor } = require('./keystore');

  const ks = keystoreFor('default');
  ks.generate(2, { role: 'bundle' });

  const file = process.env.KEYSTORE_PATH;
  assert.equal(fs.existsSync(file), true, 'keystore file exists');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'temp file was renamed away');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));

  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600, 'still 0600');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "temp file"`
Expected: FAIL — no `.tmp` handling exists, so the assertion about mode may pass but the test documents the contract. If it passes trivially, that is fine; the real proof is Step 3's implementation plus the mode assertion.

- [ ] **Step 3: Make persist atomic**

Replace `backend/src/wallets/keystore.js:195-199`:

```js
  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // ATOMIC, and not merely tidy. add() calls this once per wallet, and each
    // call rewrites the WHOLE keystore — every role, every user's own file.
    // Generating a batch of V4 seed wallets is hundreds of consecutive full
    // rewrites, and a process killed partway through a plain writeFileSync
    // leaves a truncated file where every private key used to be. Writing to a
    // sibling and renaming makes the swap a single filesystem operation: the
    // path either holds the old complete file or the new complete file, never
    // half of either. 0600 is set on the temp file so the keys are never even
    // momentarily readable by another account.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
```

- [ ] **Step 4: Run the whole backend suite**

Run: `npm test --workspace backend`
Expected: PASS, with no change in any existing test. This change must be invisible to every caller.

- [ ] **Step 5: Commit alone**

```bash
git add backend/src/wallets/keystore.js backend/src/wallets/keystore.atomic.test.js
git commit -m "Write the keystore through a temp file, not over itself"
```

---

### Task 2: V4's role table

**Files:**
- Create: `backend/src/v4/roles.js`
- Create: `backend/src/v4/roles.test.js`
- Modify: `backend/src/wallets/keystore.js` — `ROLES` set only

**Interfaces:**
- Produces: `ROLES = { master: 'v4master', seed: 'v4seed' }`, `isV4Role(role) -> boolean`, `masters(ks) -> wallet[]`, `seeds(ks) -> wallet[]`, `all(ks) -> { masters, seeds }`

- [ ] **Step 1: Write the failing test**

Create `backend/src/v4/roles.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const roles = require('./roles');

function ks(wallets = []) {
  return {
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
}

const V4 = [
  { id: 'm1', role: 'v4master', address: '0x0000000000000000000000000000000000000001' },
  { id: 'm2', role: 'v4master', address: '0x0000000000000000000000000000000000000002' },
  { id: 's1', role: 'v4seed', address: '0x0000000000000000000000000000000000000003' },
];

// Every role owned by another strategy. If a V4 lookup returns one of these,
// two strategies are spending one wallet.
const OTHERS = [
  { id: 'a', role: 'dev', address: '0x00000000000000000000000000000000000000a1' },
  { id: 'b', role: 'bundle', address: '0x00000000000000000000000000000000000000a2' },
  { id: 'c', role: 'v2dev', address: '0x00000000000000000000000000000000000000a3' },
  { id: 'd', role: 'v2bundle', address: '0x00000000000000000000000000000000000000a4' },
  { id: 'e', role: 'distdev', address: '0x00000000000000000000000000000000000000a5' },
  { id: 'f', role: 'distfunding', address: '0x00000000000000000000000000000000000000a6' },
  { id: 'g', role: 'distbundle', address: '0x00000000000000000000000000000000000000a7' },
  { id: 'h', role: 'v2funding', address: '0x00000000000000000000000000000000000000a8' },
  { id: 'i', role: 'v3dev', address: '0x00000000000000000000000000000000000000a9' },
  { id: 'j', role: 'v3main', address: '0x00000000000000000000000000000000000000aa' },
  { id: 'k', role: 'v3bundle', address: '0x00000000000000000000000000000000000000ab' },
];

test('the role names are v4s own', () => {
  assert.deepEqual(roles.ROLES, { master: 'v4master', seed: 'v4seed' });
});

test('isV4Role accepts only v4s two', () => {
  assert.equal(roles.isV4Role('v4master'), true);
  assert.equal(roles.isV4Role('v4seed'), true);
  for (const other of OTHERS) assert.equal(roles.isV4Role(other.role), false);
});

test('the lookups never resolve another strategys wallet', () => {
  const store = ks(OTHERS);
  assert.deepEqual(roles.masters(store), []);
  assert.deepEqual(roles.seeds(store), []);
});

test('the lookups find v4s own among everyone elses', () => {
  const store = ks([...OTHERS, ...V4]);
  assert.deepEqual(roles.masters(store).map((w) => w.id), ['m1', 'm2']);
  assert.deepEqual(roles.seeds(store).map((w) => w.id), ['s1']);
});

test('master is plural — parallel campaigns need more than one', () => {
  const store = ks(V4);
  assert.equal(roles.masters(store).length, 2);
});

test('empty is not an error — it is the state the tab starts in', () => {
  assert.deepEqual(roles.all(ks()), { masters: [], seeds: [] });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "role names are v4"`
Expected: FAIL — `Cannot find module './roles'`

- [ ] **Step 3: Write `backend/src/v4/roles.js`**

```js
'use strict';

/**
 * Which wallets V4 owns.
 *
 * DELIBERATELY NOT AN ENTRY IN wallets/variants.js, and deliberately not an
 * entry in v3/roles.js either. Those are other strategies' tables. Two tables
 * that share nothing cannot confuse each other: a v1 request cannot resolve a
 * V4 wallet because variants.js has never heard of these strings, and a V4
 * request cannot resolve v1's, v2's or V3's because this file has never heard
 * of theirs. The test beside this asserts exactly that, over every role in the
 * keystore.
 *
 * TWO ROLES, NOT THREE:
 *
 *   v4master  the funding wallets. Pay for a campaign and do nothing else —
 *             never buy, never sell, never hold supply.
 *   v4seed    the fresh wallets. Receive exactly one transfer, then sit.
 *
 * There is no equivalent of v3main because nothing here trades.
 *
 * v4master IS PLURAL, and that is the whole of how parallel campaigns work.
 * Every other treasury role in the keystore is a singleton — one dev, one
 * v3dev — because those strategies have one position and one payer. V4 runs
 * several campaigns at once and each needs a payer with no connection to the
 * others, so `v4master` is deliberately NOT in SINGLETON_ROLES.
 *
 * The strings must also be in ROLES in wallets/keystore.js. That is the one
 * edit V4 makes to that file, and it is not optional: add() resolves an unknown
 * role to 'bundle', so without it every V4 wallet would be created holding v1's
 * bundle role and appear on the V1 tab, spendable by v1's launcher.
 */

const ROLES = {
  master: 'v4master',
  seed: 'v4seed',
};

/** Is this one of V4's two? Used to refuse V4 routes a wallet they don't own. */
function isV4Role(role) {
  return role === ROLES.master || role === ROLES.seed;
}

/**
 * Every funding wallet. Empty is not an error: it is the state the tab starts
 * in, and a campaign is what refuses to start without one.
 */
function masters(ks) {
  return ks.walletsWithRole(ROLES.master);
}

/** Every seed wallet, claimed or not. The store decides which are spoken for. */
function seeds(ks) {
  return ks.walletsWithRole(ROLES.seed);
}

/** Both groups at once — what GET /v4/wallets reads. */
function all(ks) {
  return { masters: masters(ks), seeds: seeds(ks) };
}

module.exports = { ROLES, isV4Role, masters, seeds, all };
```

- [ ] **Step 4: Add the strings to the keystore's ROLES set**

In `backend/src/wallets/keystore.js`, extend the `ROLES` set (around line 84). Add **only** these two lines inside the existing `new Set([...])`, after `'v3bundle',`:

```js
  'v4master',
  'v4seed',
```

Then extend the comment block above the set with:

```js
// v4master / v4seed are the fifth owner — the seasoning campaigns. Their names
// live in v4/roles.js, which is V4's own table and shares nothing with
// variants.js or v3/roles.js. v4master is deliberately NOT in SINGLETON_ROLES:
// campaigns run in parallel, one per funding wallet, so a singleton would cap
// the whole feature at one campaign.
```

**Do not touch `SINGLETON_ROLES`.**

- [ ] **Step 5: Run tests**

Run: `npm test --workspace backend`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Commit**

```bash
git add backend/src/v4/roles.js backend/src/v4/roles.test.js backend/src/wallets/keystore.js
git commit -m "Give v4 its own role table"
```

---

### Task 3: V4's Relay client

**Files:**
- Create: `backend/src/v4/relay.js`
- Create: `backend/src/v4/relay.test.js`

**Interfaces:**
- Consumes: `config`, `evm/provider`, `evm/fees`, `evm/errors`
- Produces: `transfer({ fromWallet, toAddress, amountWei }, deps) -> Promise<entry>` where `entry = { from, to, amountEth, depositEth, requestId, depositAddress, hash | simulated }`; `status(requestId, deps)`; `quoteBody({ from, recipient, amountWei })`; `depositStep(quote, { expectedFrom })`

This is a deliberate third copy of the same idea (see the spec). It is the *smallest* of the three — V4 needs `transfer()` and `status()` and nothing else. Do not import `v3/relay.js`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/v4/relay.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const relay = require('./relay');

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const DEPOSIT = '0x3333333333333333333333333333333333333333';

function quote({ from = FROM, chainId, value = '1100000000000000' } = {}) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: `0x${'ab'.repeat(32)}`,
        depositAddress: DEPOSIT,
        items: [
          {
            kind: 'transaction',
            check: { endpoint: '/x' },
            data: { from, to: DEPOSIT, value, gas: '50000', chainId: chainId ?? require('../config').chainId },
          },
        ],
      },
    ],
    fees: {},
    details: {},
  };
}

test('the order is same-chain and exact-output', () => {
  const body = relay.quoteBody({ from: FROM, recipient: TO, amountWei: parseEther('0.004') });
  const { chainId } = require('../config');
  assert.equal(body.originChainId, Number(chainId));
  assert.equal(body.destinationChainId, Number(chainId));
  assert.equal(body.tradeType, 'EXACT_OUTPUT');
  assert.equal(body.strict, true);
  // A refund must land where the payer will look for it, not with whoever asked.
  assert.equal(body.refundTo.toLowerCase(), FROM.toLowerCase());
});

test('depositStep refuses a quote from the wrong wallet', () => {
  assert.throws(
    () => relay.depositStep(quote({ from: TO }), { expectedFrom: FROM }),
    /expected/
  );
});

test('depositStep refuses another chain', () => {
  assert.throws(() => relay.depositStep(quote({ chainId: 999999 }), {}), /chain/);
});

test('depositStep refuses a zero deposit', () => {
  assert.throws(() => relay.depositStep(quote({ value: '0' }), {}), /positive/);
});

test('transfer refuses when the payer cannot cover deposit plus gas', async () => {
  await assert.rejects(
    relay.transfer(
      { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
      {
        keystore: {},
        dryRun: false,
        relayQuote: async () => quote(),
        getFeesFn: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
        rpc: { getBalance: async () => 1n, getTransactionCount: async () => 0 },
      }
    ),
    /needs/
  );
});

test('a dry run quotes and signs nothing', async () => {
  const out = await relay.transfer(
    { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
    {
      dryRun: true,
      relayQuote: async () => quote(),
      getFeesFn: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      rpc: { getBalance: async () => parseEther('10'), getTransactionCount: async () => 0 },
    }
  );
  assert.equal(out.simulated, true);
  assert.equal(out.hash, null);
  assert.equal(out.depositAddress.toLowerCase(), DEPOSIT.toLowerCase());
});

test('a live transfer signs with the pending nonce and returns the hash', async () => {
  let signed = null;
  const out = await relay.transfer(
    { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
    {
      dryRun: false,
      keystore: {
        signer: () => ({
          sendTransaction: async (tx) => {
            signed = tx;
            return { hash: `0x${'cd'.repeat(32)}` };
          },
        }),
      },
      relayQuote: async () => quote(),
      getFeesFn: async () => ({ maxFeePerGas: 7n, maxPriorityFeePerGas: 2n }),
      rpc: { getBalance: async () => parseEther('10'), getTransactionCount: async () => 41 },
    }
  );
  assert.equal(signed.nonce, 41);
  // Relay's own fee fields are dropped and re-read from the chain.
  assert.equal(signed.maxFeePerGas, 7n);
  assert.match(out.hash, /^0x[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "same-chain and exact-output"`
Expected: FAIL — `Cannot find module './relay'`

- [ ] **Step 3: Write `backend/src/v4/relay.js`**

Copy the structure of `backend/src/v3/relay.js`, keeping only `quoteBody`, `depositStep`, `normaliseTx`, `gasLimitOf`, `publicFees`, `publicDetails`, `transfer` and `status`. Change the header comment to name V4 and its reason:

```js
'use strict';

/**
 * V4's Relay client: move ETH from a funding wallet we hold to a seed wallet,
 * on this chain, through a Relay solver.
 *
 * DELIBERATELY NOT A REFACTOR OF v3/relay.js OR relay/funding.js. Those are
 * other strategies' money paths and they work. This is the third
 * implementation of the same idea, and the duplication is the price of the
 * three never being able to break each other.
 *
 * V4 has the strongest version of that argument. A campaign runs unattended for
 * three weeks. A shared client would mean a change made for V3 on a Tuesday
 * alters what V4 signs, unwatched, on day 11 of a run nobody is looking at.
 *
 * WHY RELAY AT ALL, WHEN BOTH ENDS ARE ON THE SAME CHAIN: not to bridge. The
 * transfer exists to break the edge. A direct send from the funding wallet to a
 * seed wallet draws a line anyone reading the chain can follow, and 400 of
 * those lines from one address is the whole shape this strategy spends three
 * weeks avoiding. With Relay the funder pays a deposit address and a SOLVER
 * pays the seed wallet — two transactions with no counterparty in common.
 *
 * EXACT_OUTPUT, not EXACT_INPUT: what matters is what ARRIVES in the seed
 * wallet. The fee comes off the sender's side, so the deposit Relay quotes is
 * always larger than the amount ordered — which is why plan.js budgets fees on
 * top of the sum of the amounts.
 */
```

The body is the same code as `v3/relay.js:29-249`, with `FEE_BUMP_PCT = 50` and the `transfer()` error message naming V4. Every dependency stays injectable exactly as it is there — the tests above supply `relayQuote`, `getFeesFn`, `rpc` and `keystore`.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace backend -- --test-name-pattern "transfer|deposit|order is same-chain"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/v4/relay.js backend/src/v4/relay.test.js
git commit -m "Give v4 its own Relay client"
```

---

### Task 4: Seeded dice and plan generation

**Files:**
- Create: `backend/src/v4/rng.js`
- Create: `backend/src/v4/plan.js`
- Create: `backend/src/v4/plan.test.js`

**Interfaces:**
- Produces:
  - `rng.make(seed) -> { next(): number in [0,1), int(min,max): integer inclusive, pick(array) }`
  - `rng.newSeed() -> string` (32 hex chars)
  - `plan.DEFAULTS` — the parameter defaults
  - `plan.normaliseParams(raw) -> params` (throws on bad input)
  - `plan.feasible(walletCount, params) -> { ok, min, max, reason }`
  - `plan.generate({ walletIds, addresses, params, seed, now }) -> { seed, params, transfers[], byDay[], totalEth }`
  - `plan.estimateCost(transfers, { feePct, gasWei }) -> { depositsWei, feesWei, gasWei, totalWei, totalEth }`

Transfer shape produced here and consumed by Tasks 5–7:

```js
{ id, walletId, address, amountEth, dueAt, day, status: 'pending', attempts: [],
  requestId: null, depositAddress: null, hash: null, sentAt: null }
```

- [ ] **Step 1: Write the failing test**

Create `backend/src/v4/plan.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const plan = require('./plan');
const rng = require('./rng');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-01T00:00:00.000Z');

function wallets(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    address: `0x${String(i + 1).padStart(40, '0')}`,
  }));
}

function build(n, overrides = {}, seed = 'a'.repeat(32)) {
  const ws = wallets(n);
  return plan.generate({
    walletIds: ws.map((w) => w.id),
    addresses: Object.fromEntries(ws.map((w) => [w.id, w.address])),
    params: plan.normaliseParams({ ...overrides }),
    seed,
    now: NOW,
  });
}

test('the same seed and params give the same plan', () => {
  const a = build(60);
  const b = build(60);
  assert.deepEqual(a.transfers, b.transfers);
});

test('a different seed gives a different plan', () => {
  const a = build(60, {}, 'a'.repeat(32));
  const b = build(60, {}, 'b'.repeat(32));
  assert.notDeepEqual(a.transfers, b.transfers);
});

test('every wallet is funded exactly once', () => {
  const out = build(400, { days: 20 });
  assert.equal(out.transfers.length, 400);
  assert.equal(new Set(out.transfers.map((t) => t.walletId)).size, 400);
});

test('feasibility refuses too many wallets for the days, naming the ceiling', () => {
  const check = plan.feasible(700, plan.normaliseParams({ days: 20 }));
  assert.equal(check.ok, false);
  assert.equal(check.max, 600);
  assert.match(check.reason, /600/);
});

test('feasibility refuses too few wallets for the days, naming the floor', () => {
  const check = plan.feasible(50, plan.normaliseParams({ days: 20 }));
  assert.equal(check.ok, false);
  assert.equal(check.min, 200);
});

test('generate throws rather than silently funding a subset', () => {
  assert.throws(() => build(700, { days: 20 }), /600/);
});

test('days is a parameter, not a constant', () => {
  const out = build(21, { days: 3, perDayMin: 5, perDayMax: 10 });
  assert.equal(out.byDay.length, 3);
  assert.equal(out.transfers.length, 21);
});

test('per-day counts stay inside the configured range', () => {
  const out = build(400, { days: 20, perDayMin: 10, perDayMax: 30 });
  for (const day of out.byDay) {
    assert.ok(day.count >= 10 && day.count <= 30, `day ${day.day} had ${day.count}`);
  }
});

test('amounts sit inside the range at six decimals, and are not round', () => {
  const out = build(400);
  const seen = new Set();
  for (const t of out.transfers) {
    const n = Number(t.amountEth);
    assert.ok(n >= 0.0031 && n <= 0.0089, `${t.amountEth} out of range`);
    // Six decimals is the point: a two-decimal range has nine possible values,
    // and round numbers are themselves a pattern.
    assert.match(t.amountEth, /^\d+\.\d{6}$/);
    seen.add(t.amountEth);
  }
  assert.ok(seen.size > 300, `only ${seen.size} distinct amounts across 400 transfers`);
});

test('transfers are ordered by due time and none share a moment', () => {
  const out = build(400);
  for (let i = 1; i < out.transfers.length; i++) {
    assert.ok(out.transfers[i].dueAt > out.transfers[i - 1].dueAt);
  }
});

test('every gap respects the configured minimum', () => {
  const out = build(400, { days: 20, gapMinMs: 20 * 60_000, gapMaxMs: 4 * 3_600_000 });
  for (let i = 1; i < out.transfers.length; i++) {
    const gap = out.transfers[i].dueAt - out.transfers[i - 1].dueAt;
    assert.ok(gap >= 20 * 60_000, `gap of ${gap}ms is under the floor`);
  }
});

test('the whole campaign fits inside its days', () => {
  const out = build(400, { days: 20 });
  const last = out.transfers[out.transfers.length - 1];
  assert.ok(last.dueAt < NOW + 20 * DAY_MS);
});

test('a transfer starts pending with no attempts', () => {
  const [t] = build(30, { days: 2, perDayMin: 10, perDayMax: 20 }).transfers;
  assert.equal(t.status, 'pending');
  assert.deepEqual(t.attempts, []);
  assert.equal(t.hash, null);
});

test('cost includes relay fees and gas, not just the amounts', () => {
  const out = build(400);
  const cost = plan.estimateCost(out.transfers, { feePct: 3, gasWei: 50_000n * 2_000_000_000n });
  const deposits = cost.depositsWei;
  assert.ok(cost.totalWei > deposits, 'total must exceed the bare deposits');
  assert.ok(cost.feesWei > 0n && cost.gasWei > 0n);
});

test('normaliseParams refuses a zero-day campaign and a backwards range', () => {
  assert.throws(() => plan.normaliseParams({ days: 0 }), /days/);
  assert.throws(() => plan.normaliseParams({ days: 200 }), /days/);
  assert.throws(() => plan.normaliseParams({ perDayMin: 30, perDayMax: 10 }), /per-day/);
  assert.throws(() => plan.normaliseParams({ amountMinEth: '0.9', amountMaxEth: '0.1' }), /amount/);
  assert.throws(() => plan.normaliseParams({ gapMinMs: 0 }), /gap/);
});

test('rng is deterministic and stays in range', () => {
  const a = rng.make('seed-one');
  const b = rng.make('seed-one');
  for (let i = 0; i < 100; i++) {
    const x = a.next();
    assert.equal(x, b.next());
    assert.ok(x >= 0 && x < 1);
  }
  const r = rng.make('x');
  for (let i = 0; i < 200; i++) {
    const n = r.int(5, 9);
    assert.ok(Number.isInteger(n) && n >= 5 && n <= 9);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "same seed and params"`
Expected: FAIL — `Cannot find module './plan'`

- [ ] **Step 3: Write `backend/src/v4/rng.js`**

```js
'use strict';

/**
 * A seeded pseudo-random generator, because Math.random cannot be one.
 *
 * The plan is generated once and then lived with for weeks, so the operator has
 * to be able to prove after the fact that nothing re-rolled itself. Storing the
 * seed alongside the campaign makes the whole schedule reproducible: same seed
 * and same parameters regenerate it byte for byte. That is also what lets the
 * commit endpoint regenerate the plan server-side from a seed rather than
 * trusting a transfer list the browser has had its hands on.
 *
 * mulberry32 — small, fast, and good enough for scheduling jitter. This is NOT
 * a source of cryptographic randomness and must never be used to make a key;
 * key generation goes through the keystore, which uses crypto.
 */

const crypto = require('crypto');

/** A fresh seed. Crypto-random because a guessable schedule is a schedule. */
function newSeed() {
  return crypto.randomBytes(16).toString('hex');
}

/** Fold an arbitrary string into the 32-bit state mulberry32 wants. */
function hashSeed(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function make(seed) {
  let a = hashSeed(seed);

  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], both inclusive. */
  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  function pick(array) {
    return array[int(0, array.length - 1)];
  }

  return { next, int, pick };
}

module.exports = { make, newSeed, _private: { hashSeed } };
```

- [ ] **Step 4: Write `backend/src/v4/plan.js`**

```js
'use strict';

/**
 * The plan is the state.
 *
 * Starting a campaign rolls EVERY dice once and writes the whole schedule out.
 * Nothing is decided later. The runner does not accumulate anything; it reads
 * this list and sends whatever is due.
 *
 * That is what makes a three-week job recoverable. There is no intent to infer
 * from history after a restart — there is a list of transfers with due times,
 * and each one is either done or not.
 *
 * WHAT IS RANDOMISED, AND WHY EACH ONE: the count per day, so the batch has no
 * daily rhythm; the amount, at six decimals, so no two wallets share a figure
 * and none of them are round; the gap, so the sends have no cadence. Each is a
 * column somebody could group by.
 */

const { parseEther, formatEther } = require('ethers');
const rng = require('./rng');

const DAY_MS = 24 * 60 * 60 * 1000;

// The strategy's own numbers. Every one of them is a field on the campaign —
// these are where the form starts, not what it is limited to.
const DEFAULTS = {
  days: 20,
  perDayMin: 10,
  perDayMax: 30,
  amountMinEth: '0.0031',
  amountMaxEth: '0.0089',
  gapMinMs: 20 * 60_000,
  gapMaxMs: 4 * 3_600_000,
};

const LIMITS = {
  days: [1, 90],
  perDay: [1, 200],
  gapMs: [60_000, 24 * 3_600_000],
};

// Amounts are quoted to six decimals. A range sampled at two has nine possible
// values across the whole campaign, which is not randomness, it is a category.
const AMOUNT_DECIMALS = 6;

// How much of each day the transfers are allowed to occupy. Leaving a margin
// means the last transfer of a day cannot collide with the first of the next.
const DAY_FILL = 0.95;

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${value}"`);
  return n;
}

function ethString(value, what) {
  const raw = String(value ?? '').trim();
  if (!/^\d*\.?\d+$/.test(raw)) throw new Error(`${what} must be a number of ETH`);
  return raw;
}

/** Validate and fill in a parameter set. Throws naming the field it refuses. */
function normaliseParams(raw = {}) {
  const days = Math.round(num(raw.days, DEFAULTS.days));
  if (days < LIMITS.days[0] || days > LIMITS.days[1]) {
    throw new Error(`days must be between ${LIMITS.days[0]} and ${LIMITS.days[1]}`);
  }

  const perDayMin = Math.round(num(raw.perDayMin, DEFAULTS.perDayMin));
  const perDayMax = Math.round(num(raw.perDayMax, DEFAULTS.perDayMax));
  if (perDayMin < LIMITS.perDay[0] || perDayMax > LIMITS.perDay[1]) {
    throw new Error(`per-day counts must be between ${LIMITS.perDay[0]} and ${LIMITS.perDay[1]}`);
  }
  if (perDayMin > perDayMax) throw new Error('per-day minimum cannot exceed the maximum');

  const amountMinEth = ethString(raw.amountMinEth ?? DEFAULTS.amountMinEth, 'amount minimum');
  const amountMaxEth = ethString(raw.amountMaxEth ?? DEFAULTS.amountMaxEth, 'amount maximum');
  if (parseEther(amountMinEth) <= 0n) throw new Error('amount minimum must be positive');
  if (parseEther(amountMinEth) > parseEther(amountMaxEth)) {
    throw new Error('amount minimum cannot exceed the maximum');
  }

  const gapMinMs = Math.round(num(raw.gapMinMs, DEFAULTS.gapMinMs));
  const gapMaxMs = Math.round(num(raw.gapMaxMs, DEFAULTS.gapMaxMs));
  if (gapMinMs < LIMITS.gapMs[0] || gapMaxMs > LIMITS.gapMs[1]) {
    throw new Error(`gaps must be between ${LIMITS.gapMs[0]}ms and ${LIMITS.gapMs[1]}ms`);
  }
  if (gapMinMs > gapMaxMs) throw new Error('gap minimum cannot exceed the maximum');

  return { days, perDayMin, perDayMax, amountMinEth, amountMaxEth, gapMinMs, gapMaxMs };
}

/**
 * Can this many wallets fit in this many days?
 *
 * Answered BEFORE anything is generated, and named in both directions. A
 * campaign that quietly funded 600 of 700 wallets would leave 100 wallets the
 * operator believes are seasoned and which have never been touched.
 */
function feasible(walletCount, params) {
  const min = params.days * params.perDayMin;
  const max = params.days * params.perDayMax;
  if (walletCount > max) {
    return {
      ok: false,
      min,
      max,
      reason:
        `${walletCount} wallets will not fit in ${params.days} days at ` +
        `${params.perDayMin}–${params.perDayMax} a day — the ceiling is ${max}. ` +
        'Raise the days, raise the daily maximum, or run fewer wallets.',
    };
  }
  if (walletCount < min) {
    return {
      ok: false,
      min,
      max,
      reason:
        `${walletCount} wallets is below the floor of ${min} for ${params.days} days at ` +
        `${params.perDayMin} a day minimum. Lower the days or the daily minimum.`,
    };
  }
  return { ok: true, min, max, reason: null };
}

/** Split `total` across `days`, each inside [min, max], summing exactly. */
function dailyCounts(total, params, r) {
  const counts = new Array(params.days).fill(params.perDayMin);
  let remaining = total - params.days * params.perDayMin;
  const room = params.perDayMax - params.perDayMin;

  // One at a time into a day that still has room. O(remaining), and remaining
  // is at most days × room — a few hundred for any realistic campaign.
  while (remaining > 0) {
    const open = [];
    for (let d = 0; d < counts.length; d++) {
      if (counts[d] - params.perDayMin < room) open.push(d);
    }
    const d = r.pick(open);
    counts[d] += 1;
    remaining -= 1;
  }
  return counts;
}

/** A random amount in range, quoted to six decimals. */
function amountFor(params, r) {
  const min = Number(params.amountMinEth);
  const max = Number(params.amountMaxEth);
  return (min + r.next() * (max - min)).toFixed(AMOUNT_DECIMALS);
}

/**
 * The send times for one day.
 *
 * Gaps are drawn from the configured range, then scaled down if they overrun
 * the day. THE RANGE IS A DISTRIBUTION, NOT A GUARANTEE: at 30 wallets in a day
 * the gaps must average under 48 minutes, so the top of a 4-hour range simply
 * will not be drawn. The daily count is the parameter a filter would key on,
 * so it wins.
 */
function dayTimes(dayStart, count, params, r) {
  const gaps = [];
  for (let i = 0; i < count; i++) {
    gaps.push(params.gapMinMs + r.next() * (params.gapMaxMs - params.gapMinMs));
  }

  const usable = DAY_MS * DAY_FILL;
  let total = gaps.reduce((a, b) => a + b, 0);
  if (total > usable) {
    const scale = usable / total;
    for (let i = 0; i < gaps.length; i++) {
      gaps[i] = Math.max(params.gapMinMs, gaps[i] * scale);
    }
    total = gaps.reduce((a, b) => a + b, 0);
  }

  // Slide the whole day's run to a random offset in whatever slack is left, so
  // the campaign does not start at the same time every morning.
  const slack = Math.max(0, DAY_MS - total);
  let at = dayStart + Math.floor(r.next() * slack);

  const times = [];
  for (const gap of gaps) {
    at += Math.round(gap);
    times.push(at);
  }
  return times;
}

/**
 * Roll the whole campaign.
 *
 * @param {object} input
 * @param {string[]} input.walletIds  seed wallet ids, each funded exactly once
 * @param {object} input.addresses    walletId -> address
 * @param {object} input.params       from normaliseParams
 * @param {string} input.seed         stored with the campaign; makes this reproducible
 * @param {number} input.now          campaign start, ms since epoch
 */
function generate({ walletIds, addresses, params, seed, now }) {
  const check = feasible(walletIds.length, params);
  if (!check.ok) throw new Error(check.reason);

  const r = rng.make(seed);
  const counts = dailyCounts(walletIds.length, params, r);

  // Shuffle which wallet lands on which day, so creation order is not funding
  // order — consecutive ids funded on consecutive days is itself an edge.
  const pool = walletIds.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const transfers = [];
  const byDay = [];
  let cursor = 0;

  for (let d = 0; d < params.days; d++) {
    const count = counts[d];
    const times = dayTimes(now + d * DAY_MS, count, params, r);
    const ids = pool.slice(cursor, cursor + count);
    cursor += count;

    let dayEth = 0;
    ids.forEach((walletId, i) => {
      const amountEth = amountFor(params, r);
      dayEth += Number(amountEth);
      transfers.push({
        id: `${d + 1}-${i + 1}`,
        walletId,
        address: addresses[walletId],
        amountEth,
        dueAt: times[i],
        day: d + 1,
        status: 'pending',
        attempts: [],
        requestId: null,
        depositAddress: null,
        hash: null,
        sentAt: null,
      });
    });

    byDay.push({ day: d + 1, count, totalEth: dayEth.toFixed(AMOUNT_DECIMALS) });
  }

  transfers.sort((a, b) => a.dueAt - b.dueAt);

  const totalWei = transfers.reduce((sum, t) => sum + parseEther(t.amountEth), 0n);
  return { seed, params, transfers, byDay, totalEth: formatEther(totalWei) };
}

/**
 * What the campaign actually costs the funding wallet.
 *
 * NOT the sum of the amounts. An EXACT_OUTPUT order charges Relay's fee on the
 * SENDER's side, so every deposit is larger than the amount ordered, and every
 * deposit costs gas of its own. A campaign budgeted on the bare sum runs dry
 * near the end — which is the worst possible moment, because the wallets that
 * go unfunded are the ones with the least time left to season.
 */
function estimateCost(transfers, { feePct = 3, gasWei = 0n } = {}) {
  const depositsWei = transfers.reduce((sum, t) => sum + parseEther(t.amountEth), 0n);
  const feesWei = (depositsWei * BigInt(Math.round(feePct * 100))) / 10_000n;
  const totalGasWei = BigInt(gasWei) * BigInt(transfers.length);
  const totalWei = depositsWei + feesWei + totalGasWei;
  return {
    depositsWei,
    feesWei,
    gasWei: totalGasWei,
    totalWei,
    totalEth: formatEther(totalWei),
  };
}

module.exports = {
  DAY_MS,
  DEFAULTS,
  LIMITS,
  normaliseParams,
  feasible,
  generate,
  estimateCost,
  _private: { dailyCounts, dayTimes, amountFor },
};
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace backend -- --test-name-pattern "seed|wallet is funded|feasib|amounts|gap|days is a parameter|cost|rng"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/v4/rng.js backend/src/v4/plan.js backend/src/v4/plan.test.js
git commit -m "Roll a whole seasoning campaign from one stored seed"
```

---

### Task 5: Persistence

**Files:**
- Create: `backend/src/v4/store.js`
- Create: `backend/src/v4/store.test.js`

**Interfaces:**
- Produces: `storeFor(userId) -> { campaigns(), get(id), create(campaign), update(id, patch), updateTransfer(id, transferId, patch), running(), recordBackup(walletIds), backedUp(walletIds) -> string[] (the ones NOT backed up), claimedSeedIds(), _reset() }`
- `pathFor(userId)` exported for tests

Campaign record shape, consumed by Tasks 6–8:

```js
{ id, name, status, seed, createdAt, startedAt, completedAt, haltedAt, haltReason,
  masterWalletId, params, transfers: [...], consecutiveFailures: 0 }
```

`status` ∈ `running | paused | complete | halted | cancelled`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/v4/store.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-'));
  process.env.HISTORY_PATH = path.join(dir, 'launches.json');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./store')];
  const store = require('./store');
  store._reset();
  return { store, dir };
}

function campaign(over = {}) {
  return {
    id: 'c1',
    name: 'august',
    status: 'running',
    seed: 'abc',
    masterWalletId: 'm1',
    params: { days: 2 },
    transfers: [
      { id: '1-1', walletId: 's1', address: '0x1', amountEth: '0.004000', dueAt: 1, status: 'pending', attempts: [] },
      { id: '2-1', walletId: 's2', address: '0x2', amountEth: '0.005000', dueAt: 2, status: 'pending', attempts: [] },
    ],
    consecutiveFailures: 0,
    ...over,
  };
}

test('a campaign survives a round trip through disk', () => {
  const { store } = freshStore();
  store.storeFor('u').create(campaign());
  store._reset();
  const back = store.storeFor('u').get('c1');
  assert.equal(back.name, 'august');
  assert.equal(back.transfers.length, 2);
});

test('several campaigns live in one file', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'c1', masterWalletId: 'm1' }));
  s.create(campaign({ id: 'c2', masterWalletId: 'm2' }));
  assert.equal(s.campaigns().length, 2);
  assert.equal(s.running().length, 2);
});

test('the write leaves no temp file behind', () => {
  const { store, dir } = freshStore();
  store.storeFor('u').create(campaign());
  const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(stray, []);
});

test('updateTransfer changes one transfer and nothing else', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign());
  s.updateTransfer('c1', '1-1', { status: 'sent', hash: '0xdead' });
  const back = s.get('c1');
  assert.equal(back.transfers[0].status, 'sent');
  assert.equal(back.transfers[1].status, 'pending');
});

test('running excludes everything that is not running', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'a', status: 'running' }));
  s.create(campaign({ id: 'b', status: 'paused' }));
  s.create(campaign({ id: 'c', status: 'complete' }));
  s.create(campaign({ id: 'd', status: 'halted' }));
  s.create(campaign({ id: 'e', status: 'cancelled' }));
  assert.deepEqual(s.running().map((c) => c.id), ['a']);
});

test('claimed seed ids span every campaign, running or not', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'a', status: 'complete' }));
  assert.deepEqual([...s.claimedSeedIds()].sort(), ['s1', 's2']);
});

test('backedUp names the wallets with no backup on record', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  assert.deepEqual(s.backedUp(['s1', 's2']), ['s1', 's2']);
  s.recordBackup(['s1']);
  assert.deepEqual(s.backedUp(['s1', 's2']), ['s2']);
  s.recordBackup(['s2', 's3']);
  assert.deepEqual(s.backedUp(['s1', 's2']), []);
});

test('two users never see each others campaigns', () => {
  const { store } = freshStore();
  store.storeFor('alice').create(campaign({ id: 'a' }));
  assert.deepEqual(store.storeFor('bob').campaigns(), []);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "survives a round trip"`
Expected: FAIL — `Cannot find module './store'`

- [ ] **Step 3: Write `backend/src/v4/store.js`**

```js
'use strict';

/**
 * Where a seasoning campaign lives between restarts.
 *
 * ONE FILE PER USER, holding an ARRAY of campaigns — not one. Campaigns run in
 * parallel, one per funding wallet, so a store shaped around a single job would
 * have made the feature impossible.
 *
 * Written temp-then-rename, for the same reason keystore.js is: a three-week
 * campaign is written to several thousand times, and a process killed during
 * any one of those writes must not be able to leave a half-serialised file
 * where the plan used to be. Losing the plan means losing the record of which
 * of 400 wallets have been funded.
 *
 * The path mirrors store/history.js so a deployment has one data directory and
 * one backup story, not two.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_ID = 'default';
const instances = new Map();

/** Where a user's campaigns live, beside their launches. */
function pathFor(userId) {
  const dir = path.dirname(config.historyPath);
  // userId is validated at creation (users.slug) and never taken from a
  // request, so it cannot escape this directory.
  const name = userId === DEFAULT_ID ? 'seasoning.json' : `seasoning.${userId}.json`;
  return path.join(dir, name);
}

function build(userId) {
  const file = pathFor(userId);
  let cache = null;

  function load() {
    if (cache) return cache;
    if (!fs.existsSync(file)) {
      cache = { version: 1, campaigns: [], backups: [] };
      return cache;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = {
        version: parsed.version || 1,
        campaigns: parsed.campaigns || [],
        backups: parsed.backups || [],
      };
    } catch (_err) {
      // A corrupt file must not take the server down — but it must not be
      // silently overwritten either, so it is moved aside with a timestamp.
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      cache = { version: 1, campaigns: [], backups: [] };
    }
    return cache;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function campaigns() {
    return load().campaigns.slice();
  }

  function get(id) {
    return load().campaigns.find((c) => c.id === id) || null;
  }

  function create(campaign) {
    const store = load();
    if (store.campaigns.some((c) => c.id === campaign.id)) {
      throw new Error(`campaign ${campaign.id} already exists`);
    }
    store.campaigns.unshift(campaign);
    persist();
    return campaign;
  }

  function update(id, patch) {
    const store = load();
    const c = store.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`no campaign ${id}`);
    Object.assign(c, patch);
    persist();
    return c;
  }

  function updateTransfer(id, transferId, patch) {
    const store = load();
    const c = store.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`no campaign ${id}`);
    const t = c.transfers.find((x) => x.id === transferId);
    if (!t) throw new Error(`no transfer ${transferId} in campaign ${id}`);
    Object.assign(t, patch);
    persist();
    return t;
  }

  /** Campaigns the runner should be holding a timer for. */
  function running() {
    return load().campaigns.filter((c) => c.status === 'running');
  }

  /**
   * Every seed wallet spoken for by any campaign, in any state.
   *
   * Not just the running ones. A wallet funded by a completed campaign has a
   * funding edge already; funding it again from a second source would give it
   * two, which is worse than one.
   */
  function claimedSeedIds() {
    const claimed = new Set();
    for (const c of load().campaigns) {
      for (const t of c.transfers) claimed.add(t.walletId);
    }
    return claimed;
  }

  /** Note that these wallets' keys have been exported. */
  function recordBackup(walletIds) {
    const store = load();
    store.backups.push({ at: new Date().toISOString(), walletIds: [...walletIds] });
    persist();
  }

  /**
   * Which of these wallets have NO backup on record.
   *
   * Returns the gap rather than a boolean so the refusal can name the wallets
   * the operator still has to protect.
   */
  function backedUp(walletIds) {
    const seen = new Set();
    for (const b of load().backups) for (const id of b.walletIds) seen.add(id);
    return walletIds.filter((id) => !seen.has(id));
  }

  function _reset() {
    cache = null;
  }

  return {
    campaigns,
    get,
    create,
    update,
    updateTransfer,
    running,
    claimedSeedIds,
    recordBackup,
    backedUp,
    _reset,
  };
}

function storeFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

/** Test seam — drops every memoised store. */
function _reset() {
  instances.clear();
}

module.exports = { storeFor, pathFor, _reset };
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace backend -- --test-name-pattern "round trip|one file|temp file behind|updateTransfer|running excludes|claimed seed|backedUp|two users"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/v4/store.js backend/src/v4/store.test.js
git commit -m "Persist seasoning campaigns so a restart does not lose one"
```

---

### Task 6: The runner

**Files:**
- Create: `backend/src/v4/runner.js`
- Create: `backend/src/v4/runner.test.js`

**Interfaces:**
- Consumes: `store.storeFor`, `relay.transfer`, `keystore.keystoreFor`, `activity.activityFor`, `v4/roles`
- Produces: `createRunner(deps) -> { start(userId, campaign), pause(userId, id), resume(userId, id), cancel(userId, id), resumeAll(), status(userId, id), _reset() }`; module default export is a singleton with the same shape.

Constants: `MAX_ATTEMPTS = 3`, `HALT_AFTER_CONSECUTIVE_FAILURES = 3`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/v4/runner.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const plan = require('./plan');

/** A controllable clock and timer table. No real time passes in this file. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return { id, unref() {} };
    },
    clearTimeout: (h) => h && timers.delete(h.id),
    /** Advance to the next due timer and run it. Returns false when idle. */
    async tick() {
      const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return false;
      const [id, timer] = due;
      timers.delete(id);
      now = Math.max(now, timer.at);
      await timer.fn();
      return true;
    },
    async drain(max = 500) {
      let n = 0;
      while (n < max && (await this.tick())) n++;
      return n;
    },
    pending: () => timers.size,
  };
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4run-'));
  process.env.HISTORY_PATH = path.join(dir, 'launches.json');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./store')];
  delete require.cache[require.resolve('./runner')];
  const store = require('./store');
  store._reset();
  return { store, dir };
}

function makeCampaign(store, { id = 'c1', masterWalletId = 'm1', count = 4, now = 1_000_000 } = {}) {
  const ids = Array.from({ length: count }, (_, i) => `s${i}`);
  const built = plan.generate({
    walletIds: ids,
    addresses: Object.fromEntries(ids.map((w, i) => [w, `0x${String(i + 1).padStart(40, '0')}`])),
    params: plan.normaliseParams({ days: 1, perDayMin: count, perDayMax: count }),
    seed: 'fixed-seed',
    now,
  });
  const campaign = {
    id,
    name: id,
    status: 'running',
    seed: built.seed,
    createdAt: new Date(now).toISOString(),
    startedAt: new Date(now).toISOString(),
    completedAt: null,
    haltedAt: null,
    haltReason: null,
    masterWalletId,
    params: built.params,
    transfers: built.transfers,
    consecutiveFailures: 0,
  };
  store.storeFor('u').create(campaign);
  return campaign;
}

function runnerWith(store, clock, transfer) {
  const { createRunner } = require('./runner');
  return createRunner({
    storeForFn: store.storeFor,
    transferFn: transfer,
    keystoreForFn: () => ({ list: () => [], signer: () => ({}) }),
    activityForFn: () => ({ record() {} }),
    rolesResolve: () => ({ id: 'm1', address: '0x' + '1'.repeat(40) }),
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    nowFn: clock.now,
  });
}

test('a campaign sends every transfer and completes', async () => {
  const { store } = env();
  const clock = fakeClock();
  const sent = [];
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    sent.push(toAddress);
    return { hash: '0x' + 'a'.repeat(64), requestId: null, depositAddress: '0x' + 'b'.repeat(40) };
  });

  makeCampaign(store);
  runner.resumeAll();
  await clock.drain();

  assert.equal(sent.length, 4);
  assert.equal(store.storeFor('u').get('c1').status, 'complete');
});

test('a failed transfer is re-slotted and retried, not abandoned at once', async () => {
  const { store } = env();
  const clock = fakeClock();
  let calls = 0;
  const runner = runnerWith(store, clock, async () => {
    calls++;
    if (calls === 1) throw new Error('relay hiccup');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 2 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'complete');
  const retried = c.transfers.find((t) => t.attempts.length > 0);
  assert.equal(retried.attempts.length, 1);
  assert.equal(retried.status, 'sent');
});

test('three consecutive failures halt the campaign', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => {
    throw new Error('relay is down');
  });

  makeCampaign(store, { count: 10 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  assert.equal(c.status, 'halted');
  assert.match(c.haltReason, /relay is down/);
  // It must stop, not burn the remaining slots.
  assert.ok(c.transfers.filter((t) => t.status === 'pending').length > 0);
});

test('a success resets the consecutive-failure counter', async () => {
  const { store } = env();
  const clock = fakeClock();
  let n = 0;
  // fail, fail, succeed, fail, fail, succeed … never three in a row
  const runner = runnerWith(store, clock, async () => {
    n++;
    if (n % 3 !== 0) throw new Error('flaky');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.notEqual(store.storeFor('u').get('c1').status, 'halted');
});

test('a transfer is abandoned after three attempts, and the campaign goes on', async () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async ({ toAddress }) => {
    // Only the first wallet ever fails, so failures are never consecutive.
    if (toAddress.endsWith('1')) throw new Error('this one is cursed');
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 8 });
  runner.resumeAll();
  await clock.drain();

  const c = store.storeFor('u').get('c1');
  const cursed = c.transfers.find((t) => t.address.endsWith('1'));
  assert.equal(cursed.status, 'abandoned');
  assert.equal(cursed.attempts.length, 3);
  assert.equal(c.status, 'complete');
});

test('a restart re-arms from disk and does not fire a burst', async () => {
  const { store } = env();
  const clock = fakeClock();
  const times = [];
  const runner = runnerWith(store, clock, async () => {
    times.push(clock.now());
    return { hash: '0x' + 'a'.repeat(64) };
  });

  // Every transfer is already overdue — the shape of a six-hour outage.
  makeCampaign(store, { count: 5, now: clock.now() - 10 * 60 * 60 * 1000 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(times.length, 5);
  // Re-slotted, not bunched: no two sends land in the same instant.
  assert.equal(new Set(times).size, 5, 'overdue transfers were fired as a burst');
});

test('two campaigns on two funding wallets run in parallel', async () => {
  const { store } = env();
  const clock = fakeClock();
  const byCampaign = { c1: 0, c2: 0 };
  const runner = runnerWith(store, clock, async ({ campaignId }) => {
    byCampaign[campaignId]++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1', count: 3 });
  makeCampaign(store, { id: 'c2', masterWalletId: 'm2', count: 3 });
  runner.resumeAll();
  await clock.drain();

  assert.equal(byCampaign.c1, 3);
  assert.equal(byCampaign.c2, 3);
});

test('a campaign refuses to start on a funding wallet already running', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));

  makeCampaign(store, { id: 'c1', masterWalletId: 'm1' });
  runner.resumeAll();

  assert.throws(
    () => runner.start('u', { id: 'c2', masterWalletId: 'm1', status: 'running', transfers: [], consecutiveFailures: 0 }),
    /m1|already/
  );
});

test('pause stops the clock and resume picks up where it stopped', async () => {
  const { store } = env();
  const clock = fakeClock();
  let sends = 0;
  const runner = runnerWith(store, clock, async () => {
    sends++;
    return { hash: '0x' + 'a'.repeat(64) };
  });

  makeCampaign(store, { count: 6 });
  runner.resumeAll();
  await clock.tick();
  runner.pause('u', 'c1');
  const afterPause = sends;
  await clock.drain();
  assert.equal(sends, afterPause, 'a paused campaign kept sending');

  runner.resume('u', 'c1');
  await clock.drain();
  assert.equal(sends, 6);
});

test('cancel is final — resume refuses it', () => {
  const { store } = env();
  const clock = fakeClock();
  const runner = runnerWith(store, clock, async () => ({ hash: '0x' + 'a'.repeat(64) }));
  makeCampaign(store);
  runner.resumeAll();
  runner.cancel('u', 'c1');
  assert.equal(store.storeFor('u').get('c1').status, 'cancelled');
  assert.throws(() => runner.resume('u', 'c1'), /cancelled/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "sends every transfer"`
Expected: FAIL — `Cannot find module './runner'`

- [ ] **Step 3: Write `backend/src/v4/runner.js`**

Implement to satisfy every test above. The required behaviours, each of which has a test:

1. **One timer per campaign**, held in a `Map` keyed by `${userId}:${campaignId}`, `unref`'d so it never holds the process open.
2. **`resumeAll()`** reads `store.running()` for every user with a campaigns file and arms each. Called from `server.js` at boot.
3. **Re-slotting on boot.** Any transfer whose `dueAt` is in the past gets a fresh `dueAt` of `now + rng gap`, spread so no two coincide. Never fire overdue transfers together.
4. **`MAX_ATTEMPTS = 3` per transfer.** A failure appends `{ at, error }` to `attempts[]`, re-slots `dueAt` forward, and leaves `status: 'pending'`. At 3 attempts it becomes `'abandoned'` and the campaign continues.
5. **`HALT_AFTER_CONSECUTIVE_FAILURES = 3` per campaign.** `consecutiveFailures` increments on any failed attempt and is **reset to 0 by any success**. At 3, set `status: 'halted'`, `haltedAt`, `haltReason` (the last error message), clear the timer, and write an activity entry.
6. **One send at a time per campaign.** An `inFlight` flag, so a slow Relay call cannot overlap the next tick — this is what keeps the funding wallet's nonce sequential.
7. **`start()` refuses** if another *running* campaign holds the same `masterWalletId`. Refuse, do not queue.
8. **`pause` / `resume` / `cancel`.** `cancel` is terminal — `resume` on a `cancelled` campaign throws. `resume` on a `halted` one is allowed.
9. **Completion.** When no `pending` transfers remain, set `status: 'complete'` and `completedAt`.
10. **Activity logging** on start, halt, complete, and each transfer, via `activityForFn(userId).record('v4', summary, detail)`.
11. **Boot-gap logging.** If `resumeAll()` finds overdue transfers, record one entry naming how long the gap was, how many were re-slotted, and which campaign.
12. The injected `transferFn` receives `{ campaignId, walletId, toAddress, amountWei, fromWallet }` — the test asserts on `campaignId` and `toAddress`.

- [ ] **Step 4: Run the runner tests**

Run: `npm test --workspace backend -- --test-name-pattern "campaign|transfer|restart|parallel|pause|cancel"`
Expected: PASS, all eleven

- [ ] **Step 5: Run the whole suite**

Run: `npm test --workspace backend`
Expected: PASS — nothing in v1/v2/v3 changed

- [ ] **Step 6: Commit**

```bash
git add backend/src/v4/runner.js backend/src/v4/runner.test.js
git commit -m "Run seasoning campaigns in parallel, one per funding wallet"
```

---

### Task 7: Routes, with the backup gate

**Files:**
- Create: `backend/src/routes/v4.js`
- Create: `backend/src/routes/v4.test.js`

**Interfaces:**
- Consumes: everything from Tasks 2–6
- Produces: the `/api/v4/*` surface

```
GET    /v4/wallets                 { masters:[{...,inCampaign}], seeds:[{...,claimed,backedUp,ageDays}] }
POST   /v4/wallets/generate        { count, role } -> wallet[]
POST   /v4/wallets/backup          { confirm: true } -> { wallets:[{address,privateKey,...}] }
GET    /v4/campaigns               campaign[] (summaries)
GET    /v4/campaigns/:id           one campaign, transfers included
POST   /v4/campaigns/preview       { params, walletIds? } -> { seed, params, byDay, totalEth, cost, feasible }
POST   /v4/campaigns               { name, masterWalletId, seed, params, walletIds } -> campaign
POST   /v4/campaigns/:id/pause
POST   /v4/campaigns/:id/resume
POST   /v4/campaigns/:id/cancel
```

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/v4.test.js` covering, at minimum:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// These are unit tests over the route module's exported guards, not an HTTP
// harness — the repo has no supertest dependency and this plan does not add one.
const guards = require('./v4')._private;

test('generate refuses a role V4 does not own', () => {
  assert.throws(() => guards.assertV4Role('v3bundle'), /v4master|v4seed/);
  assert.throws(() => guards.assertV4Role('bundle'), /v4master|v4seed/);
  assert.doesNotThrow(() => guards.assertV4Role('v4seed'));
});

test('the backup gate refuses a campaign whose wallets have no backup', () => {
  assert.throws(
    () => guards.assertBackedUp(['s1', 's2'], () => ['s2']),
    /s2|backup/i
  );
  assert.doesNotThrow(() => guards.assertBackedUp(['s1'], () => []));
});

test('a campaign refuses a seed wallet another campaign already claimed', () => {
  assert.throws(
    () => guards.assertUnclaimed(['s1', 's9'], new Set(['s9'])),
    /s9|claimed/i
  );
});

test('a campaign refuses a funding wallet that is not a v4master', () => {
  assert.throws(() => guards.assertMaster('m1', []), /v4master/);
  assert.doesNotThrow(() => guards.assertMaster('m1', [{ id: 'm1', role: 'v4master' }]));
});

test('backup requires an explicit confirm', () => {
  assert.throws(() => guards.assertConfirmed({}), /confirm/);
  assert.throws(() => guards.assertConfirmed({ confirm: 'yes' }), /confirm/);
  assert.doesNotThrow(() => guards.assertConfirmed({ confirm: true }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test --workspace backend -- --test-name-pattern "refuses a role V4"`
Expected: FAIL — `Cannot find module './v4'`

- [ ] **Step 3: Write `backend/src/routes/v4.js`**

Follow the shape of `backend/src/routes/v3.js` exactly: `express.Router()`, `requireApiKey` on every route, its own local `jsonSafe`, and `next(err)` in every catch. Header comment:

```js
/**
 * Every /api/v4/* endpoint — the seasoning campaigns' whole surface.
 *
 * SEPARATE FROM routes/wallets.js, routes/launch.js AND routes/v3.js BY DESIGN,
 * and mounted beside them rather than inside them. A router that can be
 * unmounted in one line is the strongest form of the isolation promise.
 *
 * THE BACKUP GATE IS THE MOST IMPORTANT REFUSAL IN THIS FILE. A campaign is
 * about to send real ETH to hundreds of wallets over three weeks. If the
 * keystore is lost before those keys have been exported even once, every wei is
 * unrecoverable — there is no seed phrase behind these wallets, they are random
 * keys in one encrypted file on one machine. So POST /v4/campaigns refuses to
 * start until every seed wallet in the plan appears in a backup on record, and
 * it names the ones that do not.
 */
```

Export the pure guards so the tests above can reach them without HTTP:

```js
function assertV4Role(role) {
  if (!v4roles.isV4Role(role)) {
    throw new Error(`role must be one of ${Object.values(v4roles.ROLES).join(', ')}`);
  }
}

function assertConfirmed(body) {
  if ((body || {}).confirm !== true) throw new Error('this requires { confirm: true }');
}

function assertMaster(walletId, masters) {
  if (!masters.some((w) => w.id === walletId)) {
    throw new Error(`wallet ${walletId} is not a v4master funding wallet`);
  }
}

function assertUnclaimed(walletIds, claimed) {
  const taken = walletIds.filter((id) => claimed.has(id));
  if (taken.length) {
    throw new Error(
      `${taken.length} wallet(s) are already claimed by another campaign: ${taken.slice(0, 5).join(', ')}` +
        `${taken.length > 5 ? '…' : ''}. A wallet funded twice has two funding edges.`
    );
  }
}

function assertBackedUp(walletIds, backedUpFn) {
  const missing = backedUpFn(walletIds);
  if (missing.length) {
    throw new Error(
      `${missing.length} of ${walletIds.length} seed wallets have no key backup on record. ` +
        'Download the V4 backup first — these keys exist in one encrypted file and nowhere else, ' +
        'and a campaign funds them with real ETH.'
    );
  }
}

module.exports = router;
module.exports._private = { assertV4Role, assertConfirmed, assertMaster, assertUnclaimed, assertBackedUp };
```

`POST /v4/wallets/backup` returns only `v4seed` and `v4master` wallets — filter `ks.exportAll()` by `v4roles.isV4Role(w.role)`, call `store.recordBackup(ids)`, and log to activity with `record('export', …)`. Never return another tab's keys from a V4 route.

`POST /v4/campaigns` runs the guards in this order, and only then calls `runner.start`: `assertMaster` → `assertUnclaimed` → `assertBackedUp` → `plan.feasible` → balance check via `estimateCost` against `provider.getBalance(master.address)`.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace backend`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/v4.js backend/src/routes/v4.test.js
git commit -m "Expose v4 over /api/v4, behind a mandatory key-backup gate"
```

---

### Task 8: Mount it and resume at boot

**Files:**
- Modify: `backend/server.js` — two additive lines plus a boot call

- [ ] **Step 1: Add the require beside the others**

After line 20 (`const v3Routes = require('./src/routes/v3');`):

```js
const v4Routes = require('./src/routes/v4');
const v4Runner = require('./src/v4/runner');
```

- [ ] **Step 2: Mount the router**

After line 64 (`app.use('/api', v3Routes);`):

```js
app.use('/api', v4Routes);
```

- [ ] **Step 3: Re-arm campaigns at boot**

Immediately before the server starts listening, add:

```js
// A seasoning campaign outlives this process. Every other job in this codebase
// dies on restart, which is fine for a run measured in minutes and is not fine
// for one measured in weeks — so V4's campaigns are read back off disk and
// re-armed here. Transfers that came due while the process was gone are
// re-slotted forward, never fired as a burst.
try {
  const resumed = v4Runner.resumeAll();
  if (resumed.length) console.log(`[v4] resumed ${resumed.length} seasoning campaign(s)`);
} catch (err) {
  console.error('[v4] could not resume campaigns:', err.message);
}
```

Wrapped in try/catch deliberately: a V4 store problem must never stop the server that v1 launches from.

- [ ] **Step 4: Verify the server boots**

Run: `cd backend && node -e "require('./server.js')" ` then stop it, or `npm run dev --workspace backend` and confirm no error.
Expected: server starts, no `[v4]` error line.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js
git commit -m "Mount /api/v4 and re-arm campaigns at boot"
```

---

### Task 9: The V4 console

**Files:**
- Create: `frontend/src/v4/V4Console.jsx`
- Create: `frontend/src/v4/V4FundingPanel.jsx`
- Create: `frontend/src/v4/V4SeedPanel.jsx`
- Create: `frontend/src/v4/V4PlanPanel.jsx`
- Create: `frontend/src/v4/V4CampaignsPanel.jsx`
- Create: `frontend/src/v4/backup.js`

**Interfaces:**
- Consumes: `api` from `../api.js`, `Sequence`/`Step`/`Section`/`Modal` from `../components/` (presentation only — these decide how a procedure looks, never what a tab spends)
- Produces: `<V4Console health credential report output reportedAt />`, matching how `App.jsx` already calls `V3Console`

- [ ] **Step 1: Write `frontend/src/v4/backup.js`**

Its own downloader rather than reusing `api.js`'s `downloadBackup`, so the V4 tab never pulls another tab's keys:

```js
import { getApiKey } from '../api.js';

/**
 * Download the private keys of V4's wallets only.
 *
 * Deliberately not api.js's downloadBackup, which exports the WHOLE keystore.
 * A V4 operator backing up a campaign should not be handed v1's dev key in the
 * same file — and the campaign gate only needs V4's wallets on record.
 */
export async function downloadV4Backup() {
  const res = await fetch('/api/v4/wallets/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': getApiKey() },
    body: JSON.stringify({ confirm: true }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'backup failed');

  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pons-v4-wallets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return `Backed up ${json.wallets.length} V4 wallet key(s). Keep this file offline.`;
}
```

- [ ] **Step 2: Write the four panels**

Each takes its data as props and reports through `report`. Follow `frontend/src/v3/V3TreasuryPanel.jsx` for structure, spacing and the `Section`/`Busy` idiom.

- **`V4FundingPanel`** — table of `v4master` wallets: address, balance, and which campaign holds it. A "create funding wallet" button posting `{ count: 1, role: 'v4master' }`.
- **`V4SeedPanel`** — "generate N" (capped at 100 per request, matching the V3 route's cap), a table of address / balance / campaign / funded-at / **age in days**, and the **Download backup** button wired to `downloadV4Backup`, with a typed `EXPORT` confirmation in a `Modal` exactly as `BackupControls.jsx` does.
- **`V4PlanPanel`** — the parameter form (days, per-day min/max, amount min/max, gap min/max), a **Preview** button hitting `POST /v4/campaigns/preview`, the returned per-day table and total cost, and a **Start campaign** button that posts the seed + params. When the backend refuses on the backup gate, surface the error text verbatim — it names the wallets.
- **`V4CampaignsPanel`** — one card per campaign, several at once: name, status, day X of Y, `last sent 34m ago · next due 15:12`, sent/failed/abandoned counts, per-day rows expanding to transfers, and pause/resume/cancel.

- [ ] **Step 3: Write `frontend/src/v4/V4Console.jsx`**

Mirror `V3Console.jsx`: own state, own polling, shares nothing with the tree beside it.

```jsx
/**
 * The V4 tab, whole.
 *
 * It owns all of its own state and shares none with the v1/v2/v3 consoles. App
 * renders one or the other; this component holds V4's wallets and its running
 * campaigns, and nothing it does can change what another tab is drawing.
 *
 * FOUR PANELS AND NO LAUNCH. V4 does not launch, does not buy and does not
 * sell. It funds fresh wallets slowly enough that nothing about them reads as a
 * batch, and then it stops. What the wallets are used for afterwards happens
 * elsewhere.
 */
```

Poll `/v4/campaigns` every 15s while any campaign is `running` — a campaign that sends once an hour does not need a 2-second poll, and the tab may be open for weeks.

- [ ] **Step 4: Build the frontend**

Run: `npm run build`
Expected: build succeeds with no new warnings.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/v4/
git commit -m "Add the V4 console and its four panels"
```

---

### Task 10: The tab

**Files:**
- Modify: `frontend/src/App.jsx:453-482` (tab strip) and `:487` (the branch)

- [ ] **Step 1: Add the tab button**

After the V3 button in the `.tabs` div:

```jsx
            <button
              type="button"
              className={tab === 'v4' ? 'quiet is-on' : 'quiet'}
              onClick={() => setTab('v4')}
            >
              V4 · seasoning
            </button>
```

- [ ] **Step 2: Extend the hint**

Change the hint expression to include v4:

```jsx
              {tab === 'v1'
                ? `the ${steps.length}-step sequence — dev wallet funds everything`
                : tab === 'v2'
                  ? `${steps.length} steps, no disperser — funded from outside this console`
                  : tab === 'v3'
                    ? 'not a launcher — distributes a live token, one wallet at a time'
                    : 'not a launcher — drips ETH into fresh wallets over weeks'}
```

- [ ] **Step 3: Add the branch**

Change the V3 branch at line 487 to handle both:

```jsx
          {tab === 'v3' ? (
            <V3Console health={health} credential={credential} report={report} output={output} reportedAt={reportedAt} />
          ) : tab === 'v4' ? (
            <V4Console health={health} credential={credential} report={report} output={output} reportedAt={reportedAt} />
          ) : (
```

And add the import beside V3's:

```jsx
import V4Console from './v4/V4Console.jsx';
```

- [ ] **Step 4: Verify nothing else changed**

Run: `git diff frontend/src/App.jsx`
Expected: only the import, the button, the hint expression and the branch. **No change to `steps`, `rolesFor`, `share`, or any panel prop.**

Run: `npm test`
Expected: PASS, including `frontend/src/variant.test.js` — V4 must not appear in `VARIANTS`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "Add the V4 tab"
```

---

### Task 11: End-to-end dry run

**Files:**
- Create: `backend/scripts/v4-simulate.js`

The `timeScale` proof from the spec. A feature whose first honest feedback is three weeks away otherwise ships having never been watched end to end.

- [ ] **Step 1: Write the script**

`backend/scripts/v4-simulate.js` generates a 20-day plan, then replays it against a stubbed `transfer` at a configurable compression (`--scale 1440` runs a day per minute), printing each send with its due time and its day. It asserts at the end that every wallet was funded exactly once, no two sends shared an instant, and the daily counts stayed in range.

Add to `backend/package.json` scripts:

```json
    "v4:simulate": "node scripts/v4-simulate.js",
```

- [ ] **Step 2: Run it**

Run: `npm run v4:simulate --workspace backend -- --scale 1440 --wallets 400 --days 20`
Expected: 400 sends, 20 day-groups, counts inside 10–30, all assertions pass.

- [ ] **Step 3: Run a real dry-run campaign**

With `DRY_RUN=true`, generate 40 seed wallets and a funding wallet through the console, download the backup, and start a 2-day campaign at `perDayMin: 20, perDayMax: 20`. Confirm: the plan previews, the gate refuses before the backup and allows after, transfers appear in the activity log, and **restarting the server mid-campaign resumes it**.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/v4-simulate.js backend/package.json
git commit -m "Replay a 20-day campaign in a minute, so it is watched before it is trusted"
```

---

## Self-Review

**Spec coverage:** isolation → Global Constraints + Tasks 2/3/7/9; roles → Task 2; non-singleton master → Task 2 Step 4; own Relay client → Task 3; pre-generated plan + seed + feasibility + cost → Task 4; days as a parameter → Task 4 (`normaliseParams`, tested); persistence + atomic writes + multi-campaign → Task 5; parallel campaigns + nonce invariant → Task 6 tests 7 and 8; retry/abandon vs halt (two counters) → Task 6 tests 2–5; boot resume without bursting → Task 6 test 6 + Task 8; staleness readout + boot-gap logging → Task 6 items 10–11 + Task 9; routes → Task 7; backup gate → Task 7; console → Task 9; tab → Task 10; `timeScale` → Task 11.

**Added beyond the spec:** Task 1 (atomic keystore write) and the backup gate, both approved during planning. The spec should be updated to record them — do this as part of Task 1.

**Type consistency:** the transfer shape declared in Task 4 is the one Task 5 persists, Task 6 mutates and Task 7 serialises. `status` values are `pending | sent | abandoned` for transfers and `running | paused | complete | halted | cancelled` for campaigns, used identically in Tasks 5, 6 and 7. `storeFor`, `campaigns`, `get`, `create`, `update`, `updateTransfer`, `running`, `claimedSeedIds`, `recordBackup`, `backedUp` are named identically in Tasks 5, 6 and 7.
