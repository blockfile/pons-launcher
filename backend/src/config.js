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

  // pons v2 — a different protocol, not a newer factory. Deployed and verified
  // on chain, but launchEnabled was false and no pair token approved at the
  // time of writing, so every launchToken call reverts. The v2 routes exist so
  // the port is ready; they refuse loudly rather than burning a fee.
  v2FactoryAddress:
    lowerOrNull(process.env.PONS_V2_FACTORY) || '0x7e1eabd52ae29598e6483f72dcf1a70b14284db8',

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
  // 50ms against a 6ms read is ~320 sequential reads across a 16s block —
  // comfortably inside the rate limits, and it caps how late the bundle can
  // be to the tick. A competitor spamming a buy every block detects the tick
  // instantly, so this is the number that decides whether they are ahead.
  launchBlockPollMs: num(process.env.LAUNCH_BLOCK_POLL_MS, 50),
  launchBlockWaitMs: num(process.env.LAUNCH_BLOCK_WAIT_MS, 90000),

  keystorePassphrase: process.env.KEYSTORE_PASSPHRASE || null,
  keystorePath:
    process.env.KEYSTORE_PATH || path.join(__dirname, '..', 'data', 'wallets.keystore.json'),
  historyPath: process.env.HISTORY_PATH || path.join(__dirname, '..', 'data', 'launches.json'),
  // Beside the keystore: one users file for the whole deployment. Absent means
  // single-tenant, which is what every existing install is.
  usersPath: process.env.USERS_PATH || path.join(__dirname, '..', 'data', 'users.json'),

  apiKey: process.env.API_KEY || null,

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
