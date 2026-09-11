# V4 seed table — grouped by readiness, not by run

Date: 2026-09-12. Approved in conversation the same day.

## Why

The seed table split wallets by RUN: "Seasoned pool — earlier campaigns" vs "New
campaign" (the latest fan-out + fresh wallets). An aged, usable wallet from the latest
run therefore sat under "New campaign" until a later run started — the operator read
that as "the old campaign did not go up". He wants every usable wallet together and
everything else together.

## What

Three sections, a wallet in exactly one:

1. **Ready to use** (jade) — funded at least 1 day ago (`daysSinceFunded >= 1`, the same
   rule as the tab's "usable" count), not withdrawn, from any run. Hint: count, "funded
   1+ day ago · safe to hand to V1/V3 or export". Its "Back up N" is the usable export.
2. **Not ready yet** (sky) — every other non-withdrawn seed, with a **Status** column:
   - `failed · never funded` — its transfer is `abandoned` (amber `is-part`)
   - `cancelled · never funded` — unfunded, its campaign `cancelled` (amber)
   - `campaign halted` / `campaign paused` — unfunded, campaign halted/paused (grey)
   - `aging · Nh left` — funded, under a day (outlined `is-wait`)
   - `waiting` — in a running campaign, not yet sent (outlined; the Funded-at column
     already shows "due …")
   - `not in a campaign` — never claimed (grey)
   Default order is that list (problems first, so a failed wallet is never buried
   under hundreds of fresh ones); a clicked column sort overrides it. The hint counts
   each non-zero status: "685 wallets · 5 failed · 600 not in a campaign".
3. **Withdrawn — set aside** — unchanged.

Removed: the run clustering (`NEW_BATCH_WINDOW_MS`, `inNewBatch`), "Seasoned pool" /
"New campaign" / "Current campaign" titles, and the separate "Export usable N" button
(the Ready section's "Back up N" is exactly that set now). Search, sort, ticks, bulk
actions, per-section backup, and the Campaign column are unchanged.

## How

- `frontend/src/v4/seedStatus.js` (pure) — `seedStatus(wallet, fact, { seasonDays, now })`
  → `{ key, ready, rank, label, tone }`; `orderByStatus(list, statusOf)`;
  `statusCounts(list, statusOf)`. Tested in `seedStatus.test.js`.
- `V4Console.jsx` `seedFacts` also carries `campaignStatus: c.status`.
- `V4SeedPanel.jsx` derives the three sections from `seedStatus`.
