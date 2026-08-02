'use strict';

// Waiting for a receipt on a chain that makes ten blocks a second.
//
// ethers' tx.wait() polls at provider.pollingInterval, which defaults to
// 4000ms. On a 100ms chain that is up to forty blocks of delay before the
// caller even learns the transaction landed. For v1 that only slowed reporting,
// because the buys were already pre-signed and broadcast. For v2 it sits
// directly in the critical path: the curve address comes from the launch
// receipt, so every millisecond spent not noticing it is a millisecond the
// bundle is late to a curve that anyone else can already buy.
//
// Polling getTransactionReceipt directly costs one cheap call per interval and
// removes the delay entirely.

const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} rpc provider
 * @param {string} hash transaction hash
 * @param {{pollMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<object|null>} the receipt, or null if it never appeared
 */
async function waitForReceipt(rpc, hash, opts = {}) {
  // A provider without this method is a wiring mistake, not a transient blip.
  // Without the guard the loop below would swallow the TypeError and retry for
  // the full timeout — two minutes of silence instead of an immediate answer.
  if (!rpc || typeof rpc.getTransactionReceipt !== 'function') {
    throw new Error('provider cannot fetch receipts — getTransactionReceipt is missing');
  }

  const pollMs = opts.pollMs ?? config.receiptPollMs;
  const timeoutMs = opts.timeoutMs ?? config.receiptTimeoutMs;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let receipt = null;
    try {
      receipt = await rpc.getTransactionReceipt(hash);
    } catch (_err) {
      // A blip mid-poll is not a failure; the next tick retries.
    }
    if (receipt) return receipt;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

module.exports = { waitForReceipt };
