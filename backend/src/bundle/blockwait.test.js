'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { waitForNextBlock, KEEP_POLLS, MAX_IN_FLIGHT } = require('./blockwait');

const LAUNCH = 100n;

// Lets every pending microtask run without any real time passing. setImmediate
// fires after the microtask queue drains, so a read whose virtual deadline has
// just been reached has actually delivered its answer by the time this resolves.
const flush = () => new Promise((r) => setImmediate(r));

/**
 * A chain on a virtual clock, with reads that genuinely overlap.
 *
 * Nothing here waits: time only moves when the code under test sleeps, so a
 * sixteen-second block costs the test microseconds. But a read no longer
 * consumes the caller's time — it is queued to resolve once the virtual clock
 * reaches its deadline, which is what makes concurrent polls modellable at all.
 *
 * The read observes the chain at issue + rtt/2 and answers at issue + rtt. That
 * midpoint is exactly what the estimator assumes, so modelling it is what makes
 * the lateness estimate testable rather than merely plausible.
 */
function fakeChain({ rttMs = 6, tickAtMs = 500, failAfter = null, rttFor = null } = {}) {
  let t = 0;
  let reads = 0;
  let peakInFlight = 0;
  let inFlight = 0;
  const queue = [];

  // Flushing after each answer matters: the code under test reads the clock
  // inside its own .then, so the clock has to still say the answer's deadline
  // when that runs. Jumping straight to `target` would time every read as if it
  // had arrived at the end of the interval.
  const advanceTo = async (target) => {
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      if (!queue.length || queue[0].at > target) break;
      const next = queue.shift();
      t = Math.max(t, next.at);
      inFlight -= 1;
      next.fire();
      await flush();
    }
    t = Math.max(t, target);
  };

  return {
    now: () => t,
    at: () => t,
    reads: () => reads,
    peakInFlight: () => peakInFlight,
    pause: async (delay) => {
      await advanceTo(t + delay);
      await flush();
    },
    readBlock: () => {
      const n = (reads += 1);
      const rtt = rttFor ? rttFor(n) : rttMs;
      const issuedAt = t;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      return new Promise((resolve, reject) => {
        queue.push({
          at: issuedAt + rtt,
          fire: () => {
            if (failAfter !== null && n > failAfter) return reject(new Error('multicall unreachable'));
            resolve(issuedAt + rtt / 2 >= tickAtMs ? LAUNCH + 1n : LAUNCH);
          },
        });
      });
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

test('the uncertainty window is the poll interval, not the interval plus a round trip', async () => {
  // This is the whole Phase 2 change, stated as a number. A sequential poller
  // cannot issue a read until the last one answered, so it resolves the tick no
  // finer than pollMs + rtt. Overlapping the reads puts the round trip outside
  // the period, and the window collapses to the interval alone.
  for (const rttMs of [10, 40, 90]) {
    const chain = fakeChain({ rttMs, tickAtMs: 1000 });
    const res = await run(chain, { pollMs: 50 });
    assert.equal(
      res.tickWindowMs,
      50,
      `a ${rttMs}ms read must not widen a 50ms cadence — that was the bug`
    );
  }
});

test('a read slower than the interval does not stall the cadence', async () => {
  // A 200ms read against a 25ms cadence. Sequentially that is one read every
  // 225ms and a 225ms blind spot around the tick; overlapped, the reads pile up
  // until the in-flight ceiling throttles them to one per 50ms.
  const chain = fakeChain({ rttMs: 200, tickAtMs: 2000 });
  const res = await run(chain, { pollMs: 25 });

  assert.ok(chain.peakInFlight() > 1, 'reads must actually be concurrent');
  assert.equal(
    chain.peakInFlight(),
    MAX_IN_FLIGHT,
    `in-flight reads must stop at the ceiling, saw ${chain.peakInFlight()}`
  );
  assert.ok(res.skipped > 0, 'polls the ceiling refused are counted, not hidden');
  assert.ok(
    res.tickWindowMs < 225,
    `a sequential poller would be blind for 225ms; this was ${res.tickWindowMs}ms`
  );
});

test('the in-flight ceiling is what bounds sockets held at the tick', async () => {
  // fire.js warms MAX_IN_FLIGHT sockets on top of one per buy on the strength
  // of this. If the ceiling stopped binding, the burst would find the pool
  // short at exactly the wrong moment.
  const chain = fakeChain({ rttMs: 5000, tickAtMs: 20000 });
  await run(chain, { pollMs: 1, waitMs: 3000 });
  assert.equal(chain.peakInFlight(), MAX_IN_FLIGHT);
});

test('the wait ends on the answer, not on the next scheduled poll', async () => {
  // Overlapping is pointless if the winning answer then waits out the rest of
  // an interval in a queue. The tick must be reported at the instant the read
  // that saw it came back.
  const chain = fakeChain({ rttMs: 30, tickAtMs: 200 });
  const res = await run(chain, { pollMs: 25 });

  const winner = res.polls[res.polls.length - 1];
  assert.equal(res.observedTickMs, winner.returnedMs);
  assert.equal(chain.at(), winner.returnedMs, 'the loop returned on the answer itself');
});

test('a stale answer arriving late never masquerades as the tick', async () => {
  // Out-of-order answers are the hazard overlapping introduces. A read issued
  // early and answered slowly still saw the old block, and must only ever be
  // used as a lower bound — never as a reason to keep waiting past the tick,
  // and never as the tick itself.
  const chain = fakeChain({
    tickAtMs: 60,
    // The first read crawls; later ones are quick and overtake it.
    rttFor: (n) => (n === 1 ? 500 : 5),
  });
  const res = await run(chain, { pollMs: 25 });

  assert.equal(res.reason, 'ticked');
  const winner = res.polls[res.polls.length - 1];
  assert.equal(winner.block, String(LAUNCH + 1n));
  assert.ok(chain.at() < 500, 'the slow read must not have held the bundle back');
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

test('one failed read does not abandon the wait', async () => {
  // Giving up means firing without knowing the block ticked, and if it has not
  // then all 32 buys revert. A single blip must never be allowed to cause that.
  const chain = fakeChain({ rttMs: 5, tickAtMs: 400, failAfter: null });
  let reads = 0;
  const res = await waitForNextBlock(LAUNCH, {
    rpc: {},
    readBlock: () => {
      if (++reads === 1) return Promise.reject(new Error('transient'));
      return chain.readBlock();
    },
    pause: chain.pause,
    now: chain.now,
    originMs: 0,
    pollMs: 25,
    waitMs: 90000,
  });

  assert.equal(res.reason, 'ticked', 'a blip must not turn into a blind fire');
  assert.equal(res.errors, 1);
});

test('an endpoint that has stopped answering gives up rather than throwing', async () => {
  // Persistent failure is different from a blip. The provider already retries
  // each read four times with backoff before it fails here, so this many in a
  // row is an endpoint that is gone.
  const chain = fakeChain({ failAfter: 0 });
  const res = await run(chain, { maxConsecutiveErrors: 5 });
  assert.equal(res.reason, 'unreadable');
  assert.equal(res.waitedMs, null);
  assert.equal(res.observedTickMs, null);
  assert.equal(res.errors, 5, 'every failure is counted');
  assert.ok(res.pollCount >= 5, 'the failed reads are still recorded');
});

test('a run of failures that recovers is forgiven, not accumulated', async () => {
  // The counter has to be consecutive. Counting failures cumulatively would let
  // a flaky-but-working endpoint trip the give-up on an otherwise fine launch.
  const chain = fakeChain({ rttMs: 5, tickAtMs: 2000 });
  let reads = 0;
  const res = await waitForNextBlock(LAUNCH, {
    rpc: {},
    readBlock: () => {
      reads += 1;
      // Fails three in every four, forever — but never four in a row.
      if (reads % 4) return Promise.reject(new Error('flaky'));
      return chain.readBlock();
    },
    pause: chain.pause,
    now: chain.now,
    originMs: 0,
    pollMs: 25,
    waitMs: 90000,
    maxConsecutiveErrors: 4,
  });

  assert.equal(res.reason, 'ticked');
  assert.ok(res.errors > 4, `expected many forgiven failures, saw ${res.errors}`);
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
