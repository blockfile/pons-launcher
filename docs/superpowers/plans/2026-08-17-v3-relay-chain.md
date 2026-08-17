# V3 Relay Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third console tab that takes a live pons v2 token and distributes a position across bundle wallets one at a time — big buy, then a cycle per wallet of sell → Relay transfer → buy, ~7s apart — without touching v1 or v2.

**Architecture:** Six new backend modules under `backend/src/v3/`, one new route file, and five new console panels under `frontend/src/v3/`. A server-side job engine holds the cycle state machine so the browser can close. Relay moves ETH from the seller to each buyer so no on-chain edge connects them.

**Tech Stack:** Node 20 CommonJS, `node:test` + `node:assert/strict`, ethers v6, Express 4, React 18 + Vite, Relay.link `/quote/v2`.

**Spec:** [`docs/superpowers/specs/2026-08-17-v3-relay-chain-design.md`](../specs/2026-08-17-v3-relay-chain-design.md)

## Global Constraints

- **V1 and V2 are not touched.** No file under `backend/src/bundle/`, `backend/src/relay/`, `backend/src/wallets/variants.js`, `backend/src/routes/wallets.js`, `backend/src/routes/launch.js`, `backend/src/routes/distributor.js`, or `frontend/src/variant.js` is modified. No existing component under `frontend/src/components/` is modified.
- **Exactly three additive edits outside `v3/`:** `backend/src/wallets/keystore.js` (three role names), `backend/server.js` (one `app.use`), `frontend/src/App.jsx` (one tab + one branch).
- **The existing test suite must pass unmodified.** `npm test --workspace backend` is green before and after every task. If a change requires editing an existing test, the change is wrong.
- **CommonJS on the backend** (`'use strict';`, `require`, `module.exports`), **ESM on the frontend**.
- **Tests use `node:test`**, injected dependencies, and never touch a network. Every module takes a `deps = {}` last argument.
- **No slippage floor anywhere:** `minQuoteOut` and `minTokensOut` are `0` on every trade. Deliberate — see the spec.
- **BigInt never crosses the JSON boundary.** Every route response passes through the local `jsonSafe`.
- Test command: `npm test --workspace backend`. Single file: `node --test backend/src/v3/<name>.test.js`.

---

## File Structure

**Backend — created:**

| File | Responsibility |
|---|---|
| `backend/src/v3/roles.js` | The three role names and V3's own keystore lookups. Nothing else knows the strings. |
| `backend/src/v3/relay.js` | V3's Relay client: EXACT_OUTPUT same-chain transfer, wallet → address. |
| `backend/src/v3/sizing.js` | Pure arithmetic: how many tokens to sell to raise `T`. No I/O. |
| `backend/src/v3/trade.js` | Buy and sell transaction construction and broadcast against a v2 curve. |
| `backend/src/v3/engine.js` | The cycle state machine: start/stop/resume/status, timers, failure handling. |
| `backend/src/v3/exit.js` | Sell everything out of `v3main` + every `v3bundle`. |
| `backend/src/routes/v3.js` | Every `/api/v3/*` endpoint. |

**Backend — modified (additive only):** `backend/src/wallets/keystore.js`, `backend/server.js`.

**Frontend — created:** `frontend/src/v3/roles.js`, `V3Console.jsx`, `V3TreasuryPanel.jsx`, `V3BundlePanel.jsx`, `V3MainPanel.jsx`, `V3ChainPanel.jsx`, `V3ExitPanel.jsx`.

**Frontend — modified (additive only):** `frontend/src/App.jsx`.

---

### Task 1: V3 roles and keystore registration

**Files:**
- Create: `backend/src/v3/roles.js`
- Create: `backend/src/v3/roles.test.js`
- Modify: `backend/src/wallets/keystore.js` (two `Set` literals only)

**Interfaces:**
- Produces: `ROLES = { treasury: 'v3dev', main: 'v3main', bundle: 'v3bundle' }`, `treasury(ks)`, `main(ks)`, `bundle(ks)`, `all(ks)`. Each of `treasury`/`main` throws when its wallet is missing; `bundle` returns `[]`.

- [ ] **Step 1: Write the failing test** — `backend/src/v3/roles.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const roles = require('./roles');

function ks(wallets) {
  return {
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
}

test('role names are v3s own and do not collide with v1 or v2', () => {
  assert.deepEqual(roles.ROLES, { treasury: 'v3dev', main: 'v3main', bundle: 'v3bundle' });
});

test('treasury throws by name when missing', () => {
  assert.throws(() => roles.treasury(ks([])), /v3dev/);
});

test('main throws by name when missing', () => {
  assert.throws(() => roles.main(ks([])), /v3main/);
});

test('bundle returns empty rather than throwing', () => {
  assert.deepEqual(roles.bundle(ks([])), []);
});

test('lookups never return another launchers wallet', () => {
  const store = ks([
    { id: 'a', role: 'dev', address: '0x1' },
    { id: 'b', role: 'v2dev', address: '0x2' },
    { id: 'c', role: 'bundle', address: '0x3' },
    { id: 'd', role: 'v2bundle', address: '0x4' },
  ]);
  assert.throws(() => roles.treasury(store), /v3dev/);
  assert.deepEqual(roles.bundle(store), []);
});

test('all returns the three groups', () => {
  const store = ks([
    { id: 't', role: 'v3dev', address: '0x1' },
    { id: 'm', role: 'v3main', address: '0x2' },
    { id: 'b1', role: 'v3bundle', address: '0x3' },
    { id: 'b2', role: 'v3bundle', address: '0x4' },
  ]);
  const out = roles.all(store);
  assert.equal(out.treasury.id, 't');
  assert.equal(out.main.id, 'm');
  assert.equal(out.bundle.length, 2);
});

test('all tolerates missing singletons', () => {
  const out = roles.all(ks([]));
  assert.equal(out.treasury, null);
  assert.equal(out.main, null);
  assert.deepEqual(out.bundle, []);
});
```

- [ ] **Step 2: Run it and watch it fail** — `node --test backend/src/v3/roles.test.js`, expect `Cannot find module './roles'`.

- [ ] **Step 3: Write `backend/src/v3/roles.js`**

Module header must state why this exists rather than a `variants.js` entry: V1/V2 and V3 do not share a role table, so neither can resolve to the other's wallets. `treasury()` and `main()` throw messages naming the role and telling the operator to create it on the V3 tab. `all()` is the tolerant read used by `GET /v3/wallets`, returning `null` rather than throwing.

- [ ] **Step 4: Register the roles in the keystore**

In `backend/src/wallets/keystore.js`, add `'v3dev'`, `'v3main'`, `'v3bundle'` to the `ROLES` set (line ~77) and `'v3dev'`, `'v3main'` to `SINGLETON_ROLES` (line ~87). Nothing else in that file changes. Add a short comment above the additions: V3 owns these outright, and they must be in `ROLES` because `add()` collapses an unknown role to `'bundle'` — which would put a V3 wallet on the V1 tab holding v1's role.

- [ ] **Step 5: Run the whole suite** — `npm test --workspace backend`. Expect green, including every pre-existing keystore and variants test, unmodified.

- [ ] **Step 6: Commit** — `git commit -m "Give v3 its own role table"`

---

### Task 2: V3's Relay client

**Files:**
- Create: `backend/src/v3/relay.js`, `backend/src/v3/relay.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `transfer({ fromWallet, toAddress, amountWei }, deps) -> { requestId, depositAddress, depositWei, amountWei, hash, check, fees, details }`, `quoteBody(input)`, `depositStep(quote, opts)`, `status(requestId, deps)`.
- `deps`: `{ fetch, keystore, provider, getFees, dryRun }`.

Same-chain EXACT_OUTPUT: `originChainId === destinationChainId === config.chainId`, `useDepositAddress: true`, `strict: true`, `refundTo` the sender.

- [ ] **Step 1: Write the failing test** — `backend/src/v3/relay.test.js`

Seven tests, each asserting one refusal or behaviour:

```js
test('quote is EXACT_OUTPUT, same chain, strict, refunding to the sender')
test('refuses a quote with no deposit transaction')          // /deposit transaction/
test('refuses a deposit on another chain')                   // /chain/
test('refuses a deposit from a wallet we did not name')      // /expected/
test('refuses a zero-value deposit')                         // /positive/
test('sends the REFRESHED fee ceiling, not the quoted one')  // the assertion that matters
test('dry run returns the plan and signs nothing')
```

The fee test is the load-bearing one: build a quote whose `maxFeePerGas` is `1n`, inject `getFees` returning `30_000_000n`, assert the transaction handed to `sendTransaction` carries `30_000_000n`. A stale ceiling is why every deposit was rejected before it reached the mempool on the v2 path, and V3 must not relearn it.

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Write `backend/src/v3/relay.js`.**

`transfer()` quotes, validates all four properties, refreshes fees with a 50% bump, checks the sender's balance covers `deposit + gasCost(fees, gasLimit)`, then signs and sends at the wallet's pending nonce. Errors come back through `rpcMessage`. The header states that this is V3's own client and deliberately not a refactor of `relay/funding.js`, and why the refreshed ceiling exists.

- [ ] **Step 4: Run the file, then the suite.** Expect green.

- [ ] **Step 5: Commit** — `git commit -m "Give v3 its own Relay transfer"`

---

### Task 3: Sell sizing

**Files:**
- Create: `backend/src/v3/sizing.js`, `backend/src/v3/sizing.test.js`

**Interfaces:**
- Produces:
  - `quoteSellOut({ tokensIn, quoteReserve, tokenReserve, feeBps, creatorTaxBps }) -> bigint`
  - `tokensToRaise({ targetWei, quoteReserve, tokenReserve, feeBps, creatorTaxBps, headroomPct }) -> bigint` — throws when the curve cannot pay it
  - `SELL_HEADROOM_PCT = 10`, `BPS = 10_000n`

Pure. No I/O, no ethers calls, no `deps`.

```
withHeadroom = targetWei · (100 + headroomPct) / 100
gross        = ceil(withHeadroom · BPS / (BPS − feeBps − creatorTaxBps))
tokensIn     = ceil(gross · tokenReserve / (quoteReserve − gross))
```

Every division rounds **up**, so sizing errs toward selling slightly more than needed. Erring the other way leaves the next transfer short, which stops the run.

- [ ] **Step 1: Write the failing test.** The round-trip is the important one:

```js
test('sizing for a target then quoting it back raises at least the target', () => {
  const curve = { quoteReserve: parseEther('40'), tokenReserve: 800_000_000n * 10n ** 18n,
                  feeBps: 100, creatorTaxBps: 100 };
  for (const eth of ['0.01', '0.1', '0.5', '2']) {
    const target = parseEther(eth);
    const tokens = tokensToRaise({ targetWei: target, ...curve, headroomPct: 0 });
    assert.ok(quoteSellOut({ tokensIn: tokens, ...curve }) >= target, `${eth} fell short`);
  }
});

test('headroom is applied before solving, so it raises more than the bare target')
test('refuses when the curve cannot pay the target at any size')   // /cannot pay/
test('refuses a non-positive target')
test('zero fees and zero tax still round-trip')
test('rounding always favours selling more, never less')
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write `backend/src/v3/sizing.js`** with a header deriving the inversion from `out = gross − gross·(fee+tax)/BPS` and `gross = q·a/(t+a)`, and stating why headroom is structural rather than cautious: `minQuoteOut` is 0, so the sell is a quote and not a promise.
- [ ] **Step 4: Run the file, then the suite.**
- [ ] **Step 5: Commit** — `git commit -m "Size a v3 sell from the ETH it has to raise"`

---

### Task 4: Trading primitives

**Files:**
- Create: `backend/src/v3/trade.js`, `backend/src/v3/trade.test.js`

**Interfaces:**
- Consumes: `sizing` (Task 3) is *not* used here — the caller sizes.
- Produces:
  - `readCurve(curveAddress, deps) -> { token, isNativeQuote, quoteReserve, tokenReserve, feeBps, creatorTaxBps, graduated, readyToGraduate }`
  - `snipeTax(curveAddress, recipient, deps) -> { bps, secondsLeft }`
  - `buy({ wallet, curve, amountWei }, deps) -> { hash, status, blockNumber, tokensOut }`
  - `sell({ wallet, curve, token, tokensIn }, deps) -> { approveHash, sellHash, status, blockNumber, ethReceived }`
  - `tokenBalance(token, owner, deps) -> bigint`

`sell()` signs `approve` at nonce *n* and `sell` at nonce *n+1* from the same wallet and broadcasts both without waiting for the approval — the sequencer executes a wallet's transactions in nonce order. `ethReceived` is a **balance delta with gas added back**, because a curve sell's proceeds are a return value and a return value is not in a receipt.

- [ ] **Step 1: Write the failing test.**

```js
test('approve and sell are signed at consecutive nonces from the same wallet')
test('the approval is for exactly the tokens being sold, never unlimited')
test('minQuoteOut is 0 on the sell')
test('minTokensOut is 0 on the buy, and the buy sends amountIn as value')
test('ethReceived is the balance delta with gas added back')
test('a reverted sell reports reverted and does not claim proceeds')
test('snipeTax reports what the recipient would pay right now')
test('dry run broadcasts nothing')
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write `backend/src/v3/trade.js`,** building on `CURVE_V2_ABI` from `evm/v2/abi.js` (data, imported unmodified) plus a local one-line `approve` fragment. Gas: `config.buyGasLimit` for buys, `100_000n` for approve, `600_000n` for sell — the sell cannot be estimated because the approval it depends on has not been mined.
- [ ] **Step 4: Run the file, then the suite.**
- [ ] **Step 5: Commit** — `git commit -m "Give v3 its own buy and partial sell"`

---

### Task 5: The cycle engine

**Files:**
- Create: `backend/src/v3/engine.js`, `backend/src/v3/engine.test.js`

**Interfaces:**
- Consumes: `roles`, `relay.transfer`, `sizing.tokensToRaise`, `trade.{readCurve, buy, sell, tokenBalance}`.
- Produces: `createEngine(deps) -> { start, stop, resume, status, _reset, _tick }` and a module-level singleton, mirroring how `relay/timedFunding.js` exports both.
- `start(userId, { token, bigBuyEth, targets, intervalMs, jitterPct })`, `targets: [{ walletId, buyEth }]`.
- `status(userId) -> publicJob`.

**Constants:** `DEFAULT_INTERVAL_MS 7000`, `MIN_INTERVAL_MS 3000`, `MAX_INTERVAL_MS 600000`, `DEFAULT_JITTER_PCT 0`, `MAX_JITTER_PCT 50`, `FILL_POLL_MS 1500`, `FILL_TIMEOUT_MS 90000`.

**Job shape:** `{ id, userId, status: 'running'|'stopped'|'complete'|'failed', token, curve, symbol, bigBuyEth, intervalMs, jitterPct, currentIndex, targets[], cycles[], startedAt, updatedAt, nextRunAt, failure }`.

**Cycle record:** `{ index, walletId, address, buyEth, state: 'pending'|'selling'|'transferring'|'waiting-fill'|'buying'|'done'|'failed', tokensSold, ethRaised, requestId, depositAddress, sellHash, buyHash, error, startedAt, finishedAt }`.

Cycle 0 is the big buy and is recorded as `{ index: 0, kind: 'big-buy' }`.

- [ ] **Step 1: Write the failing test.** Fake clock, fake steps — nothing touches a network or a real timer.

```js
test('cycle 0 is the big buy, and it happens before any transfer')
test('one cycle per target, in the order given')
test('a cycle runs sell then transfer then fill-wait then buy, in that order')
test('the interval is a floor: a slow cycle does not bunch the next one')
test('jitter stays within +/- jitterPct of the interval')
test('jitter defaults to off, so cycles are exactly intervalMs apart')
test('a failed sell halts the run and keeps state')
test('a failed transfer halts the run and keeps state')
test('a fill that never arrives halts the run after FILL_TIMEOUT_MS')
test('a failed buy halts the run and keeps state')
test('resume continues at the wallet that failed, not the next one')
test('resume refuses when the job is complete')
test('stop halts and status stays readable')
test('a second start while running is refused')
test('the transfer is sized against the actual balance, not the sell estimate')
test('a run stops if v3main cannot cover the deposit after its sell')
test('every step is written to the activity log as it happens')
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Write `backend/src/v3/engine.js`.**

Structure it as one `async runCycle(job, index)` that walks the four steps, each in its own small function, with a single `try/catch` that on **any** throw sets `job.status = 'failed'`, records `job.failure = { index, step, error }`, and schedules nothing. The scheduler is `timedFunding.js`'s shape: `schedule(job, delayMs)` clearing and re-arming one `setTimeout`, `unref`'d.

Sleep is `max(0, intervalMs ± jitter − elapsed)` — computed from when the cycle *started*, which is what makes the interval a floor rather than a clock.

The fill wait polls `rpc.getBalance(address)` every `FILL_POLL_MS` until it covers `buyEth + gasReserve`, throwing a message naming the wallet and the `requestId` after `FILL_TIMEOUT_MS` so a stall can be looked up on Relay.

- [ ] **Step 4: Run the file, then the suite.**
- [ ] **Step 5: Commit** — `git commit -m "Run the v3 chain as a server-side job"`

---

### Task 6: The exit

**Files:**
- Create: `backend/src/v3/exit.js`, `backend/src/v3/exit.test.js`

**Interfaces:**
- Consumes: `roles`, `trade.{readCurve, sell, tokenBalance}`.
- Produces: `preview(userId, { token }, deps) -> { token, symbol, curve, wallets[], totalTokens }`, `run(userId, { token, confirm }, deps) -> { wallets[], totals }`.

Sells the whole balance out of **`v3main` and every `v3bundle`** — `v3main` finishes a run holding whatever it did not sell.

- [ ] **Step 1: Write the failing test.**

```js
test('the exit includes v3main as well as the bundle wallets')
test('it skips a wallet holding none')
test('it skips a wallet too short of gas, and says which')
test('it refuses without confirm: true')
test('it refuses a graduated curve')
test('one wallets revert does not stop the others')
test('totals count sold, failed and eth received')
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write `backend/src/v3/exit.js`,** reusing `trade.sell` per wallet with the wallet's whole balance.
- [ ] **Step 4: Run the file, then the suite.**
- [ ] **Step 5: Commit** — `git commit -m "Give v3 its own exit"`

---

### Task 7: Routes

**Files:**
- Create: `backend/src/routes/v3.js`, `backend/src/routes/v3.test.js`
- Modify: `backend/server.js` (one line)

**Interfaces:**
- Consumes: every module from Tasks 1–6.
- Produces: the eleven endpoints in the spec's API table.

Local `jsonSafe` copied into this file (seven lines) rather than imported from `routes/launch.js` — importing a route module to borrow a helper pulls its router in as a side effect, and V3 is meant to be detachable.

**Start validation, in order, each with its own message:** job already running → token is a pons v2 launch → not graduated / not ready → launched by a wallet we hold or have held → `v3main` exists → `v3bundle` non-empty → `v3main` covers `bigBuyEth` + gas → every target has a positive `buyEth` → `intervalMs` and `jitterPct` in range → `confirm: true`.

`/v3/chain/plan` returns, and broadcasts nothing: the curve state, each wallet's `buyEth`, the tokens cycle 1 would sell, **and `currentSnipeTaxBps` per wallet with `snipeTaxSeconds` remaining** — V3 buys after the launch, so its wallets are not exempt, and starting inside the opening window costs that tax on every buy.

- [ ] **Step 1: Write the failing test.** One test per validation bullet plus:

```js
test('plan broadcasts nothing')
test('plan states the snipe tax each wallet would pay and when the window closes')
test('start requires confirm: true')
test('exit requires confirm: true')
test('deleting a v3 wallet is refused while a job is running')
test('no response body contains a BigInt')
```

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Write `backend/src/routes/v3.js`** and add `app.use('/api', v3Routes)` to `backend/server.js` beside the three existing mounts, with `const v3Routes = require('./src/routes/v3');` beside the others.
- [ ] **Step 4: Run the suite.** Expect green.
- [ ] **Step 5: Commit** — `git commit -m "Expose the v3 chain over /api/v3"`

---

### Task 8: Console shell — roles, tab, and the V3 console

**Files:**
- Create: `frontend/src/v3/roles.js`, `frontend/src/v3/V3Console.jsx`
- Modify: `frontend/src/App.jsx` (one tab button, one branch)

**Interfaces:**
- Produces: `ROLES`, `isTreasury(w)`, `isMain(w)`, `isBundle(w)` (drawing only); `<V3Console health credential report />`.

`V3Console` owns all V3 state — wallets, rows, job, token — and shares none with the v1/v2 tree. It builds its own five-step plan and renders it through the existing `Sequence` and `Step` components, which are presentation and are not modified.

The `App.jsx` edit is exactly:

```jsx
{tab === 'v3' ? (
  <V3Console health={health} credential={credential} report={report} />
) : (
  <div className="sequence" hidden={SHOW_V2_BUNDLER && mode !== 'v1'}>
    { /* …the entire existing tree, unchanged… */ }
  </div>
)}
```

plus a third `<button className={tab === 'v3' ? 'quiet is-on' : 'quiet'}>` and a `tab === 'v3'` arm on the hint. No existing prop, effect, or `useMemo` changes.

- [ ] **Step 1: Write `frontend/src/v3/roles.js`** — the three names, three predicates, and a header saying it mirrors `backend/src/v3/roles.js` and deliberately does not import `variant.js`.
- [ ] **Step 2: Write `V3Console.jsx`** — state, `loadWallets` against `/v3/wallets`, `loadJob` against `/v3/chain`, the five-step plan, and the five panels in order.
- [ ] **Step 3: Add the tab and the branch to `App.jsx`.**
- [ ] **Step 4: Verify V1 and V2 are untouched** — `git diff frontend/src/App.jsx` shows only the tab button, the hint arm, the import, and the branch wrapper. `git diff --stat` names no other file under `frontend/src/components/`.
- [ ] **Step 5: Build** — `npm run build`. Expect success.
- [ ] **Step 6: Commit** — `git commit -m "Add the V3 tab"`

---

### Task 9: Console — the three wallet panels

**Files:**
- Create: `frontend/src/v3/V3TreasuryPanel.jsx`, `V3BundlePanel.jsx`, `V3MainPanel.jsx`

**Interfaces:**
- Consumes: `api` from `../api.js`, `Step`/`Section`/`Address` from `../components/`, `/v3/wallets*`, `/v3/fund`.
- Produces: `onRows(rows)` from `V3BundlePanel` — `{ [walletId]: { buyEth } }` — which `V3Console` holds and `V3ChainPanel` reads.

- [ ] **Step 1: `V3TreasuryPanel`** — create or import `v3dev`, address, balance, explorer link, delete behind a confirm.
- [ ] **Step 2: `V3BundlePanel`** — generate N `v3bundle` wallets, a table with a `buyEth` field per row, a running total, and what that total plus gas will cost. No 31-wallet cap: that limit is the factory's exemption list and only binds at launch.
- [ ] **Step 3: `V3MainPanel`** — create `v3main`, show its ETH and its token position, and fund it from `v3dev` through Relay with an amount field, reporting the `requestId` and deposit address.
- [ ] **Step 4: Build** — `npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "Draw the v3 wallets"`

---

### Task 10: Console — the chain panel

**Files:**
- Create: `frontend/src/v3/V3ChainPanel.jsx`

- [ ] **Step 1: The form** — token address, big buy, interval (default 7000ms), jitter (default 0), and a Preview button hitting `/v3/chain/plan`.
- [ ] **Step 2: The preview** — curve state, per-wallet buy, what cycle 1 would sell, and the **snipe-tax line**: if `currentSnipeTaxBps > 0`, say plainly that every wallet pays it and how many seconds until the window closes.
- [ ] **Step 3: The arm bar** — Start behind a typed confirm, Stop, Resume. Start states the total ETH and that there is no slippage floor.
- [ ] **Step 4: The live table** — poll `/v3/chain` every 2s while running; one row per cycle with per-step state (`sold · transferred · waiting for fill · bought`), hashes linked to the explorer, and the failure banner naming the wallet and the step when the job is `failed`.
- [ ] **Step 5: Build, then commit** — `git commit -m "Drive the v3 chain from the console"`

---

### Task 11: Console — the exit panel, and the whole-repo check

**Files:**
- Create: `frontend/src/v3/V3ExitPanel.jsx`

- [ ] **Step 1: `V3ExitPanel`** — `/v3/exit/preview` on load, a table of what each wallet holds, and Sell everything behind a typed confirm, stating there is no slippage floor.
- [ ] **Step 2: Build** — `npm run build`.
- [ ] **Step 3: Run the whole suite** — `npm test --workspace backend`. Expect green.
- [ ] **Step 4: Prove the isolation rule held** — `git diff --stat main...HEAD` must show, outside `v3/` and `routes/v3.js`, only `backend/src/wallets/keystore.js`, `backend/server.js`, and `frontend/src/App.jsx`. Not one existing test file is modified.
- [ ] **Step 5: Commit** — `git commit -m "Give v3 its exit"`

---

## Self-Review

**Spec coverage:** roles → T1; Relay → T2; sizing → T3; trading and the approve/sell nonce pair → T4; engine, timing, failure policy → T5; exit including `v3main` → T6; API, refusals, snipe-tax preview → T7; tab and isolation → T8; panels → T9–11. The three additive edits are named in T1, T7 and T8 respectively and nowhere else.

**Placeholders:** none — every step names its file, its assertions, and its command.

**Type consistency:** `tokensToRaise`/`quoteSellOut` (T3) are called only by T5. `trade.sell` returns `ethReceived`, which T5 uses for the balance check and T6 sums into `totals`. `relay.transfer` returns `requestId`, which T5 stores on the cycle and T10 links. Cycle `state` strings are the same five in T5 and T10.
