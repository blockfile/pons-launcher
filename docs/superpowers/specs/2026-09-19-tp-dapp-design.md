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

### A: risks the operator accepts, and where the build departs from the text above

Signed off by the operator with the v2 plan, before the first real save.

- **A phished pair of signatures opens the saved keys.** The unlock message is fixed,
  so any site can ask a wallet to sign it. A phishing copy of dapp.rhbond.xyz that gets
  a visitor to sign it AND one login challenge (which the phisher fetches live from this
  server) can download that visitor's ciphertext and decrypt every saved bundle key.
  MetaMask warns when a sign-in message names another domain, but it does not block the
  signature, and other wallets may not warn at all. An nginx password in front of the
  dApp would not remove this risk (the phishing page asks for the same signatures), and
  it cannot keep wallets across refreshes unless the server holds the keys, which is the
  dropped private mode. The console keeps its nginx basic auth unchanged.
- **The unlock message is frozen once anyone saves.** Its text, the HKDF salt and info
  and the AES-GCM additional data are golden-tested: one changed byte (a new domain, a
  CRLF, the em dash above) silently changes every user's key. Its form (shaped like a
  sign-in message, so MetaMask warns on another domain, or plain text) is final after
  the first save.
- **Lockout.** A wallet that stops signing deterministically (an MPC or smart-contract
  wallet, a wallet update) or is lost takes the saved list with it; the server cannot
  help. The saved list is a convenience copy: the console's key exports stay the backup.
- Already accepted under decision 1: an XSS, a malicious extension or a compromised
  dependency can USE the cached key while it is cached (12 h), and the server remains
  the root of trust for the page's code.
- **The build departs from the text above in four places:** the cookie is
  `__Host-tp_session` with `Path=/` (the `__Host-` prefix requires it, and it is what
  stops the sibling hosts from tossing a cookie); concurrency is on an integer `rev`, not
  `updatedAt`; a public `keyId` (HKDF of the same signature) replaces the AES "check"
  value; and the unlock message is ASCII, without the em dash.
- **A saved list can be damaged, not destroyed.** Anyone holding a session for an
  address (a phished sign-in signature included) can overwrite or delete its list, so:
  a save under another key is refused with no override, and starting over is Delete;
  the list's `.prev` keeps the copy from before the latest session began saving,
  however many times that session saves; a Delete keeps the deleted list, still
  encrypted, for 30 days (`TP_VAULT_KEEP_DELETED_DAYS`; only the first deletion in that
  window) so the operator can restore it by hand, and it signs the address out
  everywhere. Do not tidy these away: they are the recovery path. Two phished sign-ins,
  one after the other, can still push the owner's copy out of `.prev`; a Delete cannot
  lose it.

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

## E. What the v2 build decided, and what it accepts (approved by Ivan 2026-09-19)

**Encrypted account, or an nginx login?** The encrypted account, on the dApp only. An
nginx password decides who may reach a server; it stores nothing, so it could fix
"wallets vanish on refresh" only if the server kept the keys: the private mode that was
dropped, and it would make the droplet a readable store of every visitor's keys. The
account keeps ciphertext the server cannot decrypt, follows the visitor to another
device, and keeps the dApp public. The console hosts (rhbond.xyz, api.rhbond.xyz) keep
their nginx basic auth unchanged: that server holds keys that spend.

**Accepted risk: a phished unlock signature opens the saved wallets.** The saved copy's
key comes from the visitor's wallet signing ONE fixed message. Whoever gets a visitor to
sign that message AND one sign-in message can sign in as that visitor, download the
ciphertext and decrypt every saved bundle key. A phishing copy of dapp.rhbond.xyz can
ask for both: it can fetch a real sign-in challenge from this server for any address.
MetaMask warns when a sign-in message names another site than the one asking (the unlock
message is SIWE-shaped for exactly that), but it does not block, and other wallets may
not warn at all. Decision 1's accepted risks (an XSS, an extension, a compromised
dependency) cover the keys while the page is open; this one covers the saved copy while
the page is closed. It is accepted on the same footing: bundle wallets are trading
wallets, the unlock message itself says "Only sign it on https://dapp.rhbond.xyz", and
saving is optional: a visitor who never connects keeps v1's behaviour, and v1's
passphrase vault on the device stays available. Ivan accepted this risk on 2026-09-19.

**Frozen forever: the unlock message.** Once anyone has saved, one changed byte (a word,
the domain, a CRLF from an editor) derives a different key for every visitor and locks
them out of their saved wallets; the server cannot help. The message, for the EIP-55
test address (frontend/src/dapp/account/messages.test.js pins the same SHA-256,
2cd970a7...a10f, and backend/src/tp/spec.test.js checks this block against it):

```text unlock-message
dapp.rhbond.xyz wants you to sign in with your Ethereum account:
0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed

Unlock the wallets you saved on rhbond take-profit. This signature never leaves your browser: it is the key to your saved wallets. Only sign it on https://dapp.rhbond.xyz.

URI: https://dapp.rhbond.xyz/vault
Version: 1
Chain ID: 4663
Nonce: vaultkeyv1
Issued At: 2026-09-19T00:00:00Z
```

The alternative, open only until the first real save: a plain-text message (no wallet
warns about it on any site). After the first save, neither can change.

**Other accepted risks.** While a key is cached (12 h, non-extractable), an XSS or an
extension can USE it, not copy it. A stolen session can overwrite or delete the saved
copy but not read it, and it cannot destroy it: the server keeps the copy from before
that session began saving (`.prev`) and a deleted copy for 30 days, for a hand restore
(Addendum A, as built). A wallet that changes how it signs, or is lost, locks its saved
copy for good: the console's export files stay the real backup. The server is still
the root of trust: it serves the page's code.

**Decisions for sign-off.** Approved by Ivan on 2026-09-19 as listed, with 18 and 19
changed by him. Each is one named constant or line to change back.

Account (backend/src/tp/account.js, vaultStore.js; frontend/src/dapp/account/):
1. The session cookie is `__Host-tp_session; Path=/`, not `Path=/api/tp/account`: the `__Host-` prefix requires `Path=/`, and that prefix is what stops the same-site console hosts from tossing a cookie at the dApp.
2. Saves are ordered by an integer `rev`, not by `updatedAt` (two saves in one millisecond cannot collide).
3. A public `keyId` (HKDF of the same signature) replaces the spec's AES "check" value: the server refuses a write under another key without being able to decrypt anything.
4. The sign-in message expires with its nonce (5 min); the 24 h is the cookie's. The server builds the message; the page signs only a byte-identical rebuild of it.
5. The server canonicalises signatures (high-s, v 0/1) instead of `ethers.verifyMessage`, which refuses them.
6. Deleting the saved copy signs that account out on EVERY device (the page then offers Connect).
7. The account API answers on the dApp host only; the console host answers 404.
8. The unlock message is SIWE-shaped with a fixed nonce (above). Irreversible after the first save.
9. Lock and Disconnect also take the account's wallets and their %-left marks out of the tab, after a last save; otherwise "locked" would still sign.
10. Delete saved copy sits behind a typed DELETE; it is the only way out of a copy made under another key.
11. The routes are the server's: `POST /api/tp/account/nonce` (answer `{nonce, message, issuedAt, expirationTime}`), `POST /login`, `POST /logout`, `GET /me`, `GET/PUT/DELETE /vault`. backend/src/tp/accountContract.json pins them for both sides.

Positions and wallets (frontend/src/dapp/ui/):
12. One positions book: the book the %-left bars draw from is the one the encrypted copy saves, its four record fields unchanged. A wallet a device first sees before its account copy has arrived (a new device, a page opened before its unlock) takes the copy's start and the higher of the two marks, so every device shows the same bar.
13. The high-water mark resets when a wallet is seen empty and then holding again: a new position starts at 100 % (C above said a pure high-water mark).
14. Positions and the pair ledger stay on the device only with "Remember on this device" (their entries can be linked to the wallets), and in the account whenever it is unlocked. After a passphrase vault moves into the account, the pair ledger (unconverted pair proceeds) is memory-only again: the proceeds stay in the wallets, but a reload no longer offers Convert for them.
15. A row's own 25 / 50 / 100 sells that wallet whether or not it is ticked; a row whose wallet still needs its approval stays off until it is ticked (ticking arms it).
16. Every 20 s the listed rows are re-read; once a minute the same read also looks at up to 100 imported wallets that are not listed, and one that bought since is listed, ticked and armed, as Refresh would do, with a toast.
17. The rows' value is shown in ETH and in USD (a token-quoted pair through the pair to ETH rate).

Token header (backend/src/tp/tokenInfo.js, logo.js, safeFetch.js, cid.js; frontend/src/dapp/ui/TokenHeader.jsx):
18. Logos over 3 MiB become identicons; `TP_LOGO_MAX_BYTES` sets the cap, at most 5 MiB. (Ivan's change: the plan proposed 1 MiB, which turned about 15 % of real pons logos into identicons.)
19. Logos on non-IPFS https hosts (about 21 %) are FETCHED, through an SSRF-safe GET (backend/src/tp/safeFetch.js): https only, port 443 only, no userinfo, a DNS name (no IP literal); the name is resolved and every address it resolves to must be public (loopback, private, link-local, CGNAT, multicast, unspecified, reserved, IPv4-mapped and other IPv4-carrying IPv6 forms, ULA and the cloud metadata addresses are refused); the connection goes to the vetted address (the lookup is pinned: no second one) with the name as SNI and Host; at most 2 redirects, each hop vetted again; 5 s in all; the same size cap and magic-byte rule (PNG, JPEG, GIF or WebP, never SVG). They are cached like IPFS logos but never immutable: a day, on the server and in browsers. (Ivan's change: the plan proposed identicons for them.)
20. The first logo gateway is ponsfamily's own, undocumented worker; its 451 (moderated) is final. Filebase and Pinata follow; `TP_LOGO_GATEWAYS` changes the list.
21. Pool liquidity is the quote side only (a v1 position is not full-range, so doubling the quote side would be a wrong number).
22. v1 tokens say "launched before 2026-08-12" instead of a looked-up launch time (a whole-chain getLogs is refused or throttled).
23. Where the page's own maths covers a figure (curve progress, a graduated pool's liquidity), the live mark wins over the server's figures.

**Also built** (from the whole-plan review's fixes; each follows from the decisions above and is one clearly marked spot to change):
- A save under another key is refused with no override (there is no `rekey`); starting over is Delete. A list's `.prev` keeps the copy from before the latest session began saving, however often that session saves. A Delete keeps the deleted list, still encrypted, for `TP_VAULT_KEEP_DELETED_DAYS` (30) days, the first deletion only, for a hand restore (README "Take-profit dApp").
- Every vault disk call is async and writes go one at a time (the store's write lane): a save never stalls a sell on the one pm2 process.
- The wallet list merges as an add-wins set with no clock in it: a removal on another device takes out only the imports it had seen, so a skewed clock can never drop a key from a live tab.
- Saves are paced (a 5 s debounce, at most one scheduled save per 10 s, never later than 30 s) to stay well under the server's 30 writes a minute per account; a 429's Retry-After is honoured, and `rate_limited` / `unavailable` are retried.
- A wallet removed by another device, or by Lock / Disconnect, leaves the table at once through `session.removeRows`; one with a sell in flight keeps counting until it settles. The session is never reset from the sync.
- Lock, Disconnect and Switch first wait (up to 60 s, new sells paused, with Keep unlocked) for what the tab still has to sign, and ask before stranding pair proceeds; the teardown runs every step even when one fails, and a failure is shown, not swallowed.
- `GET /token` waits for the mark alone (it is the sell click's fallback); the header's info may arrive on the page's re-read.
- A dag-pb logo (not hash-checked against its CID) is cached a day, not a year; only a raw CID's bytes are immutable.
- One social host table on both sides; `discordapp.com` links are sent as `discord.com`.

Before announcing the account (a check, not a decision): with each of MetaMask, Rabby,
OKX and the Coinbase extension, on the real host, does it sign the same message the same
way twice, sign a Chain ID 4663 sign-in without that chain added, and inject under
`script-src 'self'`? A wallet that fails any of these is refused safely: the passphrase
vault remains.
