# Pons v2 — Paired Assets (RWA) & Holder Fee Sharing

Reference for extending the operator tool to (1) launch tokens paired against a non-ETH
asset (SPCX/NVDA/USDG/…) and (2) route a launch's creator fees to its holders.

All addresses are Robinhood Chain (id **4663**). Facts marked **VERIFIED** were read from
verified on-chain source / live `eth_call`; **INFERRED** were recovered from bytecode +
behavior (the contract is not source-verified).

## Contract map

| Role | Address | Verified |
|---|---|---|
| Core factory `PonsV2LaunchFactory` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | ✅ |
| Launch-and-buy forwarder `PonsV2LaunchAndBuy` | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | ✅ |
| Fee escrow `V2FeeEscrow` | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` | ✅ |
| Holder-fee **distributor factory** (proxy) | `0x70e95CC5f03DB2906081E7a8D16e4C4209291507` | logic unverified |
| Distributor beacon | `0xa125492aca28449d2291f5415a818697345cfa09` | — |
| Distributor implementation (BeaconProxy target) | `0xf70c5B3ac4B7Cb0d9Ef26774306aaa94F3d58A8a` | ❌ unverified |
| Pons deployer / owner | `0xFdDE5a1E3cDF791Da71E49F817D70C7ceD72CC36` | ✅ |

The core `TokenParams` struct is `{name, symbol, logo, description, socials,
creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt}` — **there is
no holder-fee field.** Holder fee sharing is achieved entirely by *who* `creatorFeeRecipient`
points at (see below).

---

## 1. Paired assets (RWA / stables)

A v2 launch takes an `address pairToken`. `address(0)` = native ETH (default; uses the
LaunchConfig's own phantomQuote/threshold). Any other address must be an **approved** ERC-20.

**Detecting support (no enumeration function exists):**
- `approvedPairTokens(address) → bool` — the authority (VERIFIED).
- `pairTokenEconomics(address) → (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)`
  — per-asset curve economics, in that asset's own decimals (VERIFIED).
- Build the candidate list from the event `PairTokenApprovalUpdated(address indexed pairToken,
  bool approved)` from the factory creation block, then confirm each **live** with
  `approvedPairTokens` (approvals get revoked — RIVN was). Never hard-code the set as truth.

**Currently approved (sample, all 18-dec unless noted):**
SPCX `0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa`, NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`,
TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`, GOOGL `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3`,
AAPL `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9`, GME `0x1b0E319c6A659F002271B69dB8A7df2F911c153E`,
**USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals)**, plus SPY/AMD/AMZN/MSFT/META/
COIN/PLTR/MSTR/QQQ/… WETH and HOOD are **not** approved.

**Operator-tool implementation (branch `feat/v2-paired-assets`):**
- `backend/src/evm/v2/pairTokens.js` — live resolver (`getPairTokens()`), 5-min cache + `refresh`,
  native first, never throws. Served via `/api/v2/configs`.
- ERC-20 launch flow (gated on `pairToken !== address(0)`; native path unchanged):
  - **Bundle buys:** each wallet signs `approve(curve, amountIn)` then the value-0 `buy`
    (approve → **the curve**, which pulls the pair token).
  - **Dev buy** via forwarder: `approve(forwarder, quoteIn)` on the pair token, and the launch
    tx `value` = **launchFee only** (not fee+devBuy).
  - Sizing from `erc20.balanceOf` in the pair token's decimals; exact-amount approvals (no
    infinite allowance).
  - `shared/bundleShare.js` is decimals-aware (correct for 6-dec USDG and 18-dec SPCX).

**Needs on-chain validation before real use:** the ERC-20 dev-buy gas fail-safe (`launchAndBuy`
can't be gas-estimated before the dev's `approve` is mined). Residual is non-catastrophic — an
ERC-20 buy to a not-yet-created curve is a value-0 no-op, no fund loss — but confirm on a small
launch first.

---

## 2. Holder fee sharing ("creator fees go to holders")

**Mechanism:** point a launched token's `creatorFeeRecipient` at a **per-token distributor**
contract. The token's creator-fee share then accrues (in the pair asset) to that distributor,
which splits it among holders. **This is a POST-LAUNCH operation** — the distributor cannot
exist until the token is a registered launch.

### The exact sequence (VERIFIED)

1. **Launch** with `creatorFeeRecipient = a wallet you control` **and `creatorTaxBps > 0`**
   (no creator tax ⇒ no fees ⇒ nothing to distribute).
2. **`createFor(address token)`** on the distributor factory `0x70e95CC5…`
   - selector `0xc0715888`, calldata `0xc0715888 || pad32(token)`
   - **permissionless** (any EOA may call — the operator can self-deploy)
   - **plain CREATE (not CREATE2)** → distributor address is **not predictable**; read it back
     from the `DistributorCreated(address indexed token, address distributor)` event, the call
     return, or the getter **`distributorOf(address token)`** (`0x3f20b9b4`)
   - reverts `DistributorAlreadyExists(existing)` (`0xef16401d`) if it already exists (the
     revert data carries the existing address), or `UnknownLaunch(token)` (`0x9dc35999`) if the
     token isn't a pons launch.
3. **`transferCreatorFeeRecipient(address token, address distributor)`** on the core factory
   `0x7eD598Bc…` — callable by the **current** `creatorFeeRecipient` (that's why step 1 uses a
   wallet you control); takes effect immediately.

After that: creator fees accrue in the pair asset to the distributor. Distribution is
**pull-based (INFERRED, impl unverified):** anyone calls `harvest()` (`0x4641257d`) to pull the
token's escrow-credited fees into the distributor; holders call `claim()` (`0x4e71d92d`) for
their pro-rata share; `release(address)` (`0x19165587`) is a PaymentSplitter-style payout.
Pons's announcement says fees are "pushed to wallets" — a push path could not be verified from
the unverified implementation; treat auto-push as unconfirmed.

### Caveats
- **Distributor impl + factory are not source-verified** — the deploy call is VERIFIED, but the
  claim/harvest interface is recovered from bytecode. Validate on-chain before relying on it.
- **Not deterministic** — always read the distributor address back after `createFor`.
- **Buyback is independent** — `buybackEnabled` is a separate creator-side toggle (buyback/burn),
  not holder distribution.
- Pons can upgrade the distributor implementation for all tokens (beacon owner).

---

## 3. Operator recipe — "SPCX-paired token + bundle, fees auto-shared to holders"

1. Launch (+ bundle) with `pairToken = SPCX 0x4a0E65A3…`, `creatorFeeRecipient = <your wallet>`,
   `creatorTaxBps = <non-zero>` (the % of trades taken as creator fee, paid in SPCX).
2. `createFor(token)` on `0x70e95CC5…`; read the distributor from `distributorOf(token)`.
3. `transferCreatorFeeRecipient(token, distributor)` on `0x7eD598Bc…` (as `<your wallet>`).
4. Fees accrue in **SPCX** to the distributor; `harvest()` + holders `claim()`.

Steps 2–3 are two cheap owner transactions after the launch confirms.
