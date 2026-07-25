# pons-launcher

**Launch a token on the ponsfamily.com launchpad with the team's buys in first.**

The launch transaction carries an **atomic dev buy**. Up to ~25 pre-funded
bundle wallets buy immediately behind it, with every buy signed *before* the
launch goes out.

```
1. WALLETS   generate or import a dev wallet + bundle wallets  (encrypted at rest)
2. FUND      dev wallet → disperse ETH to the bundle wallets
3. LAUNCH    launchToken{value: launchFee + devBuy}   ← atomic, uncapped, unfront-runnable
               → blast N pre-signed buys              ← same block or the next one
4. SWEEP     leftover ETH back to the dev wallet
```

This does not reimplement the launchpad. It calls ponsfamily's own
`PonsLaunchFactory`, so the token deploys, pools and locks exactly as it does
from their site.

## Why snipers can't beat the dev buy

`PonsLaunchFactory.launchToken` is payable, and its own doc comment reads
*"Atomically deploys, pools, locks, records, and optionally buys a token."*
Everything above `launchFee` becomes `initialBuyAmount` and is swapped **inside
the same transaction**.

So there is no race to win. The pool does not exist until that transaction
runs, and your buy is the first swap in it.

**A private RPC would not help and is not needed.** Private mempools protect a
*pending* transaction from being front-run; an atomic buy has no such window.
Robinhood Chain is sequencer-ordered with no public mempool anyway — bots there
react to the pool-creation event, which is emitted *after* your buy already
happened.

## Why the bundle wallets still matter

During the restriction window the token caps **pool→user buys per address**:

| Live config (read 2026-07-25) | |
|---|---|
| max wallet | 500 bps = **5%** of supply |
| cumulative buy cap | 550 bps = **5.5%** of supply |
| restriction window | **2 blocks** |
| exempt | `initialBuyRecipient`, launch block only |

Your atomic dev buy is the *only* thing exempt from those caps. Everyone
else — snipers included — is limited to ~5% each, and each fresh wallet carries
its own allowance. That is what the bundle is for.

Note how short the window is: **2 blocks**. After that it is unrestricted, so
landing in block 0 or 1 is the whole game. That's why buys are pre-signed
rather than built after the launch confirms.

## Quick start

```bash
npm install
cp .env.example .env         # DRY_RUN=true by default — nothing is broadcast
# set KEYSTORE_PASSPHRASE (required to store any wallet) and API_KEY
npm start                    # http://127.0.0.1:3100
npm test
```

Work through the console top to bottom: generate wallets → enter fund amounts →
**Disperse** → fill the launch form → **Preflight** → **LAUNCH + BUNDLE**.

**Preflight signs the entire bundle and broadcasts nothing.** It is a full
rehearsal: it verifies balances, estimates gas and resolves the exact token
address the launch will produce. Run it before every real launch.

## Going live

1. Import the dev wallet you intend to launch from and fund it.
2. Generate bundle wallets, enter fund amounts, **Disperse**.
3. `DRY_RUN=false`, set `KEYSTORE_PASSPHRASE` and `API_KEY`, restart.
4. **Preflight** and read the plan — predicted token address, per-wallet
   amounts, and any warnings about skipped wallets.
5. **LAUNCH + BUNDLE**, then check `sameBlock` in the result: how many buys
   landed in the launch block itself.

The launch must be sent **directly by your dev wallet**. The factory records
`deployer = msg.sender`, and only the deployer can later claim creator fees —
route it through a helper contract and [ponscat](https://github.com/blockfile/ponscat)
could never claim them.

## Config

| Env | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | Simulates everything; broadcasts nothing |
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Keep the host on loopback in production |
| `RPC_URL` / `CHAIN_ID` | RH mainnet / `4663` | |
| `FACTORY_ADDRESS` | `0xA5aA…51feB` | The live factory, validated at boot |
| `SWAP_ROUTER` | *(auto)* | Override only — normally read from the dex config |
| `KEYSTORE_PASSPHRASE` | *(none)* | Encrypts the keystore. **Lose it and the keys are gone** |
| `API_KEY` | *(none)* | Required on every mutating route |
| `GAS_BUFFER_ETH` | `0.0004` | Left behind when a wallet buys with its entire balance |
| `BUY_GAS_LIMIT` | `400000` | Bundle buys are signed before the pool exists, so they can't be estimated |

## API

```
GET    /api/health              dry-run flag, chain, factory
GET    /api/configs             launch + dex configs and launchFee, read live
GET    /api/wallets             addresses, roles, balances (never keys)
POST   /api/wallets/generate    { count, label, role }
POST   /api/wallets/import      { privateKeys[], label, role }
DELETE /api/wallets/:id
POST   /api/wallets/export      { id, confirm: true } — logged
POST   /api/fund                { targets: [{ walletId, amountEth }] }
POST   /api/sweep               { includeTokens?, tokenAddress? }
POST   /api/preflight           signs the bundle, sends nothing
POST   /api/launch              prepare + fire
GET    /api/launches            history
```

Signed transactions never leave the server — a raw signed buy could be
broadcast by anyone holding it.

## Security

The box is internet-reachable, so treat it that way:

- Keys are AES-256-GCM encrypted with a scrypt-derived key; the keystore file
  is written `0600` and a wrong passphrase **fails closed**
- `API_KEY` on every mutating route; the app binds `127.0.0.1`
- `deploy/nginx.conf` adds TLS + basic auth and is the only way in
- `DRY_RUN=false` refuses to start without `KEYSTORE_PASSPHRASE` and `API_KEY`
- `data/` and `.env` are gitignored — **never commit the keystore**

## Deploy (Ubuntu)

```bash
git clone https://github.com/blockfile/pons-launcher.git && cd pons-launcher
npm install --omit=dev
cp .env.example .env && $EDITOR .env      # DRY_RUN=false, passphrase, API key
pm2 start ecosystem.config.js && pm2 save
sudo cp deploy/nginx.conf /etc/nginx/sites-available/pons-launcher
sudo ln -s /etc/nginx/sites-available/pons-launcher /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Verified on-chain

Checked against the live contracts on 2026-07-25, not assumed:

- `launchToken` buys atomically from `msg.value - launchFee`
- live factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (four older
  deployments are stale; fallback `0x966ffA3957a6d3621D3EfC96E22160806f0EF141`)
- launch fee `0.0005 ETH`; pair token WETH; pool fee 1%; `routerRequiresDeadline
  = false`, so the Router02 shape is used
- `predictTokenAddress` is deterministic per salt — confirmed live, and it is
  what makes pre-signing possible
