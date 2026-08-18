# V4 — seasoning

**Date:** 2026-08-18
**Status:** approved, not yet implemented

## What this is

A fourth tab. Not a launcher and not a distributor: V4 never buys, never sells
and never touches a token. It is a **funding campaign that runs for weeks**.

You generate a batch of fresh wallets. V4 then drips ETH into them from a
funding wallet, through Relay, on a schedule that is randomised in every
dimension a filter could key on — how many land on a given day, how much each
one gets, and how long the gap is between one and the next. When the campaign
finishes, the wallets have been sitting untouched for long enough that nothing
about them reads as freshly minted.

The tape it produces, over 20 days rather than 20 seconds:

```
day 1    18 transfers      0.00412  0.00769  0.00531  …     gaps of 34m, 2h11m, 51m, …
day 2    27 transfers      0.00688  0.00344  0.00817  …     gaps of 1h02m, 26m, 3h40m, …
day 3    11 transfers      …
 …
day 20   22 transfers      …
```

The reason this is worth building rather than funding 400 wallets in an
afternoon: a batch announces itself. Four hundred wallets funded from one
address inside an hour, each getting the same amount, is a single query. Spread
over three weeks with no two amounts alike and no two gaps alike, there is no
shape left to match on — and each wallet's ETH arrives from a Relay solver, not
from the address that paid for it.

**V4 funds. It does nothing else.** What the wallets are eventually used for
happens outside this tab, by hand or through the tabs that already exist.

## THE ISOLATION RULE

**V1, V2 and V3 are not touched. V4 brings its own components, top to bottom.**

This is the first requirement of the build, not a style preference, and it
outranks every argument for reuse that appears later in this document. It is the
same rule [the V3 spec](2026-08-17-v3-relay-chain-design.md) opens with, and it
is restated here because V4 has a reason of its own to want it:

**V4 runs unattended for three weeks.** Every other job in this codebase is
minutes long and watched by the person who started it. This one is not. A
regression that a V3 operator would catch on the next cycle is, here, a
regression that quietly funds nothing for nine days. Code that runs unwatched
for that long must not be code that something else can change underneath it.

What that means concretely:

| V4 owns | Path |
|---|---|
| roles | `backend/src/v4/roles.js` |
| Relay client | `backend/src/v4/relay.js` |
| plan generation | `backend/src/v4/plan.js` |
| persistence | `backend/src/v4/store.js` |
| the runner | `backend/src/v4/runner.js` |
| routes | `backend/src/routes/v4.js` |
| console | `frontend/src/v4/` |

### The one edit outside the directory

Both role strings go into the `ROLES` set in
[`wallets/keystore.js`](../../../backend/src/wallets/keystore.js). This is not
optional and it is not cosmetic: `add()` resolves a role it does not recognise
to `'bundle'`, so omitting them would not fail — it would silently create every
V4 wallet holding V1's bundle role, on V1's tab, spendable by V1's launcher.

`v4master` does **not** join `SINGLETON_ROLES`. See "Parallel campaigns" below.

### On duplicating the Relay client

`v4/relay.js` is a third near-copy of `relay/funding.js` and `v3/relay.js`.

This is a real cost and it is being paid on purpose. The header of
[`v3/relay.js`](../../../backend/src/v3/relay.js) already made this argument —
"the duplication is the price of the two never being able to break each other" —
and V4 has the stronger version of it. A shared client would mean a change made
for V3 on a Tuesday alters what V4 signs, unattended, on day 11 of a campaign
nobody is watching.

The honest downside: a Relay API change is now three edits, and this copy is the
one least likely to be exercised while you are looking at it. The mitigation is
that V4's copy is the smallest of the three — it needs `transfer()` and
`status()`, nothing else.

## Roles

```
v4master   the funding wallets. Pay for the campaign and do nothing else.
v4seed     the fresh wallets. Receive exactly one transfer, then sit.
```

Two roles, not three. There is no equivalent of `v3main`, because nothing here
buys or holds anything.

**`v4master` is not a singleton.** Every other treasury role in the keystore is
— one `dev`, one `v3dev` — because those strategies have one position and one
payer. V4 is explicitly the opposite: you hold several funding wallets and run
several campaigns at once, and each campaign has to be paid for by a wallet with
no connection to the others. A singleton here would cap you at one campaign.

## Parallel campaigns

**Multiple campaigns run at once, one per funding wallet.**

### The invariant that makes it safe

> **A `v4master` wallet may be in at most one *running* campaign.**

This is not a policy choice, it is a correctness requirement, and it is the
single most load-bearing line in this document.

`transfer()` reads `getTransactionCount(from, 'pending')` and then signs with
that nonce. Two transfers leaving the same address at the same moment both read
the same value, and the second one broadcast replaces the first in the mempool.
One of the two transfers is simply gone — no error anywhere, a wallet that
believes it was funded and was not, and a campaign whose records disagree with
the chain.

Two *different* funding wallets have two independent nonce sequences and cannot
collide, which is exactly why the unit of parallelism is the funding wallet.
Five funding wallets, five concurrent campaigns.

Enforced at start: a campaign refuses to start if its funding wallet is already
in one whose status is `running`. Refuses, does not queue — a queue would mean a
campaign you started silently doing nothing for a fortnight.

### The second invariant

> **A `v4seed` wallet belongs to at most one campaign, ever.**

Claimed when a campaign starts, never released. A wallet funded twice from two
different sources is a wallet with two funding edges, which is worse than one.
The console only offers unclaimed wallets, and the backend re-checks — the
console draws controls, it does not grant anything.

## The plan is the state

Starting a campaign rolls **every dice once** and writes the entire schedule to
disk. Nothing is decided later. The plan is not a description of what the runner
will do; it is the thing the runner reads.

This is what makes a three-week job recoverable. There is no accumulated state
to reconstruct, no intent to infer from history — there is a list of transfers
with due times, and each one is either done or not.

### Parameters

| Parameter | Default | Range |
|---|---|---|
| funding wallet | — | any unclaimed `v4master` |
| seed wallets | all unclaimed | — |
| **days** | **20** | **1 – 90** |
| wallets per day | 10 – 30 | 1 – 200 |
| amount per transfer | 0.0031 – 0.0089 ETH | > 0 |
| gap between transfers | 20 min – 4 h | ≥ 1 min |
| start at | now | any future time |

**Days is a field, not a constant.** Twenty is the default because it is what
the strategy was written around, but a campaign is as long as you say it is.

Amounts are sampled to **six decimals** — `0.004127`, not `0.004`. Round numbers
are themselves a pattern, and a range sampled at two decimals only has nine
possible values.

### Generation

Seeded PRNG, and **the seed is stored with the campaign**. The plan is therefore
reproducible: the same seed and the same parameters regenerate it exactly. This
is what lets you prove after the fact that nothing re-rolled itself mid-run.

Per day: draw the count, then walk forward from a random offset into the day,
drawing each gap from the configured range.

Before anything is written, two checks:

**Feasibility.** N seed wallets must fit inside `days × [min, max] per day`. 400
wallets over 20 days at 10–30/day fits; 700 does not, and it says so and names
the shortfall rather than quietly funding 600 of them.

**Cost.** Total deposits *plus* Relay fees *plus* gas, checked against the
funding wallet's live balance. `EXACT_OUTPUT` charges the fee on the sender's
side, so the deposit is always larger than the amount ordered — a campaign
budgeted on the sum of its amounts would run dry near the end.

### Preview before commit

The per-day breakdown, the total ETH, and the balance check are shown as a plan
you read *before* anything is signed. Nothing is broadcast until you start a
plan you have seen.

### Where the ranges are a distribution, not a guarantee

At 30 wallets in a day, the gaps must average under 48 minutes, so the top of a
4-hour range will not be drawn on a busy day. The range describes the
distribution the gaps are pulled from; it is not a promise about any given pair.
This is the correct resolution — the daily count is the parameter that matters
to a filter — but it is stated here so it is not later read as a bug.

## Persistence and the runner

### The store

`backend/src/v4/store.js` — one JSON file per user,
`data/seasoning.<user>.json`, following the `pathFor` pattern in
[`store/history.js`](../../../backend/src/store/history.js). It holds an **array
of campaigns**, not one.

Written temp-then-rename. A three-week campaign will be written to several
thousand times, and a crash during any one of them must not be able to leave a
half-serialised file where the plan used to be.

A campaign record:

```
id, name, status, seed, createdAt, startedAt, completedAt
masterWalletId
params { days, perDay, amount, gap, startAt }
transfers[] {
  id, walletId, address, amountEth, dueAt, day,
  status,            pending | sent | abandoned
  attempts[] { at, error }
  requestId, depositAddress, hash, sentAt
}
```

A transfer has no `failed` state. A failed attempt appends to `attempts[]` and
returns the transfer to `pending` with a new `dueAt`; only exhausting its
attempts moves it to `abandoned`. A status that a retry would immediately leave
is a status nothing can act on.

Campaign `status` is one of `running`, `paused`, `complete`, `halted`,
`cancelled`. `halted` is the runner's decision and is resumable; `cancelled` is
the operator's and is not.

### The runner

[`timedFunding.js`](../../../backend/src/relay/timedFunding.js)'s shape — an
`unref`'d `setTimeout`, every dependency injectable so tests drive a fake clock
— with four differences.

**1. Timers are keyed by campaign, not by user.** The existing managers hold one
job per user in a `Map` keyed by `userId`. V4 holds one per campaign. This is
what parallel campaigns are, mechanically.

**2. It re-arms from disk on boot.** `server.js` calls the runner's `resume()`
at startup, which reads every campaign with status `running` and schedules each
one's next due transfer. Today every job in this codebase dies silently on
restart; that is acceptable for a run measured in minutes and is not acceptable
here.

**3. Downtime never causes a burst.** If the process was down for six hours and
four transfers came due, they are **not** all fired on boot. They are re-slotted
into fresh random future gaps. Firing them together would reproduce, in one
minute, exactly the pattern the campaign spent three weeks avoiding.

The consequence, stated plainly: **downtime extends the campaign.** A two-day
outage turns a 20-day plan into a 22-day one. That is the right trade and it is
deliberate.

**4. Failure retries, then halts.** Two counters, and they are not the same
counter — this is the part that is easy to get wrong:

- **Per transfer.** A failed attempt is recorded and the transfer is re-slotted
  to a fresh random future gap. After **3 attempts** it becomes `abandoned` and
  the campaign moves on without it.
- **Per campaign.** A counter of *consecutive* failed attempts, across all
  wallets, **reset to zero by any successful send**. At **3** the campaign
  halts.

So an isolated failure costs one wallet a delay and nothing else. Three failures
in a row with no success between them is systemic — funding wallet dry, Relay
down, RPC unreachable — and continuing would burn every remaining slot achieving
nothing.

The two interact in the way you want: a wallet only ever reaches `abandoned` if
other transfers succeeded in between, because three failures with nothing
succeeding between them halts the campaign first.

This is a deliberate departure from V3, which halts on the first failure. V3's
cycles feed each other, so a failure mid-chain leaves the next step unfunded.
V4's transfers are entirely independent — one wallet failing tells you nothing
about the next — so halting the other 380 over one bad quote would be an
overreaction.

### Visibility

A campaign that stops must not look like a campaign that is quiet.

- **Staleness readout.** The campaign panel shows `last sent 34m ago · next due
  15:12`. A stalled run is visible at a glance rather than inferred from a
  counter that stopped moving.
- **Boot-gap logging.** When the process comes back and finds transfers that
  came due while it was gone, it writes a loud activity entry: how long the gap
  was, how many were re-slotted, which campaign.
- Every transfer writes to the activity log as it goes, the way the timed funder
  already does.

### What this still cannot promise

The campaign only sends while the process is alive. PM2's `autorestart`
([`ecosystem.config.js`](../../../ecosystem.config.js)) covers crashes, deploys
and the `max_memory_restart` ceiling — the process is back in seconds and the
campaign resumes. A powered-off host is a different case: no process, no timers,
nothing sent, and the campaign resumes and stretches when the host returns.

**Operational note, outside this build:** `pm2 save` records the process list
but only survives a *machine reboot* if `pm2 startup` has installed the boot
hook. Worth confirming on the deployment before a campaign is relied on.

## Not losing the keys

These wallets have no seed phrase behind them. They are random keys in one
AES-256-GCM file on one machine, and a campaign sends real ETH to hundreds of
them over three weeks. Losing that file loses the funds outright.

`.gitignore` already covers `data/` and `*.keystore.json`, and nothing under
`backend/data/` is tracked. Two things are added on top.

### The keystore write becomes atomic

[`keystore.js`](../../../backend/src/wallets/keystore.js) `persist()` is a plain
`fs.writeFileSync` that rewrites the **entire** keystore — every role, v1's dev
key included. `add()` calls it once per wallet, so generating 400 seed wallets
is 400 consecutive full rewrites, and a process killed partway through any one
of them truncates the file holding every key in the deployment.

That is not hypothetical on the current deployment: 76 PM2 restarts against a
`max_memory_restart: '400M'` ceiling is exactly the profile that eventually
lands a kill mid-write.

`persist()` therefore writes to a sibling `.tmp` and renames. Rename is a single
filesystem operation, so the path holds either the old complete file or the new
complete file and never half of either.

**This is the one exception to the isolation rule, and it is deliberate.** It
modifies a function v1, v2 and V3 all depend on — but it makes that function
safer without changing its semantics, and the risk it removes is a risk to their
keys, not just V4's. It lands as its own commit, before any V4 code, so it can
be reverted alone.

### A campaign cannot start without a key backup

`POST /v4/campaigns` refuses until **every** seed wallet in the plan appears in a
backup on record, and the refusal names the wallets that do not.

The store keeps `backups: [{ at, walletIds[] }]`, appended by
`POST /v4/wallets/backup`. That endpoint returns V4's wallets only — filtered by
role — so backing up a campaign never hands the operator v1's dev key in the
same file.

The gate costs one click. It prevents funding hundreds of wallets that cannot
afterwards be spent from.

### What is still on the operator

`KEYSTORE_PASSPHRASE` is not recoverable. Lose it and the encrypted file is
noise, backup or no backup. Nothing in this build can change that.

## Routes

`backend/src/routes/v4.js`, mounted at `/api/v4`.

```
GET    /v4/wallets                 master + seed wallets, with claim state
POST   /v4/wallets                 generate seed wallets, or a master wallet
GET    /v4/campaigns               every campaign, newest first
POST   /v4/campaigns/preview       generate a plan, return it, persist nothing
POST   /v4/campaigns               commit a previewed plan and start it
POST   /v4/campaigns/:id/pause
POST   /v4/campaigns/:id/resume
POST   /v4/campaigns/:id/cancel
GET    /v4/campaigns/:id           full plan and per-transfer detail
```

`preview` and the commit are separate calls so that what you approve is what
runs. `preview` returns the plan **and the seed that produced it**; the commit
posts back the seed and the parameters, and the server regenerates the plan from
them rather than trusting a transfer list the browser has had its hands on. Same
seed and same parameters give the same plan, so what you read is provably what
starts.

## The console

`frontend/src/v4/V4Console.jsx`, in the idiom of
[`V3Console.jsx`](../../../frontend/src/v3/V3Console.jsx). Four panels.

1. **Funding wallets** — every `v4master`, its balance, and which campaign (if
   any) currently holds it. Create another.
2. **Seed wallets** — generate N; a table of address, balance, campaign, funded
   at, and **age in days**.
3. **Plan** — the parameter form, the preview, the start button.
4. **Campaigns** — one card per campaign, several at once: day 7 of 20, next due
   15:12, sent / failed counts, per-day rows expanding to individual transfers.
   Pause, resume, cancel per campaign.

The age column in panel 2 is the only surface that speaks to what happens after
funding. V4 does not pick wallets and does not execute anything; that column is
campaign output, and it is what you read when deciding by hand.

## Testing

The dice, the feasibility check, the cost estimate, the re-slotting and the
halt decision are **pure functions over an injected PRNG and clock**. They are
the bulk of what can be wrong here, and none of them need a network or a wait.

- `plan.test.js` — determinism from a fixed seed; feasibility rejection at both
  ends; amounts inside range and at six decimals; per-day counts inside range;
  gaps inside range; cost includes fees and gas.
- `store.test.js` — round-trip through a temp dir; a torn write leaves the
  previous file intact; multiple campaigns in one file.
- `runner.test.js` — fake clock, injected transfer. Retry then abandon; three
  consecutive failures halt; **a restart mid-campaign re-arms and does not
  burst**; two campaigns on two funding wallets interleave; a campaign refuses
  to start on a funding wallet already running.
- `roles.test.js` — the V3 test's shape: no V4 role resolves through
  `variants.js` and no V1/V2/V3 role resolves through V4's table.

### `timeScale`

A dev-only campaign parameter that divides every due time, so a 20-day plan
replays in 20 minutes against `DRY_RUN=true`. Not exposed in the production
console.

A feature whose first honest feedback is three weeks away otherwise ships having
never been observed in the only mode that matters. This is how the schedule
shape, the re-slotting and the boot recovery get watched end to end before a
real campaign is trusted with real ETH.

## What is deliberately not here

- **No Phase 3.** V4 does not select seasoned wallets and does not execute
  on-chain actions with them. That is done by hand, or through the existing
  tabs.
- **No cross-chain funding.** Both ends are `config.chainId`, the same as V3.
  Relay still breaks the edge — you pay a deposit address and a solver pays the
  wallet. A different origin chain would need a second provider and a second fee
  source in the money path, and buys nothing this strategy needs.
- **No importing externally generated addresses.** Seed wallets are generated
  in-tab into the encrypted keystore.
- **No active-hours window.** Transfers land at any hour. A funding pattern that
  respects one timezone's working day is itself a pattern.
