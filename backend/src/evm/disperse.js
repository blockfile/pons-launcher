'use strict';

// Client side of contracts/Disperse.sol.
//
// Funding twenty wallets individually means twenty concurrent broadcasts, and
// that is the exact shape that hit the provider's rate limiter and failed a
// whole sweep. One call cannot be half-rate-limited, and it is ~20% cheaper at
// twenty recipients.
//
// It is NOT cheaper below about five. Measured on this chain: three recipients
// through a multisend cost 68,847 gas against 63,585 for three plain transfers,
// because the contract call pays its own 21k base cost on top of each internal
// transfer. shouldBatch() encodes that threshold so callers stop guessing.

const { Contract, getAddress } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');

const DISPERSE_ABI = [
  'function disperse(address[] to, uint256[] amounts) payable',
  'function disperseEqual(address[] to, uint256 amount) payable',
  'event Dispersed(address indexed from, uint256 recipients, uint256 total)',
];

// Below this, individual transfers cost less gas than one batched call.
const BATCH_THRESHOLD = 5;

function disperser(runner = provider) {
  if (!config.disperserAddress) throw new Error('DISPERSER_ADDRESS is not set');
  return new Contract(config.disperserAddress, DISPERSE_ABI, runner);
}

/** Whether batching actually wins for this many recipients. */
function shouldBatch(count) {
  return Boolean(config.disperserAddress) && count >= BATCH_THRESHOLD;
}

/**
 * One unsigned transaction paying every target.
 * @param {Array<{address: string, value: bigint}>} targets
 */
async function buildDisperseTx(targets) {
  if (!targets.length) throw new Error('nothing to disperse');

  const to = targets.map((t) => getAddress(t.address));
  const amounts = targets.map((t) => t.value);
  const total = amounts.reduce((s, v) => s + v, 0n);

  // Every amount identical is the usual case when funding a bundle, and the
  // equal variant sends a fraction of the calldata.
  const allEqual = amounts.every((v) => v === amounts[0]);
  const d = disperser();

  return allEqual
    ? d.disperseEqual.populateTransaction(to, amounts[0], { value: total })
    : d.disperse.populateTransaction(to, amounts, { value: total });
}

module.exports = { DISPERSE_ABI, BATCH_THRESHOLD, disperser, shouldBatch, buildDisperseTx };
