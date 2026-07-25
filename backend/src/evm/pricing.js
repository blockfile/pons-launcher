'use strict';

// Estimating how much of a token a bundle buy will receive, so a buy that would
// breach the launch-window caps can be caught BEFORE it is signed.
//
// Why this is needed: during the restriction window every non-dev address is
// capped at maxWalletBps of supply, and a buy that exceeds it does not clamp —
// it REVERTS. The wallet pays gas and receives nothing, and we only find out
// after the launch. There is no pool to quote against at signing time (it does
// not exist yet), so the estimate is made against the pool's initial price,
// which the launch config fixes in advance via initialTick.
//
// The estimate is deliberately optimistic: it ignores the price impact of the
// bundle's own buys, so it reports MORE tokens than a wallet will really get.
// That errs toward warning early, which is the safe direction — a false warning
// costs a resize, a missed one costs a reverted buy.

const Q = 1.0001;

/**
 * The pool's initial price as token1 per token0, from the Uniswap V3 tick the
 * launch config pins. Both sides are assumed to be 18 decimals, which holds for
 * the launched token and for the wrapped-native pair token.
 */
function priceFromTick(initialTick) {
  return Math.pow(Q, Number(initialTick));
}

/**
 * Tokens a buy of `amountInWei` native wei receives at the initial price.
 *
 * Uniswap orders a pool's tokens by address, and the tick is quoted as
 * token1-per-token0 — so which side we are on flips the arithmetic. Getting
 * this backwards silently produces an estimate that is wrong by orders of
 * magnitude, which is why it is derived rather than assumed.
 *
 * @returns {number} whole tokens (not wei); NaN-safe, returns 0 on bad input
 */
function estimateTokensOut({ amountInWei, initialTick, token, pairToken }) {
  const price = priceFromTick(initialTick);
  if (!Number.isFinite(price) || price <= 0) return 0;

  const amountIn = Number(amountInWei) / 1e18;
  if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;

  const tokenIsToken0 = String(token).toLowerCase() < String(pairToken).toLowerCase();
  const out = tokenIsToken0 ? amountIn / price : amountIn * price;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

/**
 * Where a buy lands against the launch-window caps.
 *
 * @returns {{estTokens:number, estBps:number, exceedsWallet:boolean, exceedsTx:boolean}}
 *          estBps is the estimated share of total supply in basis points.
 */
function capCheck({ amountInWei, launchConfig, token }) {
  const supply = Number(launchConfig.supply) / 1e18;
  const estTokens = estimateTokensOut({
    amountInWei,
    initialTick: launchConfig.initialTick,
    token,
    pairToken: launchConfig.pairToken,
  });

  if (!supply || !estTokens) {
    return { estTokens: 0, estBps: 0, exceedsWallet: false, exceedsTx: false };
  }

  const estBps = (estTokens / supply) * 10000;
  return {
    estTokens,
    estBps,
    exceedsWallet: estBps > Number(launchConfig.maxWalletBps),
    exceedsTx: estBps > Number(launchConfig.maxTxBps),
  };
}

module.exports = { priceFromTick, estimateTokensOut, capCheck };
