'use strict';

/**
 * How big a slice of the position each cycle sells.
 *
 * Pure arithmetic — no provider, no keystore, no network — so its one property (the
 * running mean self-corrects, and the last wallet lands the position on zero) is
 * provable by a test rather than observed on a chain.
 *
 * V7 SIZES BY TOKENS, exactly as v6 does, and reads the ETH each sell actually raised
 * from the chain (trade.sell measures a native balance delta). The flap curve does have
 * a closed-form inverse — but a flap token is FEE-ON-TRANSFER, so "sell exactly enough
 * tokens to raise T wei" computed offline would be wrong by the tax on every hop. Slicing
 * the remaining TOKEN balance directly — `remaining tokens ÷ remaining wallets`, jittered —
 * and sizing the Relay transfer that follows against the REAL proceeds sidesteps the tax
 * entirely: whatever the sell actually netted, net of the curve fee and any on-curve tax,
 * is what moves. Same distribution shape as v3; the venue just answers "what did this
 * raise" from a live balance delta instead of a formula.
 *
 * THE MEAN IS RECOMPUTED EVERY CYCLE, and that is the whole design. Selling a fixed
 * fraction N times drifts: a slice that hits more price impact than expected leaves the
 * position worth less than the arithmetic assumed, so the run reaches the last wallets
 * with too little. `remaining ÷ walletsLeft` re-derived each cycle spreads a shortfall
 * across the wallets that remain rather than dumping it on the last one.
 *
 * THE LAST WALLET TAKES WHATEVER IS LEFT, exactly — no jitter — so the position ends on
 * zero. The caller passes the whole remaining balance for that cycle.
 */

// How far a cycle's slice may stray from the running mean, and the operator ceiling.
// ±30% is clearly irregular without any single sell standing out; past ±90% the small
// end rounds to dust.
const DEFAULT_VARIANCE_PCT = 30;
const MAX_VARIANCE_PCT = 90;

const BPS = 10_000n;

/**
 * The token slice this cycle should sell: the running mean of the remaining token
 * balance, jittered ±variancePct. The LAST wallet (remainingWallets === 1) takes the
 * whole remaining balance so the position lands on exactly zero.
 *
 * `roll` is a 0..1 uniform, injected rather than drawn here so the engine's tests are
 * deterministic.
 *
 * @param {object} input
 * @param {bigint} input.tokenBalance the main wallet's remaining token balance
 * @param {number} input.remainingWallets bundle wallets still to be fed (incl. this one)
 * @param {number} [input.variancePct]
 * @param {number} [input.roll] 0..1 uniform
 * @returns {bigint} tokens to sell this cycle (base units)
 */
function sliceTokens({ tokenBalance, remainingWallets, variancePct = DEFAULT_VARIANCE_PCT, roll = 0.5 }) {
  const balance = BigInt(tokenBalance);
  if (balance <= 0n) throw new Error('there is nothing left of the position to slice');

  const left = Number(remainingWallets);
  if (!Number.isInteger(left) || left < 1) throw new Error('remainingWallets must be a positive integer');

  // One wallet left: it takes the remainder. Returning the full balance keeps this
  // honest about what it is saying (the engine sells the whole balance in that case).
  if (left === 1) return balance;

  const mean = balance / BigInt(left);
  const swing = Number(variancePct);
  if (!Number.isFinite(swing) || swing < 0 || swing > MAX_VARIANCE_PCT) {
    throw new Error(`variance must be between 0 and ${MAX_VARIANCE_PCT} percent`);
  }
  if (swing === 0) return mean;

  // ±swing%, uniform, folded into basis points so the maths stays BigInt.
  const factorBps = BigInt(Math.round(10_000 + swing * 100 * (roll * 2 - 1)));
  const slice = (mean * factorBps) / BPS;

  // Never more than is there, and never zero — a cycle that sells nothing would transfer
  // nothing and buy nothing, leaving a hole in the tape.
  if (slice >= balance) return balance;
  return slice > 0n ? slice : 1n;
}

/**
 * A LIGHT plan-time feasibility estimate. Given the position's current ETH value (one
 * live quote of selling the whole balance) and the run parameters, it reports the
 * per-wallet average and whether that average clears the per-cycle cost (main-wallet gas +
 * the bundle buy after the Relay fee). This is an ESTIMATE, not a guarantee — every sell
 * moves the price, so the real tail raises less; the engine's per-cycle running mean is
 * what actually self-corrects. Pure arithmetic; the caller formats.
 *
 * @returns {{ feasible: boolean, perWalletWei: bigint, reason: string|null }}
 */
function estimateFeasibility({ positionValueWei, walletCount, mainGas, buyGas, buffer, relayFeePct = 3 }) {
  const value = BigInt(positionValueWei);
  const n = Number(walletCount);
  if (!Number.isInteger(n) || n < 1) throw new Error('walletCount must be a positive integer');
  if (value <= 0n) return { feasible: false, perWalletWei: 0n, reason: 'worthless' };

  const perWallet = value / BigInt(n);
  const mg = BigInt(mainGas);
  const spendable = perWallet - mg;
  if (spendable <= 0n) return { feasible: false, perWalletWei: perWallet, reason: 'slice-below-gas' };

  const afterFee = (spendable * BigInt(100 - relayFeePct)) / 100n;
  if (afterFee <= BigInt(buyGas) + BigInt(buffer)) {
    return { feasible: false, perWalletWei: perWallet, reason: 'buy-underfunded' };
  }
  return { feasible: true, perWalletWei: perWallet, reason: null };
}

module.exports = {
  DEFAULT_VARIANCE_PCT,
  MAX_VARIANCE_PCT,
  sliceTokens,
  estimateFeasibility,
};
