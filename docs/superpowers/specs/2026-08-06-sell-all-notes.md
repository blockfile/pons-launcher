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
