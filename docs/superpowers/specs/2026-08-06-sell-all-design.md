# sell-all — design

**Date:** 2026-08-06
**Project:** pons-launcher
**Status:** approved, not yet implemented
**Supersedes:** 2026-08-06-sell-all-notes.md

Sell 100% of a launched token from every bundle wallet holding it, in one
action.

## Decisions

All seven were made by the operator. Where a decision carries a risk, the risk
is recorded next to it so a later reader does not "fix" a deliberate choice.

**Order: all at once.** Every sell broadcast concurrently, like the buy bundle.
The sequencer decides who lands first and the tail fills worse. That spread is
accepted in exchange for the fastest possible exit.

**Floor: none.** No `minQuoteOut`. Every wallet exits at whatever price, and
nothing is left holding tokens. *Accepted risk:* a sell into a drained curve or
behind a front-runner can return near zero and still succeed. This was chosen
with that stated. Do not add a floor later without asking.

**Selection: `launched-by-dev` INTERSECT `held-by-bundle`.** The candidate set
comes from `TokenLaunched` filtered on `deployer`, plus launch history; the
balance check only narrows it. *Never list a token because a wallet holds it* —
bundle wallets get dusted, and selling an unknown token means approving an
unknown contract and calling into it. A hostile ERC-20 can do as it likes in
`transferFrom`, including behaving differently per address. Listing by balance
alone would make dusting a way to get a poisoned contract approved by twenty
funded wallets.

**Proceeds: left in each wallet.** The sell delivers ETH to the wallet that
sold; nothing else moves. Sweep already exists, already works, and consolidating
is a separate decision from exiting.

**Approval: exact balance, per sell.** No standing allowance is left behind, so
a wallet reused for a later launch carries no lingering permission to a contract
it no longer trades with.

**Routing: one button, decided per token at preflight.** A bonding curve gets
`curve.sell()`; a graduated token gets a Uniswap v4 swap. The operator never
picks — the curve's own state decides.

## How it works

### Finding what can be sold

```
candidates = history  (and only if that yields nothing sellable:
              TokenLaunched(deployer = devWallet), bounded scan)
launches   = candidates where factory.getLaunchedToken(t).deployer == devWallet
sellable   = launches where SUM(bundle wallet balances) > 0
```

**Amended 2026-08-06, after a production hang.** The original spec said
`TokenLaunched UNION history`, with the log scan run first and unconditionally.
On the operator's node that scan never finished: QuickNode caps `eth_getLogs` at
a 10000-block range, the chain is at ~28.7M blocks and grows ten a second, and
the backwards walk turned into thousands of sequential requests — each refusal
retried four times with backoff before the window was split. `GET /api/sellable`
simply never returned.

So history is now the primary source, not a top-up: `data/launches.<user>.json`
already holds the token and curve for every launch this console made, and
reading it costs nothing. The log scan is a fallback, runs only when history
yields no sellable row, and is capped at 20 windows of 10000 blocks with a
10-second wall clock; when it runs out it returns what it found with a warning
naming the blocks it covered. **The gate did not move** — every candidate,
history included, is still re-checked against `getLaunchedToken`, because a
local file naming a token is not evidence that this dev wallet launched it.

The cost of this is stated rather than hidden: a launch made outside this
console, by a dev wallet that also has launches inside it, will not be offered.

The picker shows, per token: symbol, total held across the bundle, how many
wallets hold any, and whether the curve has graduated. Old launches fall off the
list on their own once their balance is gone.

One dev wallet launches several tokens in practice — `0x1ada673A…97C8ee` has
launched at least twice — so the picker is required, not a convenience.

### Preflight

For the chosen token, per wallet holding it:

1. read the token balance
2. read the curve's `graduated()` / `readyToGraduate()` once for the token, not
   per wallet
3. build `approve(spender, balance)` where `spender` is the curve or the
   UniversalRouter, depending on route
4. build the sell — `curve.sell(balance, 0, wallet)` or a v4 exact-input swap of
   token for ETH
5. sign both, at consecutive nonces

Preflight signs and broadcasts nothing, like every other preflight here.

### Firing

Both transactions per wallet go out together. The approval takes nonce `n` and
the sell nonce `n+1`, so the sequencer executes them in order without the
approval needing to confirm first — the same trick the buy bundle uses to avoid
a round trip.

All wallets broadcast concurrently. Receipts are collected afterwards.

### Reporting

Per wallet: tokens sold, ETH received, and the transaction hashes. Plus the
totals, and — because the tail is expected to fill worse — the best and worst
price achieved, so the spread is visible rather than inferred.

Recorded to the activity log as one `sell` entry with the per-wallet results,
including failures. The failures are why anyone returns to that log.

## Safety

- The action is irreversible and touches every wallet, so it takes the same Arm
  switch the launch button has, and a confirm naming the token and the wallet
  count.
- Approvals only ever go to the curve or router for a token the dev wallet
  launched.
- A wallet whose sell fails keeps its tokens; the others are unaffected. One
  wallet's failure never aborts the run.
- Nothing is signed at fire time.

## Testing

Unit, no chain, with injected fakes:

- the candidate list excludes a held token the dev wallet did not launch
- a token with zero bundle balance is not offered
- graduated and bonding tokens route to different builders
- approve and sell get consecutive nonces from the same wallet
- one wallet's broadcast failure does not stop the others
- a dry run broadcasts nothing
- the result reports best and worst fill

## Out of scope

- Partial sells. This is all-or-nothing by decision.
- Sweeping the proceeds. Sweep already exists.
- Selling the dev wallet's own holdings — it is not a bundle wallet.
