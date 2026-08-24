'use strict';

require('dotenv').config();

const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);

const DRY_RUN = bool(process.env.DRY_RUN, true);

const config = {
  dryRun: DRY_RUN,
  port: num(process.env.PORT, 3100),
  // Bind loopback by default — nginx is meant to be the only way in.
  host: process.env.HOST || '127.0.0.1',

  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  explorerUrl: (process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/$/, ''),

  // The live PonsLaunchFactory. Validated at boot (see evm/factory.validate).
  factoryAddress: lowerOrNull(process.env.FACTORY_ADDRESS) || '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
  // Normally read from the selected dex config; this only overrides it.
  swapRouterOverride: lowerOrNull(process.env.SWAP_ROUTER),

  // pons v2 — a different protocol, not a newer factory. LIVE: thousands of
  // launches, launchEnabled true, and canLaunch() true for ordinary wallets.
  //
  // This is NOT the address in docs.ponsfamily.com/v2, which points at a
  // superseded deployment that has never emitted an event. It was found by
  // scanning the chain for the TokenLaunched topic rather than trusting the
  // docs, so treat that page as unreliable for addresses.
  v2FactoryAddress:
    lowerOrNull(process.env.PONS_V2_FACTORY) || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',

  // The pons v2 holder-fee distributor FACTORY. Permissionless: createFor(token)
  // deploys a per-token distributor, and pointing the token's creatorFeeRecipient
  // at it (via the core factory's transferCreatorFeeRecipient) routes the
  // creator's cut of every trade to the token's holders instead of one wallet.
  // A non-secret on-chain constant, verified on Robinhood Chain; overridable only
  // so a redeployment does not need a code change. See evm/v2/holderFees.js.
  holderFeeFactory:
    lowerOrNull(process.env.HOLDER_FEE_FACTORY) || '0x70e95cc5f03db2906081e7a8d16e4c4209291507',

  // Optional Disperse contract (contracts/Disperse.sol). When set, funding
  // five or more wallets goes out as ONE transaction instead of N concurrent
  // broadcasts — the pattern that tripped the provider's rate limiter and
  // failed a whole sweep. Below five, individual sends are cheaper and are
  // used regardless.
  // One address, or several comma-separated. With several, a funding run is
  // split across them — so twenty wallets go out as three transactions rather
  // than one, which also isolates failures: a batch that reverts takes only its
  // own share down.
  disperserAddresses: (process.env.DISPERSER_ADDRESSES || process.env.DISPERSER_ADDRESS || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),

  // Relay.link solver funding. Used only by the pons v2 bundle funding path:
  // strict exact-output deposit orders send ETH to Relay, then a solver fills
  // the v2 bundle wallet on Robinhood Chain. The old /api/fund path does not
  // read this and v1 keeps its direct/disperser behaviour.
  relayApiUrl: (process.env.RELAY_API_URL || 'https://api.relay.link').replace(/\/$/, ''),

  // Relay API key (dashboard.relay.link → API keys). Sent as `x-api-key` on every
  // Relay request when set. Unauthenticated, the /quote endpoint rate-limits at
  // ~5-per-window per IP — shared across v2, v3 and every seasoning campaign, so
  // a many-wallet run trips it. A key lifts /quote to 50/min (10/s on request),
  // which is why the pacing knobs above can be relaxed once this is set. Null =
  // anonymous, the old behaviour.
  relayApiKey: process.env.RELAY_API_KEY || null,

  // Pacing for the v2 bundle-funding quote requests to Relay. Measured against
  // the live API from the server: ~5 quotes land, then HTTP 429 "Could not
  // process request. Please try again later.", and hammering while blocked keeps
  // it blocked. That per-IP budget is shared with the seasoning campaigns and v3.
  // So quotes go out `batchSize` at a time (1 = strictly serial) with `gapMs`
  // between them, and a 429 is met with a long `backoffMs` (growing per attempt,
  // up to `retries` times) to wait the window out rather than re-arm it. TIMING
  // KNOBS ONLY — never the amounts, the deposits, or their order. Raise the gap /
  // backoff if a large run (or busy campaigns) still trips it; lower them if
  // Relay ever gives this IP more headroom.
  relayQuoteBatchSize: Math.max(1, num(process.env.RELAY_QUOTE_BATCH_SIZE, 1)),
  relayQuoteGapMs: Math.max(0, num(process.env.RELAY_QUOTE_GAP_MS, 4000)),
  relayQuoteRetries: Math.max(0, num(process.env.RELAY_QUOTE_RETRIES, 5)),
  relayQuote429BackoffMs: Math.max(0, num(process.env.RELAY_QUOTE_BACKOFF_MS, 20000)),

  // ethers' tx.wait() polls every 4s by default, which is forty blocks on this
  // chain. v2 reads the curve address out of the launch receipt, so that delay
  // would sit squarely in the critical path — poll for it directly instead.
  receiptPollMs: num(process.env.RECEIPT_POLL_MS, 50),
  receiptTimeoutMs: num(process.env.RECEIPT_TIMEOUT_MS, 120000),

  // Multicall3, at its standard address on this chain. Used only to read the
  // EVM's own block.number, which advances every ~16s and is what every launch
  // restriction is measured against — the RPC's block height is not.
  multicallAddress:
    lowerOrNull(process.env.MULTICALL_ADDRESS) || '0xca11bde05977b3631167028862be2a173976ca11',
  // A bundle must NOT land in the launch block: the token blocks every
  // pool-to-user buy there except the factory's own atomic one. So the buys
  // wait for block.number to tick past the launch, then fire instantly.
  waitForLaunchBlock: bool(process.env.WAIT_FOR_LAUNCH_BLOCK, true),
  // How often to ask whether it has ticked, and how long to keep asking.
  //
  // This is now a true cadence: the reads overlap, so the interval is the whole
  // period rather than the period minus a round trip (see bundle/blockwait.js).
  // 25ms is ~640 reads across a full 16s block and ~320 across the average
  // wait — the same budget the old 50ms sequential poll was already spending,
  // because that one could not issue a read until the previous had answered.
  //
  // Lower is better for the race and worse for the rate limiter, and which one
  // binds depends entirely on the round trip from the box this runs on:
  // `npm run latency` measures it and says which.
  launchBlockPollMs: num(process.env.LAUNCH_BLOCK_POLL_MS, 25),
  launchBlockWaitMs: num(process.env.LAUNCH_BLOCK_WAIT_MS, 90000),

  keystorePassphrase: process.env.KEYSTORE_PASSPHRASE || null,
  keystorePath:
    process.env.KEYSTORE_PATH || path.join(__dirname, '..', 'data', 'wallets.keystore.json'),
  historyPath: process.env.HISTORY_PATH || path.join(__dirname, '..', 'data', 'launches.json'),

  // How many DELETED wallets the recovery archive keeps, per user, across every
  // tab — see the header on MAX_ARCHIVED in wallets/keystore.js, which is the
  // only place that reads this. Past it, the oldest deleted key is destroyed to
  // make room, and there is no role filter: deleting V4 seed wallets in bulk
  // can evict an archived v1 dev key. 100 was chosen when a keystore held tens
  // of wallets; a deployment running V4 discards them by the hundred. The only
  // cost of raising it is disk.
  archiveMax: num(process.env.ARCHIVE_MAX, 100),
  // Beside the keystore: one users file for the whole deployment. Absent means
  // single-tenant, which is what every existing install is.
  usersPath: process.env.USERS_PATH || path.join(__dirname, '..', 'data', 'users.json'),

  apiKey: process.env.API_KEY || null,

  // Who may read another user's activity log. Comma-separated user ids, the
  // same ids `npm run user:list` prints. Empty — the default — means nobody is
  // an admin and every log stays private, which is what every existing install
  // gets on upgrade.
  //
  // GRANTED HERE AND NOWHERE ELSE. There is deliberately no route that adds an
  // admin, because admin status that could be set over the API would be
  // reachable with a stolen key: one compromised account would promote itself
  // and then read every other user's addresses, amounts and key-export
  // history. Changing this list means editing the environment and restarting
  // the process — a step that needs the box, not a credential.
  adminUsers: (process.env.ADMIN_USERS || '')
    .split(',')
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean),

  // ponsfamily's own IPFS uploader — the same endpoint their /launchpad/create
  // form posts to, so our tokens carry the same kind of ipfs:// logo as a
  // launch made from their site. Undocumented, hence configurable.
  ipfsUploadUrl:
    process.env.PONS_IPFS_UPLOAD_URL ||
    'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/image',
  // Read-side gateway, used only to preview the pinned image in the console.
  ipfsGatewayUrl: (process.env.IPFS_GATEWAY_URL || 'https://gateway.pinata.cloud/ipfs/').replace(
    /\/?$/,
    '/'
  ),
  // The pons worker allowlists Origin — a server-side fetch sends none and is
  // refused with 403. We are pinning a logo for a token launched on their own
  // launchpad, so we present their site's origin, as their form does.
  ipfsUploadOrigin: process.env.PONS_IPFS_ORIGIN || 'https://www.ponsfamily.com',

  // Native ETH left in a bundle wallet when it buys with its "entire balance",
  // so it can still pay for the buy's own gas.
  gasBufferEth: num(process.env.GAS_BUFFER_ETH, 0.0004),
  // Bundle buys are signed BEFORE the pool exists, so they cannot be estimated
  // against a live pool — this limit is used instead.
  buyGasLimit: num(process.env.BUY_GAS_LIMIT, 400000),

  // A V4 seed wallet is claimable by V1/V3 once it has been funded and has aged
  // at least this many hours — the "done seasoning" gate. 24h by default.
  seasonedMinHours: num(process.env.SEASONED_MIN_HOURS, 24),

  // ── pons "ETH-zap" bundle buys ────────────────────────────────────────────
  // Pons's own swap-zap endpoint. For a curve priced in a NON-ETH pair token,
  // a bundle wallet holding only ETH can still buy in one transaction: the zap
  // routes ETH → pair → curve.buy, with the taker (the wallet itself) as the
  // recipient, so the snipe-tax exemption still applies. No auth. The route
  // bakes recipient=taker and carries a ~6-minute deadline and calls curve.buy,
  // so a quote can only be fetched AFTER the launch confirms — see
  // evm/v2/zeroexSwap.js and the ethZap branch of bundle/fireV2.js.
  zapUrl: process.env.PONS_ZAP_URL || 'https://www.ponsfamily.com/api/zeroex-swap',
  // Slippage tolerance for a zap buy, in basis points. 3% by default. A whole
  // bundle buys the SAME fresh, thin curve within a block or two, and every buy
  // that lands ahead of another pushes the curve price up — so a wallet's quote
  // (minus slippage) can be undercut by its own bundle-mates and revert with
  // InsufficientOutput. A live 20-wallet launch reverted 7 buys at 1% on a ~0.65%
  // self-competition move; 3% absorbs that with margin. The cost of the wider
  // tolerance is only on the ETH→pair leg (a sandwich could take up to this much);
  // for a launch bundle a filled buy is worth far more than shaving basis points.
  // Raise it further if a thin curve still reverts; lower it if pair-leg slippage
  // matters more than fill certainty for a given launch.
  zapSlippageBps: num(process.env.PONS_ZAP_SLIPPAGE_BPS, 300),
  // How many zap buys may be in flight at once. The pons zap endpoint THROTTLES
  // concurrent quotes — ~20 at once returns HTTP 409 "No price right now." for
  // most of them (a live launch skipped 12 of 20 this way), while the same
  // requests spaced out succeed. Keep this low so quotes are served, and so the
  // buys spread across blocks rather than all racing into one (which is what
  // drives the self-competition slippage above). Not a tax concern: the bundle
  // wallets are exempt whenever they land, so spreading them costs nothing there.
  zapSendConcurrency: num(process.env.PONS_ZAP_SEND_CONCURRENCY, 3),
  // A throttled quote (409 / "No price right now." / "No route") is retried with
  // exponential backoff rather than skipped — the route already exists (fireZap
  // waited for it), the endpoint is just busy. Attempts include the first try.
  zapQuoteMaxAttempts: num(process.env.PONS_ZAP_QUOTE_MAX_ATTEMPTS, 5),
  zapQuoteBackoffMs: num(process.env.PONS_ZAP_QUOTE_BACKOFF_MS, 500),
  // Gas limit for a zap buy. Higher than a plain curve.buy (buyGasLimit) because
  // the zap is a multi-hop settle: ETH → pair → curve.buy in one call. Unused gas
  // is refunded, so this is deliberately generous — the only cost of over-reserving
  // is that a wallet buying its "entire balance" holds a little more ETH back for
  // gas. Raise it if a live zap ever runs out of gas.
  zapBuyGasLimit: num(process.env.PONS_ZAP_BUY_GAS_LIMIT, 900000),
  // How long fireZap waits for the aggregator to index a freshly-launched curve
  // before quoting the buys. A brand-new curve is not routable for a beat or two
  // after the launch confirms; without this wait every buy answers "No route for
  // that pair" and is lost, as a live launch showed. 45s covers the observed
  // indexing lag with margin; the zap route's own ~6-min deadline is the ceiling.
  zapRouteTimeoutMs: num(process.env.PONS_ZAP_ROUTE_TIMEOUT_MS, 45000),

  // The deployed EthToSpcxSwap router (contracts/EthToSpcxSwap.sol) — the address
  // printed by `node scripts/deploy-contract.js EthToSpcxSwap --broadcast`. Lets
  // each bundle wallet swap its OWN ETH→SPCX in preflight, so the dev wallet never
  // transfers SPCX to the bundle (no on-chain dev→buyers link). Empty until
  // deployed; the swap-to-pair route refuses with a clear message when unset.
  ethToSpcxSwap: lowerOrNull(process.env.ETH_TO_SPCX_SWAP_ADDRESS),
  // The SPCX token the router swaps to — hardcoded in the contract, mirrored here
  // so the route can reject a launch paired against anything else (the router only
  // ever outputs this token).
  spcxToken: (process.env.SPCX_TOKEN || '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa').toLowerCase(),
  // Gas limit for one ETH→SPCX swap through the router (wrap-free native settle +
  // one V4 hop). Generous; unused gas is refunded.
  pairSwapGasLimit: num(process.env.PAIR_SWAP_GAS_LIMIT, 500000),
  // Slippage floor for the auto-swap, in bps. The pool is thin and pons-managed,
  // so this protects each wallet's ETH→SPCX leg; a swap that would fill worse than
  // this reverts (ETH kept, only gas lost) rather than dumping into a bad price.
  // NB this is RELATIVE to the simulated quote — it guards against the price
  // MOVING between simulate and mine, not against a bad STANDING price; that is
  // what pairSwapMinSpcxPerEth below is for.
  pairSwapSlippageBps: num(process.env.PAIR_SWAP_SLIPPAGE_BPS, 300),
  // Optional absolute floor on the auto-swap rate, in whole SPCX per 1 ETH. 0
  // disables it (the default) — the dry-run preview shows the expected SPCX per
  // wallet, which is the primary guard against a thin/mispriced pool. Set it (env
  // PAIR_SWAP_MIN_SPCX_PER_ETH) to hard-refuse any wallet the pool would fill
  // below that rate, rather than dumping ETH for dust.
  pairSwapMinSpcxPerEth: num(process.env.PAIR_SWAP_MIN_SPCX_PER_ETH, 0),
};

/**
 * Fail fast on a configuration that cannot safely send funds. Called at boot;
 * DRY_RUN deployments are allowed to be incomplete so the console still runs.
 */
function assertLiveReady() {
  const problems = [];
  if (!config.keystorePassphrase) problems.push('KEYSTORE_PASSPHRASE is required when DRY_RUN=false');
  // Once users exist, each one carries their own key and API_KEY is unused —
  // demanding it would force a live deployment to set a variable nothing reads.
  if (!config.apiKey && !require('./users/users').enabled()) {
    problems.push('API_KEY is required when DRY_RUN=false (or create users with `npm run user:add`)');
  }
  if (problems.length) throw new Error(problems.join('; '));
}

module.exports = config;
module.exports.assertLiveReady = assertLiveReady;
