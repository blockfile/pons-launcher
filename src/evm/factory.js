'use strict';

// Reads and writes against ponsfamily.com's PonsLaunchFactory. We do not
// reimplement the launchpad — launchToken deploys, pools, locks and (with
// excess msg.value) buys atomically, exactly as it does from their site.

const { Contract, getAddress, ZeroAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { FACTORY_ABI } = require('./abi');

function factory(signerOrProvider) {
  return new Contract(config.factoryAddress, FACTORY_ABI, signerOrProvider || provider);
}

/**
 * Normalise a form payload into the positional TokenParams tuple. Missing
 * socials become empty strings; a blank feeWallet becomes the zero address,
 * which makes the launching wallet the initial-buy recipient.
 */
function toTokenParams(input = {}) {
  const s = input.socials || {};
  const str = (v) => (v == null ? '' : String(v));
  return {
    name: str(input.name),
    symbol: str(input.symbol),
    logo: str(input.logo),
    description: str(input.description),
    socials: {
      twitter: str(s.twitter),
      telegram: str(s.telegram),
      discord: str(s.discord),
      website: str(s.website),
      farcaster: str(s.farcaster),
    },
    feeWallet: input.feeWallet ? getAddress(input.feeWallet) : ZeroAddress,
  };
}

/** Every enabled launch config and dex config, plus the current launch fee. */
async function getConfigs() {
  const f = factory();
  const [launchCount, dexCount, launchFee] = await Promise.all([
    f.launchConfigCount(),
    f.dexConfigCount(),
    f.launchFee(),
  ]);

  const launchConfigs = [];
  for (let i = 0; i < Number(launchCount); i++) {
    const c = await f.getLaunchConfig(i);
    launchConfigs.push({
      id: i,
      pairToken: String(c.pairToken).toLowerCase(),
      graduationThreshold: c.graduationThreshold.toString(),
      initialTick: Number(c.initialTick),
      supply: c.supply.toString(),
      maxWalletBps: Number(c.maxWalletBps),
      maxTxBps: Number(c.maxTxBps),
      restrictionBlocks: Number(c.restrictionBlocks),
      reservedFee: Number(c.reservedFee),
      enabled: Boolean(c.enabled),
      routerRequiresDeadline: Boolean(c.routerRequiresDeadline),
    });
  }

  const dexConfigs = [];
  for (let i = 0; i < Number(dexCount); i++) {
    const d = await f.getDexConfig(i);
    dexConfigs.push({
      id: i,
      name: d.name,
      factory: String(d.factory).toLowerCase(),
      positionManager: String(d.positionManager).toLowerCase(),
      swapRouter: String(d.swapRouter).toLowerCase(),
      poolFee: Number(d.poolFee),
      tickSpacing: Number(d.tickSpacing),
      enabled: Boolean(d.enabled),
    });
  }

  return { launchFee: launchFee.toString(), launchConfigs, dexConfigs };
}

/**
 * The token address this launch WILL have — known before the launch exists,
 * which is what lets every bundle buy be signed in advance.
 */
async function predictTokenAddress({ params, launchConfigId, dexId, salt, deployer }) {
  const address = await factory().predictTokenAddress(
    toTokenParams(params),
    launchConfigId,
    dexId,
    salt,
    deployer
  );
  return getAddress(address);
}

/** The unsigned launchToken transaction. `value` must be launchFee + devBuy. */
async function buildLaunchTx({ params, launchConfigId, dexId, salt, value }) {
  return factory().launchToken.populateTransaction(
    toTokenParams(params),
    launchConfigId,
    dexId,
    salt,
    { value }
  );
}

/**
 * Boot check: confirm the configured address really is a live factory. Factory
 * deployments rotate (five are verified on-chain) and claiming against a dead
 * one fails in confusing ways, so fail loudly at startup instead.
 */
async function validate() {
  const code = await provider.getCode(config.factoryAddress);
  if (!code || code === '0x') {
    throw new Error(`FACTORY_ADDRESS ${config.factoryAddress} has no contract code on chain ${config.chainId}`);
  }
  const { launchFee, launchConfigs, dexConfigs } = await getConfigs();
  if (!launchConfigs.some((c) => c.enabled)) throw new Error('factory has no enabled launch config');
  if (!dexConfigs.some((d) => d.enabled)) throw new Error('factory has no enabled dex config');
  return { launchFee, launchConfigs: launchConfigs.length, dexConfigs: dexConfigs.length };
}

module.exports = {
  factory,
  toTokenParams,
  getConfigs,
  predictTokenAddress,
  buildLaunchTx,
  validate,
};
