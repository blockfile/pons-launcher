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

  keystorePassphrase: process.env.KEYSTORE_PASSPHRASE || null,
  keystorePath:
    process.env.KEYSTORE_PATH || path.join(__dirname, '..', 'data', 'wallets.keystore.json'),
  historyPath: process.env.HISTORY_PATH || path.join(__dirname, '..', 'data', 'launches.json'),

  apiKey: process.env.API_KEY || null,

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
  if (!config.apiKey) problems.push('API_KEY is required when DRY_RUN=false');
  if (problems.length) throw new Error(problems.join('; '));
}

module.exports = config;
module.exports.assertLiveReady = assertLiveReady;
