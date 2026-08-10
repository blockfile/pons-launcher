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
 * The factory's own record for a launched token. THE AUTHORITY ON WHO LAUNCHED
 * IT, and the v1 counterpart of v2's getLaunchedToken — the sell path gates on
 * this and nothing else.
 *
 * Deliberately NOT the token's own deployer()/launchFactory() getters: those are
 * self-reported, and a dusted ERC-20 can claim whatever it likes about itself.
 * Approving a contract is the whole dusting attack (see evm/v2/holdings.js), so
 * provenance has to come from a contract we already trust.
 *
 * `exists` false means the factory has never heard of it, which is reason enough
 * to refuse. Shaped like the v2 record so the picker can treat the two alike.
 */
async function describeToken(token, runner) {
  const address = getAddress(token);
  const rec = await factory(runner).getLaunchedToken(address);
  if (!rec.exists) return { token: address, protocol: 'v1', exists: false };
  return {
    token: address,
    protocol: 'v1',
    deployer: getAddress(rec.deployer),
    // The pool this token actually launched into, per token. Preferred over the
    // launch/dex config, which can be edited by the factory owner after the
    // fact — the record cannot.
    pairToken: getAddress(rec.pairedToken),
    poolFee: Number(rec.poolFee),
    dexId: Number(rec.dexId),
    launchConfigId: Number(rec.launchConfigId),
    restrictionsEndBlock: rec.restrictionsEndBlock,
    isToken0: Boolean(rec.isToken0),
    exists: true,
  };
}

/** One dex config, without paying for every other one. */
async function getDexConfig(id) {
  const d = await factory().getDexConfig(Number(id));
  return {
    id: Number(id),
    name: d.name,
    factory: String(d.factory).toLowerCase(),
    positionManager: String(d.positionManager).toLowerCase(),
    swapRouter: String(d.swapRouter).toLowerCase(),
    poolFee: Number(d.poolFee),
    tickSpacing: Number(d.tickSpacing),
    enabled: Boolean(d.enabled),
  };
}

/** One launch config, without paying for every other one. */
async function getLaunchConfig(id) {
  const c = await factory().getLaunchConfig(Number(id));
  return {
    id: Number(id),
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
  };
}

/**
 * The two configs a sell needs, read from the ids the launch record itself
 * carries rather than from whatever the console currently has selected. A dex
 * config that has since been disabled is still the one this token trades
 * through, so `enabled` is not checked here — refusing to sell a token because
 * its dex was later switched off would strand it.
 */
async function sellRoute(record) {
  const [dexConfig, launchConfig] = await Promise.all([
    getDexConfig(record.dexId),
    getLaunchConfig(record.launchConfigId),
  ]);
  return { dexConfig, launchConfig };
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
  getDexConfig,
  getLaunchConfig,
  describeToken,
  sellRoute,
  predictTokenAddress,
  buildLaunchTx,
  validate,
};
