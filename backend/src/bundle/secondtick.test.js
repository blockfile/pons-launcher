'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { waitForFreshSecond, readLatestHeader, MAX_IN_FLIGHT } = require('./secondtick');

// A chain whose header timestamp is whatever the script says at that read.
// Reads answer after `rttMs` of fake time, so the cadence and the round trip
// can be pulled apart without a real clock.
function fakeChain(seconds, { rttMs = 5, fail = () => false } = {}) {
  const chain = { reads: 0, inFlight: 0, maxInFlight: 0, clock: 0 };
  chain.now = () => chain.clock;
  chain.pause = async (delay) => {
    chain.clock += delay;
  };
  chain.readHeader = async () => {
    const i = chain.reads++;
    chain.inFlight += 1;
    chain.maxInFlight = Math.max(chain.maxInFlight, chain.inFlight);
    await Promise.resolve();
    chain.clock += rttMs;
    chain.inFlight -= 1;
    if (fail(i)) throw new Error('node said no');
    return { timestamp: seconds[Math.min(i, seconds.length - 1)] };
  };
  return chain;
}

const run = (chain, over = {}) =>
  waitForFreshSecond({
    rpc: {},
    readHeader: chain.readHeader,
    pause: chain.pause,
    now: chain.now,
    pollMs: 20,
    maxWaitMs: 1500,
    ...over,
  });

test('returns the moment a read shows the next second, and says which seconds it saw', async () => {
  const chain = fakeChain([100, 100, 100, 101, 101]);
  const res = await run(chain);

  assert.equal(res.ticked, true);
  assert.equal(res.fromSecond, 100);
  assert.equal(res.toSecond, 101);
  assert.ok(res.reads >= 2, `expected at least two reads, got ${res.reads}`);
  assert.ok(res.waitedMs > 0, 'the wait is timed');
  assert.equal(res.reason, 'ticked');
});

test('a chain that never ticks gives up at maxWaitMs and lets the launch go', async () => {
  const chain = fakeChain([100]);
  const res = await run(chain, { maxWaitMs: 200 });

  assert.equal(res.ticked, false);
  assert.equal(res.reason, 'timeout');
  assert.ok(res.waitedMs >= 200, `waited ${res.waitedMs}ms`);
  assert.equal(res.fromSecond, 100);
});

test('read errors do not abort the wait: a later tick still wins', async () => {
  // The first read works (so the starting second is known), the next three
  // fail, then the chain ticks.
  const chain = fakeChain([100, 100, 100, 100, 101], { fail: (i) => i >= 1 && i <= 3 });
  const res = await run(chain);

  assert.equal(res.ticked, true);
  assert.equal(res.toSecond, 101);
  assert.ok(res.errors >= 3, `expected the failures to be counted, got ${res.errors}`);
});

test('a node that answers nothing at all is reported, not thrown', async () => {
  const chain = fakeChain([100], { fail: () => true });
  const res = await run(chain, { maxWaitMs: 150 });

  assert.equal(res.ticked, false);
  assert.equal(res.reason, 'unreadable');
  assert.equal(res.fromSecond, null);
  assert.ok(res.errors > 0);
});

test('polls overlap but never pile up: in-flight reads are capped', async () => {
  // A node that takes every read and answers none of them. Without a cap the
  // cadence would keep issuing one every interval until the wait expired.
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let clock = 0;
  const res = await waitForFreshSecond({
    rpc: {},
    readHeader: () =>
      new Promise(() => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pending.push(1);
      }),
    pause: async (delay) => {
      clock += delay;
    },
    now: () => clock,
    pollMs: 10,
    // Past its deadline a read stops counting against the cap (it is not coming
    // back in time to matter), so the cap is measured with the reads still live.
    readTimeoutMs: 10000,
    maxWaitMs: 200,
  });

  assert.equal(res.ticked, false);
  assert.equal(res.reason, 'unreadable');
  assert.ok(maxInFlight <= MAX_IN_FLIGHT, `in-flight reached ${maxInFlight}, cap is ${MAX_IN_FLIGHT}`);
  assert.ok(res.skipped > 0, 'the cadence records the polls it had to skip');
});

test('disabled by the caller: no read is made and nothing is waited', async () => {
  const chain = fakeChain([100, 101]);
  const res = await run(chain, { enabled: false });

  assert.equal(res.ticked, false);
  assert.equal(res.reason, 'disabled');
  assert.equal(res.waitedMs, 0);
  assert.equal(chain.reads, 0);
});

test('a node answering nothing gives up after a few reads, not after the whole budget', async () => {
  // The budget is a second and a half; an endpoint that refuses every read
  // must not spend it, because the launch is waiting behind this.
  const chain = fakeChain([100], { fail: () => true });
  const res = await run(chain, { maxWaitMs: 5000 });

  assert.equal(res.reason, 'unreadable');
  assert.ok(res.waitedMs < 1000, `gave up after ${res.waitedMs}ms`);
  assert.ok(res.errors >= 3, `errors counted: ${res.errors}`);
});

test('the header read goes straight to the node, past ethers\' 250ms cache', async () => {
  // getBlock('latest') is served from AbstractProvider's per-tag cache for
  // 250ms (cacheTimeout), which would turn a 20ms cadence into a 250ms one and
  // land the launch a block later. The read has to be the raw call.
  const calls = [];
  const rpc = {
    send: async (method, params) => {
      calls.push([method, ...params]);
      return { timestamp: '0x6aae82d7' };
    },
    getBlock: async () => {
      throw new Error('getBlock must not be used: it is cached');
    },
  };
  const header = await readLatestHeader(rpc);

  assert.deepEqual(calls, [['eth_getBlockByNumber', 'latest', false]]);
  assert.equal(header.timestamp, 0x6aae82d7);
});

test('a timestamp that goes backwards never counts as a tick', async () => {
  // A load-balanced endpoint can answer from replicas that straddle a second
  // boundary (provider.js documents this chain's RPC as exactly that). Seeing
  // 101, then a lagging 100, then 101 again is the same second twice — not a
  // tick — and launching there would put the launch at an arbitrary point in
  // the second while the record claimed the hold worked.
  const chain = fakeChain([101, 100, 101, 100, 101]);
  const res = await run(chain, { maxWaitMs: 200 });

  assert.equal(res.ticked, false, 'the baseline must never ratchet down');
  assert.equal(res.reason, 'timeout');
  assert.equal(res.fromSecond, 101);
});

test('a read that does not answer in time counts as an error, so the early exit can fire', async () => {
  // The provider retries a read four times with backoff before it ever rejects
  // (~1.8s), which is past the whole budget: without its own deadline every
  // read would still be outstanding when the wait gave up, and the "gives up
  // after a few unanswered reads" promise would be empty.
  let clock = 0;
  const res = await waitForFreshSecond({
    rpc: {},
    readHeader: () => new Promise(() => {}),
    pause: async (delay) => {
      clock += delay;
    },
    now: () => clock,
    pollMs: 20,
    readTimeoutMs: 60,
    maxWaitMs: 5000,
  });

  assert.equal(res.ticked, false);
  assert.equal(res.reason, 'unreadable');
  assert.ok(res.errors >= 5, `expected the timed-out reads to be counted, got ${res.errors}`);
  assert.ok(res.waitedMs < 2000, `gave up after ${res.waitedMs}ms`);
});

test('the wait never sleeps past its own budget', async () => {
  // A misconfigured cadence must not become a longer hold than the ceiling.
  const chain = fakeChain([100]);
  const res = await run(chain, { pollMs: 5000, maxWaitMs: 300 });

  assert.ok(res.waitedMs <= 400, `waited ${res.waitedMs}ms against a 300ms ceiling`);
  assert.equal(res.ticked, false);
});

test('a header the node cannot express is an error, and is not also counted as a read', async () => {
  const chain = fakeChain([100]);
  const res = await waitForFreshSecond({
    rpc: {},
    readHeader: async () => ({ timestamp: 'not a number' }),
    pause: chain.pause,
    now: chain.now,
    pollMs: 20,
    maxWaitMs: 200,
  });

  assert.equal(res.reads, 0, 'a header with no usable timestamp was not a reading');
  assert.ok(res.errors > 0);
});

test('a read that misses its deadline and THEN rejects is counted once, not twice', async () => {
  // The give-up fires on five failures, so double-counting one read would halve
  // the number of endpoints' worth of patience the hold has: a slow-but-alive
  // node would be abandoned and the record would call it unreadable.
  let clock = 0;
  let rejectIt;
  const res = await waitForFreshSecond({
    rpc: {},
    readHeader: () =>
      new Promise((_resolve, reject) => {
        if (!rejectIt) rejectIt = reject;
      }),
    pause: async (delay) => {
      clock += delay;
      // Once the first read has expired (deadline 60ms), let it fail as well.
      if (clock >= 100 && rejectIt) {
        const r = rejectIt;
        rejectIt = null;
        r(new Error('too late, and refused'));
        await Promise.resolve();
      }
    },
    now: () => clock,
    pollMs: 20,
    readTimeoutMs: 60,
    maxWaitMs: 200,
    maxErrorsBeforeAnyReading: 99, // keep the wait alive long enough to observe both
  });

  // Reads are issued every 20ms into a node that answers none of them, so the
  // count is bounded by the cadence — what matters is that the one read which
  // expired AND rejected contributed a single error.
  const issued = Math.ceil(res.waitedMs / 20);
  assert.ok(
    res.errors <= issued,
    `each read failed at most once: ${res.errors} errors from at most ${issued} reads`
  );
  assert.equal(res.ticked, false);
});
