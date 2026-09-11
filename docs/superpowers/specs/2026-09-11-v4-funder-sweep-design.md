# V4 — sweep funders to a super-main (Relay or Direct)

Date: 2026-09-11. Approved in conversation the same day.

## What and why

Step 5 of the V4 tab ("Gather the ETH back") becomes **"Sweep funders to a super-main"**:
leftover ETH in the **funder** wallets goes to **one super-main the operator picks**, by
**Relay** (default) or **Direct**, with the operator able to untick individual funders in
the preview.

It replaces the old Gather rather than sitting beside it. The old panel could also sweep
seed wallets and withdrawn seeds; the operator's rule is that **aged wallets are never
swept**, so no code path in the sweep may reach a seed.

## The aged-wallet rule (the invariant everything else serves)

- The sweep module **never reads `v4seed` wallets**. `v4roles.seeds()` and
  `store.withdrawnSeedIds()` are not called anywhere in `v4/sweep.js`.
- Sources are computed from `v4roles.masters(ks)` only, minus super-mains.
- A run request whose `walletIds` names anything that is not a funder — a seed, a
  withdrawn seed, a super-main, another tab's wallet, an unknown id — is **refused whole**,
  before any balance is read or anything is sent.
- Seeds already handed to V1/V3 ("bundle wallets") are re-roled out of `v4seed` by the
  claim, so they are unreachable here by construction.
- A funder that is the source of a live campaign (`running`, `paused`, `halted`) is never
  swept — emptying it would starve the drips that are still aging seeds. (Campaigns are
  created directly in `running`, so there is no earlier state to miss.)
- Tests assert each of these with seeds holding a balance, on **both** routes.

The Direct route draws an on-chain funder → super-main link. It does not touch seeds:
every funder → seed transfer went through Relay, so no on-chain edge joins a seed to its
funder.

## Definitions

- **Super-main**: a `v4master` whose id is in `store.superMainIds()`.
- **Funder**: a `v4master` whose id is NOT in `store.superMainIds()`.
- **Busy funder**: a funder that is the `masterWalletId` of a campaign whose status is
  `running`, `paused` or `halted`.

## Backend — `backend/src/v4/sweep.js` (reworked in place)

`CATEGORIES` and every seed/withdrawn path are removed.

### `plan(userId, { destinationId, route = 'relay', minSweepEth })`

1. `route` must be `'relay'` or `'direct'`; anything else throws.
2. The destination must be a super-main. No super-main flagged → throws
   "flag a super-main in step 1 first". An id that is a funder, a seed or unknown → throws.
3. Sources = funders, excluding the destination (belt and braces — a super-main cannot be
   a funder). Busy funders go to `skipped` with reason "running a campaign — sweeping it
   would starve the campaign", instead of silently vanishing.
4. Per funder, read the live balance, then by route:
   - **Relay** (unchanged math): `gas = gasCost(fees(+25%), 50_000)`;
     `amount = (balance − gas) × 97%`; skip if under `minSweepEth` (default `0.002`).
   - **Direct**: gas limit = `estimateGas({from, to, value: 1})` × 1.2, floored at
     `30_000` (a plain send is 21,195 gas on this chain, not 21,000; a failed estimate
     falls back to the floor). Estimated once per plan against the destination.
     `reserve = gasLimit × maxFeePerGas(+25%)`; `amount = balance − reserve`; skip if
     `amount ≤ 0` ("does not cover its own gas").
5. Returns `{ to, route, wallets: [{wallet, balance, amountWei}], skipped, minWei, fees, gasLimit }`.

### `preview(userId, input)`

Reads only. Returns `destination`, `route`, `minSweepEth`, `wallets[]`
(`walletId, address, balanceEth, sendEth, sendWeiRaw`), `skipped[]`
(`walletId, address, balanceEth, reason`), `walletCount`, `totalEth`, `totalEthRaw`.

### `run(userId, { destinationId, route, walletIds, minSweepEth, confirm })`

1. `confirm !== true` → throws.
2. `walletIds` must be a non-empty array. Every id must be a funder (not a super-main,
   not a seed, not another role, not unknown) → otherwise throws naming the id. This check
   happens before any chain read.
3. Re-plans from live balances. Sends to the plan's wallets that are in `walletIds`.
   A ticked funder that the fresh plan skipped (became busy, dropped under the floor)
   appears in `skipped` with the plan's reason.
4. Nothing to send → throws "nothing to sweep".
5. **Relay**: one `relay.transfer` per wallet, sequentially (unchanged). On the first
   error matching a Relay rate-limit refusal
   (`/try again later|could not process|rate.?limit|too many|\b429\b/i`) the loop stops;
   that wallet is `failed`, every later wallet is reported `not-attempted` with reason
   "Relay is rate-limiting — run the sweep again in a minute". Their ETH is untouched.
   Row status `sent` = the deposit was broadcast.
6. **Direct**: each wallet signs a plain `{ to, value: amount, gasLimit, ...fees }`
   sequentially (nonce from the wallet's own signer); then all receipts are awaited
   together with a 30 s cap (`waitForReceipt(rpc, hash, { timeoutMs: 30_000 })`), so the
   request stays under nginx's ~60 s read timeout. Row status is `confirmed`, `reverted`,
   `pending` (no receipt within the cap) or `failed` (the send threw).
7. Totals count `sent` (relay) or `confirmed` (direct) as moved. Activity log records the
   route; Direct entries say "direct — links these funders to the super-main on-chain".
8. **DRY_RUN is honoured on both routes.** Relay already simulates inside `v4/relay.js`;
   the direct path checks `deps.dryRun ?? config.dryRun` and signs nothing, reporting rows
   `simulated`. Without this, a direct sweep would really send on a server the operator
   believes is dry-running.

`v4/relay.js` is not modified. Low-level infra (`evm/provider`, `evm/fees`,
`evm/receipt`) is imported as today; the gas-estimate helper is V4's own copy (isolation
rule — it is not imported from `wallets/funding.js`).

## Routes — `backend/src/routes/v4.js`

- `GET /v4/sweep/preview?destinationId=&route=` — `categories` removed.
- `POST /v4/sweep` body `{ destinationId, route, walletIds, minSweepEth, confirm }`.

## Frontend — `frontend/src/v4/V4GatherPanel.jsx` and the step in `V4Console.jsx`

- Step 5 title "Sweep funders to a super-main", detail "leftover funder ETH → one
  super-main, by Relay or direct".
- **to super-main**: `<select>` of flagged super-mains only, with balance. None flagged →
  a hint pointing at step 1 and Preview disabled.
- **route**: `<select>` — "Relay — funders stay unlinked (≈3% fee, 0.002 floor)" (default)
  and "Direct — gas only, links each funder to the super-main on-chain". Choosing Direct
  shows a one-line hint stating the linkage.
- The three category checkboxes are removed.
- **Preview**: a table of sweepable funders, a checkbox per row (all ticked on each fresh
  preview) with select-all, address, balance, sends. Below it, the skipped funders with
  their reasons. The footer total is the sum of ticked rows' `sendWeiRaw` (BigInt, exact).
- Changing destination or route clears the preview.
- **Sweep** button disabled unless at least one row is ticked. Confirm dialog: count,
  total, to, route; for Direct, a Fact stating the on-chain linkage.
- The POST sends the ticked ids as `walletIds`. The result line reports sent/confirmed,
  failed, pending and not-attempted counts.
- Existing button classes are kept (`btn-primary` Preview, `danger` Sweep) — no styling
  change, so the money-colour law is untouched.

## Tests — `backend/src/v4/sweep.test.js` (rewritten)

- Sources are funders only: super-mains, seeds and withdrawn seeds are never sources,
  on both routes, with seeds holding a balance.
- The module never calls `walletsWithRole('v4seed')` (the fake keystore records calls).
- Destination must be a super-main: a funder, a seed, an unknown id, or no super-main
  flagged → refused.
- Busy funder is skipped and named; never sent.
- `route` defaults to relay; an unknown route is refused.
- Direct math: estimate × 1.2 with the 30k floor; estimate failure falls back to the
  floor; amount = balance − gasLimit × maxFee; a funder that cannot cover its gas is
  skipped; the signed tx carries that value and gasLimit; receipts map to statuses.
- `run` requires `confirm`; requires non-empty `walletIds`; a seed, super-main or unknown
  id in `walletIds` refuses the whole run and nothing is sent; unticked funders are not
  sent; a ticked funder that became busy is skipped.
- Relay stops at the first rate-limit error; later wallets are `not-attempted` and were
  never passed to `relay.transfer`.

## Out of scope

- `v3/gather.js` `sweepEthToMain` hard-codes 21,000 gas, which this chain rejects
  (see `wallets/funding.js`). Noted for a separate fix; V3 is not touched here.
- Pacing the Relay route (timed background sweep). The stop-at-first-rate-limit rule
  keeps a run safe; the operator re-runs to pick up the rest.
