'use strict';

// Hold a v2 launch until a wall-clock second has just begun.
//
// WHY. The opening snipe tax steps on whole wall-clock SECONDS, not blocks:
// 99.00% in the launch's own second, 6.18% in the next, 0.19% in the one after,
// nothing from the third (see bundle/fireV2.js and memory v2-block-timing). The
// bundle is exempt, so the tier is not a cost to us — it is the wall that keeps
// everyone else out while the bundle lands. Its width in blocks is therefore
// the whole game, and it is decided by WHERE IN THE SECOND the launch lands:
// blocks come every ~100ms, so a launch in the first block of a second leaves
// ~9 blocks of 99% behind it, and a launch in the last block leaves none.
//
// The Tomachi launch of 2026-09-29 was the second case. The launch landed in
// block 75675874, the last of second 1790686883; block 75675875 was already the
// next second at 6.18%, and two sniper contracts and one direct buyer took
// 3.06% of supply there, ahead of the first bundle buy in 75675876. Nothing was
// wrong with the exemption — every bundle wallet paid exactly the 1% base fee —
// and nothing was slow: the box measures 4.7ms to its RPC. The launch simply
// arrived at the end of a second.
//
// WHAT THIS DOES. Poll the chain's own latest header until its timestamp moves,
// then return immediately: at that instant the new second is at most one poll
// interval plus one round trip old, so the launch that follows lands in its
// first blocks. Cost: up to one second of waiting before a launch, which is
// nothing next to what it buys.
//
// NEVER THROWS, NEVER BLOCKS FOREVER. A launch that goes out at a worse moment
// beats a launch that does not go out, so every failure path returns a report
// saying the wait did not happen and lets the caller broadcast: an unreadable
// node, a chain whose clock looks stuck, or the operator turning it off.
//
// The poll shape (overlapping reads, an in-flight cap, errors counted rather
// than raised) is bundle/blockwait.js's, for the same reason: a cadence that
// awaited each read would have the round trip inside its period and would be
// late by that much on every observation.

const { monotonic, ms, summary } = require('../evm/timing');

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

// Overlapping polls need a ceiling, or a node that stops answering turns a
// fixed cadence into an unbounded pile of open requests. Four also bounds how
// many pooled sockets this holds when the burst starts.
const MAX_IN_FLIGHT = 4;

// How many reads may fail before a wait that has never had ONE answer gives up.
// Without this an endpoint that refuses everything would hold the launch for the
// whole budget while learning nothing: with no reading there is no second to
// wait for, and the launch is better off going out now. A wait that HAS read the
// clock keeps asking until the budget runs out — there the tick is still coming.
const MAX_ERRORS_BEFORE_ANY_READING = 5;

/** Read the latest header's timestamp, in whole seconds. */
async function readLatestHeader(rpc) {
  const block = await rpc.getBlock('latest');
  if (!block || block.timestamp === undefined || block.timestamp === null) {
    throw new Error('the node returned no latest block');
  }
  return { timestamp: Number(block.timestamp) };
}

/**
 * Wait until the chain's latest header timestamp moves to a new second.
 *
 * @param {object} deps
 * @param {object} deps.rpc provider, passed to readHeader
 * @param {(rpc: object) => Promise<{timestamp: number}>} [deps.readHeader]
 * @param {(delay: number) => Promise<void>} [deps.pause] injectable sleep
 * @param {() => number} [deps.now] injectable monotonic clock — tests pass a fake
 * @param {boolean} [deps.enabled] false returns at once, having read nothing
 * @param {number} deps.pollMs how often to ask
 * @param {number} deps.maxWaitMs how long to keep asking before giving up
 * @param {number} [deps.maxInFlight]
 * @returns {Promise<object>} the wait, timed, with `ticked` and `reason`
 */
async function waitForFreshSecond(deps = {}) {
  const enabled = deps.enabled !== false;
  const now = deps.now || monotonic;
  const started = now();

  const report = (over) => ({
    ticked: false,
    reason: 'disabled',
    waitedMs: 0,
    pollMs: deps.pollMs ?? null,
    reads: 0,
    errors: 0,
    skipped: 0,
    fromSecond: null,
    toSecond: null,
    readRtt: summary([]),
    ...over,
  });

  if (!enabled) return report({});

  const rpc = deps.rpc;
  const readHeader = deps.readHeader || readLatestHeader;
  const pause = deps.pause || sleep;
  const pollMs = deps.pollMs;
  const maxWaitMs = deps.maxWaitMs;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;

  let reads = 0;
  let errors = 0;
  let skipped = 0;
  let inFlight = 0;
  // The second every read so far has agreed on. Set by the first answer, and
  // the thing a later read has to disagree with for the wait to be over.
  let fromSecond = null;
  let toSecond = null;
  const rtts = [];

  let resolveTick;
  const ticked = new Promise((r) => {
    resolveTick = r;
  });
  let done = false;

  const issue = () => {
    if (done) return;
    if (inFlight >= maxInFlight) {
      skipped += 1;
      return;
    }
    inFlight += 1;
    const at = now();
    readHeader(rpc).then(
      (header) => {
        inFlight -= 1;
        reads += 1;
        rtts.push(now() - at);
        if (done) return;
        const second = Number(header.timestamp);
        if (!Number.isFinite(second)) {
          errors += 1;
          return;
        }
        if (fromSecond === null) {
          fromSecond = second;
          return;
        }
        // A chain whose timestamp went BACKWARDS is not a second we can trust
        // to be fresh; take the lower value as the new baseline and keep asking.
        if (second < fromSecond) {
          fromSecond = second;
          return;
        }
        if (second > fromSecond) {
          toSecond = second;
          done = true;
          resolveTick();
        }
      },
      () => {
        inFlight -= 1;
        errors += 1;
      }
    );
  };

  const maxBlindErrors = deps.maxErrorsBeforeAnyReading ?? MAX_ERRORS_BEFORE_ANY_READING;
  while (!done && now() - started < maxWaitMs) {
    if (fromSecond === null && errors >= maxBlindErrors && inFlight === 0) break;
    issue();
    // Race the cadence against the tick so the wait ends on the answer, not on
    // the next interval boundary.
    await Promise.race([pause(pollMs), ticked]);
  }

  const waitedMs = now() - started;
  if (done) {
    return report({
      ticked: true,
      reason: 'ticked',
      waitedMs: ms(waitedMs),
      pollMs,
      reads,
      errors,
      skipped,
      fromSecond,
      toSecond,
      readRtt: summary(rtts),
    });
  }
  return report({
    ticked: false,
    // Nothing ever answered: the launch goes out blind, and the report says so
    // in the word an operator reading launches.json will understand.
    reason: fromSecond === null ? 'unreadable' : 'timeout',
    waitedMs: ms(waitedMs),
    pollMs,
    reads,
    errors,
    skipped,
    fromSecond,
    toSecond: null,
    readRtt: summary(rtts),
  });
}

module.exports = { waitForFreshSecond, readLatestHeader, MAX_IN_FLIGHT };
