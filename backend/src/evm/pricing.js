'use strict';

// Estimating how much of a token a bundle buy will receive, so a buy that would
// breach the launch-window caps can be caught BEFORE it is signed.
//
// During the restriction window every non-dev address is capped at
// maxWalletBps of supply, and a buy over it does not clamp — it REVERTS, and
// the pool's TransferHelper masks the reason as "TF". There is no pool to quote
// against at signing time, so the estimate comes from the initial tick the
// launch config pins.
//
// On the sign of initialTick: a Uniswap tick is quoted as token1-per-token0,
// so its sign follows the pool's address ordering rather than the economics.
// A launchpad always opens with the token cheap against the pair token — a
// billion-token supply against a fraction of an ETH — so the magnitude is the
// exchange rate whichever side the token lands on. An earlier version of this
// file derived the direction from address ordering and got it inverted, which
// reported 0.00% for a buy that was really 0.11% of supply.
//
// Anchored to a real launch: token 0x4aE28f7022F0db76F9B791ff3DEe6bE67B40137F,
// initialTick -204200, where 0.003 ETH bought 2,186,029 tokens.
//
// The estimate ignores the price impact of the bundle's own buys, so it reports
// slightly MORE tokens than a wallet will really get. That errs toward warning
// early, which is the safe direction.

const Q = 1.0001;

/**
 * Tokens received per whole pair token at the pool's opening price.
 */
function rateFromTick(initialTick) {
  const tick = Math.abs(Number(initialTick));
  if (!Number.isFinite(tick)) return 0;
  const rate = Math.pow(Q, tick);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Tokens a buy of `amountInWei` native wei receives at the opening price.
 * @returns {number} whole tokens (not wei); 0 on unusable input
 */
function estimateTokensOut({ amountInWei, initialTick }) {
  const rate = rateFromTick(initialTick);
  if (!rate) return 0;

  const amountIn = Number(amountInWei) / 1e18;
  if (!Number.isFinite(amountIn) || amountIn <= 0) return 0;

  const out = amountIn * rate;
  return Number.isFinite(out) && out > 0 ? out : 0;
}

/**
 * Where a buy lands against the launch-window caps.
 * @returns {{estTokens:number, estBps:number, exceedsWallet:boolean, exceedsTx:boolean}}
 */
function capCheck({ amountInWei, launchConfig }) {
  const supply = Number(launchConfig.supply) / 1e18;
  const estTokens = estimateTokensOut({ amountInWei, initialTick: launchConfig.initialTick });

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

module.exports = { rateFromTick, estimateTokensOut, capCheck };
