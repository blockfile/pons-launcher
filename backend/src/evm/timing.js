'use strict';

// One clock, and one vocabulary, for everything that measures a launch.
//
// Two launches were lost by roughly 100 milliseconds — one RPC block — between
// the EVM's block.number ticking past the launch block and our first buy
// reaching the wire. Nothing in the codebase could say WHERE those milliseconds
// went: whether we noticed the tick late, or noticed it on time and were slow
// to broadcast. These helpers exist so that question has an answer in the
// launch record rather than a theory.
//
// Date.now() is the wrong instrument for it. It is wall clock: it steps when
// ntp corrects the VPS, and a 20ms step is a fifth of the entire budget we are
// arguing about. performance.now() is a monotonic counter that cannot step, so
// every DURATION here is measured against it, and wall clock is sampled exactly
// once per launch so the numbers can still be lined up against a block
// explorer afterwards.

const { performance } = require('node:perf_hooks');

/** Milliseconds on a monotonic counter. Meaningless in absolute terms; only differences count. */
const monotonic = () => performance.now();

/**
 * Round to a tenth of a millisecond.
 *
 * Full float precision from performance.now() is noise at this scale and makes
 * the launch record unreadable, but whole milliseconds would round away the
 * difference between a 0.4ms local dispatch and a 0ms one.
 */
function ms(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

/**
 * A stopwatch reading milliseconds since it was created.
 * @param {() => number} [now] injectable clock — tests pass a fake one so no test ever waits.
 */
function stopwatch(now = monotonic) {
  const started = now();
  const read = () => ms(now() - started);
  read.raw = () => now() - started;
  read.startedAt = started;
  return read;
}

/** The p-th percentile of `values` by nearest rank. p is 0..100. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/**
 * min / median / p95 / max over a set of samples.
 *
 * Median and p95 rather than a mean because the thing being measured is a
 * network round trip: one 400ms retry drags a mean somewhere no sample ever
 * was, and it is the typical case and the bad tail that decide a race.
 */
function summary(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { n: 0, min: null, median: null, p95: null, max: null };
  return {
    n: clean.length,
    min: ms(Math.min(...clean)),
    median: ms(percentile(clean, 50)),
    p95: ms(percentile(clean, 95)),
    max: ms(Math.max(...clean)),
  };
}

module.exports = { monotonic, ms, stopwatch, percentile, summary };
