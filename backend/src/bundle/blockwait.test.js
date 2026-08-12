'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { waitForNextBlock, KEEP_POLLS } = require('./blockwait');

const LAUNCH = 100n;

/**
 * A chain on a fake clock. Nothing here waits: `pause` and the read latency
 * both move a counter, so a sixteen-second block costs the test microseconds.
 *
 * The read models the thing that actually makes detection hard — a read issued
 * at T does not observe the chain at T, it observes it somewhere inside its own
 * round trip. Taking the midpoint is what the estimator assumes, so modelling it
 * here is what makes the estimate testable at all.
 */
function fakeChain({ rttMs = 6, tickAtMs = 500, failAfter = null } = {}) {
  let t = 0;
  let reads = 0;
  return {
    now: () => t,
    at: () => t,
    reads: () => reads,
    pause: async (delay) => {
      t += delay;
    },
    readBlock: async () => {
      reads += 1;
      if (failAfter !== null && reads > failAfter) {
        t += rttMs;
        throw new Error('multicall unreachable');
      }
      const observedAt = t + rttMs / 2;
      t += rttMs;
      return observedAt >= tickAtMs ? LAUNCH + 1n : LAUNCH;
    },
  };
}

const run = (chain, over = {}) =>
  waitForNextBlock(LAUNCH, {
    rpc: {},
    readBlock: chain.readBlock,
    pause: chain.pause,
    now: chain.now,
    originMs: 0,
    pollMs: 50,
    waitMs: 90000,
    ...over,
  });

test('releases only once block.number is past the launch block', async () => {
  // The verified source bans pool buys at `block.number == launchBlock` exactly,
  // so launchBlock+1 is legal — but not a moment before it.
  const chain = fakeChain({ tickAtMs: 500 });
  const res = await run(chain);

  assert.equal(res.reason, 'ticked');
  const last = res.polls[res.polls.length - 1];
  assert.equal(last.block, String(LAUNCH + 1n), 'it returned on a read that saw the new block');
  for (const poll of res.polls.slice(0, -1)) {
    assert.equal(poll.block, String(LAUNCH), 'no earlier poll may have been treated as a tick');
  }
});

test('never returns before the tick, however long the wait', async () => {
  // The failure this guards is worth 32 reverted buys, so it is asserted
  // against the clock rather than against the loop's own bookkeeping.
  for (const tickAtMs of [0, 37, 500, 3000, 15999]) {
    const chain = fakeChain({ tickAtMs });
    const res = await run(chain);
    assert.equal(res.reason, 'ticked');
    assert.ok(
      chain.at() >= tickAtMs,
      `returned at ${chain.at()}ms for a tick at ${tickAtMs}ms — that buy would revert`
    );
  }
});

test('times every poll: when it went out, when it came back, how long it took', async () => {
  const chain = fakeChain({ rttMs: 8, tickAtMs: 300 });
  const res = await run(chain, { pollMs: 50 });

  assert.ok(res.polls.length > 1);
  for (const poll of res.polls) {
    assert.equal(poll.rttMs, 8, 'the round trip is measured, not assumed');
    assert.equal(poll.returnedMs - poll.issuedMs, poll.rttMs);
  }
  assert.equal(res.pollRtt.median, 8);
  assert.equal(res.pollRtt.n, res.pollCount);
});

test('the estimate of how late we noticed brackets the real tick', async () => {
  // This is the number the whole exercise turns on. It cannot be exact — the
  // chain is only observed at poll instants — so what is asserted is that the
  // true lateness lies inside the window the estimator reports.
  for (const tickAtMs of [123, 337, 1000, 2222]) {
    const chain = fakeChain({ rttMs: 6, tickAtMs });
    const res = await run(chain, { pollMs: 50 });

    const trueLagMs = res.observedTickMs - tickAtMs;
    assert.ok(res.detectionLagMs !== null, 'a tick must come with an estimate');
    assert.ok(
      Math.abs(res.detectionLagMs - trueLagMs) <= res.tickWindowMs / 2 + 0.1,
      `estimated ${res.detectionLagMs}ms late, really ${trueLagMs}ms, window ${res.tickWindowMs}ms`
    );
  }
});

test('the uncertainty window is the poll interval plus a round trip', async () => {
  // Sequential polling cannot resolve the tick more finely than one interval
  // plus the round trip it waits out first. Pinning that here is what makes any
  // later change to the poll schedule provable rather than plausible.
  const chain = fakeChain({ rttMs: 10, tickAtMs: 1000 });
  const res = await run(chain, { pollMs: 50 });
  assert.equal(res.tickWindowMs, 60, 'pollMs 50 + rtt 10');
});

test('a launch-block read taken before the wait tightens the first-poll estimate', async () => {
  // When the tick happens during the launch broadcast, the very first poll sees
  // it and there is no earlier poll to bound it — except the read taken before
  // the launch went out, which did see the old block.
  const chain = fakeChain({ rttMs: 6, tickAtMs: 0 });
  const res = await run(chain, {
    staleSince: { issuedMs: -40, returnedMs: -34, rttMs: 6 },
  });

  assert.equal(res.pollCount, 1, 'the first poll already saw the tick');
  assert.ok(res.detectionLagMs !== null, 'the pre-launch read still bounds it');
  // The pre-launch read observed at -40+3ms; the first poll observed at 0+3ms.
  assert.equal(res.tickWindowMs, 40, 'from the pre-launch read to the first poll');
});

test('without any earlier observation it says it does not know', async () => {
  // A guess dressed as a measurement is worse than an absent one.
  const chain = fakeChain({ rttMs: 6, tickAtMs: 0 });
  const res = await run(chain, { staleSince: null });
  assert.equal(res.pollCount, 1);
  assert.equal(res.detectionLagMs, null);
  assert.equal(res.tickWindowMs, null);
});

test('keeps the polls around the tick and counts the rest', async () => {
  // A sixteen-second wait makes hundreds of polls. Storing them all would bloat
  // every launch record; the informative ones are the last few.
  const chain = fakeChain({ rttMs: 5, tickAtMs: 6000 });
  const res = await run(chain, { pollMs: 50 });

  assert.ok(res.pollCount > KEEP_POLLS, `expected a long wait, got ${res.pollCount} polls`);
  assert.equal(res.polls.length, KEEP_POLLS);
  assert.equal(res.pollRtt.n, res.pollCount, 'the summary still covers every poll');
  assert.equal(
    res.polls[res.polls.length - 1].block,
    String(LAUNCH + 1n),
    'the tick is the one poll that must never be dropped'
  );
});

test('an unreadable block number gives up rather than throwing', async () => {
  // A bundle that fires late beats a launch that dies here.
  const chain = fakeChain({ failAfter: 0 });
  const res = await run(chain);
  assert.equal(res.reason, 'unreadable');
  assert.equal(res.waitedMs, null);
  assert.equal(res.observedTickMs, null);
  assert.equal(res.pollCount, 1, 'the failed read is still recorded');
});

test('a tick that never comes stops waiting and says so', async () => {
  const chain = fakeChain({ tickAtMs: Infinity });
  const res = await run(chain, { waitMs: 2000 });
  assert.equal(res.reason, 'timeout');
  assert.equal(typeof res.waitedMs, 'number');
  assert.ok(res.waitedMs >= 2000);
  assert.equal(res.observedTickMs, null, 'nothing was observed, so nothing is reported');
});

test('block numbers survive as strings, because JSON cannot hold a bigint', async () => {
  // The launch record is written to disk. An unconverted bigint throws on
  // JSON.stringify and would take the whole launch response with it.
  const chain = fakeChain({ tickAtMs: 100 });
  const res = await run(chain);
  assert.doesNotThrow(() => JSON.stringify(res));
  assert.ok(res.polls.every((p) => typeof p.block === 'string' || p.block === null));
});
