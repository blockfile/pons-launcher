import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMEFRAMES,
  alignTime,
  cleanBars,
  upsertBar,
  mergeOlderBar,
  drainBars,
  mcFactor,
  displayBar,
  volumeBar,
  minMoveFor,
  tradeId,
  mergeTrades,
  ownMarkers,
  tickLabel,
  crosshairTime,
} from './chartMath.js';

process.env.TZ = 'UTC';

const bar = (time, o, h, l, c, v = 1) => ({ time, open: o, high: h, low: l, close: c, volume: v });

test('timeframes are 1s / 15s / 1m / 5m / 1h', () => {
  assert.deepEqual(
    TIMEFRAMES.map((t) => [t.sec, t.label]),
    [
      [1, '1s'],
      [15, '15s'],
      [60, '1m'],
      [300, '5m'],
      [3600, '1h'],
    ]
  );
  assert.equal(alignTime(1_700_000_047, 15), 1_700_000_040);
  assert.equal(alignTime(1_700_000_047, 1), 1_700_000_047);
});

test('cleanBars sorts, de-duplicates (last wins) and drops broken bars', () => {
  const out = cleanBars([bar(3, 1, 1, 1, 1), bar(1, 1, 2, 1, 2), bar(3, 5, 5, 5, 5), { time: 2, open: NaN }, null]);
  assert.deepEqual(
    out.map((b) => [b.time, b.open]),
    [
      [1, 1],
      [3, 5],
    ]
  );
});

test('upsertBar appends, replaces the last, and ignores older bars', () => {
  const list = [bar(10, 1, 1, 1, 1)];
  assert.equal(upsertBar(list, bar(10, 1, 3, 1, 2)), 'replace');
  assert.equal(list[0].close, 2);
  assert.equal(upsertBar(list, bar(11, 2, 2, 2, 2)), 'append');
  assert.equal(upsertBar(list, bar(9, 0, 0, 0, 0)), 'stale');
  assert.equal(list.length, 2);
});

test('drainBars coalesces a frame of updates: latest per time, ascending, older bars kept', () => {
  const q = new Map();
  q.set(12, bar(12, 1, 1, 1, 1));
  q.set(11, bar(11, 1, 1, 1, 1));
  q.set(12, bar(12, 1, 9, 1, 9));
  q.set(8, bar(8, 1, 1, 1, 1));
  const out = drainBars(q);
  assert.deepEqual(
    out.map((b) => [b.time, b.close]),
    [
      [8, 1],
      [11, 1],
      [12, 9],
    ]
  );
  assert.equal(q.size, 0);
});

test('mergeOlderBar replaces an older time in place (historical update) or inserts a missing one in order', () => {
  const list = [bar(10, 1, 1, 1, 1), bar(20, 1, 1, 1, 1), bar(30, 1, 1, 1, 1)];
  const late = bar(20, 1, 4, 1, 3); // a late trade in the 20 s bucket
  assert.equal(upsertBar(list, late), 'stale');
  assert.equal(list[1].close, 1, 'upsertBar leaves an older time alone');
  assert.equal(mergeOlderBar(list, late), 'history');
  assert.equal(list[1].close, 3);
  assert.equal(list[1].high, 4);
  assert.equal(list.length, 3);
  assert.equal(mergeOlderBar(list, bar(10, 1, 2, 1, 2)), 'history', 'the first bar too');
  assert.equal(list[0].close, 2);
  assert.equal(mergeOlderBar(list, bar(15, 2, 2, 2, 2)), 'insert');
  assert.deepEqual(
    list.map((b) => b.time),
    [10, 15, 20, 30]
  );
  assert.equal(mergeOlderBar(list, bar(5, 2, 2, 2, 2)), 'insert');
  assert.deepEqual(
    list.map((b) => b.time),
    [5, 10, 15, 20, 30]
  );
  assert.equal(mergeOlderBar([], bar(1, 1, 1, 1, 1)), 'insert');
});

test('mcFactor = supply x USD per quote unit; absent inputs give null, never a guess', () => {
  const venue = { totalSupply: '1000000000000000000000000000', decimals: 18 }; // 1e9 tokens
  assert.equal(mcFactor(venue, 3000), 3e12);
  assert.equal(mcFactor(venue, null), null);
  assert.equal(mcFactor(venue, 0), null);
  assert.equal(mcFactor({ totalSupply: '0', decimals: 18 }, 3000), null);
  // price 1.8e-9 ETH/token x 1e9 tokens x $3000 = $5,400
  const b = displayBar(bar(1, 1.8e-9, 2e-9, 1e-9, 1.8e-9), mcFactor(venue, 3000));
  assert.ok(Math.abs(b.close - 5400) < 1e-6);
  assert.equal(displayBar(bar(1, 2, 2, 2, 2), null).close, 2);
});

test('volumeBar colours by direction', () => {
  const colors = { upVol: 'U', downVol: 'D' };
  assert.deepEqual(volumeBar(bar(5, 1, 2, 1, 2, 7), colors), { time: 5, value: 7, color: 'U' });
  assert.equal(volumeBar(bar(5, 2, 2, 1, 1, 7), colors).color, 'D');
});

test('minMoveFor tracks meme-sized prices', () => {
  assert.equal(minMoveFor([1.234e-9, 5e-9]), 1e-13);
  assert.equal(minMoveFor([5400.5, 6000]), 0.01);
  assert.equal(minMoveFor([]), 0.01);
  assert.equal(minMoveFor([1e-30]), 1e-18);
});

test('mergeTrades keeps the newest 100, de-duplicated', () => {
  const t = (block, logIndex, tx = `0x${block}${logIndex}`) => ({ block, logIndex, tx, ts: block, side: 'buy' });
  const cur = [t(5, 0), t(4, 1)];
  const merged = mergeTrades(cur, [t(4, 1), t(6, 2), t(6, 1)], 3);
  assert.deepEqual(merged.map(tradeId), ['0x62:2', '0x61:1', '0x50:0']);
  assert.equal(tradeId({ tx: '0xABC', logIndex: 3 }), '0xabc:3');
});

test('ownMarkers puts one counted arrow per candle', () => {
  const trades = [
    { ts: 100, tx: 'a' },
    { ts: 106, tx: 'b' },
    { ts: 130, tx: 'c' },
  ];
  assert.deepEqual(ownMarkers(trades, 15, '#fff'), [
    { time: 90, position: 'aboveBar', shape: 'arrowDown', color: '#fff', text: 'you' },
    { time: 105, position: 'aboveBar', shape: 'arrowDown', color: '#fff', text: 'you' },
    { time: 120, position: 'aboveBar', shape: 'arrowDown', color: '#fff', text: 'you' },
  ]);
  assert.deepEqual(
    ownMarkers(trades, 60, '#fff').map((x) => [x.time, x.text]),
    [
      [60, 'you ×2'],
      [120, 'you'],
    ]
  );
  assert.equal(ownMarkers(trades, 3600, '#fff')[0].text, 'you ×3');
});

test('tick and crosshair labels (UTC in this test)', () => {
  const t = Date.UTC(2026, 8, 19, 7, 5, 9) / 1000;
  assert.equal(tickLabel(t, 4), '07:05:09');
  assert.equal(tickLabel(t, 3), '07:05');
  assert.equal(tickLabel(t, 2), '19 Sep');
  assert.equal(tickLabel(t, 1), 'Sep');
  assert.equal(tickLabel(t, 0), '2026');
  assert.equal(tickLabel('2026-09-19', 0), null);
  assert.equal(crosshairTime(t), '19 Sep 07:05:09');
});
