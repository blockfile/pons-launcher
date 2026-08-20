# Seasoned-wallet handoff (V4 → V1 & V3)

**Status:** approved design, 2026-08-21
**Author:** Ivan + Claude

## Problem

V1 and V3 bundle wallets are generated **fresh** in their bundle step — brand-new
addresses that suddenly buy a token, which reads as coordinated/sybil. V4 already
runs a seasoning pipeline that funds fresh wallets over days so they age and look
organic. Today that pipeline feeds nothing but itself. We want V1 and V3 to draw
their bundle wallets from V4's **already-seasoned** wallets, so their buyers carry
age instead of being minted seconds before the buy.

## Goal

A seed wallet that V4 has finished seasoning can be **claimed** by V1 or V3 and
becomes a bundle wallet in that tab — pre-aged and pre-funded. V4 keeps a
read-only record of what it handed off.

## Non-goals

- No change to V4's seasoning engine, schedule, or funding math.
- No change to the launch (V1) or chain (V3) trading math beyond reading a
  pre-existing balance.
- v2 is untouched.
- Not selection-by-address in v1 (take-the-N-oldest is enough); a picker can come
  later if wanted.

## Definitions

**Available / "done" seasoned wallet.** V4 funds each seed exactly once ("one
transfer each"). A seed is therefore *finished* — and V4 will never sign from it
again — once it is **funded** (funding fact status `sent`, `fundedAt` set) **and
aged ≥ `SEASONED_MIN_HOURS`** (default 24) since that funding. Because V4 is truly
done with these wallets, handing one off cannot nonce-collide, even while the
campaign keeps funding *other* seeds.

The availability set = `walletsWithRole('v4seed')` where `fundedAt != null` and
`hoursSinceFunded >= SEASONED_MIN_HOURS`, ordered most-aged first (a wallet funded
under the threshold is simply not yet in the set).

## Architecture

### Config
- `config.seasonedMinHours` from `SEASONED_MIN_HOURS`, default `24`. Documented in
  `.env.example`. Read only by the availability helper below.

### Backend — availability (one read-only interface into V4's domain)
- New module `backend/src/v4/seasoned.js`:
  - `available(ks, store, now, { minHours = config.seasonedMinHours })` → array of
    claimable seed wallet records (id, address, label, fundedAt, hoursSinceFunded,
    balanceEth), most-aged first. Pure over its inputs; built from the same
    `fundingFacts()` V4's backup uses.
  - `claim(ks, store, ids, { toRole, now, minHours })` → validates each id is
    currently a claimable seed (re-checks availability at claim time, not just at
    list time), calls `ks.setRole(id, toRole)`, and `store.recordGraduated(...)`.
    Returns the claimed records. Throws naming the first id that is not claimable.
- `GET /api/v4/seasoned` (routes/v4.js) → `{ count, minHours, wallets: [...] }`
  for the UIs to show what's available. `requireApiKey`.

### Backend — the graduated record (V4 "stays in V4")
- V4 store gains:
  - `recordGraduated(entries)` where each entry is `{ id, address, toTab, at }`.
    Persisted beside the campaign store.
  - `graduated()` → the list, newest first.
- `GET /api/v4/seasoned` response and a V4 view read `graduated()`. A re-roled
  wallet drops out of `onlyV4Wallets()` naturally (role is no longer `v4seed`), so
  V4's active seed list shrinks on its own; the graduated list is what preserves
  visibility.

### Backend — claim endpoints (one per consuming tab; isolation rule → duplicated)
- **V1:** `POST /api/wallets/claim-seasoned` (routes/wallets.js), body
  `{ count }` — take the N most-aged. Resolves availability via `seasoned.available`,
  takes the N most-aged, enforces `assertBundleRoom(ks, 'bundle', n)` (the
  31-wallet snipe-exemption cap), then `seasoned.claim(..., { toRole: 'bundle',
  toTab: 'v1' })`. Records activity.
- **V3:** `POST /api/v3/wallets/claim-seasoned` (routes/v3.js), body `{ count }`.
  Refused mid-run (same guard as the v3 delete: the engine resolves wallets by id
  every cycle). `seasoned.claim(..., { toRole: 'v3bundle', toTab: 'v3' })`. No cap.
  Records activity.
- Both: if fewer are available than requested, claim what exists and return the
  count claimed + the shortfall; never partially re-role on error (validate all
  ids up front).

### Frontend
- **Availability hook / fetch:** a small `GET /api/v4/seasoned` read, used by both
  V1 and V3 bundle panels to show "N seasoned wallets ready (aged ≥24h)".
- **V1** (`components/WalletsPanel.jsx`): a **"Use N seasoned wallets"** control
  beside Generate — count input + button, disabled when 0 available or when the
  claim would breach the 31 cap (shows the room left). On success, reloads wallets.
- **V3** (`v3/V3BundlePanel.jsx`): the same control beside Generate; disabled
  during a run.
- **V4** (`v4/V4SeedPanel.jsx` or a small addition): a read-only **"Graduated"**
  count/list — address, which tab took it, when — so V4 shows what it produced.

## The pre-existing balance

A claimed wallet carries the small ETH it was seasoned with.
- **V1:** a bonus — bundle wallets need ETH to buy, so this is pre-funding. V1's
  fund step tops up whatever is still short; no special handling.
- **V3:** the wallet's first buy is larger by that starting balance, because the
  engine sizes a buy from what a cycle delivers and would now find extra already
  sitting there. At seasoning amounts (~0.0002 ETH) this is negligible. Documented,
  not corrected. If it ever matters, the fix is to sweep the seed balance on claim
  — explicitly out of scope here.

## Error handling

- Claim re-validates availability per id at claim time (a wallet claimed by the
  other tab, deleted, or funded-too-recently since the list was drawn must fail,
  not silently re-role).
- All-or-nothing per request: validate every id before the first `setRole`, so a
  failure leaves no half-claimed batch.
- V1 claim over the 31 cap is refused before any re-role, naming the room left.
- V3 claim during a run is refused before anything.

## Testing

- `seasoned.available`: funded+aged included; funded-but-too-young excluded;
  never-funded excluded; non-seed roles excluded; ordering most-aged first.
- `seasoned.claim`: re-roles to the given role, records graduated, refuses an id
  that is not currently claimable, is all-or-nothing on a bad id in the batch.
- V1 claim route: honors the 31 cap; shortfall reported.
- V3 claim route: refused mid-run; re-roles to v3bundle.
- Store `recordGraduated`/`graduated` round-trips and persists.

## What is deliberately not touched

V4's seasoning engine and schedule; the launch and chain trading math; v2; the
keystore's role mechanics (we only call the existing `setRole`).

## As-built deltas (2026-08-21)

- `available()` returns `{ id, address, label, fundedAt, hoursSinceFunded }` — no
  balance, so the helper stays pure over (ks, store, now) with no RPC. (As the
  spec anticipated.)
- The V4 graduated list is folded into the `GET /api/v4/seasoned` response as
  `graduated: store.graduated()` rather than a separate `/v4/graduated` route.
- Both claim endpoints short-circuit to `{ claimed: [], available, shortfall }`
  when nothing is claimable, instead of surfacing `seasoned.claim`'s empty-`ids`
  error (added in review).
- The V1 claim control is gated to `variant === 'v1'` in the shared WalletsPanel,
  so v2 never shows it (v2 has no claim endpoint).
- A new `backend/src/routes/wallets.test.js` was created (there was none) using the
  same router-stack + temp-keystore harness `v4.test.js` established.
- Full backend suite: 610/610 pass.
