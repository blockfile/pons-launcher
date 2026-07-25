'use strict';

// Builds the bundle buys. These deliberately mirror the factory's own
// _executeInitialBuy: same router, same pair token, same pool fee, native
// value in, amountOutMinimum 0 — so a bundle buy behaves exactly like the
// atomic dev buy, one transaction later.

const { Contract } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { SWAP_ROUTER_V3_ABI, SWAP_ROUTER_02_ABI } = require('./abi');

/**
 * The router to use for a launch. Read from the selected dex config, exactly
 * as the factory does; SWAP_ROUTER only overrides it.
 * @param {object} dexConfig from factory.getConfigs()
 * @param {object} launchConfig from factory.getConfigs()
 */
function routerFor(dexConfig, launchConfig, signerOrProvider) {
  const address = config.swapRouterOverride || dexConfig.swapRouter;
  const abi = launchConfig.routerRequiresDeadline ? SWAP_ROUTER_V3_ABI : SWAP_ROUTER_02_ABI;
  return new Contract(address, abi, signerOrProvider || provider);
}

/**
 * An unsigned native-ETH → token buy.
 *
 * amountOutMinimum is 0 by design. The transaction is signed BEFORE the pool
 * exists, so there is no price to quote a slippage bound against — and the
 * factory's own initial buy passes 0 for the same reason. The launch-window
 * per-address cap is what bounds the damage here, not slippage.
 *
 * @param {bigint} amountIn native wei to spend
 * @param {number} deadline unix seconds, only used by the V3 router shape
 */
async function buildBuyTx({ dexConfig, launchConfig, token, recipient, amountIn, deadline }) {
  const router = routerFor(dexConfig, launchConfig);
  const base = {
    tokenIn: launchConfig.pairToken,
    tokenOut: token,
    fee: dexConfig.poolFee,
    recipient,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };
  const params = launchConfig.routerRequiresDeadline
    ? { ...base, deadline: BigInt(deadline) }
    : base;

  // Ordered tuples — the two router shapes differ only by `deadline`.
  const args = launchConfig.routerRequiresDeadline
    ? [
        [
          params.tokenIn,
          params.tokenOut,
          params.fee,
          params.recipient,
          params.deadline,
          params.amountIn,
          params.amountOutMinimum,
          params.sqrtPriceLimitX96,
        ],
      ]
    : [
        [
          params.tokenIn,
          params.tokenOut,
          params.fee,
          params.recipient,
          params.amountIn,
          params.amountOutMinimum,
          params.sqrtPriceLimitX96,
        ],
      ];

  return router.exactInputSingle.populateTransaction(...args, { value: amountIn });
}

module.exports = { routerFor, buildBuyTx };
