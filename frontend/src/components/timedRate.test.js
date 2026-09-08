import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WALLETS_PER_TICK,
  WALLETS_PER_TICK_OPTIONS,
  TIMED_INTERVALS,
  capReason,
  formatSpan,
  intervalLabel,
  timedRate,
} from './timedRate.js';

// The run this exists for: 31 wallets, one a minute, 31 minutes — and the
// operator asking why the timed path could not do three or four at a time.
test('the operator question: 31 wallets at 4 a minute is about 8 minutes', () => {
  const r = timedRate({ wallets: 31, perTick: 4, intervalMinutes: 1 });
  assert.equal(r.ticks, 8);
  assert.equal(r.minutes, 8);
  assert.equal(r.rate, '4 wallets a minute');
  assert.equal(r.eta, 'about 8 min for 31 wallets');
  assert.equal(r.sentence, '4 wallets a minute — about 8 min for 31 wallets');
});

test('the unchanged default is still one a minute, and says the 31 minutes out loud', () => {
  const r = timedRate({ wallets: 31, perTick: 1, intervalMinutes: 1 });
  assert.equal(r.ticks, 31);
  assert.equal(r.sentence, '1 wallet a minute — about 31 min for 31 wallets');
});

test('a partial last tick still counts as a tick', () => {
  assert.equal(timedRate({ wallets: 9, perTick: 4, intervalMinutes: 1 }).ticks, 3);
  assert.equal(timedRate({ wallets: 8, perTick: 4, intervalMinutes: 1 }).ticks, 2);
  assert.equal(timedRate({ wallets: 1, perTick: 4, intervalMinutes: 1 }).ticks, 1);
});

test('the cap is enforced by the maths as well as by the select', () => {
  const r = timedRate({ wallets: 31, perTick: 20, intervalMinutes: 1 });
  assert.equal(r.overCap, true);
  assert.equal(r.perTick, MAX_WALLETS_PER_TICK, 'the quoted rate is never one Relay would refuse');
  assert.equal(r.ticks, 8);
  // And the offered options never exceed it in the first place.
  assert.equal(Math.max(...WALLETS_PER_TICK_OPTIONS), MAX_WALLETS_PER_TICK);
  assert.match(capReason(), /max 4 a tick/);
  assert.match(capReason(), /re-arms the block/);
});

test('a server that says its own cap is the one that is honoured', () => {
  const r = timedRate({ wallets: 12, perTick: 4, intervalMinutes: 1, max: 2 });
  assert.equal(r.perTick, 2);
  assert.equal(r.overCap, true);
  assert.equal(r.ticks, 6);
});

test('the long intervals still read as English', () => {
  assert.equal(timedRate({ wallets: 4, perTick: 2, intervalMinutes: 60 }).rate, '2 wallets an hour');
  assert.equal(timedRate({ wallets: 4, perTick: 2, intervalMinutes: 30 }).rate, '2 wallets every 30 min');
  assert.equal(timedRate({ wallets: 4, perTick: 2, intervalMinutes: 120 }).rate, '2 wallets every 2 hrs');
  assert.equal(timedRate({ wallets: 31, perTick: 1, intervalMinutes: 60 }).eta, 'about 1 day 7 hr for 31 wallets');
});

test('no wallets, no promise about how long they will take', () => {
  const r = timedRate({ wallets: 0, perTick: 4, intervalMinutes: 1 });
  assert.equal(r.ticks, 0);
  assert.equal(r.eta, '');
  assert.equal(r.sentence, '4 wallets a minute');
});

test('garbage in does not produce a wrong promise', () => {
  const r = timedRate({ wallets: undefined, perTick: undefined, intervalMinutes: undefined });
  assert.equal(r.perTick, 1);
  assert.equal(r.intervalMinutes, 30);
  assert.equal(r.eta, '');
  const junk = timedRate({ wallets: 'x', perTick: 'x', intervalMinutes: 'x' });
  assert.equal(junk.perTick, 1);
  assert.equal(junk.intervalMinutes, 1);
  assert.equal(junk.wallets, 0);
});

test('spans are read the way a clock is', () => {
  assert.equal(formatSpan(0), 'under a minute');
  assert.equal(formatSpan(8), '8 min');
  assert.equal(formatSpan(60), '1 hr');
  assert.equal(formatSpan(80), '1 hr 20 min');
  assert.equal(formatSpan(1440), '1 day');
  assert.equal(formatSpan(2880), '2 days');
});

test('every offered interval has a label', () => {
  for (const i of TIMED_INTERVALS) assert.equal(intervalLabel(i.minutes), i.label);
  assert.equal(intervalLabel(7), '7 min');
});
