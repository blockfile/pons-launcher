'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { waitForFreshSecond, MAX_IN_FLIGHT } = require('./secondtick');

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
