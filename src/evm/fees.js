'use strict';

const { provider } = require('./provider');

/**
 * Current fee overrides, as an EIP-1559 pair when the chain reports one and a
 * legacy gasPrice otherwise.
 * @param {number} bumpPct raise the ceiling by this %, so a bundle buy is not
 *   the transaction that gets left behind when the base fee ticks up.
 */
async function getFees(bumpPct = 0) {
  const fd = await provider.getFeeData();
  const bump = (v) => (v == null ? null : (v * BigInt(100 + bumpPct)) / 100n);

  if (fd.maxFeePerGas && fd.maxPriorityFeePerGas) {
    return {
      type: 2,
      maxFeePerGas: bump(fd.maxFeePerGas),
      maxPriorityFeePerGas: bump(fd.maxPriorityFeePerGas),
    };
  }
  return { type: 0, gasPrice: bump(fd.gasPrice ?? 1_000_000_000n) };
}

/** Worst-case cost of a transaction at these fees. */
function gasCost(fees, gasLimit) {
  const price = fees.maxFeePerGas ?? fees.gasPrice;
  return price * BigInt(gasLimit);
}

module.exports = { getFees, gasCost };
