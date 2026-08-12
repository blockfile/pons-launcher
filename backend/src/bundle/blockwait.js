'use strict';

// Holding a bundle until the EVM's block.number ticks past the launch block,
// and recording exactly how late we were to notice.
//
// WHY THE WAIT EXISTS — confirmed against the verified source of a launched
// token (PonsLauncherToken._update, contracts/src/PonsLauncherToken.sol):
//
//     bool isAtomicLaunchBuy =
//         block.number == launchBlock && _initialBuyRecipient != address(0) && to == _initialBuyRecipient;
//     if (!isAtomicLaunchBuy && block.number == launchBlock) {
//         revert LaunchBlockBuyBlocked(to);
//     }
//
// The ban is `block.number == launchBlock` — a STRICT EQUALITY, not a window.
// `restrictionBlocks` (2 on our launches) sizes something else entirely: the
// separate `restrictionEndBlock = launchBlock + restrictionBlocks` window
// inside which pool buys are merely CAPPED at maxWalletBps/maxTxBps. So:
//
//     launchBlock       every bundle buy reverts LaunchBlockBuyBlocked
//     launchBlock + 1   legal, and still inside the capped window
//     launchBlock + 2   legal, still capped
//     launchBlock + 3   unrestricted
//
// launchBlock + 1 is therefore the earliest legal moment, and releasing on
// `now > launchBlock` is exactly right. Nothing here may release sooner.
//
// WHY THE TIMING EXISTS. block.number on this chain is L1-derived and advances
// about every 16 seconds, while RPC blocks arrive about ten a second. Two
// launches were lost to competitors who fired at the tick while our bundle
// went out one RPC block later — about 100ms. The loop below cannot be judged
// without knowing how much of that gap was spent not yet knowing the block had
// ticked, so every poll is timed and the estimate is reported.

const { monotonic, ms, summary } = require('../evm/timing');
const { rpcMessage } = require('../evm/errors');

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

// A launch that waits the full 16 seconds at a 50ms poll makes ~320 reads.
// Keeping every one of them would put 320 records into launches.json per
// launch for no benefit: the only polls that carry information are the ones
// around the tick. Keep the tail.
const KEEP_POLLS = 20;

/**
 * Block until the chain's own block.number moves past `launchBlock`.
 *
 * Never throws. A bundle that fires late is worth far more than a bundle that
 * does not fire at all, so an unreadable block number gives up waiting and lets
 * the caller broadcast rather than propagating.
 *
 * @param {bigint} launchBlock the block the launch itself executed in
 * @param {object} deps
 * @param {object} deps.rpc provider passed through to readBlock
 * @param {(rpc: object) => Promise<bigint>} deps.readBlock reads EVM block.number
 * @param {(delay: number) => Promise<void>} [deps.pause] injectable sleep
 * @param {() => number} [deps.now] injectable monotonic clock — tests pass a fake
 * @param {number} deps.pollMs how often to ask
 * @param {number} deps.waitMs how long to keep asking before giving up
 * @param {{issuedMs: number, returnedMs: number}} [deps.staleSince] the last
 *   observation, before this call, that still saw `launchBlock` — it bounds how
 *   early the tick could have happened
 * @param {number} [deps.originMs] clock offset all reported times are relative
 *   to, so the wait's numbers line up with the rest of the launch record
 * @returns {Promise<object>} the wait, fully timed
 */
async function waitForNextBlock(launchBlock, deps) {
  const { rpc, readBlock, pollMs, waitMs } = deps;
  const pause = deps.pause || sleep;
  const now = deps.now || monotonic;
  // Times are reported relative to the caller's origin when it gives one, so a
  // poll timestamp and a broadcast timestamp are directly comparable.
  const origin = deps.originMs === undefined ? now() : deps.originMs;
  const at = () => now() - origin;

  const started = at();
  const polls = [];
  const rtts = [];
  let pollCount = 0;
  // The most recent observation that still saw the launch block. It is the
  // lower bound on when the tick could have happened, so it is what turns "we
  // noticed at T" into "we were N milliseconds late".
  let lastStale = deps.staleSince || null;

  const record = (poll) => {
    pollCount += 1;
    rtts.push(poll.rttMs);
    polls.push(poll);
    if (polls.length > KEEP_POLLS) polls.shift();
  };

  const report = (extra) => ({
    // Unchanged semantics: how long the bundle was held, or null when the wait
    // could not be performed at all.
    waitedMs: null,
    startedMs: ms(started),
    pollMs,
    pollCount,
    // Only the tail is kept; pollRtt covers every poll, including dropped ones.
    polls: polls.map((p) => ({ ...p, block: p.block === null ? null : p.block.toString() })),
    pollRtt: summary(rtts),
    // When the tick-observing poll came back — the instant we first knew.
    observedTickMs: null,
    // The window the tick actually fell in, and our best estimate of how much
    // of it we spent not knowing. See estimate() below.
    tickWindowMs: null,
    detectionLagMs: null,
    reason: 'unreadable',
    ...extra,
  });

  /**
   * How late we were to notice, and how sure we can be.
   *
   * A poll issued at I and answered at R observed the chain at some single
   * instant in between; the request leg is the better guess, so treat the
   * observation as landing at I + rtt/2. The tick therefore happened somewhere
   * after the last poll that still saw the old block observed, and at or before
   * the poll that saw the new one observed. That span is the window; with no
   * reason to prefer any point in it, the midpoint is the estimate.
   */
  const estimate = (tickPoll) => {
    if (!lastStale) return { tickWindowMs: null, detectionLagMs: null };
    const lower = lastStale.issuedMs + (lastStale.rttMs || 0) / 2;
    const upper = tickPoll.issuedMs + (tickPoll.rttMs || 0) / 2;
    return {
      tickWindowMs: ms(upper - lower),
      detectionLagMs: ms(tickPoll.returnedMs - (lower + upper) / 2),
    };
  };

  while (at() - started < waitMs) {
    const issuedMs = at();
    let block;
    try {
      block = await readBlock(rpc);
    } catch (err) {
      const returnedMs = at();
      record({ issuedMs: ms(issuedMs), returnedMs: ms(returnedMs), rttMs: ms(returnedMs - issuedMs), block: null });
      console.warn(`[pons-launcher] could not read block.number: ${rpcMessage(err)}`);
      return report({ reason: 'unreadable' });
    }
    const returnedMs = at();
    const poll = {
      issuedMs: ms(issuedMs),
      returnedMs: ms(returnedMs),
      rttMs: ms(returnedMs - issuedMs),
      block,
    };
    record(poll);

    if (block > launchBlock) {
      return report({
        waitedMs: ms(returnedMs - started),
        observedTickMs: ms(returnedMs),
        reason: 'ticked',
        ...estimate(poll),
      });
    }
    lastStale = poll;
    await pause(pollMs);
  }

  console.warn(
    `[pons-launcher] block.number did not pass ${launchBlock} within ${waitMs}ms — firing anyway`
  );
  return report({ waitedMs: ms(at() - started), reason: 'timeout' });
}

module.exports = { waitForNextBlock, KEEP_POLLS };
