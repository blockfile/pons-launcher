# V1 paced funding through the disperser — design

**Date:** 2026-08-25
**Scope:** the V1 tab only (`variant === 'v1'`). V2/V3/V4/V5 are untouched.

## What changes

Today V1's step 4 "Send" posts every target in one `POST /fund`. The backend
either broadcasts every plain transfer concurrently (hand-assigned nonces) or,
at ≥5 recipients with a disperser deployed, sends one batched disperser
transaction. Either way the bundle is funded in a burst.

Ivan wants the bundle funded **one wallet at a time, 4–7 seconds apart, each
transfer going through the disperser contract** so that on-chain every bundle
wallet is funded by an internal transfer from the contract, never directly from
the dev wallet.

## Where the pacing lives: the browser

The loop runs in `FundPanel.jsx`, one `POST /fund` per wallet with a random
4–7 s wait between them. Reasons:

- Every request is short. A single paced request for 30 wallets would run up
  to 210 s, past nginx's 180 s `proxy_read_timeout` in `deploy/*.conf`.
- Progress is visible per wallet in the report box as each transfer is sent.
- Stopping is trivial (a Stop button, or closing the tab). Nothing double-
  sends: a wallet that was never posted simply stays unfunded.
- The backend change is a small additive flag; the money-moving path without
  the flag is byte-for-byte unchanged.

A server-held job (the v2 `timedFunding` pattern) was rejected as ~4× the code
and a new stateful job to fund-safety review, for a run that takes 2–3 minutes
and that the operator watches.

## Backend: `viaDisperser` on `POST /fund`

`backend/src/wallets/funding.js` `disperse(targets, opts)` gains two options,
threaded through from the route body:

- `viaDisperser: boolean` (default `false`)
- `disperser: string | undefined` — which of the user's configured disperser
  contracts to use.

When `viaDisperser` is true:

1. If the user has no disperser configured (`addresses(userId)` is empty),
   throw `no disperser deployed — deploy one in step 2 first`.
2. If `disperser` is given, it MUST equal (case-insensitively, via
   `getAddress`) one of `addresses(userId)`; otherwise throw
   `disperser 0x… is not one of your configured dispersers`. A body-supplied
   address is never trusted on its own — that would be a way to route the dev
   wallet's ETH to an arbitrary contract. If `disperser` is omitted, the first
   configured disperser is used.
3. The batching threshold is bypassed: the run goes through
   `buildDisperseTx(targets, disperser)` regardless of recipient count. All
   targets in the request go into ONE disperser transaction (the frontend sends
   one target per request, so in practice it is one recipient).
4. There is **no fallback** to plain transfers when the disperser transaction
   fails. The per-wallet result carries `error` and `disperser`, exactly the
   shape the existing batch failure path returns.
5. Everything before the send — target resolution, the dry-run short circuit,
   the balance check with gas cost — is unchanged. In dry run the result is the
   existing `simulated: true` shape.

When `viaDisperser` is false or absent, `disperse()` behaves exactly as today.
The `disperser` option is ignored without `viaDisperser`.

Results keep today's shape: `{ walletId, address, amountEth, hash, batched:
true, disperser }` on success, `{ walletId, address, amountEth, error,
disperser }` on failure.

The route (`backend/src/routes/wallets.js` `POST /fund`) reads `viaDisperser`
and `disperser` from the body and passes them to `disperse()`. The activity
line gains ` via disperser` when the flag is set so the log distinguishes the
paced path from a burst.

## Frontend: V1's Send button

In `frontend/src/components/FundPanel.jsx`, only when `variant === 'v1'`:

- The Send button label becomes
  `Send {total} ETH to {N} wallets — 1 by 1 via disperser, 4–7 s apart`.
- Clicking it runs `sendPaced()`:
  1. If `dispersers.addresses` is empty, report
     `ERROR: no disperser deployed — deploy one in step 2 first` and return
     without posting anything.
  2. For each target in order (index `i`):
     - `POST /fund` with `{ targets: [target], variant: 'v1', viaDisperser:
       true, disperser: dispersers.addresses[i % dispersers.addresses.length] }`
       (rotating across several dispersers if configured).
     - Report the per-wallet outcome: `funded {address} {amountEth} ETH via
       {disperser} — {hash}` on success.
     - On a thrown request error, or a result carrying `error`, report
       `stopped at wallet {i+1}/{N}: {error}` plus `funded: {i} wallet(s);
       remaining: {N-i} — clear the funded rows' Fund amounts before re-sending`
       and stop the loop.
     - If more wallets remain and Stop was not pressed, wait a random
       4000–7000 ms (uniform, integer ms) before the next one.
  3. If Stop is pressed, the wait is cut short and the loop ends before the
     next post, reporting `stopped by operator after {i}/{N} wallets`.
  4. On completion report `funded {N}/{N} wallets via disperser` and reload
     balances after the usual 3 s pause.
- A `Stop` button (`.spend` styling, like the existing v2 "Stop timed") is
  shown only while a paced run is in progress. It never cancels a request
  already in flight — only the gap before the next one.
- The existing hint text about batching thresholds is replaced for V1 by a
  single hint: `one disperser transaction per wallet, 4–7 s apart`.
- The burst/batched Send is removed from V1's UI. The backend batched path
  remains for other callers and for `viaDisperser: false`.
- V2's branch of the panel is untouched.

The random wait is a small exported helper (`pacedDelayMs(min = 4000, max =
7000)`) so it can be unit-tested for bounds.

## Error handling summary

| Situation | Behaviour |
|---|---|
| No disperser configured | Frontend refuses before posting; backend also refuses if hit directly |
| `disperser` not in the user's list | Backend refuses; nothing is sent |
| Disperser tx fails on wallet k | Backend returns `error` for that wallet; frontend stops, reports funded/remaining |
| Dev wallet cannot cover transfer + gas | Existing backend balance error, surfaced as a stop |
| Operator presses Stop | Loop ends before the next post |
| Tab closed mid-run | Loop dies; already-posted wallets are funded, the rest untouched |

## Tests

- `backend/src/wallets/funding.disperse.test.js` (new; uses the existing
  keystore/provider mocking style from the v5 tests):
  - `viaDisperser` with one recipient goes through `buildDisperseTx` even
    though the count is below the batching threshold.
  - Refuses when no disperser is configured.
  - Refuses a `disperser` address that is not configured; sends nothing.
  - Accepts a configured address in different case.
  - A failed disperser send returns `{ error, disperser }` and does NOT fall
    back to a plain transfer (the signer is called once).
  - Without the flag, a 1-recipient run still takes the plain-transfer path
    (behaviour unchanged).
- `frontend/src/components/pacedDelay.test.js`: `pacedDelayMs()` returns an
  integer within [4000, 7000] over many samples, and honours custom bounds.

## Out of scope

- Server-held / resumable paced jobs.
- Pacing for V2–V5 (each tab owns its own funding path).
- Changing the disperser contract or the batching threshold for non-paced
  callers.
