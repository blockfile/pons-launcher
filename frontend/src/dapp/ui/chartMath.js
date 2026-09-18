/**
 * Pure helpers for the chart and the trades feed. The chart itself
 * (Chart.jsx) only wires these to lightweight-charts through refs.
 */
import { toNumber } from './format.js';

export const TIMEFRAMES = Object.freeze([
  { sec: 1, label: '1s' },
  { sec: 15, label: '15s' },
  { sec: 60, label: '1m' },
  { sec: 300, label: '5m' },
  { sec: 3600, label: '1h' },
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function alignTime(ts, interval) {
  return Math.floor(Number(ts) / interval) * interval;
}

/** Snapshot bars -> strictly ascending, unique times (setData throws otherwise). The last bar per time wins. */
export function cleanBars(bars) {
  const byTime = new Map();
  for (const b of bars || []) {
    if (!b || !Number.isFinite(b.time)) continue;
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    byTime.set(b.time, b);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Keep the raw bar list in step with a live bar at the newest end.
 * 'append' | 'replace' (the last bar) | 'stale' (older than the last bar: the
 * list is left untouched and the caller hands the bar to mergeOlderBar).
 */
export function upsertBar(list, bar) {
  const last = list[list.length - 1];
  if (!last || bar.time > last.time) {
    list.push(bar);
    return 'append';
  }
  if (bar.time === last.time) {
    list[list.length - 1] = bar;
    return 'replace';
  }
  return 'stale';
}

/**
 * A bar OLDER than the chart's last one — a late trade in an earlier bucket
 * (Task 7 contract note 4: the stream sends one `bar` per bucket a batch
 * touched). Returns 'history' after replacing a time the list already holds —
 * the chart then applies it with series.update(bar, true) (lightweight-charts
 * 5.2.1: historicalUpdate updates an existing older point only) — or 'insert'
 * after inserting a time the list lacks at its sorted place, which the chart
 * must repaint with setData (update cannot insert into the middle).
 */
export function mergeOlderBar(list, bar) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time < bar.time) lo = mid + 1;
    else hi = mid;
  }
  if (lo < list.length && list[lo].time === bar.time) {
    list[lo] = bar;
    return 'history';
  }
  list.splice(lo, 0, bar);
  return 'insert';
}

/**
 * Bar updates queued between two animation frames (a Map time -> bar, so the
 * latest per time wins), ascending by time. Older-than-the-chart bars are
 * KEPT: the caller routes them through upsertBar -> 'stale' -> mergeOlderBar
 * instead of dropping them (a dropped late bar would leave a wrong candle until
 * the next snapshot, which only comes when the history grows).
 */
export function drainBars(queue) {
  const out = [...queue.values()].sort((a, b) => a.time - b.time);
  queue.clear();
  return out;
}

/**
 * Market cap per unit of price: supply (human) x USD per quote unit. With
 * price in quote-per-token, price x this = MC in USD. null when the USD price
 * or the supply is missing — the chart then shows price, with the reason.
 */
export function mcFactor(venue, quoteUsd) {
  if (!venue || !(Number(quoteUsd) > 0)) return null;
  const supply = toNumber(venue.totalSupply, venue.decimals);
  return Number.isFinite(supply) && supply > 0 ? supply * Number(quoteUsd) : null;
}

export function displayBar(bar, factor) {
  const k = factor === null || factor === undefined ? 1 : factor;
  return { time: bar.time, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k };
}

export function volumeBar(bar, colors) {
  return { time: bar.time, value: Number(bar.volume) || 0, color: bar.close >= bar.open ? colors.upVol : colors.downVol };
}

/** The price scale's step: four significant digits below the smallest price shown, within [1e-18, 0.01]. */
export function minMoveFor(values) {
  let min = Infinity;
  for (const v of values) if (Number.isFinite(v) && v > 0 && v < min) min = v;
  if (min === Infinity) return 0.01;
  const step = 10 ** (Math.floor(Math.log10(min)) - 4);
  return Math.min(0.01, Math.max(1e-18, step));
}

export function tradeId(t) {
  return `${String(t.tx).toLowerCase()}:${t.logIndex}`;
}

/** The feed: newest first (block, then log index), de-duplicated, at most `max`. */
export function mergeTrades(current, incoming, max = 100) {
  const map = new Map();
  for (const t of [...(current || []), ...(incoming || [])]) if (t && t.tx) map.set(tradeId(t), t);
  return [...map.values()].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, max);
}

/** Series markers for the page's own sells: one per candle, counted. */
export function ownMarkers(trades, interval, color) {
  const perTime = new Map();
  for (const t of trades) {
    const time = alignTime(t.ts, interval);
    perTime.set(time, (perTime.get(time) || 0) + 1);
  }
  return [...perTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, n]) => ({ time, position: 'aboveBar', shape: 'arrowDown', color, text: n > 1 ? `you ×${n}` : 'you' }));
}

const pad = (n) => String(n).padStart(2, '0');

/** Time-axis labels in the visitor's local time (the library draws UTC by default). */
export function tickLabel(time, type) {
  if (typeof time !== 'number') return null;
  const d = new Date(time * 1000);
  if (type === 4) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (type === 3) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (type === 2) return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (type === 1) return MONTHS[d.getMonth()];
  return String(d.getFullYear());
}

/** The crosshair's time label, local. */
export function crosshairTime(time) {
  if (typeof time !== 'number') return '';
  const d = new Date(time * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
