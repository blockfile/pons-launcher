// The ETH each bundle wallet must hold BACK from its buy so the launch's
// preflight funds it rather than skipping it — the buy-gas reserve for its own
// buy, plus gas for the sells it may make later.
//
// This is the one place the composition of that reserve lives, because the
// wallet table sizes the reserve twice (the live "dev wallet needs" figure and
// the "Distribute across N wallets" auto-fill) and both must agree with the
// backend that either funds a buy or skips it. Kept as a plain module, not a
// hook, so it is unit-testable without a DOM — see bundleReserve.test.js.

// How many sells each wallet keeps gas for, deliberately generous — a wallet
// stuck holding tokens it cannot sell is worse than a slightly larger fund.
export const SELL_RESERVE = 10;

/**
 * The per-wallet BUY-gas reserve, in ETH.
 *
 * Non-zap (native / pre-signed pair launches): the cost of a plain `curve.buy`,
 * which is what /gas returns as buyGasEth.
 *
 * ETH-zap launches: a zap buy is a multi-hop settle (ETH → pair → curve.buy in
 * one call) the backend reserves config.zapBuyGasLimit (900k) for and skips a
 * wallet unless it holds `buy + zapBuyCost + buffer` — see prepareV2's ethZap
 * branch. So the reserve here must be `zapBuyGasEth + gasBufferEth` (the same
 * two figures the backend sums), NOT buyGasEth (a ~400k plain buy). Sizing a
 * zap bundle against buyGasEth leaves only the small normal-buy reserve, so
 * every distributed buy is a touch too large and the backend skips all of them.
 *
 * Missing fields read as 0 so a gas-endpoint outage sizes to no reserve rather
 * than NaN — the same fallback the callers already relied on.
 */
export function buyGasReserve(gas, zapMode) {
  if (zapMode) {
    return Number(gas?.zapBuyGasEth || 0) + Number(gas?.gasBufferEth || 0);
  }
  return Number(gas?.buyGasEth || 0);
}

/**
 * The full per-wallet reserve, in ETH: buy gas + gas for SELL_RESERVE sells.
 *
 * Only the BUY portion changes with zap mode. The sells are always a normal
 * curve sell, so the sell-gas portion is byte-for-byte the same in both modes.
 */
export function perWalletReserve(gas, zapMode, sellReserve = SELL_RESERVE) {
  return buyGasReserve(gas, zapMode) + sellReserve * Number(gas?.sellGasEth || 0);
}
