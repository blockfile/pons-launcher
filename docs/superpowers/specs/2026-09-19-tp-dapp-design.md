# Take-profit dApp (dapp.rhbond.xyz) — design

**Date:** 2026-09-19
**Project:** pons-launcher
**Status:** approved by the operator ("go start"), public mode only
**Research:** the five-lens research run of 2026-09-19 (sell paths, chart data, UX,
stack, speed/custody) plus its critic. Facts below marked *(measured)* were probed on
the live chain or read from the repo by that run.

A public take-profit page. A visitor pastes a pons token's contract address (CA),
imports their bundle wallets, watches a live candle chart and sells a percentage from
every selected wallet with one click — the GMGN / Maestro sell panel, for bundles.

## Decisions

All made by the operator. Where one carries a risk, the risk is written next to it so a
later reader does not "fix" a deliberate choice.

1. **Public, keys in the visitor's browser.** No password on dapp.rhbond.xyz. Anyone can
   use it with their own wallets. The browser holds the keys and signs; **the server
   never receives a private key**, and the dApp's backend module cannot reach the
   console keystore. A private "server holds the keys" mode was designed and **dropped
   at the operator's request** — do not add it back without asking.
   *Accepted risk:* while the page is open the keys are in browser memory. A malicious
   extension, an XSS, or a compromised npm dependency can take them. Mitigations below
   (strict CSP, no third-party scripts, pinned deps, keys never rendered). The page
   tells the visitor to use trading wallets and a clean browser profile.
2. **Pons tokens only**, first version: pons v2 bonding curve (ETH-quoted and
   token-quoted, e.g. AMZN), pons v2 graduated (Uniswap v4 pool with the pons meme
   hook), pons v1 (Uniswap v3 1% pool). **Any genuine pons token**, not only ours:
   genuineness is the pons factory's own registry (`getLaunchedToken(ca).exists`).
   Everything else is refused — never a generic "approve the router and swap", which is
   exactly the dusting attack the sell-all spec closed.
3. **Wallet import**: paste keys (one per line), or upload the console's own export
   files — XLSX (`Public address | Private key`), the JSON backups, CSV. Parsed in the
   browser. Each key must derive its row's address when an address is given. Held in
   memory; an optional **"Remember on this device"** stores them encrypted with a
   passphrase (WebCrypto AES-GCM, PBKDF2-SHA256 600k iterations) in localStorage.
4. **Slippage setting** (a %, default 15). Each wallet's sell carries a minimum-out; a
   sell that would fill worse reverts instead. The minimum for each wallet accounts for
   the wallets sent ahead of it in the same click, so the tail does not revert just
   because the head moved the price.
5. **One click sells. Always.** Preset chips 25 / 30 / 50 / 75 / 100 (editable, saved in
   the browser) and a custom %. Pressing a chip sells immediately — no second button, no
   dialog, including 100%. *Accepted risk:* a mis-click is a real sell. No hotkeys in
   this version.
6. **Approve once on load.** When a token and wallets are loaded, each wallet approves
   its **current balance** once (graduated tokens: token→Permit2 exact, Permit2→router
   bounded to the balance with a 24 h expiry). Every later % click is then one
   transaction per wallet. If a wallet's balance grows past its allowance, it is topped
   up automatically on the next load. This departs from sell-all's "exact approval per
   sell" — deliberately, for speed.
7. **Token-quoted proceeds become ETH.** A sell of an AMZN-paired (or other stock-token
   paired) curve pays out in the pair token; the dApp then swaps that to ETH in the
   same wallet automatically (the V3 route: pair → USDG → WETH → unwrap), with the
   impact guard.
8. **Proceeds stay in each wallet.** Nothing is transferred anywhere. There is no
   transfer, sweep or withdraw feature on this page.
9. **Live chart from the chain.** Our backend indexes the token's trades itself and
   builds 1-second candles. No paid data provider.
10. **Stack:** TradingView Lightweight Charts, framer-motion, react-icons. three.js only
   as a lazy-loaded scene on the empty "paste a CA" screen, unmounted the moment a token
   opens — it must never run while selling.

## What the research established (and the design leans on)

- Robinhood Chain orders transactions first-come-first-served; `eth_maxPriorityFeePerGas`
  is 0 *(measured)*. Paying more gas does not sell faster. Only latency counts, so the
  click path does **no chain reads**: all state is warm before the click.
- Blocks every ~100 ms, timestamps in whole seconds *(measured)*: 1 s is the finest real
  candle.
- Signing in the browser costs no measurable time over signing on the server
  *(measured: ~1 ms/tx; browser→droplet ≈ browser→sequencer)*.
- Trade events, confirmed live *(measured)*:
  - pons v2 curve: `CurveBuy` / `CurveSell` emitted **by the curve contract**
    (topic0 `0xec36bf57…c455` / `0x8113d738…59df`). Not in the repo ABI. Data words:
    buy `[quoteIn, tokensOut, fee, 0]`, sell `[tokensIn, quoteOut, fee, 0]`; the two
    indexed addresses are the trader. Word names inferred from samples.
  - graduated pons v2: PoolManager `0x8366a39C…0951` `Swap`, **always filtered on
    topic1 = poolId** (the manager carries ~1,200 swaps per 300 blocks unfiltered).
    currency0 = quote, currency1 = token. The `sender` is the router, not the wallet.
  - pons v1: the Uniswap v3 pool's `Swap`.
- RPC limits *(measured)*: QuickNode refuses `eth_getLogs` over 10k blocks (~17 min);
  concurrent getLogs degrade badly (8 concurrent: 16 s vs 0.3 s each), so backfill is
  sequential. The public RPC returns `blockTimestamp = 0x0` in logs, so trade blocks
  need a (cached) header lookup. The public RPC has no WSS; QuickNode advertises WSS but
  it is **untested on the operator's endpoint** — the design works without it.
- The hook `0xe5e7…e044` the config seeds as a letscash "legit hook" is actually the
  **pons v2 factory's `memeHook()`** *(measured)*. The resolver reads the pons factory,
  never the letscash hook list.
- Express serves the console SPA and every `/api` route to **any Host header**
  (`server.js:47-49,77-95`) *(read)*. A wholesale proxy of the new hostname would expose
  the key-export routes. Both nginx and the server must gate the new host.

## Architecture

```
browser (dapp.rhbond.xyz)                          backend (same pm2 process)
─────────────────────────                          ──────────────────────────
keys (memory / encrypted vault)                    src/tp/  (public, no keystore)
chain/ builders + curve math + nonces    ──HTTP──▶ routes/tp.js  /api/tp/*
sign locally (ethers Wallet)             ◀──SSE─── stream: candles, trades, mark,
POST signed raw txs ───────────────────────────▶   receipts
                                                   broadcast → QuickNode (+ sequencer)
                                                   indexer → own provider (chart only)
```

### Where the code lives

- **Frontend:** a second Vite entry in the existing workspace.
  `frontend/dapp/index.html` + `frontend/src/dapp/**`, built by the same
  `npm run build` into `dist/dapp/`. The dApp owns all its modules (tab-isolation rule)
  and may import the shared `frontend/src/components/*`. It has its own `api.js`; it
  imports nothing from the console's `api.js` (which carries the console API key).
- **Backend:** `backend/src/tp/**` + `backend/src/routes/tp.js`, mounted at `/api/tp`,
  **before** the console's auth-gated routers and **without** `requireApiKey`.
  `src/tp/**` must not require `wallets/keystore`, `users/`, or any other tab's route
  module — a test enforces it. Code it needs from other tabs (the pons factory ABI,
  curve maths, poolswap, swaproute) is **copied** into `src/tp/`, per the isolation rule.
- **Serving:** a host gate in `server.js`, placed before `express.static` (line 49):
  requests whose host is `DAPP_HOST` (default `dapp.rhbond.xyz`) get `dist/dapp/**`
  and `/api/tp/**` only; every other `/api` path answers 404 for that host. Defence in
  depth — nginx enforces the same allowlist.
- **One process.** The dApp shares the pm2 process (`ecosystem.config.js` forbids a
  second one). It holds no keys, so it cannot collide with the console's nonces — but
  its chart traffic uses **its own RPC provider**, never the console's send path.

### Frontend units (`frontend/src/dapp/`)

| Unit | Does | Depends on |
|---|---|---|
| `keys/parseImport.js` | text / XLSX / JSON / CSV → `[{address, privateKey}]`; validates each key; reports rejects by row, never echoing a key | `keys/xlsxRead.js`, ethers |
| `keys/xlsxRead.js` | minimal XLSX reader: ZIP central directory; stored and deflated entries (`DecompressionStream('deflate-raw')`); shared and inline strings | — |
| `keys/vault.js` | optional encrypted persistence (AES-GCM, PBKDF2 600k) in localStorage; wipe | WebCrypto |
| `keys/walletStore.js` | the in-memory key store (module closure). UI reads **addresses only**; signing goes through `sign(address, tx)` | ethers |
| `chain/venue.js` | venue constants and pinned addresses (factories, SwapRouter02, Permit2, V4 router, PoolManager, USDG, WETH) | — |
| `chain/curveMath.js` | exact pons v2 curve sell quote from reserves (parity-tested against `backend/src/evm/v2/holdings.js quoteSellOut`) | — |
| `chain/build.js` | calldata for approve, curve sell, v4 sell (Permit2 + router), v1 sell (SwapRouter02 multicall), pair→ETH route; pure | ethers Interface |
| `chain/plan.js` | a click → per-wallet `{amount, minOut, tx}`: amount = floor(balance × pct / 100) (exact balance at 100 %), sequential min-out across wallets, optimistic balance | `curveMath`, `build` |
| `chain/nonces.js` | local nonce counter per wallet; resync on a nonce error | — |
| `api.js` | `/api/tp/*` client; SSE via `fetch` + ReadableStream; request bodies built from an allowlist of fields | — |
| `ui/…` | TokenBar, Chart, TradesFeed, SellPanel, WalletTable, ImportDialog, EmptyScene (lazy three.js) | the above, lightweight-charts, framer-motion, react-icons |

### Backend units (`backend/src/tp/`)

| Unit | Does |
|---|---|
| `venue.js` | CA → `{kind: 'curve' \| 'graduated' \| 'v1', token, curve?, poolId?, pool?, pairToken, pairDecimals, decimals, symbol, name, totalSupply}` via one Multicall3 read of both pons factories + `getCode`. Provenance cached forever; **phase re-read** on every state refresh (a token can graduate between clicks). Anything not in a pons factory → refused with a reason. |
| `state.js` | per-token mark state (curve `getReserves`, pool `slot0` + liquidity), refreshed on every indexed trade; fee params (base fee, priority 0); wallet reads for ≤ 100 addresses via Multicall3 (token balance, ETH balance, allowance to the spender the venue needs, pending nonce). Addresses are public data; no key ever arrives here. |
| `quote.js` | batch sell quotes for graduated and v1 pools (V4 Quoter / QuoterV2, with the probe-vs-full impact guard copied from `evm/v3/poolswap.js`), and the pair→ETH route quote (copied from `evm/v3/swaproute.js`). |
| `indexer.js` | per-token trade indexer. Backfill the last 1 h first (sequential 10k-block windows), then extend to 24 h in the background. Live: poll `getLogs` from `lastBlock+1` every 400 ms (WSS `eth_subscribe` used when the endpoint supports it; probed at start-up). Dedup on `(txHash, logIndex)`. Timestamps from a block→ts LRU. Normalised trade `{ts, block, logIndex, side, tokenAmt, quoteAmt, price, trader, tx}`. 1 s candles in a columnar ring; 15 s / 1 m / 5 m / 1 h folded on request. Ref-counted by open streams; stops 5 min after the last viewer; at most `TP_MAX_TOKENS` (default 30) tokens indexed at once. Detects graduation and switches the event source without a gap. Uses its **own** provider. |
| `stream.js` | `GET /api/tp/stream?token=` — SSE: a snapshot (venue, bars for the requested interval, recent trades, mark), then batched deltas every 200 ms (trades, bar updates, mark, receipts), heartbeat every 15 s. `X-Accel-Buffering: no`. |
| `broadcast.js` | `POST /api/tp/broadcast {token, txs: [raw…]}` — each raw tx is decoded and **validated before sending**: chainId 4663; `to` and function selector in the allowlist for that token's venue (the token's `approve`, the curve's `sell`, Permit2 `approve`, the V4 router's `execute`, SwapRouter02 `multicall`, the pair token's `approve`); at most 100 per request. All sent concurrently (QuickNode, and the sequencer endpoint too if configured — a duplicate send is harmless). Returns hashes at once; receipts are watched and pushed on the token's stream. |
| `limits.js` | per-IP token buckets with no new dependency: streams (5 open), reads (120/min), broadcast (300 tx/min). |

Routes (`routes/tp.js`, all public, all JSON):
`GET /api/tp/token/:ca` · `POST /api/tp/wallets {token, addresses}` ·
`POST /api/tp/quote {token, sells:[{address, amount}]}` · `GET /api/tp/stream` ·
`POST /api/tp/broadcast` · `POST /api/tp/quote/pair {pairToken, amount}`.

## The flows

**Open a token.** Paste CA → `GET /token/:ca` → venue badge (curve / graduated / v1, and
the pair token) or a refusal with the reason. The stream opens; the chart paints the
last hour immediately and fills to 24 h behind it.

**Load wallets.** Import → addresses (only) → `POST /wallets` → the table lists wallets
**holding the token**, ticked by default, with token balance, % of supply, value, ETH
for gas. Wallets without enough ETH for a sell are flagged and skipped with the reason.
Then **arm**: every ticked wallet whose allowance is below its balance signs its
approval(s) locally → `/broadcast`. The row shows *arming → ready*. Selling is enabled
per wallet once its approval has landed.

**Click 50 %.** No chain read. For each ready, ticked wallet, in a fixed order:
amount = floor(optimisticBalance × 50 / 100); expected out from the warm state —
curve: exact curve maths applied **sequentially** across the wallets; graduated / v1: the
quote cache (refreshed every 2 s while the panel is open, fetched on the click only if
older); minOut = expected × (1 − slippage). Build, sign with the local nonce, POST every
signed tx in one `/broadcast`. Optimistic balances drop at once; rows go *sent* with a tx
link. Receipts arrive on the stream: *landed (+x ETH, block, ms)* / *reverted (reason:
price moved more than the slippage)* / *failed*. A second click during the first uses the
optimistic balance, so two fast 50 % clicks sell 75 %, never 100 %.

**Token-quoted pair.** When a curve sell lands with pair-token proceeds, the browser
builds `approve(pair → SwapRouter02, proceeds)` + the route swap to ETH (min-out from
`/quote/pair`, impact guard) at consecutive nonces and broadcasts both. The row shows
the second leg.

**Graduation mid-session.** The stream announces the phase change. The venue switches;
wallets re-arm for the new spender automatically; the chart continues from the pool's
events.

## Look

The console's Cell & Caret language (dApp-owned copy of the tokens), GMGN layout:
CA bar on top; chart left (~65 %), Trades | Wallets tabs under it; sell panel right
(~360 px): position header (tokens held across ticked wallets, value, % supply), preset
chips + custom %, slippage, one-line preview ("50 % ≈ 0.84 ETH"). Mobile: one column
with a sticky bottom sell bar. Candle colours are their own hues, not the console's
vermilion/jade (those mean irreversible / done). Chart shows market cap in USD by
default, toggle to price in ETH; timeframes 1s / 15s / 1m / 5m / 1h; own sells marked.
Series updates go through a ref (`series.update`), never React state, so a burst of
trades cannot re-render the sell panel. Custom `priceFormat` (meme prices are ~1e-9).
TradingView attribution kept. framer-motion animates only status rows and toasts —
nothing sits between a click and the network call.

## Security

- **nginx** `dapp.rhbond.xyz` block: HTTPS (certbot expand), HTTP/2, HSTS, no basic auth;
  `location /api/tp/` proxied (the stream location with `proxy_buffering off`,
  `proxy_read_timeout 1h`); every other `/api/` → 404; `limit_req` on `/api/tp/`.
  Headers: `Content-Security-Policy: default-src 'self'; script-src 'self';
  connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Frame-Options DENY`,
  `Referrer-Policy no-referrer`, `X-Content-Type-Options nosniff`.
- **Server host gate** mirrors the nginx allowlist (a mis-edited nginx file must not
  expose the console).
- **Keys:** never rendered, never logged, never in React state or props, never sent.
  `api.js` builds bodies from a field allowlist; a test asserts no request body can
  carry a key-shaped value. Import errors name the row, not the key.
- **Token names and symbols** from a pasted CA are attacker-controlled: rendered as React
  text only; no chart label renders HTML; no remote logos.
- **Dependencies:** pinned by the lockfile, bundled (no CDN), no analytics, no
  third-party scripts.
- **Broadcast proxy** accepts only transactions to the allowlisted contracts and
  selectors for the named token — it is not a general relay.
- The page states plainly: this signs with your keys in your browser; use trading
  wallets; a browser extension can read this page.

## Error handling

- Nonce too low / already known → resync that wallet's nonce from `/wallets`, re-sign
  once, resend; a second failure marks the row failed.
- Not enough ETH for gas → flagged before the click, skipped with the reason.
- Revert on min-out → "price moved more than 15 %", the row keeps its balance.
- Indexer RPC errors → the chart shows "catching up" and retries with backoff; selling
  is unaffected (separate provider).
- A figure that cannot be computed (e.g. USD while the ETH price is unavailable) shows
  nothing plus a reason — never a wrong number (launcher-eth-pair-unit-bugs).

## Testing

- **Unit (`node --test`):** import parsers (stored + deflated XLSX, JSON backups, CSV,
  pasted text; fixtures generated from throwaway keys at test time); curve maths parity
  with the backend's `quoteSellOut`; sequential min-out; optimistic balance and two fast
  clicks; nonce manager; calldata builders (golden selectors); candle folding and the
  1 s ring; SSE framing; broadcast validator (chainId, allowlist, selector, count);
  host gate; `src/tp/**` never requires the keystore; `api.js` never sends a key.
- **Live, on a local Anvil fork of chain 4663** (see memory `local-fork-smoke-test`):
  throwaway wallets buy a real pons curve token and a graduated one; the dApp served
  by a backend pointed at the fork; Playwright imports the wallets, loads, sells 25 %,
  50 % and 100 %; balances and ETH received checked on-chain.
- **Size budget:** the dApp's first load (without the lazy three.js chunk) stays under
  250 KB gzipped.

## Out of scope (this version)

Private server-key mode (dropped); letscash and flap tokens; buying; automatic TP/SL
orders; hotkeys; per-wallet PnL / cost basis; transfers or sweeps; paid chart data.

## Deploy

DNS is in place (`dapp` A record → the droplet). Then: add the nginx block,
`sudo nginx -t && sudo systemctl reload nginx`,
`sudo certbot --nginx --cert-name rhbond.xyz -d rhbond.xyz -d www.rhbond.xyz -d api.rhbond.xyz -d dapp.rhbond.xyz`,
enable HTTP/2 on the new 443 listen; `git pull`, `npm ci` (new frontend deps),
`npm run build`, `pm2 restart` (new backend routes).

---

# Addendum v2 (2026-09-19, after the operator used v1)

Operator feedback on the first build: wallets vanish on refresh; choosing which wallets
sell is not obvious; holdings should be live with a %-left bar; the token needs its
info and logo. Decisions below are the operator's.

## A. Account: connect a wallet, bundles synced encrypted

- **Connect wallet** with any injected browser wallet (EIP-6963 discovery, fallback
  `window.ethereum`): MetaMask, Rabby, OKX, Coinbase extension. No WalletConnect (it
  needs third-party connections the CSP forbids).
- **Login**: a Sign-In-With-Ethereum (EIP-4361) message — domain = the page's host,
  chain id 4663, a single-use server nonce (5 min), expiry 24 h. The server verifies it
  (`ethers.verifyMessage`, domain must equal `DAPP_HOST`, nonce unused) and sets an
  httpOnly, Secure, SameSite=Strict session cookie scoped to `/api/tp/account`.
- **Encryption key**: a SECOND, fixed message ("rhbond take-profit — unlock my saved
  wallets", naming the domain, the account and a version) signed with `personal_sign`.
  The signature → HKDF-SHA256 → AES-GCM-256 key, derived **in the browser**. That
  signature is **never sent to the server**. A stored key-check (AES-GCM of a constant)
  detects a wallet whose signatures are not deterministic (smart-contract / passkey
  wallets): such a wallet is told it cannot be used for saving, and the old
  passphrase vault remains as the fallback.
- **Sync**: the ciphertext blob `{v:2, address, check, wallets, positions}` is stored on
  the server under the connected address (`GET/PUT/DELETE /api/tp/account/vault`,
  optimistic concurrency on `updatedAt`, ≤ 256 KB). **The server stores only ciphertext
  it cannot decrypt**; decision 1's rule "the server never receives a private key"
  still holds — plaintext keys never leave the browser.
- **Staying unlocked**: after unlock the derived key is kept as a **non-extractable**
  WebCrypto key in IndexedDB with a 12 h expiry, so refreshes and new tabs do not ask
  again; a **Lock** button and Disconnect wipe it. (Browsers cannot report "browser
  closed", hence the fixed expiry.)
- Imports, removals and position records save to the account automatically. A visitor
  who does not connect keeps today's behaviour (memory only), with a banner offering to
  connect. A v1 passphrase vault found on the device is offered for moving into the
  account.

## B. Choosing wallets

Clear per-row checkboxes with All / None / Invert; the top % chips sell from the ticked
wallets only. Every row also gets its own **25 / 50 / 100** buttons that sell that one
wallet (same one-click rules, same slippage, same planning).

## C. Live holdings with a %-left bar

Each row shows live: tokens held, value (ETH and USD), % of supply, and a **bar of the
position left**: 100 % when the wallet is first seen holding this token, falling as it
sells (25 % then 50 % → 37.5 %). The starting size is a high-water mark (a later buy
raises it) and is saved in the account's encrypted `positions`. In-flight sells show as
a striped segment until they land. Balances refresh from receipts at once and by a
periodic read while the token is open; values move with the live price.

## D. Token info

A token header: logo, name, symbol, CA with copy, venue badge, price (ETH and USD),
market cap, 5 m / 1 h / 24 h change, 24 h volume, curve progress to graduation (curves) or
liquidity (pools), age, creator, description (collapsible) and social links (X,
Telegram, Discord, website, Farcaster) — https links only, `rel="noopener noreferrer"`,
rendered as text/icons, never HTML. The **logo is fetched by the server**
(`GET /api/tp/logo/:ca`) from IPFS gateways only (no arbitrary hosts — SSRF), capped at
1 MB, PNG/JPEG/GIF/WebP by magic bytes (never SVG), cached, and served from the page's
own origin so the CSP stays `img-src 'self' data:`. No logo → a generated identicon.
