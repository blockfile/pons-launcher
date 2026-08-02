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

## Layout

```
backend/    Express API, EVM layer, encrypted keystore, bundle engine  (Node, CommonJS)
frontend/   React 19 + Vite console                                    (ESM)
deploy/     nginx
docs/       design spec
```

npm workspaces, so one `npm install` at the root covers both.

In **development** the Vite server on `:5173` serves the console and proxies
`/api` to the backend on `:3100`. In **production** `npm run build` emits
`frontend/dist` and the backend serves it — one origin, one nginx block, no
CORS.

## Quick start

```bash
npm install                  # installs both workspaces
cp backend/.env.example backend/.env
# set KEYSTORE_PASSPHRASE (required to store any wallet) and API_KEY

npm run dev                  # API :3100 + Vite console :5173, together
npm test                     # backend tests
```

Production build:

```bash
npm run build                # frontend/dist
npm start                    # backend serves the built console on :3100
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
| `PONS_IPFS_UPLOAD_URL` | `pons-vercel-…/public/ipfs/image` | Where token logos are pinned. Undocumented third-party endpoint |
| `IPFS_GATEWAY_URL` | `https://gateway.pinata.cloud/ipfs/` | Read-side gateway, used only for the console preview |
| `PONS_IPFS_ORIGIN` | `https://www.ponsfamily.com` | Origin header for IPFS worker requests; required by their server |
| `KEYSTORE_PASSPHRASE` | *(none)* | Encrypts the keystore. **Lose it and the keys are gone** |
| `API_KEY` | *(none)* | Required on every mutating route |
| `GAS_BUFFER_ETH` | `0.0004` | Left behind when a wallet buys with its entire balance |
| `BUY_GAS_LIMIT` | `400000` | Bundle buys are signed before the pool exists, so they can't be estimated |
| `DISPERSER_ADDRESSES` | *(none)* | One or more deployed `Disperse.sol`, comma-separated. Funding batches through them at five recipients or more |

### Dispersing through contracts

Funding twenty wallets one transfer at a time is twenty concurrent broadcasts —
the exact shape that tripped the provider's rate limiter and failed a whole
sweep. Deploy [`contracts/Disperse.sol`](contracts/Disperse.sol) and set
`DISPERSER_ADDRESSES`, and a funding run goes out as batched calls instead.

    npm run deploy -- Disperse 3               # compiles and prices it
    npm run deploy -- Disperse 3 --broadcast   # …and deploys

Nothing is sent without `--broadcast`. The three copies come out of the dev
wallet's next three nonces, cost about 0.000009 ETH each, and the script prints
the line to paste into `.env`:

    DISPERSER_ADDRESSES=0xAAA…,0xBBB…,0xCCC…

Twenty wallets then become three transactions rather than one, in contiguous
chunks of 7/7/6. Still far below the concurrency that caused trouble, and a
batch that reverts takes down only its own share — the rest are already mined,
so the retry knows exactly who missed out. Below five recipients the batch is
skipped entirely: measured on this chain, three recipients through a multisend
cost 68,847 gas against 63,585 sent individually.

The contract has no owner, so who deploys it grants no control over it — but the
deployer is recorded on-chain forever, and every run through it is a public link
from that address to the wallets it paid. Pass `--key 0x…` to deploy from
somewhere other than the dev wallet.

## Multiple operators

By default the deployment is single-tenant: one keystore, one dev wallet,
shared by anyone who can log in.

Create users and each gets their own wallets, funding and history, invisible to
the others:

    npm run user:add -- alice          # prints the key once — save it
    npm run user:add -- ivan --adopt   # …and takes over the existing wallets
    npm run user:list
    npm run user:remove -- alice

The key IS the identity, so each user needs their own. Map each nginx login to
their key (see `deploy/nginx-rhbond.conf`) and nobody has to type one.

There is no admin: no account can read another's wallets or keys. Recovery of a
lost key means shell access to the server, not a support request.

## API

```
GET    /api/health              dry-run flag, chain, factory
GET    /api/configs             launch + dex configs and launchFee, read live
POST   /api/logo                raw PNG/JPEG/WebP body → pins to IPFS, returns { uri }
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
npm install                                        # both workspaces
npm run build                                      # frontend/dist
cp backend/.env.example backend/.env && $EDITOR backend/.env   # DRY_RUN=false, passphrase, API key
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
