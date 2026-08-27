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

  // V3's chain runner retries a rate-limited Relay QUOTE (pre-broadcast, so safe)
  // rather than halting the run for a manual resume. Shorter than the v2 funding
  // backoff above because a V3 cycle is ~7s and a 20s stall per blip would bunch
  // the buys: exponential from 2s (2s, 4s, 8s, 16s) over up to 4 retries, then
  // halt if Relay is still refusing. See v3/relay.js transfer().
  v3RelayQuoteRetries: Math.max(0, num(process.env.V3_RELAY_QUOTE_RETRIES, 4)),
  v3RelayQuoteBackoffMs: Math.max(0, num(process.env.V3_RELAY_QUOTE_BACKOFF_MS, 2000)),
  // v6 (letscash relay chain) — its own quote retry/backoff, mirroring v3's.
  v6RelayQuoteRetries: Math.max(0, num(process.env.V6_RELAY_QUOTE_RETRIES, 4)),
  v6RelayQuoteBackoffMs: Math.max(0, num(process.env.V6_RELAY_QUOTE_BACKOFF_MS, 2000)),

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

  // ── v5: letscash.fun (CashCat) launchpad, on this same chain (4663) ─────────
  // A Uniswap-V4 launchpad: a launch mints a fixed-supply token and seeds one
  // locked V4 pool with the whole supply; trades are V4 swaps priced in ETH or
  // USDG, and the CashCatHookV2 skims the tax off the quote side. All addresses
  // verified on-chain (see the letscash-contract-map notes); overridable by env
  // so a redeployment needs no code change. NO snipe-tax exemption exists — the
  // launch's atomic firstBuyIn is the only guaranteed-first entry.
  letscash: {
    factory: (process.env.LETSCASH_FACTORY || '0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661').toLowerCase(),
    // Block the factory was deployed at, so a TokenLaunched provenance lookup
    // (factory.findLaunch — v6's dusting guard) can bound its getLogs range. 0 scans
    // from genesis, splitting any window the node refuses; set
    // LETSCASH_FACTORY_DEPLOY_BLOCK once known to make it a single fast call.
    factoryDeployBlock: num(process.env.LETSCASH_FACTORY_DEPLOY_BLOCK, 0),
    hook: (process.env.LETSCASH_HOOK || '0x75A54357D9C78a2Db19004a5FDc76c50F9242AEC').toLowerCase(),
    // v6's FAST dusting guard (replaces the getLogs launch scan on the hot path): a real
    // letscash token is an EIP-1167 minimal-proxy CLONE of a factory `tokenMaster`, so
    // eth_getCode(token) → its implementation must be one of these. Seeded with the live
    // moduleSetId-0 tokenMaster; the factory's module sets are read on a TTL to absorb any
    // new one. Comma-separated, env-overridable.
    tokenMasters: (process.env.LETSCASH_TOKEN_MASTERS || '0xd6Da7f07eE822C8538C901217b37D1e7d86c76E5')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // The pool hooks the probe is restricted to (with config.hook). ALL are factory-gated:
    // their beforeInitialize reverts NotFactory for a non-factory sender, so an outsider
    // can't stand up a look-alike pool under any of them (verified). Seeding the known
    // historical hooks (0xEfe6 CashCatHook / CRYINGCAT-era, 0xe5e7 V2MemeHook) besides the
    // live 0x75A5 means genuine tokens under a retired config resolve on the FAST probe
    // instead of falling through to the slow launch scan. Extended from the factory on a TTL.
    legitHooks: (process.env.LETSCASH_LEGIT_HOOKS ||
      '0xEfe669814e5Eec33406Bd50ffa8331618D076aEc,0xe5e702641ea86f4ae6cc3cdaed2b886f976be044')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    poolManager: (process.env.LETSCASH_POOL_MANAGER || '0x8366a39CC670B4001A1121B8F6A443A643e40951').toLowerCase(),
    universalRouter: (process.env.LETSCASH_UNIVERSAL_ROUTER || '0x8876789976deCBFcbbBe364623c63652DB8c0904').toLowerCase(),
    quoter: (process.env.LETSCASH_QUOTER || '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94').toLowerCase(),
    stateView: (process.env.LETSCASH_STATE_VIEW || '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b').toLowerCase(),
    permit2: (process.env.LETSCASH_PERMIT2 || '0x000000000022D473030F116dDEE9F6B43aC78BA3').toLowerCase(),
    usdg: (process.env.LETSCASH_USDG || '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168').toLowerCase(),
    // The V4 pool shape every letscash launch uses (verified: fee 0, tickSpacing
    // 200; currency0 = the quote, ETH sentinel 0x0 or USDG; currency1 = token).
    poolFee: num(process.env.LETSCASH_POOL_FEE, 0),
    tickSpacing: num(process.env.LETSCASH_TICK_SPACING, 200),
    // The factory's flat launch fee, on top of firstBuyIn (0.0005 ETH observed).
    launchFeeEth: process.env.LETSCASH_LAUNCH_FEE_ETH || '0.0005',
  },
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
