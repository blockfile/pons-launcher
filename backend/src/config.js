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
