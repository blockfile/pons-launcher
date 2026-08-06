# sell-all — brainstorm in progress

**Date:** 2026-08-06  **Status:** decisions captured, design NOT yet written

Sell 100% of a launched token from every bundle wallet, in one action.

## Decided by the operator

**Order: all at once.** Every sell broadcast concurrently, like the buy bundle.
The sequencer decides who lands first and the tail fills worse; that spread is
accepted in exchange for the fastest possible exit.

**Floor: none.** Sells carry no `minQuoteOut`. Every wallet exits whatever the
price, and nothing is left holding tokens.

The risk was stated and accepted: with no floor, a sell into a drained curve or
behind a front-runner can return near zero and still succeed. Do not quietly
add a floor later — it was declined deliberately.

## Established, not yet decided

Which token to sell is NOT a problem. Two independent sources:

- `data/launches.<user>.json` already records `token` and `curve` per launch
- `TokenLaunched(address indexed token, address indexed curve, address indexed
  deployer, ...)` — `deployer` is indexed, so one `getLogs` enumerates every
  token a dev wallet ever launched, including launches made outside this app

Graduated or not is readable per token: `getLaunchedToken(token).phase` on the
v2 factory, or `graduated()` / `readyToGraduate()` on the curve. The button
reads it at preflight and routes accordingly rather than asking the operator.

## Which token to sell — decided

The candidate list is an INTERSECTION, and the order matters:

    tokens the dev wallet launched   INTERSECT   tokens the bundle wallets hold

The first set comes from `TokenLaunched` filtered on `deployer`, plus launch
history. The balance check only narrows that set; it never adds to it.

**Never list a token merely because a wallet holds it.** Bundle wallets get
dusted, and selling an unknown token means approving an unknown contract and
calling into it — a hostile ERC-20 can do anything it likes in `transferFrom`,
including behaving differently for one address than another. A sell-all that
swept everything with a balance would be an invitation to send poisoned tokens
to the wallets.

Approvals only ever go to the curve or router for a token the dev wallet
launched.

One dev wallet does launch several tokens in practice — `0x1ada673A…97C8ee`
has launched at least twice — so the picker is required, not optional. It
shows symbol, total held across the bundle, how many wallets hold any, and
whether the curve has graduated. Old launches drop off the list on their own
once their balance is gone.

## Still open

- Where the ETH goes: left in each bundle wallet, or swept to dev in the same
  action
- Approval shape: exact-balance or max approval to the curve (two transactions
  per wallet either way on the first sell)
- The graduated path is a Uniswap v4 swap through UniversalRouter — the same
  encoding being built in the unilauncher project. Reuse it rather than writing
  it twice.
- Whether a token with a graduated curve and one still bonding can be handled
  by one button or needs two

## Next

Resume brainstorming from "Still open", then design sections, spec, plan.
