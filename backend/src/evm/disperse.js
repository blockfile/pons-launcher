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
//
// Several disperser addresses may be configured, in which case a run is split
// across them. Three contracts turn twenty wallets into three transactions
// instead of one: still far below the concurrency that caused trouble, and a
// batch that reverts takes down only its own share rather than the whole run.

const { Contract, getAddress } = require('ethers');
const { dispersersFor } = require('../store/dispersers');
const { provider } = require('./provider');

const DISPERSE_ABI = [
  'function disperse(address[] to, uint256[] amounts) payable',
  'function disperseEqual(address[] to, uint256 amount) payable',
  'event Dispersed(address indexed from, uint256 recipients, uint256 total)',
];

// Below this, individual transfers cost less gas than one batched call.
const BATCH_THRESHOLD = 5;

/**
 * Every disperser in force for a user, in order. Empty when none is set.
 * Comes from the user's own list, or DISPERSER_ADDRESSES as the fallback.
 */
function addresses(userId = 'default') {
  return dispersersFor(userId).addresses().map((a) => getAddress(a));
}

function disperser(address, runner = provider) {
  return new Contract(getAddress(address), DISPERSE_ABI, runner);
}

/** Whether batching actually wins for this many recipients. */
function shouldBatch(count, userId = 'default') {
  return addresses(userId).length > 0 && count >= BATCH_THRESHOLD;
}

/**
 * Deal the recipients across the configured contracts.
 *
 * Contiguous chunks rather than round-robin: each contract's transaction then
 * covers a block of the list, which is far easier to reconcile when one batch
 * fails and you need to know exactly who missed out.
 *
 * A chunk is never smaller than one recipient, so more contracts than
 * recipients simply leaves the extra contracts unused.
 *
 * @param {Array} targets
 * @param {string[]} [into] defaults to every configured disperser
 * @returns {Array<{disperser: string, targets: Array}>}
 */
function splitAcross(targets, into = addresses()) {
  if (!into.length) throw new Error('no disperser configured');
  const usable = Math.min(into.length, targets.length);
  const perChunk = Math.ceil(targets.length / usable);

  const chunks = [];
  for (let i = 0; i < usable; i++) {
    const slice = targets.slice(i * perChunk, (i + 1) * perChunk);
    if (slice.length) chunks.push({ disperser: into[i], targets: slice });
  }
  return chunks;
}

/**
 * One unsigned transaction paying every target through `address`.
 * @param {Array<{address: string, value: bigint}>} targets
 */
async function buildDisperseTx(targets, address = addresses()[0]) {
  if (!targets.length) throw new Error('nothing to disperse');
  if (!address) throw new Error('no disperser configured');

  const to = targets.map((t) => getAddress(t.address));
  const amounts = targets.map((t) => t.value);
  const total = amounts.reduce((s, v) => s + v, 0n);

  // Every amount identical is the usual case when funding a bundle, and the
  // equal variant sends a fraction of the calldata.
  const allEqual = amounts.every((v) => v === amounts[0]);
  const d = disperser(address);

  return allEqual
    ? d.disperseEqual.populateTransaction(to, amounts[0], { value: total })
    : d.disperse.populateTransaction(to, amounts, { value: total });
}

module.exports = {
  DISPERSE_ABI,
  BATCH_THRESHOLD,
  addresses,
  disperser,
  shouldBatch,
  splitAcross,
  buildDisperseTx,
};
