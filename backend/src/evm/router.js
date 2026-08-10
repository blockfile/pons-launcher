'use strict';

// Builds the bundle buys, and the sell that reverses them. These deliberately
// mirror the factory's own _executeInitialBuy: same router, same pair token,
// same pool fee, native value in, amountOutMinimum 0 — so a bundle buy behaves
// exactly like the atomic dev buy, one transaction later, and the sell is that
// same swap run backwards.

const { Contract, getAddress } = require('ethers');
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

/**
 * An unsigned token → native-ETH sell: the buy above, reversed.
 *
 * Two things make this more than a swapped tokenIn/tokenOut, and both were
 * settled by running the call against the live router with the allowance
 * overridden, not by reading Uniswap's docs:
 *
 *   1. THE SWAP OUTPUT IS WETH, NOT ETH. A buy sends native value and the router
 *      wraps it; the reverse hands back WETH. So the swap pays the ROUTER, and a
 *      second call in the same transaction unwraps that and forwards native ETH
 *      to the seller. Two calls, one transaction, via the router's own multicall
 *      — proceeds land in the wallet that sold, as native ETH, which is what
 *      makes "ETH received" measurable as a balance delta afterwards.
 *
 *   2. THE RECIPIENT IS THE ROUTER'S LITERAL ADDRESS. Both router shapes have a
 *      sentinel meaning "keep it here", and they disagree about what it is:
 *      SwapRouter02 uses address(2) and treats address(0) as a real recipient,
 *      while the older deadline-taking SwapRouter maps address(0) to itself.
 *      Passing address(0) to the deployed router REVERTS WITH "TF" — verified.
 *      The literal address needs no remapping and is right for both, so no
 *      sentinel is used at all.
 *
 * unwrapWETH9 takes the router's WHOLE WETH balance, which is this swap's output
 * plus anything a previous caller left stranded there. The router is not meant
 * to hold WETH between transactions, so that is a windfall rather than a risk.
 *
 * amountOutMinimum and the unwrap's minimum are both 0. That is the sell-all
 * decision — there is no slippage floor, deliberately; see prepareSell.js.
 *
 * @param {bigint} amountIn token base units to sell — the whole balance
 * @param {string} recipient the wallet that gets the ETH: the one that sold
 * @param {string} [pairToken] the token's own paired asset; defaults to the
 *   launch config's, which is the same thing unless the config was edited later
 * @param {number} [poolFee] likewise, the fee tier the token really launched in
 */
async function buildSellTx({
  dexConfig,
  launchConfig,
  token,
  recipient,
  amountIn,
  pairToken,
  poolFee,
  deadline,
}) {
  const router = routerFor(dexConfig, launchConfig);
  const routerAddress = getAddress(config.swapRouterOverride || dexConfig.swapRouter);
  const to = getAddress(recipient);

  const base = {
    tokenIn: getAddress(token),
    tokenOut: getAddress(pairToken || launchConfig.pairToken),
    fee: poolFee ?? dexConfig.poolFee,
    // Not the seller: see (2) above. The WETH stays here until it is unwrapped.
    recipient: routerAddress,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  // Ordered tuples — the two router shapes differ only by `deadline`.
  const args = launchConfig.routerRequiresDeadline
    ? [
        [
          base.tokenIn,
          base.tokenOut,
          base.fee,
          base.recipient,
          BigInt(deadline),
          base.amountIn,
          base.amountOutMinimum,
          base.sqrtPriceLimitX96,
        ],
      ]
    : [
        [
          base.tokenIn,
          base.tokenOut,
          base.fee,
          base.recipient,
          base.amountIn,
          base.amountOutMinimum,
          base.sqrtPriceLimitX96,
        ],
      ];

  const swap = router.interface.encodeFunctionData('exactInputSingle', args);
  const unwrap = router.interface.encodeFunctionData('unwrapWETH9', [0n, to]);
  return router.multicall.populateTransaction([swap, unwrap]);
}

module.exports = { routerFor, buildBuyTx, buildSellTx };
