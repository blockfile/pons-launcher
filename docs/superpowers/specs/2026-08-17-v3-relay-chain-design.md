# V3 — the Relay chain

**Date:** 2026-08-17
**Status:** approved, not yet implemented

## What this is

A third tab. Not a third launcher: V3 never launches anything. It is a
**distribution engine** you point at a token that is already live, and it fans a
position out across bundle wallets one at a time, funding each buy with ETH it
just sold, routed through Relay so nothing on chain connects the buyers to the
seller.

The tape it produces:

```
BIGBUY   v3main buys the position
 sell    v3main sells enough to fund wallet 1        ┐
 buy     wallet 1 buys, with ETH that arrived        ┘ cycle 1
 sell    v3main sells enough to fund wallet 2        ┐
 buy     wallet 2 buys                               ┘ cycle 2
 …                                                     until every wallet has bought
```

One cycle per bundle wallet, ~7 seconds apart.

The reason this is worth building rather than just funding every wallet up front
and firing a bundle: a bundle announces itself. Twenty wallets funded from one
address in one block, then all buying in the next, is a shape anyone reading the
chain can name. This spreads the same buying over minutes, pays for it out of
sales that look like a holder taking profit, and breaks the funding edge — each
wallet's ETH arrives from a Relay solver, not from any address that ever touched
this token.

## THE ISOLATION RULE

**V1 and V2 are not touched. V3 brings its own components, top to bottom.**

This is the first requirement of the build, not a style preference, and it
outranks every argument for reuse that appears later in this document. V1 moves
real money. A refactor that "cannot change behaviour" is still a diff on the path
that spends it, and no amount of V3 is worth that.

The codebase already works this way and says so — the header of
[`routes/distributor.js`](../../../backend/src/routes/distributor.js):

> SEPARATE FROM THE V1 PATH BY DESIGN. Nothing in here touches routes/launch.js
> or bundle/prepare.js … The two are different strategies against the same
> factory, not two versions of one, so sharing code between them would only make
> each harder to reason about.

V3 follows the same rule, one step further.

### What V3 owns

Everything in its money path. New files only:

```
backend/src/v3/     roles.js  relay.js  trade.js  sizing.js  engine.js  exit.js
backend/src/routes/ v3.js
frontend/src/v3/    roles.js  V3TreasuryPanel  V3BundlePanel  V3MainPanel
                    V3ChainPanel  V3ExitPanel
```

Specifically **not** used, and each of these was in an earlier draft of this
design until the rule was stated:

| Not used | V3's own instead |
|---|---|
| `wallets/variants.js` | `v3/roles.js` |
| `relay/funding.js`, `relay/timedFunding.js` | `v3/relay.js`, `v3/engine.js` |
| `bundle/prepareSell.js`, `bundle/fireSell.js` | `v3/trade.js`, `v3/exit.js` |
| `components/DevWalletPanel`, `WalletsPanel`, `FundPanel`, `SellPanel` | the five `frontend/src/v3/` panels |
| `frontend/src/variant.js` | `frontend/src/v3/roles.js` |

### What V3 may read

Infrastructure that is already shared by v1 and v2 both, imported **unmodified**
and never edited: `config.js`, `evm/provider.js`, `evm/fees.js`, `evm/errors.js`,
`evm/receipt.js`, `evm/v2/abi.js` (ABI fragments — data, not behaviour),
`wallets/keystore.js` (signers and wallet lists), `store/activity.js`,
`middleware/auth.js`. On the console: `api.js`, and the presentational chrome
`Step`, `Section`, `Address`, `Modal`, `Toaster`, `Sequence`.

Importing a module without editing it cannot change what v1 or v2 does. Editing
one can. That is the whole line.

### The three edits outside `v3/`

Unavoidable, additive only, and each is the smallest possible:

1. **`wallets/keystore.js`** — add `v3dev`, `v3main`, `v3bundle` to `ROLES`, and
   `v3dev`/`v3main` to `SINGLETON_ROLES`. Two set literals gain three entries
   between them. This cannot be avoided: `add()` resolves an unknown role to
   `'bundle'`, so without it every V3 wallet would silently appear on the V1 tab
   holding v1's role — the exact bug the comment above that line documents.
2. **`backend/server.js`** — one `app.use('/api', v3Routes)` beside the three
   already there.
3. **`frontend/src/App.jsx`** — a third tab button, and `{tab === 'v3' ? <V3Console/> : …}`
   wrapping the existing tree unchanged. The v1/v2 branch keeps every prop,
   every effect and every step it has today; V3 renders its own console beside
   it and shares no state with it.

Nothing else in the repository changes.

## Scope

**Only pons v2 bonding-curve tokens.** Start is refused for anything else:

- a v1 token — the buy would need a router path, and the v1 factory has had
  `launchEnabled` false since 2026-08-12 anyway (see the note in `App.jsx` above
  `SHOW_V2_BUNDLER`)
- a graduated curve, or one that is `readyToGraduate` — the position would finish
  the run trading somewhere V3 cannot sell it
- a token no wallet of this account launched or has launched — V3 signs
  approvals, and an approval to a hostile ERC-20 is the whole dusting attack

**Not in scope:** launching (use the V1/V2 tab), cross-chain anything.

## Wallet roles

Three new roles, two of them singletons:

| Role | Singleton | Job |
|---|---|---|
| `v3dev` | yes | Treasury. Funds `v3main` through Relay. Never buys, never holds supply. |
| `v3main` | yes | Makes the one big buy, holds the position, makes every sell. |
| `v3bundle` | no | Receivers. Each gets one Relay transfer and makes one buy. |

`v3main` is a role of its own — rather than letting the treasury do the buying —
because the whole optic of the strategy is that the big buyer is not the
treasury. If `v3dev` bought, sold and paid for everything, the funding edge this
design exists to break would be drawn straight back in by the first person to
look.

`backend/src/v3/roles.js` holds the three names and V3's own lookups
(`treasury(ks)`, `main(ks)`, `bundle(ks)`, `all(ks)`), each throwing by name when
the wallet is missing. `frontend/src/v3/roles.js` mirrors it for drawing only.
Neither imports `variants.js`, and `variants.js` gains no `v3` entry — so a
V1 or V2 request cannot resolve to a V3 wallet, and a V3 request cannot resolve
to theirs, because the two lookups do not share a table to be confused by.

## The engine

`backend/src/v3/engine.js`. One job per user in a `Map`, with `start`, `stop`,
`resume`, `status`, a `setTimeout` that is `unref`'d so it cannot hold the
process open, and every dependency injectable so tests never touch a network.
The browser can close without killing the run.

A server restart loses the job. Acceptable because a run is
`walletCount × interval` long — 30 wallets at 7s is three and a half minutes — so
the window in which a restart costs anything is small, and what it costs is a
stopped run with every wallet's state still readable on chain.

### Cycle 0 — the big buy

`v3main` buys `bigBuyEth` from the curve; the engine waits for the receipt. If it
reverts, the run stops before a single transfer goes out.

This is part of the run rather than something done by hand so that the whole
strategy is one button, and so the engine knows the position it is about to
distribute rather than inferring it from a balance somebody else created.

### Cycle N — one per bundle wallet, in table order

1. **Size and sell.** Compute `T` (below), quote the tokens needed, sign
   `approve` at nonce *n* and `sell` at *n+1*, broadcast both, wait for the sell
   receipt, and measure what actually arrived as a **balance delta with gas added
   back** — a curve sell's proceeds are a return value, and a return value is not
   in a receipt.
2. **Relay.** An EXACT_OUTPUT quote from `v3main` to wallet N for
   `buyEth[N] + gasReserve`, validated and broadcast through `v3/relay.js`.
3. **Wait for the fill.** Poll wallet N's native balance every `FILL_POLL_MS`
   until it covers the buy, capped at `FILL_TIMEOUT_MS`. A buy is never
   broadcast against a balance that has not arrived.
4. **Buy.** Wallet N buys `buyEth[N]` from the curve; wait for the receipt.
5. **Sleep.** Until `max(interval, elapsed)`, plus jitter if it is on.

The sell precedes the buy inside a cycle, which is what produces the alternating
`sell, buy, sell, buy` tape rather than a block of sells followed by a block of
buys.

Nothing separates the sell from the buy inside a cycle beyond the Relay fill's
own latency, which is a few seconds. That is deliberate — it is real latency, not
a number someone chose, and it varies on its own.

### Timing

| Constant | Default | Why |
|---|---|---|
| `DEFAULT_INTERVAL_MS` | 7000 | What was asked for. |
| `MIN_INTERVAL_MS` | 3000 | Below this the fill wait dominates and the interval stops meaning anything. |
| `MAX_INTERVAL_MS` | 600000 | Ten minutes. |
| `DEFAULT_JITTER_PCT` | 0 | Off unless asked for. |
| `MAX_JITTER_PCT` | 50 | Beyond this the interval is not an interval. |
| `FILL_POLL_MS` | 1500 | Cheap `eth_getBalance`; fast enough not to add a visible cycle. |
| `FILL_TIMEOUT_MS` | 90000 | Relay same-chain fills land in seconds; 90s is a stall, not a slow fill. |
| `SELL_HEADROOM_PCT` | 10 | See below. |

The interval is a **floor**, not a clock. If a cycle takes eleven seconds because
Relay was slow, the next starts immediately rather than the engine trying to
catch up — catching up would bunch two buys together, which is exactly the shape
being avoided.

Jitter, when on, is `±jitterPct` of the interval, uniform. It defaults off
because exactly 7.000s between every buy is a machine signature, and the operator
should be the one deciding whether this run wants to look human.

## Sell sizing

`backend/src/v3/sizing.js`. Each cycle raises

```
T = buyEth[N] + recipientGasReserve + relayFee + mainGas
```

where `recipientGasReserve = gasCost(fees, config.buyGasLimit) + config.gasBufferEth`
— read from config, so a wallet funded by this engine can afford exactly the buy
the engine then asks it to make, and both figures stay operator-tunable where
they already live.

V3's own inversion of the constant-product sell, written in this file rather than
imported:

```
gross    = ceil(T · BPS / (BPS − feeBps − creatorTaxBps))
tokensIn = ceil(gross · tokenReserve / (quoteReserve − gross))
```

`gross ≥ quoteReserve` means the curve cannot pay `T` at any size — the run stops
and says so, rather than signing a sell for a number that would empty the
position.

`T` is multiplied by `1 + SELL_HEADROOM_PCT/100` before solving. The headroom is
not optional and the reason is structural: **`minQuoteOut` is 0 on every sell**,
so the sell is a quote and not a promise. Anything that lands between the quote
and the sell moves the price, and a sell that raised less than `T` would leave
the next transfer short.

**The Relay deposit is sized against `v3main`'s actual balance after the sell
lands, never against the estimate.** If the balance will not cover
`deposit + gas`, the run stops. This is the one place where the gap between what
was quoted and what was received turns into a decision, and it is resolved by
reading the chain rather than trusting the arithmetic above.

Surplus — headroom that was not needed — pools in `v3main` and is swept by step
5. Later cycles do **not** shrink their sells to spend it down. Every cycle gets
a visible sell, because the sells are half of what the tape is for; an engine
that quietly skipped one because it happened to be holding enough ETH would put a
hole in the pattern at an unpredictable point.

## Trading

`backend/src/v3/trade.js`, built on the ABI fragments in `evm/v2/abi.js` and an
`approve` fragment of its own:

- `buy(wallet, curve, amountWei)` — `curve.buy(amountIn, 0, wallet)` with
  `amountIn` as value, gas `config.buyGasLimit`.
- `sell(wallet, curve, token, tokensIn)` — `approve(curve, tokensIn)` at nonce
  *n*, `curve.sell(tokensIn, 0, wallet)` at *n+1*. The sequencer executes a
  wallet's transactions in nonce order, so the approval does not have to confirm
  before the sell is broadcast.

The approval is for **exactly the tokens being sold**, every cycle, not once for
the whole position. It costs one extra transaction per cycle, which on this chain
is a rounding error, and it means a run that stops halfway leaves no standing
allowance behind.

`minQuoteOut` is 0 on every sell and every buy. Not an oversight — see the
headroom section, and see the exit below.

## Relay

`backend/src/v3/relay.js`. V3's own client, not a refactor of the v2 one:

```js
transfer({ fromWallet, toAddress, amountWei }, deps)   // EXACT_OUTPUT, same chain
status(requestId, deps)
```

It quotes `/quote/v2` with `tradeType: 'EXACT_OUTPUT'`, `useDepositAddress: true`,
`strict: true`, `originChainId === destinationChainId === config.chainId`,
`refundTo` the sender, then validates the returned deposit step and signs it.

Four validations, each of which exists because it has caught something on the v2
path and would catch the same thing here:

1. the quote actually contains a deposit transaction
2. its `chainId` is the chain this server can sign for
3. its `from` is the wallet we asked to spend
4. its `value` is positive

And one behaviour that is not a validation but is the reason deposits land at
all: **the fee ceiling is refreshed at send time**, not taken from the quote.
Relay's quoted `maxFeePerGas` goes stale when the base fee ticks between quote
and broadcast, and a stale ceiling gets the deposit rejected before it reaches
the mempool.

Same-chain is the normal case here, not a special one. Relay is being used as a
funding-edge break rather than as a bridge: the ETH leaves `v3main`, and a solver
— not `v3main` — is what pays the bundle wallet.

## The exit

`backend/src/v3/exit.js` and `V3ExitPanel`. Sells everything out of **`v3main`
and every `v3bundle` wallet**: `v3main` finishes a run still holding whatever it
did not sell, and the bundle wallets hold everything they bought.

Same two-transaction shape per wallet as `v3/trade.js` uses, no slippage floor,
the same ownership and graduation gates as start, and `{ confirm: true }`
required. It is V3's own file for the same reason as everything else here, and
because what it needs — sell the whole balance from a set that includes the main
wallet — is not the shape `prepareSell` has.

## API

All under `/api/v3/`, mounted from `backend/src/routes/v3.js`:

| Method | Path | Does |
|---|---|---|
| `GET` | `/v3/wallets` | V3's three role groups with balances and token holdings. |
| `POST` | `/v3/wallets/generate` | Create wallets in a V3 role. |
| `POST` | `/v3/wallets/import` | Import a key into a V3 role. |
| `DELETE` | `/v3/wallets/:id` | Delete a V3 wallet — refused while a job is running. |
| `POST` | `/v3/fund` | Relay transfer, `v3dev` → `v3main`. |
| `GET` | `/v3/chain` | Current job, or an idle shape. The panel's poll target. |
| `POST` | `/v3/chain/plan` | Dry preview: token, curve, every wallet's buy, what cycle 1 would sell. Broadcasts nothing. |
| `POST` | `/v3/chain/start` | Validates and starts. `token`, `bigBuyEth`, `targets[] {walletId, buyEth}`, `intervalMs`, `jitterPct`, `confirm: true`. |
| `POST` | `/v3/chain/stop` | Halts after the in-flight step; keeps state. |
| `POST` | `/v3/chain/resume` | Continues from the wallet that failed or was stopped at. |
| `GET` | `/v3/exit/preview` | What the exit would sell, per wallet. |
| `POST` | `/v3/exit` | Sell everything. `{ confirm: true }`. |

`start` and `exit` take `confirm: true` the way `/sell` does. Both are
irreversible, both move the whole position, and neither has a slippage floor
anywhere in it.

Every step of every cycle is written to the activity log through `activityFor` as
it happens, tagged `v3`, so a run that is halfway done is legible from the log
alone with the panel closed.

## Failure

**Any failure halts the run and keeps state.** Sell reverts, fill never arrives,
buy reverts, `v3main` short of ETH, curve graduates mid-run, RPC dies — the
engine stops at that step, records which wallet and which step, and touches
nothing else. Resume picks up at that wallet.

No retries, no skipping. Both were considered and rejected: skipping means a
systemic fault (curve graduated, main wallet dry, Relay down) burns every
remaining wallet before anyone notices, and a retry that re-broadcasts a sell
whose first attempt actually landed sells the position twice.

A stopped run is safe to leave: nothing is pending, every wallet's state is on
chain, and the surplus is in `v3main`.

## Refusals at start

- a job is already running for this user
- the token is not a pons v2 launch, or the v2 factory has no record of it
- the curve is `graduated` or `readyToGraduate`
- the token was not launched by a wallet this account holds or has held
- no `v3main` wallet, or no `v3bundle` wallets
- `v3main` cannot cover `bigBuyEth` + gas
- any target has no positive `buyEth`
- `intervalMs` or `jitterPct` out of range

## Console

A third tab rendering V3's own console — five steps, five panels, none of them
shared with the v1/v2 tree:

| # | Step | Panel |
|---|---|---|
| 1 | Treasury wallet | `V3TreasuryPanel` — create or import `v3dev`, balance, explorer link |
| 2 | Bundle wallets | `V3BundlePanel` — generate `v3bundle`, a buy amount per row, running total |
| 3 | Main wallet | `V3MainPanel` — create `v3main`, fund it from `v3dev` through Relay, show its position |
| 4 | Run the chain | `V3ChainPanel` |
| 5 | Sell everything | `V3ExitPanel` |

`V3ChainPanel` takes the token address, the big buy, the interval and the jitter,
has a Preview button hitting `/plan`, and Start / Stop / Resume. While a job runs
it polls `/v3/chain` and draws a row per cycle with per-step state —
`sold · transferred · waiting for fill · bought` — so a stall is visible as the
step it stalled on rather than as a run that stopped moving.

The step strip uses the existing `Sequence` and `Step` components unmodified;
V3 supplies its own five-step plan to them. They are presentation, and nothing
about them decides what a launcher spends.

## Testing

Every new module takes injected dependencies, so none of these touch a network:

- **`sizing`** — round-trip: sizing for `T`, then quoting the result against the
  same reserves, returns at least `T`. Refuses when `gross ≥ quoteReserve`.
  Headroom applied before solving, not after. Rounding always favours selling
  slightly more, never less.
- **`engine`** — fake clock, fake steps: cycle order, the interval as a floor and
  not a clock, jitter bounds, halt-and-keep-state on a failure at each of the
  four steps, resume from the failed wallet, stop mid-flight, double-start
  refused.
- **`relay`** — each of the four validations refuses its own bad quote; the fee
  ceiling sent is the refreshed one and not the quoted one.
- **`trade`** — approve and sell are signed at consecutive nonces from the same
  wallet; `minQuoteOut` is 0; the approval is for exactly the amount being sold.
- **`roles`** — each lookup throws by name when its wallet is missing; the
  singletons refuse a second wallet.
- **`exit`** — includes `v3main` as well as the bundle wallets; refuses without
  `confirm`.
- **Refusals** — one test per bullet in the refusals list.

And the check that matters most for the isolation rule:

- **The entire existing test suite passes unmodified.** Not one file under
  `bundle/`, `relay/`, `wallets/variants` or `routes/launch` is edited, so not
  one of their tests should need to be. If a change to V3 requires editing an
  existing test, the change is wrong.
