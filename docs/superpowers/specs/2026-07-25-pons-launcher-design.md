# pons-launcher — launch + bundled buy console (design)

*Date: 2026-07-25*

## Summary

A self-hosted web console that launches a token through the **ponsfamily.com
launchpad** on Robinhood Chain and puts the team's buys in first. The launch
transaction carries an **atomic dev buy**; up to ~25 pre-funded bundle wallets
buy immediately afterward. The tool owns the full round trip: generate/import
wallets → fund them from the dev wallet → launch + buy → sweep leftovers back.

We do not reimplement the launchpad. We call ponsfamily's own
`PonsLaunchFactory`, so the token deploys, pools, and locks exactly as it does
from their site — only driven from our UI, with a bundle attached.

## The sniper problem, and why it is already solved

`PonsLaunchFactory.launchToken` is `payable` and its own doc comment reads
*"Atomically deploys, pools, locks, records, and optionally buys a token."*
Any `msg.value` above `launchFee` becomes `initialBuyAmount`, which the factory
swaps for the new token **inside the same transaction**:

```solidity
function launchToken(TokenParams calldata params, uint256 launchConfigId,
                     uint256 dexId, bytes32 salt)
    external payable nonReentrant returns (address token)

uint256 initialBuyAmount = msg.value - launchFee;
if (initialBuyAmount != 0) { ... _executeInitialBuy(...); }
```

There is therefore **no race to win for the dev buy**. The pool does not exist
until this transaction executes, and our buy is the first swap inside it.
Nothing can be earlier.

**A private RPC is not needed and would not help.** Private mempools defend
against front-running of a *pending* transaction; an atomic buy has no window
to front-run. Robinhood Chain is sequencer-ordered with no public mempool to
snipe from — bots there watch for the pool-creation event and fire *after* it,
which the atomic buy plus the restriction window (below) already beats.

## Confirmed on-chain facts

Verified against the live contracts on 2026-07-25 via Blockscout.

| Thing | Value |
|---|---|
| Chain / RPC | 4663 / `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| **PonsLaunchFactory (live)** | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` |
| Factory fallback (previous) | `0x966ffA3957a6d3621D3EfC96E22160806f0EF141` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

Five `PonsLaunchFactory` deployments are verified on-chain. `0xA5aA…51feB` is
the live one: it was verified 2026-07-13 and was still processing `launchToken`
calls on 2026-07-25 (three within one second), while every other deployment's
last activity is 2026-07-20 through 2026-07-24.

**`TokenParams`** — all launch metadata is on-chain:

```solidity
struct TokenParams {
    string name; string symbol; string logo; string description;
    Socials socials;              // twitter, telegram, discord, website, farcaster
    address feeWallet;
}
```

**Launch and dex configs are read at runtime**, never hardcoded:
`launchConfigCount()` / `getLaunchConfig(id)` (pair token, graduation
threshold, initial tick, supply, wallet/tx limits, restriction duration),
`dexConfigCount()` / `getDexConfig(id)` (dex factory, position manager,
**swap router**, pool fee, tick spacing), and `launchFee`.

**The restriction window.** `PonsLauncherToken` enforces, while
`block.number <= restrictionEndBlock`, and **only on pool→user buys**:

- max wallet: `totalSupply * maxWalletBps / 10_000` (e.g. 500 bps = 5%)
- cumulative buy cap per address: `totalSupply * maxTxBps / 10_000`
  (e.g. 550 bps = 5.5%), tracked in `_restrictedPoolBuys`

The **only** exemption is `_initialBuyRecipient`, and only on the launch block —
so the atomic dev buy is uncapped and everyone else, snipers included, is capped
at ~5% each. Sells are unrestricted, there is no transfer tax, and after the
window the token is a plain ERC-20. This is also why bundle wallets matter:
each fresh address carries its own allowance, which is the sanctioned way to
take more than one wallet's cap.

**`deployer` is recorded as `msg.sender`**, and `initialBuyRecipient` is
`params.feeWallet` when set, otherwise `msg.sender`.

## Architecture

Node 20 + Express + ethers v6, deployed under pm2 behind nginx — the same shape
as ponscat, so the Ubuntu deployment is familiar.

Two deliberate departures from ponscat:

- **No MongoDB.** State is an encrypted keystore file plus a launch-history
  JSON file. One less service on the server, and wallet keys should not sit in
  a database that gets backed up casually.
- **Split into `backend/` and `frontend/` npm workspaces.** The backend is
  CommonJS Node; the console is React 19 + Vite. Vite proxies `/api` to the
  backend in development, and the backend serves `frontend/dist` in production,
  so it stays a single origin behind a single nginx block.

  *(Revised after the first implementation. The original design called for
  plain HTML/CSS/JS with no build step, on the grounds that an operator console
  does not need a bundler. That shipped and worked; it was replaced at the
  owner's request. The React rewrite did earn something real — panel state
  moved into components, and per-wallet row state lifted into `App`, which is
  what makes the Fund and Launch panels read the same amounts without the
  manual DOM queries the first version needed.)*

### Modules

| Module | Responsibility |
|---|---|
| `backend/src/config.js` | Env parsing, `DRY_RUN` default true, factory address + validation |
| `backend/src/evm/provider.js` | Retrying JSON-RPC provider (ported from ponscat — the public RH RPC returns spurious `-32601`) |
| `backend/src/evm/factory.js` | Read `launchFee` and the launch/dex configs, `predictTokenAddress`, build the `launchToken` tx |
| `backend/src/evm/router.js` | Build native→token `exactInputSingle` swaps against the router **read from the selected dex config** |
| `backend/src/wallets/keystore.js` | Generate / import / list / delete wallets; the only module that touches plaintext keys |
| `backend/src/wallets/funding.js` | Disperse ETH from the dev wallet, sweep ETH and tokens back |
| `backend/src/bundle/prepare.js` | Predict token + pool address, resolve per-wallet amounts, pre-sign every transaction |
| `backend/src/bundle/fire.js` | Submit the launch, blast the pre-signed buys, collect per-wallet results |
| `backend/src/routes/` | JSON API (wallets, funding, configs, preflight, launch, history) |
| `frontend/src/` | React console: `App` owns wallets/configs/history and the per-row amounts; `WalletsPanel`, `FundPanel`, `LaunchForm`, `HistoryPanel` render them |

Each module is independently testable: `keystore` needs only a passphrase,
`prepare` needs only config data and a wallet list, `fire` needs only a
provider and pre-signed transactions.

## Flow

```
1. WALLETS   generate N or paste keys → encrypted keystore
2. FUND      dev wallet → disperse (buy amount + gas buffer) to each bundle wallet
3. FORM      name, symbol, logo, description, socials, feeWallet
             + launch config / dex (read live from the factory)
             + dev buy amount
             + per wallet: fixed amount OR entire balance minus gas buffer
4. PREFLIGHT read launchFee, predict the token address, derive the pool, verify
             every balance, estimate gas — DRY_RUN renders the plan, sends nothing
5. FIRE      launchToken{value: launchFee + devBuy} from the DEV wallet
             → immediately broadcast the N pre-signed buys
6. RESULT    token address, every tx hash, per-wallet fill, blockscout links
7. SWEEP     leftover ETH back to the dev wallet; tokens too when asked for
             explicitly (`includeTokens`), never by default
```

### The three decisions that make it work

**The launch is sent directly by the dev wallet, never through a helper
contract.** The factory records `deployer = msg.sender`. Routing through a
contract would make that contract the deployer and the owner of the creator
fees — and the ponscat claim→burn bot could never claim them.

**`predictTokenAddress` plus a chosen `salt` is the whole trick.** The token
address, and therefore the pool address, is known *before* the launch
transaction exists. Every bundle buy is signed and queued in advance and goes
out the instant the launch is submitted. Snipers cannot begin until they observe
the pool-creation event; we begin before that event exists.

**A buy that lands too early simply reverts.** No pool, no swap — that wallet
loses gas, not funds. Because the failure is cheap and bounded, we fire
optimistically rather than waiting on a receipt.

## Data model

**Keystore** (`data/wallets.keystore.json`, gitignored) — AES-256-GCM, key
derived from `KEYSTORE_PASSPHRASE` via scrypt. Each record: `id`, `address`,
`label`, `role` (`dev` | `bundle`), `createdAt`, and the encrypted private key.
Plaintext keys exist only in memory during signing.

**Launch history** (`data/launches.json`) — per launch: timestamp, token
address, params, config ids, salt, dev buy, per-wallet amount / tx hash /
status / tokens received, and the sweep result.

## API surface

```
GET  /api/configs             launch + dex configs and launchFee, read live
GET  /api/wallets             addresses, labels, roles, balances (never keys)
POST /api/wallets/generate    { count, label }
POST /api/wallets/import      { privateKeys[], label }
DELETE /api/wallets/:id
POST /api/wallets/export      deliberate, separately confirmed, audit-logged
POST /api/fund                disperse from dev → bundle wallets
POST /api/sweep               bundle wallets → dev; { includeTokens? } (default false)
POST /api/preflight           full plan + validation, sends nothing
POST /api/launch              fire the bundle
GET  /api/launches            history
```

All mutating routes require `API_KEY`.

## Security

The Ubuntu box is internet-reachable, so this is assumed hostile:

- Keys encrypted at rest (AES-256-GCM, scrypt-derived from
  `KEYSTORE_PASSPHRASE`, supplied via env and never written to disk)
- `API_KEY` required on every mutating route
- The app binds `127.0.0.1`; nginx terminates TLS and adds basic auth, and is
  the only path in
- Private keys are **never** returned to the browser; `/api/wallets/export` is a
  separate, explicitly confirmed, audit-logged endpoint
- `DRY_RUN=true` is the default, so a fresh deployment cannot spend

## Config surface

`RPC_URL`, `CHAIN_ID`, `FACTORY_ADDRESS` (default `0xA5aA…51feB`, validated at
boot by reading `launchFee` and the config list), `EXPLORER_URL`, `PORT`,
`HOST`, `API_KEY`, `KEYSTORE_PASSPHRASE`, `DRY_RUN`, `GAS_BUFFER_ETH` (reserve
left in each bundle wallet when buying "entire balance"), `BUY_GAS_LIMIT`.

The swap router is read from the selected dex config rather than configured;
`SWAP_ROUTER` exists only as an override.

**`SLIPPAGE_PCT` was dropped during implementation.** A bundle buy is signed
before the pool exists, so there is no price to quote a slippage bound
against — the knob could not have done anything. `amountOutMinimum` is 0, which
is also what the factory's own `_executeInitialBuy` passes. The per-address
launch-window cap is what bounds exposure here, not slippage.

## Testing

`node:test`, matching ponscat. `DRY_RUN=true` runs the entire flow against a
stub signer with no chain writes. Unit coverage concentrates on the code that
loses money when wrong:

- keystore encrypt/decrypt round-trip, and that a wrong passphrase fails closed
- the *balance-minus-gas* math — must never produce an unsendable or
  negative-value transaction
- nonce assignment across pre-signed transactions
- a fake-provider integration test asserting the launch transaction is
  broadcast **before** any buy, and that an early-reverting buy does not abort
  the rest of the bundle

## Verified during implementation (2026-07-25)

Read live from `0xA5aA…51feB` rather than assumed:

| | |
|---|---|
| `launchFee` | `0.0005 ETH` |
| launch configs / dex configs | 1 enabled each |
| pair token | WETH `0x0bd7…ad73` |
| pool | uniswap v3, fee `10000` (1%), tickSpacing 200 |
| `swapRouter` | `0xcaf681a6…5cb2` — matches the router already used by the sibling pons projects |
| supply | 1,000,000,000 |
| `maxWalletBps` / `maxTxBps` | 500 (5%) / 550 (5.5%) |
| **`restrictionBlocks`** | **2** |
| `routerRequiresDeadline` | `false` → the Router02 shape is used |

`predictTokenAddress` was confirmed live to be deterministic per salt and to
change with the salt — the property the entire pre-signing design rests on.

**The restriction window is only 2 blocks.** Protection lapses almost
immediately, so landing in block 0 or 1 is the whole game. This vindicates
pre-signing over building buys after the launch confirms, and it is the number
to re-check if Pons ever changes the config.

## Open items

1. **Whether ponsfamily.com lists tokens launched directly through the
   factory.** Metadata lives on-chain in `TokenParams`, so their indexer very
   likely picks it up — but this should be confirmed with one cheap real launch
   before relying on it.
2. **Factory rotation.** Five deployments exist and they evidently redeploy.
   Boot-time validation catches a dead address; the fallback is
   `0x966ffA39…F141`. Worth re-checking before any significant launch.
3. **Whether the launch config caps the dev buy in practice.** The initial-buy
   recipient is exempt on the launch block, so it should not — still unverified,
   since confirming it requires a real launch.

## Out of scope

Selling / exit logic, multi-chain support, any public-facing token page, and
holder analytics. This tool launches and buys; ponscat handles fees afterward.
