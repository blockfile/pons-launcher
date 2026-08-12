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
// WHY THE POLLS OVERLAP. block.number on this chain is L1-derived and advances
// about every 16 seconds, while RPC blocks arrive about ten a second. Two
// launches were lost to competitors who fired at the tick while our bundle went
// out one RPC block later — about 100ms.
//
// The first version of this loop read block.number, waited for the answer, and
// only THEN slept the poll interval. Its period was therefore `pollMs + rtt`,
// not `pollMs`: the round trip sat inside the interval and was charged twice.
// Working it through — a poll issued at I observes the chain around I + rtt/2
// and is known at I + rtt, and the tick falls uniformly between two issues:
//
//   sequential, period p + r   expected lateness  (p + r)/2 + r/2  =  p/2 + r
//   overlapped,  period p      expected lateness   p/2      + r/2
//
// So the reads now go out on a fixed cadence regardless of what is still in
// flight, and the wait ends on the first ANSWER that shows the tick rather than
// on the next scheduled poll after it. With a 25ms cadence and a 20ms read that
// is ~45ms of lateness down to ~22ms — a fifth of a lost RPC block, recovered
// without asking the chain anything it was not already being asked.
//
// WHAT IS DELIBERATELY NOT DONE: firing predictively. The tick is regular
// enough to extrapolate, but a bundle broadcast one tick early does not arrive
// early — it reverts LaunchBlockBuyBlocked, all of it, which has already cost
// this operator a whole bundle once. Everything here still waits for the chain
// to SAY the block moved. Prediction is only ever allowed to decide when to
// ask, never when to fire.
//
// Every poll is timed and the lateness estimated, so the next launch reports
// whether this actually worked rather than assuming it.

const { monotonic, ms, summary } = require('../evm/timing');
const { rpcMessage } = require('../evm/errors');

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

// A launch that waits the full 16 seconds at a 25ms cadence makes ~640 reads.
// Keeping every one of them would put 640 records into launches.json per launch
// for no benefit: the only polls that carry information are the ones around the
// tick. Keep the tail.
const KEEP_POLLS = 20;

// Overlapping polls need a ceiling, or an RPC that stops answering turns a
// fixed cadence into an unbounded pile of open requests. Four also bounds how
// many pooled sockets the wait is holding when the burst starts — see the
// headroom fire.js warms on top of one socket per buy.
const MAX_IN_FLIGHT = 4;

// How many reads in a row may fail before the wait gives up and lets the caller
// broadcast blind.
//
// It used to be one. That was the dangerous default: giving up means firing
// without knowing the block ticked, and if it has not, all 32 buys revert. The
// provider already retries a transient read four times with backoff before it
// ever fails here, so twenty-five consecutive failures is not a blip — it is an
// endpoint that has stopped answering. Short of that, keep asking; the wait
// budget is the real backstop, and by the time it expires the block has ticked
// several times over and the buys are legal anyway.
const MAX_CONSECUTIVE_ERRORS = 25;

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

  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const maxErrors = deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;

  const started = at();
  const polls = [];
  const rtts = [];
  let pollCount = 0;
  let inFlight = 0;
  let skipped = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let lastError = null;
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
    // Polls the cadence wanted to issue but could not, because too many were
    // still unanswered. A large number here means the round trip is longer than
    // the interval and the cadence is really being set by maxInFlight.
    skipped,
    errors,
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

  // Settled by the first ANSWER that shows the tick, not by the next scheduled
  // poll after it. The scheduling loop races its sleep against this, so the
  // moment the winning read lands the loop stops sleeping and returns — the
  // whole point of overlapping the polls is lost if the answer then sits in a
  // queue for the rest of an interval.
  let tick = null;
  let wake;
  const woken = new Promise((resolve) => {
    wake = resolve;
  });

  const issue = () => {
    const issuedMs = at();
    inFlight += 1;
    // A readBlock that throws synchronously rather than rejecting would escape
    // the scheduling loop and reject the whole wait — which fire() would see as
    // a failed launch. Nothing here is allowed to fail that way.
    let pending;
    try {
      pending = Promise.resolve(readBlock(rpc));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (block) => {
        inFlight -= 1;
        // A read that comes back after the wait has already ended tells us
        // nothing we can act on, and recording it would corrupt the timings.
        if (tick) return;
        consecutiveErrors = 0;
        const returnedMs = at();
        const poll = { issuedMs: ms(issuedMs), returnedMs: ms(returnedMs), rttMs: ms(returnedMs - issuedMs), block };
        record(poll);
        if (block > launchBlock) {
          tick = poll;
          wake();
          return;
        }
        // Under overlap the answers can arrive out of order. The tightest lower
        // bound on the tick is the LATEST-issued read that still saw the old
        // block, whenever it happens to have come back.
        if (!lastStale || poll.issuedMs > lastStale.issuedMs) lastStale = poll;
      },
      (err) => {
        inFlight -= 1;
        if (tick) return;
        errors += 1;
        consecutiveErrors += 1;
        lastError = err;
        const returnedMs = at();
        record({ issuedMs: ms(issuedMs), returnedMs: ms(returnedMs), rttMs: ms(returnedMs - issuedMs), block: null });
        if (consecutiveErrors >= maxErrors) wake();
      }
    );
  };

  while (!tick && at() - started < waitMs) {
    if (consecutiveErrors >= maxErrors) {
      console.warn(
        `[pons-launcher] block.number unreadable ${consecutiveErrors} times running` +
          ` (${rpcMessage(lastError)}) — giving up the wait`
      );
      return report({ reason: 'unreadable' });
    }
    if (inFlight < maxInFlight) issue();
    else skipped += 1;
    // Whichever comes first: the next slot in the cadence, or the answer.
    await Promise.race([pause(pollMs), woken]);
  }

  if (tick) {
    return report({
      waitedMs: ms(tick.returnedMs - started),
      observedTickMs: tick.returnedMs,
      reason: 'ticked',
      ...estimate(tick),
    });
  }

  console.warn(
    `[pons-launcher] block.number did not pass ${launchBlock} within ${waitMs}ms — firing anyway`
  );
  return report({ waitedMs: ms(at() - started), reason: 'timeout' });
}

module.exports = { waitForNextBlock, KEEP_POLLS, MAX_IN_FLIGHT, MAX_CONSECUTIVE_ERRORS };
