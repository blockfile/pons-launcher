# V4 Funder Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn V4 step 5 into "sweep funders to a super-main": leftover funder ETH goes to one chosen super-main by Relay (default) or a direct send, with per-funder unticking — and no path that can reach an aged seed wallet.

**Architecture:** `backend/src/v4/sweep.js` is reworked in place: sources come from one function (`funders`) that reads only the `v4master` role minus super-mains; `run` refuses any `walletIds` entry that is not a funder before reading a balance. A `route` switch picks the existing Relay path (plus stop-at-first-rate-limit) or a new direct path (estimated gas, broadcast-then-await receipts, honours DRY_RUN). The console panel swaps its category checkboxes for a route select and a tickable preview.

**Tech Stack:** Node (CommonJS, `node:test`), ethers v6, Express; React 19 + Vite frontend (ESM, `node:test` for pure helpers).

**Spec:** `docs/superpowers/specs/2026-09-11-v4-funder-sweep-design.md`

## Global Constraints

- **Aged wallets are never swept.** `v4/sweep.js` must not call `v4roles.seeds()`, `walletsWithRole('v4seed')` or `store.withdrawnSeedIds()`. Any `walletIds` entry that is not a funder refuses the whole run before any chain read.
- **Funder** = `v4master` whose id is NOT in `store.superMainIds()`. **Super-main** = `v4master` whose id IS in it. Destination must be a super-main.
- A funder that is `masterWalletId` of a campaign with status `running`, `paused` or `halted` is never swept.
- `route` ∈ `{'relay','direct'}`, default `'relay'`.
- Relay math unchanged: gas = `gasCost(fees(+25%), 50_000)`, amount = `(balance − gas) × 97 / 100`, floor `0.002` ETH.
- Direct gas limit = `estimateGas({from,to,value:1n}) × 120 / 100`, floored at `30_000n`; a failed estimate → `30_000n`. Amount = `balance − gasLimit × maxFeePerGas(+25%)`; skip if `≤ 0`.
- Direct receipts awaited with `timeoutMs: 30_000`.
- Relay rate-limit regex: `/try again later|could not process|rate.?limit|too many|\b429\b/i`.
- Both routes honour DRY_RUN (`deps.dryRun ?? config.dryRun`).
- Isolation rule: V4 owns its code. Do NOT import from `wallets/funding.js`, `v3/*`, or any other tab. Do NOT modify `backend/src/v4/relay.js`. Importing `evm/provider`, `evm/fees`, `evm/receipt`, `config` is fine (v4 already does).
- Do not change any CSS or button classes (money-colour law): Preview stays `btn-primary`, Sweep stays `danger`.

---

### Task 1: Backend — funders-only sweep with a Relay/Direct route

**Files:**
- Rewrite: `backend/src/v4/sweep.js`
- Rewrite: `backend/src/v4/sweep.test.js`
- Modify: `backend/src/routes/v4.js:1166-1207` (the two sweep handlers)

**Interfaces:**
- Consumes: `v4roles.masters(ks)`, `store.superMainIds(): Set<string>`, `store.campaigns(): {status, masterWalletId}[]`, `relay.transfer({fromWallet,toAddress,amountWei}, deps) → {hash, requestId, simulated?}`, `ks.signer(id, rpc).sendTransaction(tx) → {hash}`, `waitForReceipt(rpc, hash, {timeoutMs}) → receipt|null`.
- Produces:
  - `GET /api/v4/sweep/preview?destinationId=&route=` → `{ destination:{walletId,address}, route, minSweepEth, wallets:[{walletId,address,balanceEth,sendEth,sendWeiRaw}], skipped:[{walletId,address,balanceEth|null,reason}], walletCount, totalEth, totalEthRaw }`
  - `POST /api/v4/sweep` body `{ destinationId, route, walletIds, minSweepEth, confirm }` → `{ action:'v4-sweep-funders', route, dryRun, destination:{walletId,address}, wallets:[{...row, status:'sent'|'confirmed'|'reverted'|'pending'|'failed'|'not-attempted'|'simulated', hash?, requestId?, error?}], skipped, totals:{wallets, moved, failed, pending, notAttempted, eth, ethRaw} }`

- [ ] **Step 1: Replace the test file with the new tests**

Write `backend/src/v4/sweep.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');
const sweep = require('./sweep');

const A = {
  f1: '0x1111111111111111111111111111111111111111',
  f2: '0x2222222222222222222222222222222222222222',
  sm1: '0x3333333333333333333333333333333333333333',
  sm2: '0x6666666666666666666666666666666666666666',
  s1: '0x4444444444444444444444444444444444444444',
  s2: '0x5555555555555555555555555555555555555555',
};

// f1, f2: funders. sm1, sm2: flagged super-mains. s1, s2: aged seed wallets (s1 withdrawn).
const MASTERS = [
  { id: 'f1', address: A.f1, role: 'v4master' },
  { id: 'f2', address: A.f2, role: 'v4master' },
  { id: 'sm1', address: A.sm1, role: 'v4master' },
  { id: 'sm2', address: A.sm2, role: 'v4master' },
];
const SEEDS = [
  { id: 's1', address: A.s1, role: 'v4seed' },
  { id: 's2', address: A.s2, role: 'v4seed' },
];

// EVERY wallet holds ETH — seeds and super-mains included — so "was not swept" can never
// pass just because a wallet happened to be empty.
const RICH = {
  [A.f1]: parseEther('0.5'),
  [A.f2]: parseEther('0.5'),
  [A.sm1]: parseEther('1'),
  [A.sm2]: parseEther('1'),
  [A.s1]: parseEther('0.5'),
  [A.s2]: parseEther('0.5'),
};

const GWEI = 1_000_000_000n;
const FEES = { type: 2, maxFeePerGas: GWEI, maxPriorityFeePerGas: 1_000_000n };
const FUNDERS = ['f1', 'f2'];
const NEVER = ['sm1', 'sm2', 's1', 's2'];

function fakeKs(log) {
  return {
    walletsWithRole: (r) => {
      log.roleReads.push(r);
      return r === 'v4master' ? MASTERS : r === 'v4seed' ? SEEDS : [];
    },
    walletWithRole: () => null,
    signer: (id) => ({
      sendTransaction: async (tx) => {
        if ((log.sendFails || []).includes(id)) throw new Error('nonce too low');
        log.signed.push({ from: id, ...tx });
        return { hash: `0xhash-${id}` };
      },
    }),
  };
}

function fakeStore({ superMains = ['sm1', 'sm2'], campaigns = [] } = {}) {
  return {
    superMainIds: () => new Set(superMains),
    campaigns: () => campaigns,
    // Present so a regression that reads it gets an answer rather than a crash — the tests
    // assert that nothing the sweep returns or sends ever names a seed.
    withdrawnSeedIds: () => new Set(['s1']),
  };
}

function harness(o = {}) {
  const balances = o.balances || RICH;
  const log = { roleReads: [], signed: [], transfers: [], balanceReads: [], sendFails: o.sendFails, activity: null };
  const ks = fakeKs(log);
  const deps = {
    keystoreForFn: () => ks,
    storeForFn: () => fakeStore(o.store),
    activityForFn: () => ({ record: (tab, msg, data) => (log.activity = { tab, msg, data }) }),
    rpc: {
      getBalance: async (a) => {
        log.balanceReads.push(a);
        return BigInt(balances[a] ?? 0n);
      },
      estimateGas: o.estimateGas || (async () => 40_000n),
    },
    relay: {
      transfer: async ({ fromWallet, toAddress, amountWei }) => {
        log.transfers.push({ from: fromWallet.id, to: toAddress, amountWei });
        if (o.relayFail) o.relayFail(log.transfers.length);
        return { hash: '0xh', requestId: '0xr' };
      },
    },
    getFeesFn: async () => FEES,
    waitForReceiptFn: o.waitForReceipt || (async () => ({ status: 1 })),
    dryRun: o.dryRun ?? false,
  };
  return { deps, log };
}

const mentioned = (out) => [...(out.wallets || []), ...(out.skipped || [])].map((r) => r.walletId);

// ── the aged-wallet rule ─────────────────────────────────────────────────────

test('funders are the v4masters that are not super-mains — the seed role is never read', () => {
  const log = { roleReads: [], signed: [] };
  const out = sweep._private.funders(fakeKs(log), fakeStore());
  assert.deepEqual(out.map((w) => w.id), FUNDERS);
  assert.ok(!log.roleReads.includes('v4seed'));
});

for (const route of ['relay', 'direct']) {
  test(`${route}: preview names funders only — never a super-main, never an aged seed`, async () => {
    const { deps, log } = harness();
    const p = await sweep.preview('u', { destinationId: 'sm1', route }, deps);
    assert.equal(p.route, route);
    assert.deepEqual(p.wallets.map((w) => w.walletId), FUNDERS);
    for (const id of NEVER) assert.ok(!mentioned(p).includes(id), `${id} is not even considered`);
    assert.ok(!log.roleReads.includes('v4seed'), 'the seed role is never read');
    assert.ok(!log.balanceReads.includes(A.s1) && !log.balanceReads.includes(A.s2), 'no seed balance is read');
  });

  test(`${route}: run moves funders only, to the chosen super-main`, async () => {
    const { deps, log } = harness();
    const out = await sweep.run('u', { destinationId: 'sm1', route, walletIds: FUNDERS, confirm: true }, deps);
    const sends = route === 'direct' ? log.signed : log.transfers;
    assert.deepEqual(sends.map((t) => t.from), FUNDERS);
    assert.ok(sends.every((t) => t.to === A.sm1), 'every send lands at the chosen super-main');
    for (const id of NEVER) assert.ok(!mentioned(out).includes(id));
    assert.ok(!log.roleReads.includes('v4seed'));
  });

  test(`${route}: a run naming a seed, a super-main or an unknown id is refused whole — nothing read, nothing sent`, async () => {
    for (const bad of ['s1', 's2', 'sm1', 'sm2', 'nope']) {
      const { deps, log } = harness();
      await assert.rejects(
        () => sweep.run('u', { destinationId: 'sm1', route, walletIds: ['f1', bad], confirm: true }, deps),
        /not a funder/
      );
      assert.equal(log.balanceReads.length, 0, `${bad}: refused before any balance is read`);
      assert.equal(log.signed.length + log.transfers.length, 0, `${bad}: nothing sent`);
    }
  });
}

// ── the destination ──────────────────────────────────────────────────────────

test('the destination must be a flagged super-main', async () => {
  for (const bad of ['f1', 's1', 'nope', undefined]) {
    const { deps } = harness();
    await assert.rejects(() => sweep.preview('u', { destinationId: bad }, deps), /super-main/);
  }
});

test('with no super-main flagged, the sweep says to flag one first', async () => {
  const { deps } = harness({ store: { superMains: [] } });
  await assert.rejects(() => sweep.preview('u', { destinationId: 'sm1' }, deps), /flag one in step 1/);
});

// ── live campaigns ───────────────────────────────────────────────────────────

test('a funder whose campaign is running, paused or halted is skipped and named, never sent', async () => {
  for (const status of ['running', 'paused', 'halted']) {
    const { deps, log } = harness({ store: { campaigns: [{ status, masterWalletId: 'f2' }] } });
    const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
    assert.deepEqual(p.wallets.map((w) => w.walletId), ['f1'], status);
    assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /campaign/);

    const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
    assert.deepEqual(log.transfers.map((t) => t.from), ['f1'], `${status}: f2 is held back`);
    assert.ok(out.skipped.some((s) => s.walletId === 'f2'), 'a ticked funder that went busy is named');
  }
});

test('a funder whose campaign is complete or cancelled is free to sweep', async () => {
  const { deps } = harness({
    store: {
      campaigns: [
        { status: 'complete', masterWalletId: 'f1' },
        { status: 'cancelled', masterWalletId: 'f2' },
      ],
    },
  });
  const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
  assert.deepEqual(p.wallets.map((w) => w.walletId), FUNDERS);
});

// ── route ────────────────────────────────────────────────────────────────────

test('route defaults to relay and refuses anything else', async () => {
  const { deps } = harness();
  assert.equal((await sweep.preview('u', { destinationId: 'sm1' }, deps)).route, 'relay');
  await assert.rejects(() => sweep.preview('u', { destinationId: 'sm1', route: 'bridge' }, deps), /route/);
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'sm1', route: 'bridge', walletIds: FUNDERS, confirm: true }, deps),
    /route/
  );
});

test('the relay route never signs a direct send; the direct route never places a Relay order', async () => {
  const relay = harness();
  await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, relay.deps);
  assert.equal(relay.log.signed.length, 0);

  const direct = harness();
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, direct.deps);
  assert.equal(direct.log.transfers.length, 0);
});

// ── relay amounts and rate limit ─────────────────────────────────────────────

test('relay: sends 97% of the balance after gas, and skips a funder under the dust floor', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.5'), [A.f2]: parseEther('0.001') } });
  const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
  const gas = 50_000n * GWEI;
  assert.equal(p.wallets[0].sendWeiRaw, (((parseEther('0.5') - gas) * 97n) / 100n).toString());
  assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /floor/);
});

test('relay stops at the first rate-limit refusal; the rest are not attempted and keep their ETH', async () => {
  const { deps, log } = harness({
    relayFail: (n) => {
      if (n === 1) throw new Error('Could not process request. Please try again later.');
    },
  });
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.transfers.length, 1, 'no second quote while Relay is blocking');
  assert.deepEqual(out.wallets.map((w) => w.status), ['failed', 'not-attempted']);
  assert.equal(out.totals.notAttempted, 1);
});

test('relay keeps going past an error that is not a rate limit', async () => {
  const { deps, log } = harness({
    relayFail: (n) => {
      if (n === 1) throw new Error('Relay quote did not include a deposit transaction');
    },
  });
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.transfers.length, 2);
  assert.deepEqual(out.wallets.map((w) => w.status), ['failed', 'sent']);
});

// ── direct amounts ───────────────────────────────────────────────────────────

test('directGasLimit: the estimate plus 20%, never under the 30k floor, the floor when it fails', async () => {
  const at = (est) => ({ estimateGas: async () => est });
  assert.equal(await sweep._private.directGasLimit(at(40_000n), A.f1, A.sm1), 48_000n);
  assert.equal(await sweep._private.directGasLimit(at(21_195n), A.f1, A.sm1), 30_000n);
  const broken = {
    estimateGas: async () => {
      throw new Error('rpc down');
    },
  };
  assert.equal(await sweep._private.directGasLimit(broken, A.f1, A.sm1), 30_000n);
});

test('direct: sends the balance minus its own gas ceiling, signed with that gas limit', async () => {
  const { deps, log } = harness({ balances: { [A.f1]: parseEther('0.5') } });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['f1'], confirm: true }, deps);
  const reserve = 48_000n * GWEI; // 40k estimate × 1.2, at a 1 gwei ceiling
  assert.equal(log.signed.length, 1);
  assert.equal(log.signed[0].value, parseEther('0.5') - reserve);
  assert.equal(log.signed[0].gasLimit, 48_000n);
  assert.equal(log.signed[0].maxFeePerGas, GWEI);
  assert.equal(out.wallets[0].status, 'confirmed');
  assert.equal(out.totals.moved, 1);
});

test('direct: a funder that cannot cover its own gas is skipped and named', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.5'), [A.f2]: 40_000n * GWEI } });
  const p = await sweep.preview('u', { destinationId: 'sm1', route: 'direct' }, deps);
  assert.deepEqual(p.wallets.map((w) => w.walletId), ['f1']);
  assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /own gas/);
});

test('direct: a reverted receipt, a missing receipt and a failed send each report as such', async () => {
  const receipts = { '0xhash-f1': { status: 0 }, '0xhash-f2': null };
  const { deps } = harness({ waitForReceipt: async (_rpc, hash) => receipts[hash] });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.deepEqual(out.wallets.map((w) => w.status), ['reverted', 'pending']);
  assert.equal(out.totals.moved, 0);
  assert.equal(out.totals.failed, 1);
  assert.equal(out.totals.pending, 1);

  const failing = harness({ sendFails: ['f1'] });
  const out2 = await sweep.run(
    'u',
    { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true },
    failing.deps
  );
  assert.equal(out2.wallets.find((w) => w.walletId === 'f1').status, 'failed');
  assert.equal(out2.wallets.find((w) => w.walletId === 'f2').status, 'confirmed', 'one failure does not stop the rest');
});

test('direct waits at most 30 s for each receipt', async () => {
  let opts;
  const { deps } = harness({
    waitForReceipt: async (_rpc, _hash, o) => {
      opts = o;
      return { status: 1 };
    },
  });
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['f1'], confirm: true }, deps);
  assert.equal(opts.timeoutMs, 30_000);
});

test('direct under DRY_RUN signs nothing and reports simulated', async () => {
  const { deps, log } = harness({ dryRun: true });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.signed.length, 0);
  assert.ok(out.wallets.every((w) => w.status === 'simulated'));
  assert.equal(out.dryRun, true);
});

// ── run gates ────────────────────────────────────────────────────────────────

test('run requires confirm', async () => {
  const { deps, log } = harness();
  await assert.rejects(() => sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS }, deps), /confirm/);
  assert.equal(log.transfers.length, 0);
});

test('run requires the ticked walletIds', async () => {
  for (const walletIds of [undefined, [], 'f1']) {
    const { deps } = harness();
    await assert.rejects(() => sweep.run('u', { destinationId: 'sm1', walletIds, confirm: true }, deps), /walletIds/);
  }
});

test('an unticked funder is left alone and not reported', async () => {
  const { deps, log } = harness();
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: ['f2'], confirm: true }, deps);
  assert.deepEqual(log.transfers.map((t) => t.from), ['f2']);
  assert.ok(!mentioned(out).includes('f1'));
});

test('run refuses when nothing ticked clears the floor', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.001') } });
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'sm1', walletIds: ['f1'], confirm: true }, deps),
    /nothing to sweep/
  );
});

test('the activity log records the route, and a direct sweep says it links the funders', async () => {
  const { deps, log } = harness();
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.activity.tab, 'v4');
  assert.equal(log.activity.data.route, 'direct');
  assert.match(log.activity.msg, /links these funders/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && node --test src/v4/sweep.test.js`
Expected: FAIL — e.g. `sweep._private.funders is not a function`, and preview/run assertions failing (the old module still takes `categories`).

- [ ] **Step 3: Rewrite `backend/src/v4/sweep.js`**

```js
'use strict';

/**
 * Sweeping ETH out of V4's FUNDER wallets, to one super-main.
 *
 * After a run, ETH sits scattered across the funders — each campaign's leftover. This moves
 * it to ONE super-main the operator names, by the route the operator picks per sweep.
 *
 * FUNDERS ONLY — AN AGED SEED IS NEVER SWEPT. The sources are the v4master wallets that are
 * not flagged super-main, and nothing else. This module never reads the seed role, and a run
 * naming anything that is not a funder — a seed, a super-main, another tab's wallet — is
 * refused whole before a single balance is read. A seed's value is that it looks unrelated
 * to everything else the operator holds, no sweep is worth that, so there is no path here
 * that can reach one. (Seeds handed to V1/V3 are re-roled out of v4seed by the claim, so
 * they are unreachable by construction too.)
 *
 * A funder that is the source of a live campaign — running, paused or halted — is never
 * swept: its ETH is earmarked for drips that are still aging seeds. It is named in
 * `skipped` rather than silently left out.
 *
 * TWO ROUTES:
 *
 *   relay   (default) one Relay order per funder. The funder pays a deposit address and a
 *           solver pays the super-main, so the two share no on-chain edge — the same
 *           property the split that funded the funder had. Costs a Relay fee + gas; 3% is
 *           held back for the fee, so small balances fall under the dust floor. Stops at
 *           the FIRST rate-limit refusal: Relay's /quote budget on this chain is ~5 per
 *           window per IP and every request sent while blocked re-arms the block, so the
 *           funders after it are reported not-attempted and keep their ETH for a re-run.
 *
 *   direct  a plain send of the balance minus its own gas. Recovers almost everything, and
 *           draws a public funder → super-main link for every funder swept. It links no
 *           seed: every funder → seed transfer went through Relay.
 *
 * Both honour DRY_RUN — nothing is signed, and rows come back `simulated`.
 *
 * V4 owns its own copy of every piece of this, per the isolation rule — the gas estimate
 * below included, which is deliberately not imported from wallets/funding.js.
 */

const { formatEther, getAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v4roles = require('./roles');
const { storeFor } = require('./store');
const defaultRelay = require('./relay');

const ROUTES = ['relay', 'direct'];

const DEPOSIT_GAS = 50_000n; // a Relay deposit is a plain value send
const RELAY_FEE_PCT = 3; // held back for Relay's sender-side fee
const FEE_BUMP_PCT = 25;
const DEFAULT_MIN_SWEEP_ETH = '0.002'; // below this the Relay fee+gas eat the balance

// A plain send costs 21,195 gas on this chain, not the textbook 21,000 — hard-coding 21,000
// had the node reject every send with "intrinsic gas too low". So the chain is asked, with
// headroom, and this is only the floor for when the estimate fails.
const DIRECT_GAS_FLOOR = 30_000n;
const DIRECT_GAS_HEADROOM_PCT = 20;

// How long a direct sweep waits for its receipts: under nginx's ~60 s read timeout, so the
// console still gets its answer. A send not seen by then is reported pending, not failed.
const DIRECT_RECEIPT_TIMEOUT_MS = 30_000;

// Relay's rate-limit refusal — HTTP 429 "Could not process request. Please try again later."
// Matched on the message because v4/relay.js, the campaigns' money path, is deliberately not
// changed to carry a status code.
const RELAY_RATE_LIMIT_RE = /try again later|could not process|rate.?limit|too many|\b429\b/i;

// A campaign in any of these still spends from its funder.
const LIVE_CAMPAIGN = new Set(['running', 'paused', 'halted']);

function wire(deps = {}) {
  return {
    ksFor: deps.keystoreForFn || keystoreFor,
    storeForFn: deps.storeForFn || storeFor,
    activity: deps.activityForFn || activityFor,
    rpc: deps.rpc || provider,
    relay: deps.relay || defaultRelay,
    getFeesFn: deps.getFeesFn || getFees,
    waitFn: deps.waitForReceiptFn || waitForReceipt,
    dryRun: Boolean(deps.dryRun ?? config.dryRun),
  };
}

/**
 * THE ONE PLACE THAT DECIDES WHAT MAY BE SWEPT: every v4master that is not a super-main.
 * It reads the master role only, so a seed cannot appear in its answer.
 */
function funders(ks, store) {
  const supers = store.superMainIds();
  return v4roles.masters(ks).filter((w) => !supers.has(w.id));
}

function assertRoute(route) {
  if (!ROUTES.includes(route)) throw new Error(`route must be "relay" or "direct", not "${route}"`);
}

/** The destination: a flagged super-main, and nothing else. */
function resolveDestination(ks, store, destinationId) {
  const supers = store.superMainIds();
  if (supers.size === 0) {
    throw new Error('no super-main is flagged — flag one in step 1 first, then sweep the funders to it');
  }
  const to = v4roles.masters(ks).find((w) => w.id === destinationId && supers.has(w.id));
  if (!to) throw new Error('the destination must be one of your super-mains');
  return to;
}

/**
 * Refuse any id that is not a funder, before a single balance is read. This is the gate that
 * keeps a hand-written request from pointing the sweep at a seed.
 */
function assertFunderIds(ks, store, walletIds) {
  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    throw new Error('walletIds[] is required — the funders to sweep, as ticked in the preview');
  }
  const ok = new Set(funders(ks, store).map((w) => w.id));
  for (const id of walletIds) {
    if (!ok.has(id)) {
      throw new Error(`wallet ${id} is not a funder — only funders are swept; seeds and super-mains never are`);
    }
  }
  return new Set(walletIds);
}

/**
 * The gas limit a direct send is signed with. Estimated once per sweep — every send is the
 * same plain transfer to the same address. Never throws: a failed estimate is the floor.
 */
async function directGasLimit(rpc, from, to) {
  try {
    const est = BigInt(await rpc.estimateGas({ from, to, value: 1n }));
    const withHeadroom = (est * BigInt(100 + DIRECT_GAS_HEADROOM_PCT)) / 100n;
    return withHeadroom > DIRECT_GAS_FLOOR ? withHeadroom : DIRECT_GAS_FLOOR;
  } catch (_err) {
    return DIRECT_GAS_FLOOR;
  }
}

function statusOf(receipt) {
  if (!receipt) return 'pending';
  return Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
}

function errText(err) {
  return err?.shortMessage || err?.message || String(err);
}

function rowOf({ wallet, balance, amountWei }) {
  return {
    walletId: wallet.id,
    address: wallet.address,
    balanceEth: formatEther(balance),
    sendEth: formatEther(amountWei),
    sendWeiRaw: amountWei.toString(),
  };
}

async function plan(userId, { destinationId, route = 'relay', minSweepEth } = {}, deps = {}) {
  const w = wire(deps);
  assertRoute(route);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);
  const to = resolveDestination(ks, store, destinationId);

  const busy = new Set(
    store
      .campaigns()
      .filter((c) => LIVE_CAMPAIGN.has(c.status))
      .map((c) => c.masterWalletId)
  );
  const sources = [];
  const skipped = [];
  for (const wallet of funders(ks, store)) {
    if (wallet.id === to.id) continue; // a super-main is never a funder — asserted, not trusted
    if (busy.has(wallet.id)) {
      skipped.push({
        walletId: wallet.id,
        address: wallet.address,
        balanceEth: null,
        reason: 'running a campaign — sweeping it would starve the campaign',
      });
      continue;
    }
    sources.push(wallet);
  }

  const fees = await w.getFeesFn(FEE_BUMP_PCT);
  const minWei = parseEther(String(minSweepEth ?? DEFAULT_MIN_SWEEP_ETH));
  let gasLimit = DEPOSIT_GAS;
  if (route === 'direct') {
    gasLimit = sources.length ? await directGasLimit(w.rpc, sources[0].address, to.address) : DIRECT_GAS_FLOOR;
  }
  const gas = gasCost(fees, gasLimit);

  const wallets = [];
  for (const wallet of sources) {
    const balance = BigInt(await w.rpc.getBalance(wallet.address));
    const skip = (reason) =>
      skipped.push({ walletId: wallet.id, address: wallet.address, balanceEth: formatEther(balance), reason });
    if (balance <= 0n) {
      skip('nothing to sweep');
      continue;
    }
    if (route === 'direct') {
      // Everything but the send's own gas ceiling. The node checks value + gasLimit ×
      // maxFeePerGas against the balance, so at these fees this is the most that fits.
      const amountWei = balance - gas;
      if (amountWei <= 0n) {
        skip(`${formatEther(balance)} ETH does not cover the send's own gas (${formatEther(gas)} ETH)`);
        continue;
      }
      wallets.push({ wallet, balance, amountWei });
    } else {
      const afterGas = balance - gas;
      const amountWei = afterGas > 0n ? (afterGas * BigInt(100 - RELAY_FEE_PCT)) / 100n : 0n;
      if (amountWei < minWei) {
        skip(
          `too small for a Relay order — ${formatEther(balance)} ETH would send ${formatEther(amountWei)}, ` +
            `under the ${formatEther(minWei)} floor`
        );
        continue;
      }
      wallets.push({ wallet, balance, amountWei });
    }
  }

  return { to, route, wallets, skipped, minWei, fees, gasLimit };
}

/** What a sweep would move. Reads only. */
async function preview(userId, input = {}, deps = {}) {
  const { to, route, wallets, skipped, minWei } = await plan(userId, input, deps);
  const total = wallets.reduce((sum, x) => sum + x.amountWei, 0n);
  return {
    destination: { walletId: to.id, address: to.address },
    route,
    minSweepEth: formatEther(minWei),
    wallets: wallets.map(rowOf),
    skipped,
    walletCount: wallets.length,
    totalEth: formatEther(total),
    totalEthRaw: total.toString(),
  };
}

/**
 * One Relay order per funder, in turn — each is quoted against the sender's live balance
 * and nonce. Stops at the first rate-limit refusal (see RELAY_RATE_LIMIT_RE).
 */
async function sendRelay(w, ks, deps, to, wallets) {
  const results = [];
  let limited = false;
  for (const x of wallets) {
    const entry = rowOf(x);
    if (limited) {
      results.push({ ...entry, status: 'not-attempted', error: 'Relay is rate-limiting — run the sweep again in a minute' });
      continue;
    }
    try {
      const sent = await w.relay.transfer(
        { fromWallet: x.wallet, toAddress: to.address, amountWei: x.amountWei },
        { ...deps, keystore: ks, rpc: w.rpc }
      );
      results.push({ ...entry, status: sent.simulated ? 'simulated' : 'sent', hash: sent.hash, requestId: sent.requestId });
    } catch (err) {
      const error = errText(err);
      results.push({ ...entry, status: 'failed', error });
      if (RELAY_RATE_LIMIT_RE.test(error)) limited = true;
    }
  }
  return results;
}

/**
 * A plain send per funder. Every send is broadcast before any receipt is awaited — the
 * wallets are independent (each signs its own nonce), so waiting on them one at a time
 * would only add latency to a request nginx cuts off at ~60 s.
 */
async function sendDirect(w, ks, to, wallets, { fees, gasLimit }) {
  if (w.dryRun) return wallets.map((x) => ({ ...rowOf(x), status: 'simulated', hash: null }));

  const toAddr = getAddress(to.address);
  const broadcast = [];
  for (const x of wallets) {
    const entry = rowOf(x);
    try {
      const tx = await ks
        .signer(x.wallet.id, w.rpc)
        .sendTransaction({ to: toAddr, value: x.amountWei, gasLimit, ...fees });
      broadcast.push({ entry, hash: tx.hash });
    } catch (err) {
      broadcast.push({ entry, error: errText(err) });
    }
  }
  return Promise.all(
    broadcast.map(async ({ entry, hash, error }) => {
      if (!hash) return { ...entry, status: 'failed', hash: null, error };
      const receipt = await w.waitFn(w.rpc, hash, { timeoutMs: DIRECT_RECEIPT_TIMEOUT_MS }).catch(() => null);
      return { ...entry, status: statusOf(receipt), hash };
    })
  );
}

/**
 * Sweep the ticked funders to the super-main.
 *
 * @param {string[]} input.walletIds the funders to sweep — every one must be a funder.
 * @param {'relay'|'direct'} [input.route='relay']
 * @param {boolean} input.confirm required.
 */
async function run(userId, input = {}, deps = {}) {
  const w = wire(deps);
  if (input.confirm !== true) {
    throw new Error("sweeping moves each ticked funder's whole balance — requires { confirm: true }");
  }
  const route = input.route ?? 'relay';
  assertRoute(route);
  const ks = w.ksFor(userId);
  const store = w.storeForFn(userId);
  const ticked = assertFunderIds(ks, store, input.walletIds);

  const planned = await plan(userId, { ...input, route }, deps);
  const { to } = planned;
  const wallets = planned.wallets.filter((x) => ticked.has(x.wallet.id));
  // A ticked funder the fresh plan skipped — it started a campaign, or its balance fell
  // under the floor, since the preview — is named with the plan's reason.
  const skipped = planned.skipped.filter((s) => ticked.has(s.walletId));
  if (!wallets.length) {
    throw new Error('nothing to sweep — every ticked funder is empty, under the floor, or running a campaign');
  }

  const results =
    route === 'direct' ? await sendDirect(w, ks, to, wallets, planned) : await sendRelay(w, ks, deps, to, wallets);

  const MOVED = ['sent', 'confirmed', 'simulated'];
  const count = (...statuses) => results.filter((r) => statuses.includes(r.status)).length;
  const movedWei = results
    .filter((r) => MOVED.includes(r.status))
    .reduce((sum, r) => sum + BigInt(r.sendWeiRaw), 0n);
  const totals = {
    wallets: results.length,
    moved: count(...MOVED),
    failed: count('failed', 'reverted'),
    pending: count('pending'),
    notAttempted: count('not-attempted'),
    eth: formatEther(movedWei),
    ethRaw: movedWei.toString(),
  };

  const how = route === 'direct' ? 'directly — links these funders to the super-main on-chain' : 'through Relay';
  w.activity(userId).record(
    'v4',
    `[v4] swept ${totals.moved}/${totals.wallets} funder(s) to the super-main ${to.address} ${how}` +
      (w.dryRun ? ' (dry run — nothing signed)' : '') +
      (totals.failed ? `, ${totals.failed} failed` : '') +
      (totals.pending ? `, ${totals.pending} pending` : '') +
      (totals.notAttempted ? `, ${totals.notAttempted} not attempted (Relay rate limit)` : '') +
      (movedWei > 0n ? ` — ${formatEther(movedWei)} ETH` : ''),
    { destination: to.address, route, dryRun: w.dryRun, totals, wallets: results, skipped }
  );

  return {
    action: 'v4-sweep-funders',
    route,
    dryRun: w.dryRun,
    destination: { walletId: to.id, address: getAddress(to.address) },
    wallets: results,
    skipped,
    totals,
  };
}

module.exports = {
  preview,
  run,
  ROUTES,
  DEFAULT_MIN_SWEEP_ETH,
  RELAY_FEE_PCT,
  DIRECT_GAS_FLOOR,
  _private: { plan, funders, resolveDestination, assertFunderIds, directGasLimit, RELAY_RATE_LIMIT_RE },
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && node --test src/v4/sweep.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Update the two route handlers in `backend/src/routes/v4.js`**

Replace the block from `// ── gather / sweep ──` through the end of the `router.post('/v4/sweep', …)` handler with:

```js
// ── sweep: funders → a super-main ─────────────────────────────────────────────

// GET /api/v4/sweep/preview — what sweeping the funders to the chosen super-main would
// move, by the chosen route (relay | direct). Reads only. Funders only — never a seed.
router.get('/v4/sweep/preview', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(
        await sweep.preview(req.user.id, {
          destinationId: req.query.destinationId,
          route: req.query.route || undefined,
          minSweepEth: req.query.minSweepEth,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/v4/sweep — sweep the ticked funders to a super-main, by Relay (default) or
// direct. v4/sweep.js refuses any walletId that is not a funder, so no request can reach
// an aged seed.
router.post('/v4/sweep', requireApiKey, async (req, res, next) => {
  try {
    res.json(
      jsonSafe(
        await sweep.run(req.user.id, {
          destinationId: req.body?.destinationId,
          route: req.body?.route,
          walletIds: req.body?.walletIds,
          minSweepEth: req.body?.minSweepEth,
          confirm: req.body?.confirm,
        })
      )
    );
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS. Nothing else references `sweep.CATEGORIES` or `_private.resolveSources` (verified: only the old `sweep.test.js` did).

- [ ] **Step 7: Commit**

```bash
git add backend/src/v4/sweep.js backend/src/v4/sweep.test.js backend/src/routes/v4.js
git commit -m "feat(v4): sweep funders only to a super-main, by Relay or direct"
```

---

### Task 2: Frontend — route select and tickable funder preview

**Files:**
- Create: `frontend/src/v4/weiTotal.js`
- Create: `frontend/src/v4/weiTotal.test.js`
- Rewrite: `frontend/src/v4/V4GatherPanel.jsx`
- Modify: `frontend/src/v4/V4Console.jsx:270-278` (step 5 title/detail)

**Interfaces:**
- Consumes: Task 1's preview/run shapes (above). `masters[]` rows from `GET /v4/wallets` carry `id, address, balanceEth, isSuperMain`.
- Produces: `sumWei(rows: {sendWeiRaw: string}[]): bigint`, `weiToEth(wei: bigint): string` (six places, truncated).

- [ ] **Step 1: Write the failing helper test**

`frontend/src/v4/weiTotal.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { sumWei, weiToEth } from './weiTotal.js';

test('sumWei adds raw wei exactly', () => {
  const rows = [{ sendWeiRaw: '499951500000000000' }, { sendWeiRaw: '1' }, { sendWeiRaw: '0' }];
  assert.equal(sumWei(rows), 499951500000000001n);
  assert.equal(sumWei([]), 0n);
});

test('weiToEth prints six places, truncated rather than rounded up', () => {
  assert.equal(weiToEth(0n), '0.000000');
  assert.equal(weiToEth(10n ** 18n), '1.000000');
  assert.equal(weiToEth(499_951_500_000_000_000n), '0.499951');
  assert.equal(weiToEth(1_999_999_999_999_999_999n), '1.999999');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && node --test src/v4/weiTotal.test.js`
Expected: FAIL — cannot find module `./weiTotal.js`.

- [ ] **Step 3: Write the helper**

`frontend/src/v4/weiTotal.js`:

```js
/**
 * Exact ETH totals for the sweep preview.
 *
 * The backend sends each row's amount as a raw wei string (`sendWeiRaw`). Summing the
 * decimal `sendEth` strings through Number would round, and the total an operator confirms
 * should be the total that moves — so the sum is taken in BigInt and only the display is cut
 * to six places (truncated, never rounded up), the precision `eth()` shows everywhere else.
 */
const WEI_PER_ETH = 10n ** 18n;
const WEI_PER_SIXTH_PLACE = 10n ** 12n;

export function sumWei(rows) {
  return rows.reduce((sum, r) => sum + BigInt(r.sendWeiRaw || 0), 0n);
}

export function weiToEth(wei) {
  const whole = wei / WEI_PER_ETH;
  const frac = (wei % WEI_PER_ETH) / WEI_PER_SIXTH_PLACE;
  return `${whole}.${frac.toString().padStart(6, '0')}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && node --test src/v4/weiTotal.test.js`
Expected: PASS.

- [ ] **Step 5: Rewrite `frontend/src/v4/V4GatherPanel.jsx`**

```jsx
import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';
import { sumWei, weiToEth } from './weiTotal.js';

/**
 * Step 5 — sweep the funders' leftover ETH to one super-main.
 *
 * FUNDERS ONLY. Aged seed wallets are never swept, and neither are the other super-mains:
 * the backend refuses any wallet that is not a funder, so nothing this panel sends can reach
 * one. A funder still running a campaign is skipped.
 *
 * Two routes, chosen per sweep:
 *   Relay  (default) the funder stays unlinked from the super-main on chain. A Relay fee +
 *          gas per funder; small balances fall under the dust floor.
 *   Direct a plain send, gas only — recovers almost everything, and links each funder to
 *          the super-main on chain. No seed is linked either way: their funding went
 *          through Relay.
 *
 * The preview lists every funder it would sweep, all ticked. Untick any to leave it holding
 * its ETH; only the ticked ones are sent.
 */
const ROUTES = [
  { key: 'relay', label: 'Relay — funders stay unlinked (≈3% fee, dust floor)' },
  { key: 'direct', label: 'Direct — gas only, links each funder to the super-main' },
];

/** The one line the result panel shows after a sweep. */
function summarise(out) {
  const t = out.totals;
  const how = out.route === 'direct' ? 'directly' : 'through Relay';
  return (
    `${out.dryRun ? '[dry run — nothing signed] ' : ''}Swept ${t.moved}/${t.wallets} funder(s) ${how} — ${t.eth} ETH.` +
    (t.failed ? ` ${t.failed} failed.` : '') +
    (t.pending ? ` ${t.pending} pending — no receipt yet, check the explorer.` : '') +
    (t.notAttempted ? ` ${t.notAttempted} not attempted — Relay is rate-limiting; run the sweep again in a minute.` : '')
  );
}

export default function V4GatherPanel({ step, masters = [], explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [dest, setDest] = useState('');
  const [route, setRoute] = useState('relay');
  const [preview, setPreview] = useState(null);
  const [ticked, setTicked] = useState([]);
  const [arming, setArming] = useState(false);

  const supers = masters.filter((w) => w.isSuperMain);
  // A super-main un-flagged in step 1 after being chosen here is no longer a destination.
  const destOk = supers.some((w) => w.id === dest);
  const rows = preview ? preview.wallets : [];
  const tickedRows = rows.filter((w) => ticked.includes(w.walletId));
  const tickedEth = weiToEth(sumWei(tickedRows));
  const allTicked = rows.length > 0 && tickedRows.length === rows.length;
  const direct = route === 'direct';

  const reset = () => {
    setPreview(null);
    setTicked([]);
  };
  const toggleTick = (id) => setTicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleAll = () => setTicked(allTicked ? [] : rows.map((w) => w.walletId));
  const link = (address) => (explorer ? `${explorer}/address/${address}` : '');

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <Step {...step}>
      <p className="lede">
        Sweeps leftover ETH from your <b>funders</b> to one super-main. Aged seed wallets and the other
        super-mains are never touched, and a funder still running a campaign is left alone.
      </p>

      {supers.length === 0 && (
        <p className="hint">
          No super-main yet — flag one in step 1 (the ↑ arrow on a funding wallet), then sweep the funders to it.
        </p>
      )}

      <div className="row">
        <label>
          to super-main
          <select
            value={destOk ? dest : ''}
            disabled={supers.length === 0}
            onChange={(e) => {
              setDest(e.target.value);
              reset();
            }}
          >
            <option value="">choose one…</option>
            {supers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address.slice(0, 10)}… ·{' '}
                {w.balanceEth == null ? 'unreadable' : `${Number(w.balanceEth).toFixed(4)} ETH`}
              </option>
            ))}
          </select>
        </label>
        <label>
          route
          <select
            value={route}
            onChange={(e) => {
              setRoute(e.target.value);
              reset();
            }}
          >
            {ROUTES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {direct && (
        <p className="hint">
          <b>Direct links on-chain:</b> every funder swept shows up sending straight to this super-main, so
          they become publicly tied together. Seeds stay unlinked — their funding went through Relay.
        </p>
      )}

      <div className="row">
        <Busy
          busy={busy === 'preview'}
          className="btn-primary"
          disabled={!destOk}
          onClick={() =>
            act('preview', async () => {
              const out = await api(`/v4/sweep/preview?destinationId=${encodeURIComponent(dest)}&route=${route}`);
              setPreview(out);
              setTicked(out.wallets.map((w) => w.walletId));
              return `Sweep preview (${out.route}): ${plural(out.walletCount, 'funder')}, ${out.totalEth} ETH.`;
            })
          }
        >
          Preview
        </Busy>
        <Busy
          busy={busy === 'sweep'}
          className="danger"
          disabled={tickedRows.length === 0}
          onClick={() => setArming(true)}
        >
          Sweep {plural(tickedRows.length, 'funder')}
        </Busy>
      </div>

      {preview && (
        <div className="table-card" style={{ marginTop: 8 }}>
          {rows.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" checked={allTicked} onChange={toggleAll} aria-label="tick every funder" />
                  </th>
                  <th>Funder</th>
                  <th className="num">Balance</th>
                  <th className="num">Sends</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.walletId} className={ticked.includes(w.walletId) ? 'is-on' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={ticked.includes(w.walletId)}
                        onChange={() => toggleTick(w.walletId)}
                        aria-label={`Sweep ${w.address}`}
                      />
                    </td>
                    <td>
                      <Address value={w.address} plain href={link(w.address)} />
                    </td>
                    <td className="num">{eth(w.balanceEth)}</td>
                    <td className="num">{eth(w.sendEth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">
              No funder has anything to sweep{preview.route === 'relay' ? ' above the dust floor' : ''} — see why
              below.
            </p>
          )}
          <p className="hint">
            {tickedRows.length} of {rows.length} ticked → <b>{tickedEth} ETH</b> to{' '}
            {preview.destination.address.slice(0, 10)}… by {preview.route === 'direct' ? 'direct send' : 'Relay'}
          </p>
          {preview.skipped.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Skipped</th>
                  <th className="num">Balance</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {preview.skipped.map((s) => (
                  <tr key={s.walletId}>
                    <td>
                      <Address value={s.address} plain href={link(s.address)} />
                    </td>
                    <td className="num">{s.balanceEth == null ? '—' : eth(s.balanceEth)}</td>
                    <td>
                      <span className="hint">{s.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Modal
        open={arming}
        danger
        title={`Sweep ${plural(tickedRows.length, 'funder')} to the super-main?`}
        question={
          direct
            ? 'Each ticked funder sends its balance straight to the super-main — irreversible, and it links them on-chain.'
            : "Each ticked funder's balance goes to the super-main through Relay — irreversible."
        }
        confirmLabel="Sweep them"
        onCancel={() => setArming(false)}
        onConfirm={async () => {
          await act('sweep', async () => {
            const out = await api('/v4/sweep', 'POST', {
              destinationId: preview.destination.walletId,
              route: preview.route,
              walletIds: tickedRows.map((w) => w.walletId),
              minSweepEth: preview.minSweepEth,
              confirm: true,
            });
            reset();
            await reload();
            return summarise(out);
          });
          setArming(false);
        }}
      >
        {preview && (
          <>
            <Fact label="Funders">{tickedRows.length}</Fact>
            <Fact label="Total">{tickedEth} ETH</Fact>
            <Fact label="To" mono>
              {preview.destination.address}
            </Fact>
            <Fact label="Route">
              {preview.route === 'direct'
                ? 'Direct — each funder is linked to the super-main on-chain'
                : 'Relay — the funders stay unlinked from the super-main'}
            </Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
```

- [ ] **Step 6: Update step 5's title and detail in `frontend/src/v4/V4Console.jsx`**

Replace the `gather` step object:

```js
      {
        key: 'gather',
        n: 5,
        // Optional and repeatable — like v3's exit/sweep, an empty set of funders is both
        // "swept" and "never run", so there is nothing honest to mark done.
        done: false,
        title: 'Sweep funders to a super-main',
        detail: 'leftover funder ETH → one super-main, by Relay or direct',
      },
```

- [ ] **Step 7: Run frontend tests and build**

Run: `cd frontend && npm test && npm run build`
Expected: tests PASS; build completes with no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/v4/weiTotal.js frontend/src/v4/weiTotal.test.js frontend/src/v4/V4GatherPanel.jsx frontend/src/v4/V4Console.jsx
git commit -m "feat(v4): step 5 sweeps funders to a super-main — Relay/Direct and untickable preview"
```
