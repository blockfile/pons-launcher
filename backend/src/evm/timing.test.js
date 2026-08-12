'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ms, stopwatch, percentile, summary } = require('./timing');

test('ms keeps a tenth of a millisecond and nothing finer', () => {
  // 0.4ms of local dispatch and 0ms of it are different answers to "is the
  // event loop costing us the block", so tenths have to survive.
  assert.equal(ms(0.44), 0.4);
  assert.equal(ms(0.45), 0.5);
  assert.equal(ms(12.3456), 12.3);
  assert.equal(ms(0), 0);
});

test('ms reports an absent measurement as absent rather than zero', () => {
  // A missing number must never read as "it took no time".
  assert.equal(ms(null), null);
  assert.equal(ms(undefined), null);
  assert.equal(ms(NaN), null);
  assert.equal(ms(Infinity), null);
});

test('a stopwatch measures against the clock it is handed', () => {
  let t = 1000;
  const elapsed = stopwatch(() => t);
  assert.equal(elapsed(), 0);
  t = 1042.37;
  assert.equal(elapsed(), 42.4);
  // No real time passed: the whole point is that tests never wait.
  t = 1100;
  assert.equal(elapsed(), 100);
});

test('percentile picks by nearest rank, so p95 is a sample that happened', () => {
  const values = [10, 1, 5, 3, 2];
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 50), 3);
  assert.equal(percentile(values, 100), 10);
  assert.equal(percentile([], 50), null);
});

test('summary reports the typical case and the tail, not a mean', () => {
  // One 400ms retry among twenty 6ms reads. A mean would say ~26ms, a latency
  // no sample was anywhere near; the median and p95 keep both truths.
  const values = [...Array(19).fill(6), 400];
  const s = summary(values);
  assert.equal(s.n, 20);
  assert.equal(s.min, 6);
  assert.equal(s.median, 6);
  assert.equal(s.max, 400);
  assert.equal(s.p95, 6, 'nineteen of twenty samples were 6ms');
});

test('summary of nothing is empty, not zero', () => {
  const s = summary([]);
  assert.deepEqual(s, { n: 0, min: null, median: null, p95: null, max: null });
});

test('summary ignores samples that never completed', () => {
  const s = summary([5, null, 7, undefined, NaN]);
  assert.equal(s.n, 2);
  assert.equal(s.min, 5);
  assert.equal(s.max, 7);
});
