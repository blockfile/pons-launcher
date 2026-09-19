'use strict';

// 1-second candles for the take-profit chart, held in a columnar ring (spec: "1 s
// candles in a columnar ring; 15 s / 1 m / 5 m / 1 h folded on request"). Pure: no
// I/O and no clock — time comes from each trade's block timestamp.
//
// Why only 1 s bars are stored: Robinhood Chain stamps blocks in whole seconds at
// ~10 blocks per second (measured), so 1 s is the finest real candle and every
// coarser interval is an exact fold of it.
//
// Memory: 8 Float64Arrays × maxSeconds. At the default 86,400 that is ~5.5 MB per
// indexed token — TP_MAX_TOKENS (default 30) bounds the total.

const INTERVALS = Object.freeze([1, 15, 60, 300, 3600]);

// The token header's windows (spec Addendum v2 D): 5 m / 1 h / 24 h, in seconds.
const STAT_WINDOWS = Object.freeze({ m5: 300, h1: 3600, h24: 86400 });

// Chain order inside a second: block * 1e5 + logIndex. Blocks are ~6.6e7 today,
// so keys stay near 6.6e12 — far inside Number.MAX_SAFE_INTEGER (9e15).
const ORDER_SCALE = 100_000;

function checkInterval(sec) {
  const n = Number(sec);
  if (!INTERVALS.includes(n)) {
    throw new RangeError(`interval must be one of ${INTERVALS.join(', ')} seconds`);
  }
  return n;
}

class CandleRing {
  /**
   * @param {{maxSeconds?: number, quoteDecimals?: number}} [opts]
   *   quoteDecimals turns quoteAmt (base units) into a human volume — pass
   *   venue.pairDecimals (USDG is 6, ETH 18).
   */
  constructor({ maxSeconds = 86400, quoteDecimals = 18 } = {}) {
    const cap = Math.floor(Number(maxSeconds));
    if (!(cap >= 1)) throw new RangeError('maxSeconds must be at least 1');
    this.cap = cap;
    this.quoteScale = 10 ** Number(quoteDecimals);
    this.time = new Float64Array(cap);
    this.open = new Float64Array(cap);
    this.high = new Float64Array(cap);
    this.low = new Float64Array(cap);
    this.close = new Float64Array(cap);
    this.volume = new Float64Array(cap);
    this.openKey = new Float64Array(cap);
    this.closeKey = new Float64Array(cap);
    this.head = 0; // newest second held
  }

  /** @returns {boolean} whether the trade was charted */
  add(trade) {
    if (!trade) return false;
    const t = Math.floor(Number(trade.ts));
    const price = Number(trade.price);
    if (!(t > 0) || !Number.isFinite(price) || price <= 0) return false;
    if (this.head && t <= this.head - this.cap) return false; // older than the ring holds
    if (t > this.head) this.head = t;

    const i = t % this.cap;
    const n = Number(trade.quoteAmt);
    const vol = Number.isFinite(n) && n > 0 ? n / this.quoteScale : 0;
    const key = Number(trade.block) * ORDER_SCALE + Number(trade.logIndex);

    if (this.time[i] !== t) {
      // first trade of this second (or the slot still holds a second that fell out)
      this.time[i] = t;
      this.open[i] = price;
      this.high[i] = price;
      this.low[i] = price;
      this.close[i] = price;
      this.volume[i] = vol;
      this.openKey[i] = key;
      this.closeKey[i] = key;
      return true;
    }
    if (price > this.high[i]) this.high[i] = price;
    if (price < this.low[i]) this.low[i] = price;
    this.volume[i] += vol;
    if (key < this.openKey[i]) {
      this.open[i] = price;
      this.openKey[i] = key;
    }
    if (key >= this.closeKey[i]) {
      this.close[i] = price;
      this.closeKey[i] = key;
    }
    return true;
  }

  /**
   * The most recent `limit` non-empty bars of `intervalSec`, oldest first. Bar times
   * are aligned to the interval (time % intervalSec === 0, UTC).
   */
  bars(intervalSec, limit = Infinity) {
    const iv = checkInterval(intervalSec);
    const max = limit === undefined || limit === null ? Infinity : Math.floor(Number(limit));
    const out = [];
    if (!this.head || !(max > 0)) return out;
    const lowest = Math.max(1, this.head - this.cap + 1);
    let cur = null;
    for (let t = this.head; t >= lowest; t--) {
      const i = t % this.cap;
      if (this.time[i] !== t) continue;
      const bucket = t - (t % iv);
      if (cur && cur.time === bucket) {
        // an EARLIER second of the bar being built (the scan runs newest → oldest)
        cur.open = this.open[i];
        if (this.high[i] > cur.high) cur.high = this.high[i];
        if (this.low[i] < cur.low) cur.low = this.low[i];
        cur.volume += this.volume[i];
        continue;
      }
      if (cur) {
        out.push(cur);
        cur = null;
        if (out.length >= max) break;
      }
      cur = {
        time: bucket,
        open: this.open[i],
        high: this.high[i],
        low: this.low[i],
        close: this.close[i],
        volume: this.volume[i],
      };
    }
    if (cur) out.push(cur);
    return out.reverse();
  }

  /** The bar of `intervalSec` containing second `time`, or null if it holds no trade. */
  barAt(intervalSec, time) {
    const iv = checkInterval(intervalSec);
    const s = Math.floor(Number(time));
    if (!this.head || !(s > 0)) return null;
    const bucket = s - (s % iv);
    const from = Math.max(bucket, this.head - this.cap + 1, 1);
    const to = Math.min(bucket + iv - 1, this.head);
    let bar = null;
    for (let t = from; t <= to; t++) {
      const i = t % this.cap;
      if (this.time[i] !== t) continue;
      if (!bar) {
        bar = {
          time: bucket,
          open: this.open[i],
          high: this.high[i],
          low: this.low[i],
          close: this.close[i],
          volume: this.volume[i],
        };
        continue;
      }
      if (this.high[i] > bar.high) bar.high = this.high[i];
      if (this.low[i] < bar.low) bar.low = this.low[i];
      bar.close = this.close[i];
      bar.volume += this.volume[i];
    }
    return bar;
  }

  /** The newest bar of `intervalSec`, or null when nothing is held. */
  lastBar(intervalSec) {
    const [bar] = this.bars(intervalSec, 1);
    return bar || null;
  }

  /**
   * Price change and volume over the last 5 m / 1 h / 24 h, each window being the
   * seconds (nowSec - w, nowSec]. One scan, newest second first.
   *
   *   price     the close of the newest trade at or before nowSec (quote per token), or null
   *   change    price / ref - 1 per window, or null when no price is known. ref is, in order:
   *               the close of the newest trade BEFORE the window (so no trade inside it
   *               is exactly 0), else the launch price when the token launched inside the
   *               window (launchTs/launchPrice), else the open of the oldest trade inside it
   *   volume    the quote traded inside the window, in human pair units (quoteDecimals)
   *   complete  whether the indexed history (`since`, unix s) covers the whole window, or
   *             reaches back to a launch inside it. While false, change and volume are
   *             "since `since`", not the full window.
   *
   * @param {number} nowSec unix seconds the windows end at
   * @param {{since?: number|null, launchTs?: number|null, launchPrice?: number|null}} [opts]
   * @returns {{at, since, price, change: {m5, h1, h24}, volume: {m5, h1, h24}, complete: {m5, h1, h24}}}
   */
  stats(nowSec, { since = null, launchTs = null, launchPrice = null } = {}) {
    const now = Math.floor(Number(nowSec));
    const from = since === null || since === undefined || !Number.isFinite(Number(since)) ? null : Math.floor(Number(since));
    const lts = Number(launchTs) > 0 ? Math.floor(Number(launchTs)) : null;
    const lp = Number.isFinite(Number(launchPrice)) && Number(launchPrice) > 0 ? Number(launchPrice) : null;
    const names = Object.keys(STAT_WINDOWS);
    const out = { at: now, since: from, price: null, change: {}, volume: {}, complete: {} };
    const before = {};
    const firstOpen = {};
    for (const k of names) {
      out.volume[k] = 0;
      before[k] = null;
      firstOpen[k] = null;
    }

    if (this.head && now > 0) {
      const lowest = Math.max(1, this.head - this.cap + 1);
      for (let t = Math.min(this.head, now); t >= lowest; t--) {
        const i = t % this.cap;
        if (this.time[i] !== t) continue;
        if (out.price === null) out.price = this.close[i];
        for (const k of names) {
          if (t > now - STAT_WINDOWS[k]) {
            out.volume[k] += this.volume[i];
            firstOpen[k] = this.open[i]; // the scan runs newest -> oldest: the last write is the oldest
          } else if (before[k] === null) {
            before[k] = this.close[i];
          }
        }
        if (before.h24 !== null) break; // every window's reference is found
      }
    }

    for (const k of names) {
      const start = now - STAT_WINDOWS[k];
      const launchedInside = lts !== null && lts > start;
      let ref = before[k];
      if (ref === null && launchedInside && lp !== null) ref = lp;
      if (ref === null) ref = firstOpen[k];
      out.change[k] = out.price !== null && ref > 0 ? out.price / ref - 1 : null;
      out.complete[k] = from !== null && (from <= start || (launchedInside && from <= lts));
    }
    return out;
  }
}

module.exports = { CandleRing, INTERVALS, STAT_WINDOWS };
