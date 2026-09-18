'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CandleRing, INTERVALS } = require('./candles');

// 1_699_999_200 is a whole UTC hour, so it is aligned for every interval.
const T0 = 1_699_999_200;
const E18 = 10n ** 18n;

let seq = 0;
function trade(ts, price, quoteEth = 1, order = {}) {
  seq += 1;
  return {
    ts,
    price,
    quoteAmt: (BigInt(Math.round(quoteEth * 1e6)) * E18 / 1_000_000n).toString(),
    tokenAmt: '1',
    block: order.block ?? ts * 10,
    logIndex: order.logIndex ?? seq,
    side: 'buy',
    tx: '0x' + String(seq).padStart(64, '0'),
    trader: '0x' + '1'.repeat(40),
  };
}

test('INTERVALS are the five chart timeframes', () => {
  assert.deepEqual(INTERVALS, [1, 15, 60, 300, 3600]);
});

test('1 s bars: OHLC and quote volume per second', () => {
  const r = new CandleRing();
  r.add(trade(T0, 1.0, 0.5));
  r.add(trade(T0, 3.0, 0.25));
  r.add(trade(T0, 2.0, 0.25));
  r.add(trade(T0 + 1, 5.0, 1));
  const bars = r.bars(1, 10);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { time: T0, open: 1, high: 3, low: 1, close: 2, volume: 1 });
  assert.deepEqual(bars[1], { time: T0 + 1, open: 5, high: 5, low: 5, close: 5, volume: 1 });
});

test('volume is in human quote units for a 6-decimal pair', () => {
  const r = new CandleRing({ quoteDecimals: 6 });
  r.add({ ...trade(T0, 1), quoteAmt: '2500000' }); // 2.5 USDG
  assert.equal(r.bars(1, 1)[0].volume, 2.5);
});

test('out-of-order trades inside one second keep chain order for open and close', () => {
  const r = new CandleRing();
  r.add(trade(T0, 3.0, 1, { block: 100, logIndex: 5 })); // later in the chain
  r.add(trade(T0, 1.0, 1, { block: 100, logIndex: 2 })); // earlier, arrives second
  r.add(trade(T0, 2.0, 1, { block: 99, logIndex: 40 })); // earliest of all
  const [bar] = r.bars(1, 1);
  assert.equal(bar.open, 2);
  assert.equal(bar.close, 3);
  assert.equal(bar.high, 3);
  assert.equal(bar.low, 1);
});

test('an older second added after a newer one lands in order', () => {
  const r = new CandleRing();
  r.add(trade(T0 + 5, 2));
  r.add(trade(T0 + 3, 1));
  assert.deepEqual(r.bars(1, 5).map((b) => b.time), [T0 + 3, T0 + 5]);
});

test('folds 1 s bars into aligned 15 s / 60 s / 300 s / 3600 s buckets', () => {
  const r = new CandleRing();
  r.add(trade(T0 + 0, 1, 1));
  r.add(trade(T0 + 14, 4, 1));
  r.add(trade(T0 + 15, 2, 1));
  r.add(trade(T0 + 59, 0.5, 1));
  r.add(trade(T0 + 60, 3, 1));

  const b15 = r.bars(15, 10);
  assert.deepEqual(
    b15.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]),
    [
      [T0, 1, 4, 1, 4, 2],
      [T0 + 15, 2, 2, 2, 2, 1],
      [T0 + 45, 0.5, 0.5, 0.5, 0.5, 1],
      [T0 + 60, 3, 3, 3, 3, 1],
    ]
  );
  const b60 = r.bars(60, 10);
  assert.deepEqual(
    b60.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]),
    [
      [T0, 1, 4, 0.5, 0.5, 4],
      [T0 + 60, 3, 3, 3, 3, 1],
    ]
  );
  assert.deepEqual(r.bars(300, 10).map((b) => b.time), [T0]);
  const [hour] = r.bars(3600, 10);
  assert.deepEqual([hour.time, hour.open, hour.close, hour.volume], [T0, 1, 3, 5]);
  for (const iv of INTERVALS) {
    for (const b of r.bars(iv, 100)) assert.equal(b.time % iv, 0, `bar ${b.time} aligned to ${iv}`);
  }
});

test('limit returns the most recent bars, oldest first', () => {
  const r = new CandleRing();
  for (let i = 0; i < 10; i++) r.add(trade(T0 + i, i + 1));
  assert.deepEqual(r.bars(1, 3).map((b) => b.close), [8, 9, 10]);
  assert.equal(r.bars(1).length, 10, 'no limit → everything held');
  assert.deepEqual(r.bars(1, 0), []);
});

test('lastBar and barAt read single buckets', () => {
  const r = new CandleRing();
  assert.equal(r.lastBar(15), null);
  r.add(trade(T0 + 1, 1, 1));
  r.add(trade(T0 + 16, 2, 1));
  r.add(trade(T0 + 20, 3, 1));
  assert.deepEqual(r.lastBar(15), { time: T0 + 15, open: 2, high: 3, low: 2, close: 3, volume: 2 });
  assert.deepEqual(r.barAt(15, T0), { time: T0, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  assert.deepEqual(r.barAt(15, T0 + 7), r.barAt(15, T0), 'an unaligned time names its bucket');
  assert.equal(r.barAt(15, T0 + 30), null);
});

test('the ring keeps maxSeconds of history and refuses anything older', () => {
  const r = new CandleRing({ maxSeconds: 10 });
  assert.equal(r.add(trade(T0, 1)), true);
  assert.equal(r.add(trade(T0 + 9, 2)), true);
  assert.deepEqual(r.bars(1).map((b) => b.time), [T0, T0 + 9]);
  assert.equal(r.add(trade(T0 + 10, 3)), true); // evicts T0 (same slot)
  assert.deepEqual(r.bars(1).map((b) => b.time), [T0 + 9, T0 + 10]);
  assert.equal(r.add(trade(T0, 9)), false, 'older than the window');
  assert.deepEqual(r.bars(1).map((b) => b.close), [2, 3]);
});

test('bad input is refused, not charted', () => {
  const r = new CandleRing();
  assert.equal(r.add(trade(0, 1)), false, 'ts 0 = unknown time');
  assert.equal(r.add(trade(T0, 0)), false);
  assert.equal(r.add(trade(T0, NaN)), false);
  assert.equal(r.add(null), false);
  assert.deepEqual(r.bars(1), []);
  assert.throws(() => r.bars(7, 1), RangeError);
  assert.throws(() => new CandleRing({ maxSeconds: 0 }), RangeError);
});

test('a full day at one trade per second folds fast enough to serve a snapshot', () => {
  const r = new CandleRing();
  for (let i = 0; i < 86_400; i++) r.add(trade(T0 + i, 1 + (i % 7), 0.001));
  const started = process.hrtime.bigint();
  const bars = r.bars(1, 3600);
  const hours = r.bars(3600, 100);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(bars.length, 3600);
  assert.equal(hours.length, 24);
  assert.ok(ms < 250, `folding took ${ms} ms`);
});
