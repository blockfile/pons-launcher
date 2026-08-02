'use strict';

// Client side of PonsV2BundleHelper (contracts/PonsV2BundleHelper.sol).
//
// With the helper deployed, a v2 bundle goes back to being pre-signed and
// optimistic, the way v1's was:
//
//   read nextEpoch()  →  pre-sign buy(epoch, minOut) from every wallet
//   →  broadcast arm(...)  →  broadcast the buys immediately
//
// No receipt round trip, so the buys can land in the launch block. An early
// arrival reverts on NotArmed instead of paying ETH into a codeless address,
// which is the failure that makes naive v2 pre-signing unsafe.

const { Contract, getAddress } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');
const { TOKEN_PARAMS_V2 } = require('./abi');

const HELPER_ABI = [
  `function arm(${TOKEN_PARAMS_V2} params, uint256 launchConfigId, address pairToken) payable returns (uint256 epoch, address token, address curve)`,
  'function buy(uint256 epoch, uint256 minTokensOut) payable returns (uint256 tokensOut)',
  'function nextEpoch() view returns (uint256)',
  'function curveOf(uint256 epoch) view returns (address)',
  'function tokenOf(uint256 epoch) view returns (address)',
  'function owner() view returns (address)',
  'function factory() view returns (address)',
  'event Armed(uint256 indexed epoch, address indexed token, address indexed curve)',
];

function helper(runner = provider) {
  if (!config.v2HelperAddress) throw new Error('PONS_V2_HELPER is not set');
  return new Contract(config.v2HelperAddress, HELPER_ABI, runner);
}

/** The epoch the next arm() will use — what the pre-signed buys must reference. */
async function nextEpoch() {
  return helper().nextEpoch();
}

/** Sanity-check a deployed helper before trusting a launch to it. */
async function describe() {
  const h = helper();
  const [owner, factoryAddr, epoch] = await Promise.all([h.owner(), h.factory(), h.nextEpoch()]);
  return {
    address: config.v2HelperAddress,
    owner: getAddress(owner),
    factory: getAddress(factoryAddr),
    // The helper is the factory's msg.sender, so the whitelist applies to IT.
    factoryMatches: getAddress(factoryAddr).toLowerCase() === config.v2FactoryAddress.toLowerCase(),
    nextEpoch: epoch.toString(),
  };
}

/** Unsigned arm() — the launch, routed through the helper so it records the curve. */
async function buildArmTx({ params, launchConfigId, pairToken, value }) {
  return helper().arm.populateTransaction(params, launchConfigId, getAddress(pairToken), { value });
}

/** Unsigned buy() against an epoch. Signable before the launch exists. */
async function buildBuyTx({ epoch, amountIn, minTokensOut = 0n }) {
  return helper().buy.populateTransaction(epoch, minTokensOut, { value: amountIn });
}

module.exports = { HELPER_ABI, helper, nextEpoch, describe, buildArmTx, buildBuyTx };
