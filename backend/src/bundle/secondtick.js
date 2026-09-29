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

/** Read the latest header's timestamp, in whole seconds.
 *
 * NOT provider.getBlock('latest'). AbstractProvider caches a read by tag for
 * cacheTimeout (250ms by default, and this project does not override it), so a
 * 20ms cadence through it would really be a 250ms cadence: every poll for a
 * quarter of a second after the tick would answer from the pre-tick header, and
 * the launch would go out a block later than it needed to — measured at block
 * #2.9 of the second through the cache against #2.0 without it. provider.js:128
 * documents the same trap for warmPool, and :134 established this way out of it.
 */
async function readLatestHeader(rpc) {
  const block = await rpc.send('eth_getBlockByNumber', ['latest', false]);
  if (!block || block.timestamp === undefined || block.timestamp === null) {
    throw new Error('the node returned no latest block');
  }
  // The raw call answers in hex; Number() takes either form.
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
  // A read older than this frees its slot and counts as a failure. Sized against
  // the BUDGET, not the cadence: five poll intervals is 100ms, and from a box with
  // a 285ms round trip (a laptop over the internet, not the droplet) that expired
  // EVERY read — measured, three runs, reads 0, errors 5, the hold silently off. A
  // third of the ceiling is 500ms here, which no healthy read misses.
  //
  // The give-up is not five deadlines long: four reads fill the slots at once, so
  // the fifth error arrives on the second round of expiries — 2 x readTimeoutMs,
  // 1000ms of the 1500ms ceiling (measured). Bounded, and it fails open.
  const readTimeoutMs = deps.readTimeoutMs ?? Math.min(600, Math.max(150, Math.round(maxWaitMs / 3)));

  let reads = 0;
  let errors = 0;
  let skipped = 0;
  let inFlight = 0;
  // The second every read so far has agreed on. Set by the first answer, and
  // the thing a later read has to disagree with for the wait to be over.
  let fromSecond = null;
  let toSecond = null;
  const rtts = [];

  // Reads that have neither answered nor expired yet.
  const outstanding = new Set();

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
    // EVERY READ GETS ITS OWN DEADLINE, kept on the same clock as the budget so a
    // test can drive both. RetryJsonRpcProvider retries a read four times with
    // 300/600/900ms backoff before it ever rejects (provider.js:78-80), so a
    // refusing endpoint would not produce its first error until ~1.8s — past this
    // whole budget. Without a deadline the "gives up after a few unanswered reads"
    // exit could never fire, and a black-hole endpoint would hold the launch for
    // the full ceiling.
    //
    // EXPIRY FREES THE SLOT, IT DOES NOT DISCARD THE ANSWER. A read past its
    // deadline stops holding one of the four so the cadence can keep going, and
    // counts as an error so the give-up can fire — but if it does come back, its
    // header is still a reading of the chain's clock and is used. A slow endpoint
    // therefore still reaches the tick; only a silent one gives up.
    const entry = {
      at,
      expired: false,
      expire: () => {
        if (entry.expired) return;
        entry.expired = true;
        outstanding.delete(entry);
        inFlight -= 1;
        errors += 1;
      },
    };
    const release = () => {
      if (entry.expired) return;
      entry.expired = true;
      outstanding.delete(entry);
      inFlight -= 1;
    };
    outstanding.add(entry);
    readHeader(rpc).then(
      (header) => {
        release();
        if (done) return;
        const second = Number(header && header.timestamp);
        if (!Number.isFinite(second)) {
          errors += 1;
          return;
        }
        reads += 1;
        rtts.push(now() - at);
        if (fromSecond === null) {
          fromSecond = second;
          return;
        }
        // THE BASELINE ONLY EVER RISES. This RPC is load-balanced across
        // heterogeneous nodes (provider.js:29-31), so two answers can straddle a
        // second boundary: 101, then a lagging replica's 100, then 101 again. A
        // baseline that followed the lower value would read that as a tick and
        // launch in the middle of a second while the record claimed the hold
        // worked. An older answer is dropped instead — the newest second any
        // replica has seen is the second the chain is in.
        if (second < fromSecond) return;
        if (second > fromSecond) {
          toSecond = second;
          done = true;
          resolveTick();
        }
      },
      () => {
        // A read that already expired has been counted once; do not count it twice.
        const wasExpired = entry.expired;
        release();
        if (!wasExpired) errors += 1;
      }
    );
  };

  const maxBlindErrors = deps.maxErrorsBeforeAnyReading ?? MAX_ERRORS_BEFORE_ANY_READING;
  const sweep = () => {
    for (const entry of [...outstanding]) {
      if (now() - entry.at >= readTimeoutMs) entry.expire();
    }
  };
  while (!done && now() - started < maxWaitMs) {
    sweep();
    // Five failures with the clock still unread: the reads still outstanding are
    // already past their deadline, so waiting out the rest of the budget would
    // hold the launch to learn nothing.
    if (fromSecond === null && errors >= maxBlindErrors) break;
    issue();
    // Race the cadence against the tick so the wait ends on the answer, not on
    // the next interval boundary.
    // Never sleep past the ceiling: the cadence is a setting, the budget is a
    // promise to the launch waiting behind this.
    const left = maxWaitMs - (now() - started);
    await Promise.race([pause(Math.max(0, Math.min(pollMs, left))), ticked]);
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
