# V1 Paced Disperser Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** V1's step-4 "Send" funds the bundle one wallet at a time, each through the disperser contract, with a random 4–7 s gap between wallets.

**Architecture:** The backend `POST /fund` gains an additive `viaDisperser` flag (plus an optional `disperser` address that must be one of the user's own contracts) that forces a single disperser transaction regardless of recipient count and never falls back to plain transfers. The pacing loop lives in the browser as a pure, testable function (`runPacedFunding`) that posts one wallet per request; `FundPanel.jsx` only wires it to the button, a Stop button and the report box.

**Tech Stack:** Node ≥20 CommonJS backend (express, ethers v6, `node --test`); React 18 + Vite ESM frontend (`node --test` for plain `.js` modules).

## Global Constraints

- V1 only: `variant === 'v1'`. V2–V5 behaviour and UI must be byte-for-byte unchanged (tab isolation rule).
- Without `viaDisperser`, `disperse()` behaves exactly as before — no reordering, no new RPC calls.
- A body-supplied `disperser` is NEVER used unless it equals one of `addresses(userId)` (case-insensitive via `getAddress`).
- No fallback to plain transfers when `viaDisperser` is set.
- Pacing gap: uniform random integer in **[4000, 7000] ms**.
- Frontend stops on the FIRST error; it reports funded count and remaining count.
- Tests run with `cd backend && npm test` and `cd frontend && npm test`. Both must stay green.
- Commit after each task. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/wallets/funding.js` (modify) | `disperse()` gains `viaDisperser` / `disperser` options and a `deps` parameter for tests; new internal `sendViaDisperser()` |
| `backend/src/wallets/funding.disperse.test.js` (create) | Offline tests for the forced-disperser path |
| `backend/src/routes/wallets.js` (modify, `POST /fund`) | Reads the two new body fields, passes them through, tags the activity line |
| `frontend/src/components/pacedFunding.js` (create) | `pacedDelayMs()` and `runPacedFunding()` — the loop, no React |
| `frontend/src/components/pacedFunding.test.js` (create) | Tests for both |
| `frontend/src/components/FundPanel.jsx` (modify, v1 branch only) | Button label, Stop button, hint, wiring |

---

### Task 1: Backend — `viaDisperser` path in `disperse()`

**Files:**
- Modify: `backend/src/wallets/funding.js:26-36` (`transferGas`) and `:62-160` (`disperse`)
- Create: `backend/src/wallets/funding.disperse.test.js`

**Interfaces:**
- Consumes: `buildDisperseTx(targets, address)` and `addresses(userId)` from `backend/src/evm/disperse.js`; `getAddress` from ethers.
- Produces: `disperse(targets, { keystore, userId, variant, viaDisperser = false, disperser }, deps = {})` where `deps` may override `{ provider, getFees, buildDisperseTx, disperserAddresses }`. Result rows keep today's shape: success `{ walletId, address, amountEth, hash, batched: true, disperser }`, failure `{ walletId, address, amountEth, error, disperser }`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/wallets/funding.disperse.test.js`:

```js
'use strict';

// The forced-disperser path of disperse(): one disperser transaction for the
// given recipients regardless of the batching threshold, only ever through a
// contract the user has configured, and never falling back to plain transfers.
// Fully offline: fake keystore, fake provider, fake fee quote.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same isolation the disperse.js tests use: a temp history dir so a real
// dispersers.json cannot decide what these assertions see, and a fixed
// DISPERSER_ADDRESSES fallback list. DRY_RUN must be off or disperse() returns
// simulated rows before it reaches the code under test.
process.env.HISTORY_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pons-fund-')), 'launches.json');
process.env.DRY_RUN = 'false';
const D1 = '0x1111111111111111111111111111111111111111';
const D2 = '0x2222222222222222222222222222222222222222';
process.env.DISPERSER_ADDRESSES = [D1, D2].join(',');

const { getAddress, parseEther } = require('ethers');
const { disperse } = require('./funding');

const DEV = getAddress('0x' + 'aa'.repeat(20));
const B1 = getAddress('0x' + 'b1'.repeat(20));
const B2 = getAddress('0x' + 'b2'.repeat(20));

function fakeKs() {
  const ks = { sent: [], failNext: null };
  const wallets = [
    { id: 'dev', role: 'dev', address: DEV },
    { id: 'w1', role: 'bundle', address: B1 },
    { id: 'w2', role: 'bundle', address: B2 },
  ];
  ks.list = () => wallets;
  ks.devWallet = () => wallets[0];
  ks.signer = () => ({
    sendTransaction: async (tx) => {
      if (ks.failNext) {
        const err = ks.failNext;
        ks.failNext = null;
        throw err;
      }
      ks.sent.push(tx);
      return { hash: `0xhash${ks.sent.length}` };
    },
  });
  return ks;
}

function fakeProvider() {
  return {
    getBalance: async () => parseEther('10'),
    getTransactionCount: async () => 3,
    estimateGas: async () => 21195n,
  };
}

function deps(over = {}) {
  return {
    provider: fakeProvider(),
    getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    ...over,
  };
}

const ONE = [{ walletId: 'w1', amountEth: '0.05' }];

test('viaDisperser sends one recipient through the disperser even below the batching threshold', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true }, deps());

  assert.equal(ks.sent.length, 1, 'exactly one transaction');
  const tx = ks.sent[0];
  assert.equal(getAddress(tx.to), D1, 'the transaction goes TO the disperser contract, not the wallet');
  assert.equal(tx.value, parseEther('0.05'));
  assert.ok(tx.data && tx.data.length > 10, 'it is a contract call');
  assert.equal(tx.nonce, 3);
  assert.deepEqual(out, [
    { walletId: 'w1', address: B1, amountEth: '0.05', hash: '0xhash1', batched: true, disperser: D1 },
  ]);
});

test('viaDisperser honours a configured disperser address, in any case', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true, disperser: D2.toLowerCase() }, deps());
  assert.equal(getAddress(ks.sent[0].to), D2);
  assert.equal(out[0].disperser, D2);
});

test('viaDisperser refuses a disperser that is not configured and sends nothing', async () => {
  const ks = fakeKs();
  const foreign = '0x9999999999999999999999999999999999999999';
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true, disperser: foreign }, deps()),
    /not one of your configured dispersers/
  );
  assert.equal(ks.sent.length, 0);
});

test('viaDisperser refuses when no disperser is configured', async () => {
  const ks = fakeKs();
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true }, deps({ disperserAddresses: () => [] })),
    /no disperser deployed/
  );
  assert.equal(ks.sent.length, 0);
});

test('viaDisperser does NOT fall back to a plain transfer when the disperser send fails', async () => {
  const ks = fakeKs();
  ks.failNext = new Error('execution reverted: nope');
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true }, deps());

  assert.equal(ks.sent.length, 0, 'no second attempt of any kind');
  assert.equal(out.length, 1);
  assert.equal(out[0].walletId, 'w1');
  assert.equal(out[0].address, B1);
  assert.equal(out[0].amountEth, '0.05');
  assert.equal(out[0].disperser, D1);
  assert.match(out[0].error, /nope/);
  assert.equal(out[0].hash, undefined);
});

test('viaDisperser still runs the balance check before sending', async () => {
  const ks = fakeKs();
  const poor = deps();
  poor.provider.getBalance = async () => parseEther('0.01');
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true }, poor),
    /dev wallet has 0\.01 ETH but needs/
  );
  assert.equal(ks.sent.length, 0);
});

test('without viaDisperser one recipient still takes the plain-transfer path (unchanged behaviour)', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, disperser: D2 }, deps());
  assert.equal(ks.sent.length, 1);
  assert.equal(getAddress(ks.sent[0].to), B1, 'straight to the wallet');
  assert.equal(ks.sent[0].data, undefined);
  assert.deepEqual(out, [{ walletId: 'w1', address: B1, amountEth: '0.05', hash: '0xhash1' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test src/wallets/funding.disperse.test.js`
Expected: the `viaDisperser` tests FAIL (the flag is ignored, so `tx.to` is `B1`, the refusals don't reject, etc.). The last "unchanged behaviour" test may already pass.

- [ ] **Step 3: Implement `viaDisperser` in `funding.js`**

In `backend/src/wallets/funding.js`, add `getAddress` to the ethers import:

```js
const { parseEther, formatEther, getAddress } = require('ethers');
```

Change `transferGas` to take the provider it should ask (default: the module's), so a test can hand in a fake:

```js
async function transferGas(from, to, rpc = provider) {
  try {
    const est = await rpc.estimateGas({ from, to, value: 1n });
    const withHeadroom = (est * 12n) / 10n;
    return withHeadroom > TRANSFER_GAS ? withHeadroom : TRANSFER_GAS;
  } catch (_err) {
    return TRANSFER_GAS;
  }
}
```

Add this helper directly above `disperse` (after the `balances` function):

```js
/**
 * Which disperser a forced-disperser run goes through. A body-supplied address
 * is only ever honoured when it is one of the user's OWN configured contracts:
 * accepting anything else would let a request route the dev wallet's ETH to an
 * arbitrary address. Omitted → the first configured disperser.
 */
function resolveDisperser(requested, configured) {
  if (!configured.length) throw new Error('no disperser deployed — deploy one in step 2 first');
  if (requested === undefined || requested === null || requested === '') return getAddress(configured[0]);
  let wanted;
  try {
    wanted = getAddress(String(requested));
  } catch (_err) {
    throw new Error(`disperser ${requested} is not one of your configured dispersers`);
  }
  const match = configured.map((a) => getAddress(a)).find((a) => a === wanted);
  if (!match) throw new Error(`disperser ${wanted} is not one of your configured dispersers`);
  return match;
}

/**
 * ONE disperser transaction for every planned recipient, through `disperserAddress`.
 * No fallback: the operator asked for the contract to be the on-chain source,
 * so a failure is reported per wallet, not quietly re-sent as plain transfers.
 */
async function sendViaDisperser(planned, disperserAddress, { signer, fees, rpc, devAddress, build }) {
  const rows = (extra) =>
    planned.map((p) => ({
      walletId: p.walletId,
      address: p.address,
      amountEth: formatEther(p.value),
      ...extra,
      disperser: disperserAddress,
    }));
  try {
    const nonce = await rpc.getTransactionCount(devAddress, 'pending');
    const tx = await build(
      planned.map((p) => ({ address: p.address, value: p.value })),
      disperserAddress
    );
    const sentTx = await signer.sendTransaction({ ...tx, nonce, ...fees });
    return rows({ hash: sentTx.hash, batched: true });
  } catch (err) {
    return rows({ error: rpcMessage(err) });
  }
}
```

Now change the `disperse` signature and body. Replace the existing signature:

```js
async function disperse(
  targets,
  { keystore: ks = keystore, userId = 'default', variant = DEFAULT_VARIANT } = {}
) {
  const dev = devWalletFor(ks, variant);
  const signer = ks.signer(dev.id, provider);
  const fees = await getFees(DISPERSE_FEE_BUMP_PCT);
```

with:

```js
async function disperse(
  targets,
  {
    keystore: ks = keystore,
    userId = 'default',
    variant = DEFAULT_VARIANT,
    // Force ONE disperser transaction regardless of recipient count, through
    // `disperser` (must be one of the user's own) — the paced v1 funding path.
    viaDisperser = false,
    disperser: requestedDisperser,
  } = {},
  // Injection points for the offline tests only; production callers pass nothing.
  {
    provider: rpc = provider,
    getFees: quoteFees = getFees,
    buildDisperseTx: build = buildDisperseTx,
    disperserAddresses = addresses,
  } = {}
) {
  const dev = devWalletFor(ks, variant);
  // Resolved before any RPC call so a bad request fails fast and spends nothing.
  const forcedDisperser = viaDisperser ? resolveDisperser(requestedDisperser, disperserAddresses(userId)) : null;
  const signer = ks.signer(dev.id, rpc);
  const fees = await quoteFees(DISPERSE_FEE_BUMP_PCT);
```

Then in the body of `disperse`, replace these two lines:

```js
  const perTransferGas = await transferGas(dev.address, planned[0].address);
```
→
```js
  const perTransferGas = await transferGas(dev.address, planned[0].address, rpc);
```

```js
  const balance = await provider.getBalance(dev.address);
```
→
```js
  const balance = await rpc.getBalance(dev.address);
```

Immediately AFTER the `if (config.dryRun) { ... }` block and BEFORE the `if (shouldBatch(...))` block, insert:

```js
  if (forcedDisperser) {
    return sendViaDisperser(planned, forcedDisperser, {
      signer,
      fees,
      rpc,
      devAddress: dev.address,
      build,
    });
  }
```

Leave the batched block and the concurrent plain-transfer block below it exactly as they are, EXCEPT replace the two `provider.getTransactionCount(...)` calls in them with `rpc.getTransactionCount(...)` (same arguments) so the injected provider is used consistently. Do not change `sweep()`.

- [ ] **Step 4: Run the new tests and the whole backend suite**

Run: `cd backend && node --test src/wallets/funding.disperse.test.js`
Expected: all 7 PASS.

Run: `cd backend && npm test`
Expected: everything green (the existing `funding.test.js`, `disperse.test.js`, and every v2–v5 suite unchanged).

- [ ] **Step 5: Commit**

```bash
git add backend/src/wallets/funding.js backend/src/wallets/funding.disperse.test.js
git commit -m "feat(v1): viaDisperser option on disperse() — one disperser tx, own contracts only, no fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `POST /fund` passes the flag through

**Files:**
- Modify: `backend/src/routes/wallets.js:250-275` (`POST /fund`)

**Interfaces:**
- Consumes: `disperse(targets, { keystore, userId, variant, viaDisperser, disperser })` from Task 1.
- Produces: `POST /api/fund` body `{ targets, variant, viaDisperser?: boolean, disperser?: string }`; response unchanged (array of result rows).

- [ ] **Step 1: Edit the route**

In `backend/src/routes/wallets.js`, change the `POST /fund` handler body. Replace:

```js
    const { targets, variant = DEFAULT_VARIANT } = req.body || {};
```
with:
```js
    // viaDisperser: the paced v1 path — one disperser transaction for the
    // targets in THIS request (the panel posts one wallet at a time). The
    // disperser address is validated inside disperse() against the user's own
    // list; a foreign address is refused before anything is signed.
    const { targets, variant = DEFAULT_VARIANT, viaDisperser = false, disperser } = req.body || {};
```

Replace:
```js
    const out = await funding.disperse(targets, { keystore: ks, userId: req.user.id, variant });
```
with:
```js
    const out = await funding.disperse(targets, {
      keystore: ks,
      userId: req.user.id,
      variant,
      viaDisperser: viaDisperser === true,
      disperser,
    });
```

Replace the activity line:
```js
      `[${variant}] funded ${s.sent}/${s.wallets} wallet(s)` + (s.failed ? `, ${s.failed} failed` : ''),
      { ...s, variant }
```
with:
```js
      `[${variant}] funded ${s.sent}/${s.wallets} wallet(s)` +
        (viaDisperser === true ? ' via disperser' : '') +
        (s.failed ? `, ${s.failed} failed` : ''),
      { ...s, variant, viaDisperser: viaDisperser === true }
```

- [ ] **Step 2: Run the backend suite and a syntax check**

Run: `cd backend && node -e "require('./src/routes/wallets')" && npm test`
Expected: no require error; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/wallets.js
git commit -m "feat(v1): POST /fund accepts viaDisperser + disperser for paced funding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — the paced loop as a pure module

**Files:**
- Create: `frontend/src/components/pacedFunding.js`
- Create: `frontend/src/components/pacedFunding.test.js`

**Interfaces:**
- Consumes: nothing from the app (all I/O is injected).
- Produces:
  - `pacedDelayMs(min = 4000, max = 7000, random = Math.random)` → integer in `[min, max]`.
  - `runPacedFunding({ targets, dispersers, post, wait, report, stopped })` → `Promise<{ funded: number, total: number, stopped: boolean, error: string | null }>` where `targets` is `[{ walletId, amountEth }]`, `dispersers` is `string[]`, `post(body)` performs `POST /fund` and resolves with the result rows (or rejects), `wait(ms)` resolves after the pacing gap (or early when stopped), `report(text)` replaces the report box text, `stopped()` returns `true` once the operator pressed Stop.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/pacedFunding.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { pacedDelayMs, runPacedFunding } from './pacedFunding.js';

// ── pacedDelayMs ─────────────────────────────────────────────────────────────
test('pacedDelayMs stays inside [4000, 7000] and is an integer', () => {
  for (let i = 0; i < 2000; i++) {
    const ms = pacedDelayMs();
    assert.ok(Number.isInteger(ms), `${ms} is not an integer`);
    assert.ok(ms >= 4000 && ms <= 7000, `${ms} out of range`);
  }
});

test('pacedDelayMs covers both ends of the range', () => {
  assert.equal(pacedDelayMs(4000, 7000, () => 0), 4000);
  assert.equal(pacedDelayMs(4000, 7000, () => 0.999999), 7000);
  assert.equal(pacedDelayMs(10, 20, () => 0.5), 15);
});

// ── runPacedFunding ──────────────────────────────────────────────────────────
const D1 = '0x1111111111111111111111111111111111111111';
const D2 = '0x2222222222222222222222222222222222222222';

function harness({ postImpl } = {}) {
  const h = { posts: [], waits: [], reports: [], stop: false };
  h.post =
    postImpl ||
    (async (body) => {
      h.posts.push(body);
      const t = body.targets[0];
      return [{ walletId: t.walletId, address: `0xADDR_${t.walletId}`, amountEth: t.amountEth, hash: `0xh${h.posts.length}`, batched: true, disperser: body.disperser }];
    });
  h.wait = async (ms) => {
    h.waits.push(ms);
  };
  h.report = (text) => h.reports.push(text);
  h.stopped = () => h.stop;
  return h;
}

const THREE = [
  { walletId: 'w1', amountEth: '0.01' },
  { walletId: 'w2', amountEth: '0.02' },
  { walletId: 'w3', amountEth: '0.03' },
];

test('posts one wallet per request, in order, with variant v1 and viaDisperser', async () => {
  const h = harness();
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });

  assert.equal(h.posts.length, 3);
  assert.deepEqual(
    h.posts.map((p) => p.targets),
    [[THREE[0]], [THREE[1]], [THREE[2]]]
  );
  for (const p of h.posts) {
    assert.equal(p.variant, 'v1');
    assert.equal(p.viaDisperser, true);
    assert.equal(p.disperser, D1);
  }
  assert.deepEqual(out, { funded: 3, total: 3, stopped: false, error: null });
});

test('waits between wallets but not after the last one', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.waits.length, 2, 'two gaps for three wallets');
  for (const ms of h.waits) assert.ok(ms >= 4000 && ms <= 7000, `${ms} out of range`);
});

test('rotates across several dispersers', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1, D2], ...h });
  assert.deepEqual(
    h.posts.map((p) => p.disperser),
    [D1, D2, D1]
  );
});

test('reports progress per wallet and a final summary', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  const last = h.reports[h.reports.length - 1];
  assert.match(last, /funded 0xADDR_w1 0\.01 ETH via 0x1111/);
  assert.match(last, /0xh1/);
  assert.match(last, /funded 3\/3 wallets via disperser/);
});

test('stops on the first thrown request error and says what was funded and what remains', async () => {
  const h = harness({
    postImpl: async (body) => {
      h.posts.push(body);
      if (h.posts.length === 2) throw new Error('rate limited');
      const t = body.targets[0];
      return [{ walletId: t.walletId, address: `0xADDR_${t.walletId}`, amountEth: t.amountEth, hash: '0xh', batched: true, disperser: body.disperser }];
    },
  });
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });

  assert.equal(h.posts.length, 2, 'the third wallet is never posted');
  assert.deepEqual(out, { funded: 1, total: 3, stopped: false, error: 'rate limited' });
  const last = h.reports[h.reports.length - 1];
  assert.match(last, /stopped at wallet 2\/3: rate limited/);
  assert.match(last, /funded: 1 wallet\(s\); remaining: 2/);
  assert.match(last, /clear the funded rows' Fund amounts before re-sending/);
});

test('treats a result row carrying error as a failure and stops', async () => {
  const h = harness({
    postImpl: async (body) => {
      h.posts.push(body);
      const t = body.targets[0];
      if (h.posts.length === 1) return [{ walletId: t.walletId, address: `0xADDR_${t.walletId}`, amountEth: t.amountEth, error: 'execution reverted', disperser: body.disperser }];
      return [];
    },
  });
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(out, { funded: 0, total: 3, stopped: false, error: 'execution reverted' });
  assert.match(h.reports[h.reports.length - 1], /stopped at wallet 1\/3: execution reverted/);
});

test('an operator Stop ends the run before the next post', async () => {
  const h = harness();
  h.wait = async () => {
    h.stop = true; // pressed during the gap
  };
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(out, { funded: 1, total: 3, stopped: true, error: null });
  assert.match(h.reports[h.reports.length - 1], /stopped by operator after 1\/3 wallets/);
});

test('refuses to start without a disperser and posts nothing', async () => {
  const h = harness();
  const out = await runPacedFunding({ targets: THREE, dispersers: [], ...h });
  assert.equal(h.posts.length, 0);
  assert.deepEqual(out, { funded: 0, total: 3, stopped: false, error: 'no disperser deployed — deploy one in step 2 first' });
  assert.match(h.reports[h.reports.length - 1], /ERROR: no disperser deployed/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && node --test src/components/pacedFunding.test.js`
Expected: FAIL — `Cannot find module './pacedFunding.js'`.

- [ ] **Step 3: Implement the module**

Create `frontend/src/components/pacedFunding.js`:

```js
// The V1 paced funding loop — one disperser transaction per bundle wallet,
// 4–7 seconds apart, driven from the browser.
//
// Why the browser and not the server: each POST /fund is short, so nothing
// hits nginx's 180 s proxy_read_timeout (30 wallets × 7 s would); progress
// shows per wallet as it happens; and stopping is just not sending the next
// one. Nothing here can double-send: a wallet is posted exactly once or not
// at all.
//
// Pure: every side effect (the request, the wait, the report box, the Stop
// flag) is injected, so the loop is unit-tested without React or a network.

export const PACE_MIN_MS = 4000;
export const PACE_MAX_MS = 7000;

/** A uniform random integer in [min, max] milliseconds. */
export function pacedDelayMs(min = PACE_MIN_MS, max = PACE_MAX_MS, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

function short(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '?';
}

/**
 * @param {object} io
 * @param {Array<{walletId:string, amountEth:string|number}>} io.targets  in send order
 * @param {string[]} io.dispersers  the operator's configured disperser contracts
 * @param {(body:object) => Promise<Array>} io.post  performs POST /fund, resolves with the result rows
 * @param {(ms:number) => Promise<void>} io.wait  the pacing gap; may resolve early when stopped
 * @param {(text:string) => void} io.report  replaces the report box
 * @param {() => boolean} io.stopped  true once the operator pressed Stop
 * @returns {Promise<{funded:number, total:number, stopped:boolean, error:string|null}>}
 */
export async function runPacedFunding({ targets, dispersers, post, wait, report, stopped }) {
  const total = targets.length;
  const lines = [];
  const say = (line) => {
    lines.push(line);
    report(lines.join('\n'));
  };

  if (!dispersers || !dispersers.length) {
    const error = 'no disperser deployed — deploy one in step 2 first';
    say(`ERROR: ${error}`);
    return { funded: 0, total, stopped: false, error };
  }

  say(`sending ${total} wallet(s) 1 by 1 via disperser, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart…`);

  let funded = 0;
  for (let i = 0; i < total; i++) {
    const target = targets[i];
    const disperser = dispersers[i % dispersers.length];
    let row;
    try {
      const rows = await post({ targets: [target], variant: 'v1', viaDisperser: true, disperser });
      row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new Error('empty response from /fund');
      if (row.error) throw new Error(row.error);
    } catch (err) {
      const error = err?.message || String(err);
      say(`stopped at wallet ${i + 1}/${total}: ${error}`);
      say(
        `funded: ${funded} wallet(s); remaining: ${total - funded} — clear the funded rows' Fund amounts before re-sending`
      );
      return { funded, total, stopped: false, error };
    }

    funded++;
    say(
      row.simulated
        ? `simulated ${row.address} ${row.amountEth} ETH (dry run)`
        : `funded ${row.address} ${row.amountEth} ETH via ${short(row.disperser)} — ${row.hash}`
    );

    if (i < total - 1) {
      await wait(pacedDelayMs());
      if (stopped()) {
        say(`stopped by operator after ${funded}/${total} wallets`);
        return { funded, total, stopped: true, error: null };
      }
    }
  }

  say(`funded ${funded}/${total} wallets via disperser`);
  return { funded, total, stopped: false, error: null };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && node --test src/components/pacedFunding.test.js`
Expected: all 10 PASS.

Run: `cd frontend && npm test`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/pacedFunding.js frontend/src/components/pacedFunding.test.js
git commit -m "feat(v1): paced funding loop — one wallet per request, 4–7 s apart, stop on first error

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — wire the loop into V1's Send button

**Files:**
- Modify: `frontend/src/components/FundPanel.jsx` (imports, state, the Send `Busy`, the hint, add a Stop button)

**Interfaces:**
- Consumes: `runPacedFunding`, `PACE_MIN_MS`, `PACE_MAX_MS` from Task 3; `api(path, method, body)` from `frontend/src/api.js`; the existing `dispersers` prop (`{ addresses: string[], batchThreshold: number, ... }` from `GET /api/dispersers`, may be `null` while loading).
- Produces: nothing consumed elsewhere.

There is no component test harness in this repo (JSX is not run by `node --test`), so this task is verified by `vite build` and a manual dry-run check.

- [ ] **Step 1: Add the imports and state**

At the top of `frontend/src/components/FundPanel.jsx`, extend the react import and add the module import:

```js
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import { rolesFor } from '../variant.js';
import Address from './Address.jsx';
import { runPacedFunding, PACE_MIN_MS, PACE_MAX_MS } from './pacedFunding.js';
```

Inside the component, right after `const [timedStatus, setTimedStatus] = useState(null);`, add:

```js
  // V1 paced run. The Stop flag is a ref, not state: the loop reads it between
  // wallets and a re-render is not needed for it to take effect. `wake` lets
  // Stop cut the current 4–7 s gap short instead of waiting it out.
  const [pacing, setPacing] = useState(false);
  const stopRef = useRef(false);
  const wakeRef = useRef(null);

  function pacedWait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wakeRef.current = null;
        resolve();
      }, ms);
      wakeRef.current = () => {
        clearTimeout(t);
        wakeRef.current = null;
        resolve();
      };
    });
  }

  function stopPaced() {
    stopRef.current = true;
    if (wakeRef.current) wakeRef.current();
  }

  async function sendPaced() {
    stopRef.current = false;
    setPacing(true);
    try {
      await runPacedFunding({
        targets,
        dispersers: dispersers?.addresses || [],
        post: (body) => api('/fund', 'POST', body),
        wait: pacedWait,
        report,
        stopped: () => stopRef.current,
      });
    } finally {
      setPacing(false);
      // Give the last transfer a moment to land before re-reading balances.
      setTimeout(reload, 3000);
    }
  }
```

- [ ] **Step 2: Replace V1's Send button, hint and add Stop**

In the JSX, replace the whole existing Send `Busy` block:

```jsx
        <Busy
          busy={busy === 'fund'}
          disabled={!targets.length}
          title={targets.length ? '' : 'enter a fund amount in the table above'}
          onClick={() => act('fund', () => api(fundEndpoint, 'POST', fundBody))}
        >
          {targets.length
            ? isV2
              ? `Relay ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
              : `Send ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
            : 'Nothing to send'}
        </Busy>
```

with:

```jsx
        {isV2 ? (
          <Busy
            busy={busy === 'fund'}
            disabled={!targets.length}
            title={targets.length ? '' : 'enter a fund amount in the table above'}
            onClick={() => act('fund', () => api(fundEndpoint, 'POST', fundBody))}
          >
            {targets.length
              ? `Relay ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
              : 'Nothing to send'}
          </Busy>
        ) : (
          <>
            {/* V1 funds 1 by 1 through the disperser contract, 4–7 s apart, so
                every bundle wallet is funded by the contract rather than in one
                burst from the dev wallet. The burst/batched send is gone from
                this tab on purpose. */}
            <Busy
              busy={pacing}
              disabled={!targets.length || !(dispersers?.addresses?.length)}
              title={
                !targets.length
                  ? 'enter a fund amount in the table above'
                  : !(dispersers?.addresses?.length)
                    ? 'no disperser deployed — deploy one in step 2 first'
                    : ''
              }
              onClick={sendPaced}
            >
              {targets.length
                ? `Send ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'} — 1 by 1 via disperser, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart`
                : 'Nothing to send'}
            </Busy>
            {pacing && (
              <button
                className="spend"
                title="stop before the next wallet; a transfer already sent cannot be cancelled"
                onClick={stopPaced}
              >
                Stop
              </button>
            )}
          </>
        )}
```

Then replace the V1 batching hint block:

```jsx
        {!isV2 && targets.length > 0 && Boolean(threshold) && (
          <span className="hint">
            {batches && active > 0
              ? `batched through ${active} disperser contract${active === 1 ? '' : 's'} — one transaction`
              : batches
                ? `${targets.length} recipients and no disperser deployed — one transfer per wallet, which is what rate limiting hits first. Deploy one in step 2.`
                : `${targets.length} recipient${targets.length === 1 ? '' : 's'}, below the ${threshold} batching threshold — individual transfers are cheaper here`}
          </span>
        )}
```

with:

```jsx
        {!isV2 && targets.length > 0 && (
          <span className="hint">
            {active > 0
              ? `one disperser transaction per wallet, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart${active > 1 ? `, rotating across ${active} contracts` : ''}`
              : 'no disperser deployed — deploy one in step 2 first'}
          </span>
        )}
```

Finally remove the now-unused locals `threshold` and `batches` (keep `active`):

```js
  const active = dispersers?.addresses?.length ?? 0;
  const fundEndpoint = isV2 ? '/v2/relay/fund' : '/fund';
  const fundBody = isV2 ? { targets } : { targets, variant };
```

Also update the V1 lede paragraph (the non-V2 branch) to describe the new behaviour:

```jsx
          <>
            Sends ETH from the dev wallet to each bundle wallet through the disperser contract, one
            wallet at a time and {PACE_MIN_MS / 1000}–{PACE_MAX_MS / 1000} seconds apart, using the{' '}
            <b>Fund</b> column in the table above. Blank rows are skipped. Fund a little above what
            each wallet will buy — it pays its own gas. Stop halts before the next wallet.
          </>
```

Also disable the sweep button while pacing so the two cannot interleave — on the existing sweep `Busy`, add `disabled={pacing}`.

- [ ] **Step 3: Build and check the V2 branch is untouched**

Run: `cd frontend && npm run build`
Expected: build succeeds with no warnings about unused imports/variables from this file.

Run: `git diff frontend/src/components/FundPanel.jsx | grep '^-' | grep -i 'isV2\|relay\|timed'`
Expected: no removed lines mention V2/Relay/timed code (only the shared Send block was restructured, with V2's button preserved verbatim inside the `isV2` branch).

- [ ] **Step 4: Manual dry-run check**

With the backend running in `DRY_RUN=true` (`cd backend && npm run dev`) and the frontend dev server (`cd frontend && npm run dev`), on the **v1 tab**: deploy/record a disperser in step 2 if none exists, enter Fund amounts for 3 wallets in step 3, click the Send button in step 4. Expected: the report box fills line by line — a header, then `simulated 0x… 0.01 ETH (dry run)` lines roughly 4–7 s apart (dry run returns `simulated: true` rows and never reaches the disperser), ending with `funded 3/3 wallets via disperser`; the Stop button appears while running and pressing it ends the run before the next wallet with `stopped by operator after k/3 wallets`. Check the **v2 tab** step 4 still shows the Relay button and the timed-funding row exactly as before.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FundPanel.jsx
git commit -m "feat(v1): step 4 sends 1 by 1 via the disperser with a 4–7 s gap and a Stop button

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: backend flag + validation + no-fallback (Task 1), route + activity line (Task 2), 4–7 s random gap + stop-on-first-error + Stop button + rotation + messages (Tasks 3–4), removal of the burst send on V1 and untouched V2 branch (Task 4), tests for both sides (Tasks 1, 3). Dry run: the backend's existing `simulated` short-circuit returns before the forced path, and the frontend loop treats those rows as successes (no `error` field) — matches the spec.
- Names used consistently: `viaDisperser`, `disperser`, `resolveDisperser`, `sendViaDisperser`, `pacedDelayMs`, `runPacedFunding`, `PACE_MIN_MS`, `PACE_MAX_MS`, `sendPaced`, `stopPaced`, `pacedWait`.
