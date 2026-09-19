'use strict';

// Per-token trade indexer for the take-profit chart (spec: backend unit indexer.js).
//
// - Its OWN provider (tpChartProvider), never the send path: this node degrades badly
//   under concurrent getLogs — eight at once took 16 s against 0.3 s each
//   (evm/v2/holdings.js:76-79) — and chart traffic must never queue in front of a
//   sell. Every chart RPC in the process also passes one small limiter shared by all
//   indexers (TP_CHART_CONCURRENCY, default 2), and one getBlockNumber per 200 ms
//   serves every indexer. The limiter serves LIVE calls first and never lets history
//   take its last slot, so a live poll never waits on a backfill's RPCs.
// - Two loops per indexer, each with at most one chart RPC in flight: the live poll
//   and the history backfill. The live poll never waits on history: one 10k-block
//   window of a busy pool took 88-119 s on the public RPC (measured 2026-09-19: 311
//   swaps, 290 sequential getBlock timestamp reads), and live trades — a visitor's
//   own sells — must reach the chart within a poll, not after it.
// - Backfill: the last hour first, in sequential 10,000-block windows (QuickNode
//   refuses wider eth_getLogs — evm/v2/holdings.js:98-108), newest window first,
//   back to back; then the rest of 24 h, one window per 400 ms. Blocks are ~10 per
//   second, so 1 h ≈ 36,000 blocks. History is silent: it reaches the browser in the
//   snapshot the stream re-sends when historySeconds grows (stream.js).
// - Live: getLogs from lastBlock+1 every 400 ms, from the first tick (it does not wait
//   for the hour); trades are emitted in batches at most every 200 ms, each batch
//   followed by a fresh mark (state.readMark).
// - Timestamps: the public RPC returns blockTimestamp 0x0 in logs (measured), so a
//   trade block's time comes from getBlock through a shared LRU. Block timestamps
//   never decrease and are whole seconds (~10 blocks share each), so a run of blocks
//   whose first and last share a second all share it: resolved by bisection, not
//   one getBlock per block.
// - Graduation: a curve venue re-reads its phase every 10 s, and early when the curve
//   goes quiet after trading (a graduating curve stops emitting). On a change it
//   emits 'phase', switches filters and re-reads the new source from just before the
//   block where the old phase was last confirmed — no gap.
// - Ref-counted by open streams; stops 5 min after the last release; at most
//   TP_MAX_TOKENS (default 30) tokens at once → TpError('too_many', 503).
// - WSS (wss.js, optional): while the chart endpoint's socket is live, a pushed log of
//   this token wakes the poll at once (at most one woken tick per 200 ms) and the
//   quiet safety poll relaxes to 2 s; a pushed block the HTTP node has not served yet
//   is re-read every 200 ms for up to 2 s. getLogs stays the only data path. The 24 h
//   fill keeps its own 400 ms pace; the socket going down puts every live poll back on
//   400 ms.

const { EventEmitter } = require('events');
const { TOPICS, POOL_MANAGER } = require('./constants');
const { TpError } = require('./errors');
const { decodeLog } = require('./decode');
const { CandleRing } = require('./candles');

const BLOCKS_PER_SECOND = 10;
const LOG_WINDOW = 10_000;
const HOUR_BLOCKS = 3600 * BLOCKS_PER_SECOND; // 36,000
const DAY_BLOCKS = 86400 * BLOCKS_PER_SECOND; // 864,000
const POLL_MS = 400;
const WS_POLL_MS = 2_000; // the safety poll while the WSS pushes this token's logs
const WAKE_GAP_MS = 200; // at most one woken tick per 200 ms (the batch floor)
const WAKE_HOLD_MS = 2_000; // a pushed block the HTTP node lags on is retried this long
const FLUSH_MS = 200;
const PHASE_MS = 10_000;
const QUIET_MS = 2_000;
const STOP_AFTER_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 10_000;
const HEAD_TTL_MS = 200;
const RECENT_MAX = 500;
const DEDUP_MAX = 20_000;
const TS_CACHE_MAX = 4096;
const PHASE_RESCAN_MARGIN = 50;
// The narrowest getLogs range a refused window is split down to (see _logs).
const MIN_SPLIT_BLOCKS = 125;
// Refusals that splitting cannot help: the node is busy or slow, not the range too wide.
const NOT_A_RANGE_ERROR = /429|too many|rate limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i;

const lc = (s) => String(s || '').toLowerCase();
const byChainOrder = (a, b) => a.block - b.block || a.logIndex - b.logIndex;
const errText = (err) => String((err && (err.shortMessage || err.message)) || err).slice(0, 160);

/** The getLogs filters that follow a venue live. */
function liveFilters(venue) {
  if (venue.kind === 'curve') {
    return [{ address: lc(venue.curve), topics: [[TOPICS.CURVE_BUY, TOPICS.CURVE_SELL]] }];
  }
  if (venue.kind === 'graduated') {
    // ALWAYS on topic1 = poolId: unfiltered, the PoolManager carries ~1,200 swaps per
    // 300 blocks (spec, measured).
    return [{ address: lc(POOL_MANAGER), topics: [TOPICS.V4_SWAP, lc(venue.poolId)] }];
  }
  if (venue.kind === 'v1') return [{ address: lc(venue.pool), topics: [TOPICS.V3_SWAP] }];
  return [];
}

/**
 * History also reads a graduated token's dead curve (Task 2's venue.formerCurve), so
 * the 24 h chart runs through the graduation instead of starting at it. Live polls
 * never do: a graduated curve emits nothing more.
 */
function historyFilters(venue) {
  const out = liveFilters(venue);
  const former = venue.kind === 'graduated' ? venue.formerCurve || venue.curve : null;
  if (former) out.push({ address: lc(former), topics: [[TOPICS.CURVE_BUY, TOPICS.CURVE_SELL]] });
  return out;
}

/**
 * The process-wide cap on chart RPCs, with two lanes. `limit(fn, { urgent: true })`
 * (the live polls, the head) starts before any waiting history call, and history may
 * hold at most max - 1 slots when max > 1: the last slot is kept for a live call, so a
 * live poll never waits on a backfill's RPCs, only on other live ones.
 */
function createLimiter(max) {
  let active = 0;
  const urgent = [];
  const history = [];
  const run = (job) => {
    active += 1;
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  const pump = () => {
    while (active < max && urgent.length) run(urgent.shift());
    const historyMax = max > 1 ? max - 1 : max;
    while (active < historyMax && history.length) run(history.shift());
  };
  return (fn, { urgent: isUrgent = false } = {}) =>
    new Promise((resolve, reject) => {
      (isUrgent ? urgent : history).push({ fn, resolve, reject });
      pump();
    });
}

function createLru(max) {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      if (map.has(k)) map.delete(k);
      map.set(k, v);
      if (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}

class Indexer extends EventEmitter {
  constructor(venue, ctx) {
    super();
    this.setMaxListeners(0); // one listener set per open stream
    this.venue = venue;
    this.mark = null;
    this._ctx = ctx;
    this._ring = new CandleRing({ maxSeconds: 86400, quoteDecimals: venue.pairDecimals });
    this._recent = [];
    this._seen = new Set();
    this._pending = [];
    this._status = { state: 'starting', detail: 'starting', historySeconds: 0 };
    this._history = 0;
    this._migrating = false;
    this._timer = null;
    this._histTimer = null; // the history loop's own timer (see _histTick)
    this._histErrors = 0;
    this._histErr = '';
    this._liveErr = '';
    this._flushTimer = null;
    this._stopped = false;
    this._cursor = null; // last block the live filter has read
    this._lastHead = null; // newest chain head seen
    this._histLow = null; // lowest block the history has reached
    this._hourFloor = 0;
    this._dayFloor = 0;
    this._errors = 0;
    this._lastFlushAt = -Infinity;
    this._lastTradeAt = 0;
    this._quietArmed = false;
    this._lastPhaseAt = 0;
    this._phaseConfirmedBlock = null;
    this._markBusy = false;
    this._markDirty = false;
    this._ticking = false;
    this._lastTickAt = -Infinity;
    this._timerDueAt = null;
    this._wantBlock = 0; // newest block a WSS push announced for this token
    this._ingested = 0; // trades charted so far: the stats memo's version
    this._statsMemo = null; // { key, value } — one ring scan per second per ingest
    this._wantUntil = 0;
    this._unwatch = null;
  }

  // ── public ──────────────────────────────────────────────────────────────────

  bars(intervalSec, limit) {
    return this._ring.bars(intervalSec, limit);
  }

  barAt(intervalSec, time) {
    return this._ring.barAt(intervalSec, time);
  }

  recentTrades(n = 100) {
    return this._recent.slice(-Math.max(0, n));
  }

  status() {
    return { ...this._status };
  }

  /**
   * The token header's 5 m / 1 h / 24 h change and volume (CandleRing.stats), ending at
   * the later of the wall clock and the newest charted second, over the history indexed
   * so far. `launch` = {ts, price} of a v2 curve launch (tokenInfo.launchRef) or null.
   * Memoised per second and per ingest: every stream of the token shares one scan.
   */
  stats(launch = null) {
    const nowSec = Math.max(Math.floor(this._ctx.deps.now() / 1000), this._ring.head);
    const since = this._coveredSince(nowSec);
    const launchTs = launch && launch.ts != null ? Number(launch.ts) : null;
    const launchPrice = launch && launch.price != null ? Number(launch.price) : null;
    const key = [nowSec, this._ingested, since, launchTs, launchPrice].join('|');
    if (this._statsMemo && this._statsMemo.key === key) return this._statsMemo.value;
    const value = this._ring.stats(nowSec, { since, launchTs, launchPrice });
    this._statsMemo = { key, value };
    return value;
  }

  /**
   * The unix second the indexed history reaches back to (null before the first read).
   * The history loop reads by BLOCK; at the chain's ~10 blocks per second (the same
   * BLOCKS_PER_SECOND the 1 h / 24 h floors are counted in) blocks read = seconds covered.
   */
  _coveredSince(nowSec) {
    if (this._histLow === null || this._lastHead === null) return null;
    if (this._history >= 86400) return nowSec - 86400;
    const blocks = Math.max(0, this._lastHead - this._histLow + 1);
    return nowSec - Math.min(86400, Math.floor(blocks / BLOCKS_PER_SECOND));
  }

  start() {
    if (this._timer || this._stopped || this._cursor !== null) return;
    this._watchLive();
    this._schedule(0);
  }

  /** A pushed log (wss.js) at `block`: read it now, not at the next safety poll. */
  wake(block) {
    if (this._stopped) return;
    const n = Number(block);
    if (!Number.isSafeInteger(n)) return;
    const now = this._ctx.deps.now();
    if (n > this._wantBlock) this._wantBlock = n;
    this._wantUntil = now + WAKE_HOLD_MS;
    // The running tick (or the backfill) picks it up; an RPC backoff is respected.
    if (this._ticking || this._cursor === null || this._errors > 0) return;
    if (this._wantBlock <= this._cursor) return;
    const at = Math.max(now, this._lastTickAt + WAKE_GAP_MS);
    if (this._timer && this._timerDueAt <= at) return;
    if (this._timer) this._ctx.deps.clearTimeout(this._timer);
    this._timer = null;
    this._schedule(at - now);
  }

  /** The socket went down: a tick sleeping on the 2 s safety pace runs within 400 ms. */
  _repace() {
    if (this._stopped || this._ticking || !this._timer || this._errors > 0) return;
    if (this._timerDueAt - this._ctx.deps.now() <= POLL_MS) return;
    this._ctx.deps.clearTimeout(this._timer);
    this._timer = null;
    this._schedule(POLL_MS);
  }

  /** (Re)subscribe this venue's live filters on the WSS; a no-op without one. */
  _watchLive() {
    if (this._unwatch) this._unwatch();
    this._unwatch = null;
    const wss = this._ctx.deps.wss;
    if (!wss || this._stopped) return;
    const offs = liveFilters(this.venue).map((f) => wss.watch(f, (block) => this.wake(block)));
    this._unwatch = () => {
      for (const off of offs) off();
    };
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    const { clearTimeout } = this._ctx.deps;
    if (this._timer) clearTimeout(this._timer);
    if (this._histTimer) clearTimeout(this._histTimer);
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._timer = null;
    this._histTimer = null;
    this._flushTimer = null;
    this._pending = [];
    if (this._unwatch) this._unwatch();
    this._unwatch = null;
    this.removeAllListeners();
  }

  // ── the loops: the live poll and the history backfill, one chart RPC each ──

  _schedule(ms) {
    this._timerDueAt = this._ctx.deps.now() + ms;
    this._timer = this._ctx.deps.setTimeout(() => {
      this._timer = null;
      this._timerDueAt = null;
      this._tick();
    }, ms);
  }

  /** The live loop: poll, phase check. It never waits on the history loop. */
  async _tick() {
    if (this._stopped) return;
    this._ticking = true;
    this._lastTickAt = this._ctx.deps.now();
    let delay = this._ctx.wsLive() ? WS_POLL_MS : POLL_MS;
    try {
      if (this._cursor === null) {
        await this._init();
        this._scheduleHistory(0);
      }
      await this._poll();
      if (!this._stopped) await this._maybeCheckPhase();
      // A pushed block this node has not served yet: look again shortly.
      if (this._wantBlock > this._cursor && this._ctx.deps.now() < this._wantUntil) {
        delay = Math.min(delay, WAKE_GAP_MS);
      }
      this._errors = 0;
    } catch (err) {
      this._errors += 1;
      this._liveErr = errText(err);
      delay = Math.min(POLL_MS * 2 ** this._errors, MAX_BACKOFF_MS);
    }
    this._refreshStatus();
    this._ticking = false;
    // One batch per tick at most: a catch-up across several windows is one 'trades'.
    if (this._pending.length) this._scheduleFlush();
    if (!this._stopped) this._schedule(delay);
  }

  _scheduleHistory(ms) {
    if (this._stopped || this._histTimer) return;
    this._histTimer = this._ctx.deps.setTimeout(() => {
      this._histTimer = null;
      this._histTick();
    }, ms);
  }

  /**
   * The history loop: the first hour back to back, then the rest of 24 h one window
   * per 400 ms, each window read on the history lane of the limiter. It ends once the
   * day is in; an RPC error backs off here without touching the live poll's pace.
   */
  async _histTick() {
    if (this._stopped || this._histLow <= this._dayFloor) return;
    let delay;
    try {
      const inHour = this._histLow > this._hourFloor;
      await this._historyWindow(inHour ? this._hourFloor : this._dayFloor);
      if (this._stopped) return;
      if (inHour && this._histLow <= this._hourFloor) {
        this._history = 3600;
        this._requestMark();
      }
      if (this._histLow <= this._dayFloor) this._history = 86400;
      // The chart waits on the first hour: its windows go back to back.
      delay = this._histLow > this._hourFloor ? 0 : POLL_MS;
      this._histErrors = 0;
    } catch (err) {
      if (this._stopped) return;
      this._histErrors += 1;
      this._histErr = errText(err);
      delay = Math.min(POLL_MS * 2 ** this._histErrors, MAX_BACKOFF_MS);
    }
    this._refreshStatus();
    if (this._histLow > this._dayFloor) this._scheduleHistory(delay);
  }

  async _init() {
    const head = await this._ctx.head();
    this._cursor = head;
    this._lastHead = head;
    this._histLow = head + 1;
    this._hourFloor = Math.max(0, head - HOUR_BLOCKS + 1);
    this._dayFloor = Math.max(0, head - DAY_BLOCKS + 1);
    this._phaseConfirmedBlock = head;
    this._lastPhaseAt = this._ctx.deps.now();
  }

  async _poll() {
    const head = await this._ctx.head();
    if (head > this._lastHead) this._lastHead = head;
    while (!this._stopped && head > this._cursor) {
      const from = this._cursor + 1;
      const to = Math.min(head, this._cursor + LOG_WINDOW);
      const trades = await this._scan(from, to, liveFilters(this.venue), true);
      this._cursor = to;
      if (trades.length) this._ingest(trades, true);
    }
  }

  async _historyWindow(floor) {
    const to = this._histLow - 1;
    const from = Math.max(floor, to - LOG_WINDOW + 1);
    const trades = await this._scan(from, to, historyFilters(this.venue), false);
    this._histLow = from;
    if (trades.length) this._ingest(trades, false);
  }

  /**
   * getLogs over [fromBlock, toBlock], split in halves while the node refuses the range.
   * QuickNode answers 10,000 blocks per call; the chain's public RPC answers only 2,000
   * of its newest ~9,500 blocks per call and fails a range that straddles that line
   * ("internal server errror"; measured 2026-09-19). With a fixed 10k window the first
   * hour's newest window is refused on every retry and the chart never goes live, so a
   * refused range is halved (down to MIN_SPLIT_BLOCKS) and read piece by piece, in
   * order. A rate limit or a timeout is not split — more calls would not help — and
   * propagates to the tick's backoff as before.
   */
  async _logs(f, fromBlock, toBlock, urgent) {
    const { limit } = this._ctx;
    const provider = this._ctx.provider();
    try {
      const read = () => provider.getLogs({ address: f.address, topics: f.topics, fromBlock, toBlock });
      return (await limit(read, { urgent })) || [];
    } catch (err) {
      if (this._stopped || toBlock - fromBlock + 1 <= MIN_SPLIT_BLOCKS || NOT_A_RANGE_ERROR.test(errText(err))) throw err;
      const mid = fromBlock + Math.floor((toBlock - fromBlock) / 2);
      const low = await this._logs(f, fromBlock, mid, urgent);
      const high = await this._logs(f, mid + 1, toBlock, urgent);
      return low.concat(high);
    }
  }

  /** `urgent`: a live poll's reads, which the limiter serves ahead of history. */
  async _scan(fromBlock, toBlock, filters, urgent) {
    const found = new Map();
    for (const f of filters) {
      const logs = await this._logs(f, fromBlock, toBlock, urgent);
      for (const log of logs) {
        const t = decodeLog(log, this.venue);
        if (!t) continue;
        const key = t.tx + ':' + t.logIndex;
        if (!this._seen.has(key)) found.set(key, t);
      }
    }
    const trades = [...found.values()];
    if (!trades.length) return trades;
    const blocks = [...new Set(trades.filter((t) => !t.ts).map((t) => t.block))].sort((a, b) => a - b);
    if (blocks.length) {
      const times = await this._blockTimes(blocks, urgent);
      for (const t of trades) if (!t.ts) t.ts = times.get(t.block);
    }
    return trades.sort(byChainOrder);
  }

  /** Timestamps for sorted, unique block numbers: LRU first, then bisection. */
  async _blockTimes(blocks, urgent) {
    const { tsCache } = this._ctx;
    const out = new Map();
    const missing = [];
    for (const b of blocks) {
      const hit = tsCache.get(b);
      if (hit !== undefined) out.set(b, hit);
      else missing.push(b);
    }
    if (!missing.length) return out;
    const ts = new Array(missing.length);
    const fetchAt = async (k) => {
      ts[k] = await this._fetchBlockTime(missing[k], urgent);
    };
    const last = missing.length - 1;
    await fetchAt(0);
    if (last > 0) await fetchAt(last);
    const fill = async (lo, hi) => {
      if (hi - lo < 2) return;
      if (ts[lo] === ts[hi]) {
        for (let k = lo + 1; k < hi; k++) ts[k] = ts[lo];
        return;
      }
      const mid = (lo + hi) >> 1;
      await fetchAt(mid);
      await fill(lo, mid);
      await fill(mid, hi);
    };
    await fill(0, last);
    for (let k = 0; k < missing.length; k++) {
      out.set(missing[k], ts[k]);
      tsCache.set(missing[k], ts[k]);
    }
    return out;
  }

  async _fetchBlockTime(n, urgent) {
    const block = await this._ctx.limit(() => this._ctx.provider().getBlock(n), { urgent });
    const ts = block ? Number(block.timestamp) : NaN;
    if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error(`no timestamp for block ${n}`);
    return ts;
  }

  _ingest(trades, live) {
    if (this._stopped) return;
    for (const t of trades) {
      this._seen.add(t.tx + ':' + t.logIndex);
      if (this._seen.size > DEDUP_MAX) this._seen.delete(this._seen.values().next().value);
      this._ring.add(t);
    }
    this._ingested += trades.length;
    this._recent = this._recent.concat(trades).sort(byChainOrder);
    if (this._recent.length > RECENT_MAX) this._recent = this._recent.slice(-RECENT_MAX);
    if (!live) return; // history is silent: it reaches the browser in a snapshot
    for (const t of trades) this._pending.push(t);
    this._lastTradeAt = this._ctx.deps.now();
    if (this.venue.kind === 'curve') this._quietArmed = true;
  }

  _scheduleFlush() {
    if (this._flushTimer || this._stopped) return;
    const wait = Math.max(0, this._lastFlushAt + FLUSH_MS - this._ctx.deps.now());
    this._flushTimer = this._ctx.deps.setTimeout(() => this._flush(), wait);
  }

  _flush() {
    this._flushTimer = null;
    if (this._stopped || !this._pending.length) return;
    const batch = this._pending;
    this._pending = [];
    this._lastFlushAt = this._ctx.deps.now();
    this.emit('trades', batch);
    this._requestMark();
  }

  /** One readMark in flight per token; a request during one re-runs it once after. */
  _requestMark() {
    if (this._stopped) return;
    if (this._markBusy) {
      this._markDirty = true;
      return;
    }
    this._markBusy = true;
    this._markDirty = false;
    const venue = this.venue;
    // On the chart provider and at the newest head seen (at or past every trade
    // indexed so far), so it never queues on the send path (Task 3 contract note 7).
    const opts = { provider: this._ctx.provider(), blockTag: this._lastHead };
    Promise.resolve()
      .then(() => this._ctx.deps.readMark(venue, opts))
      .then(
        (mark) => {
          if (!this._stopped && mark && venue === this.venue) {
            this.mark = mark;
            this.emit('mark', mark);
          }
        },
        () => {} // the mark is advisory; the next batch asks again
      )
      .finally(() => {
        this._markBusy = false;
        if (this._markDirty && !this._stopped) this._requestMark();
      });
  }

  async _maybeCheckPhase() {
    if (this.venue.kind !== 'curve') return; // graduated and v1 never change source
    const now = this._ctx.deps.now();
    const quiet = this._quietArmed && now - this._lastTradeAt >= QUIET_MS;
    if (!quiet && now - this._lastPhaseAt < PHASE_MS) return;
    this._quietArmed = false;
    this._lastPhaseAt = now;
    const checkedAt = this._cursor;
    let next;
    try {
      next = await this._ctx.deps.refreshPhase(this.venue, { provider: this._ctx.provider() });
    } catch (err) {
      if (err && err.code === 'migrating') this._migrating = true;
      return; // a failed phase read is retried on the next interval
    }
    if (this._stopped) return;
    const cur = this.venue;
    const changed =
      next &&
      next !== cur &&
      (next.kind !== cur.kind || next.phase !== cur.phase || lc(next.poolId) !== lc(cur.poolId));
    if (!changed) {
      this._phaseConfirmedBlock = checkedAt;
      this._migrating = false;
      return;
    }
    this._migrating = next.kind === 'curve' && next.phase === 1;
    this.venue = next;
    this._watchLive();
    // Re-read the new source from just before the last block the old phase was
    // confirmed at; the dedup set drops anything already charted.
    const from = Math.max(0, this._phaseConfirmedBlock - PHASE_RESCAN_MARGIN);
    this._cursor = Math.min(this._cursor, from - 1);
    this._phaseConfirmedBlock = checkedAt;
    this.emit('phase', next);
    this._requestMark();
  }

  /**
   * One status for both loops: 'catching_up' while either is backing off (the live
   * poll's error first — that is what the chart is missing), else the healthy state. A
   * success in one loop never masks the other's error, so the status does not flap.
   */
  _refreshStatus() {
    if (this._errors > 0) return this._setStatus('catching_up', this._liveErr);
    if (this._histErrors > 0) return this._setStatus('catching_up', this._histErr);
    return this._setHealthy();
  }

  _setHealthy() {
    if (this._migrating) return this._setStatus('migrating', 'the curve is moving to its pool');
    if (this._history < 3600) return this._setStatus('backfilling', 'loading the last hour');
    if (this._history < 86400) return this._setStatus('live', 'live; loading 24 h of history');
    return this._setStatus('live', 'live');
  }

  _setStatus(state, detail) {
    const s = this._status;
    if (s.state === state && s.detail === detail && s.historySeconds === this._history) return;
    this._status = { state, detail, historySeconds: this._history };
    this.emit('status', { ...this._status });
  }
}

function createRegistry(overrides = {}) {
  const deps = {
    provider: null,
    // lazy: requiring this module must not build a provider or load the state reads
    getProvider: () => require('./providers').tpChartProvider(),
    readMark: (venue, opts) => require('./state').readMark(venue, opts),
    refreshPhase: (venue, opts) => require('./venue').refreshPhase(venue, opts),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    wss: null, // wss.js createWss(): the module-level registry passes one; tests poll only
    maxTokens: Number(process.env.TP_MAX_TOKENS) || 30,
    concurrency: Number(process.env.TP_CHART_CONCURRENCY) || 2,
    stopAfterMs: STOP_AFTER_MS,
    ...overrides,
  };

  let provider = deps.provider;
  const ctx = {
    deps,
    provider: () => {
      if (!provider) provider = deps.getProvider();
      return provider;
    },
    limit: createLimiter(deps.concurrency),
    tsCache: createLru(TS_CACHE_MAX),
    head: null,
    wsLive: () => Boolean(deps.wss && deps.wss.live()),
  };

  let headValue = 0;
  let headAt = -Infinity;
  let headInflight = null;
  ctx.head = () => {
    if (deps.now() - headAt < HEAD_TTL_MS) return Promise.resolve(headValue);
    if (!headInflight) {
      headInflight = ctx.limit(() => ctx.provider().getBlockNumber(), { urgent: true }).then(
        (n) => {
          headValue = Number(n);
          headAt = deps.now();
          headInflight = null;
          return headValue;
        },
        (err) => {
          headInflight = null;
          throw err;
        }
      );
    }
    return headInflight;
  };

  const entries = new Map(); // token → { indexer, refs, stopTimer }

  // The socket going down puts every indexer sleeping on the 2 s pace back on 400 ms.
  if (deps.wss) {
    deps.wss.onChange((up) => {
      if (!up) for (const e of entries.values()) e.indexer._repace();
    });
  }

  function acquire(venue) {
    const token = lc(venue && venue.token);
    if (!token || !liveFilters(venue).length) {
      throw new TpError('bad_request', 'this venue has no trade source to chart');
    }
    const found = entries.get(token);
    if (found) {
      found.refs += 1;
      if (found.stopTimer) {
        deps.clearTimeout(found.stopTimer);
        found.stopTimer = null;
      }
      return found.indexer;
    }
    if (entries.size >= deps.maxTokens) {
      // make room by dropping one that nobody is watching any more
      for (const [key, e] of entries) {
        if (e.refs > 0) continue;
        if (e.stopTimer) deps.clearTimeout(e.stopTimer);
        e.indexer.stop();
        entries.delete(key);
        break;
      }
    }
    if (entries.size >= deps.maxTokens) {
      throw new TpError(
        'too_many',
        `the chart server is watching ${deps.maxTokens} tokens already; try again in a few minutes`,
        503
      );
    }
    if (deps.wss) deps.wss.start(); // the probe runs once, with the first chart (idempotent)
    const indexer = new Indexer(venue, ctx);
    entries.set(token, { indexer, refs: 1, stopTimer: null });
    indexer.start();
    return indexer;
  }

  function release(tokenAddr) {
    const token = lc(tokenAddr);
    const e = entries.get(token);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs > 0 || e.stopTimer) return;
    e.stopTimer = deps.setTimeout(() => {
      e.stopTimer = null;
      if (e.refs > 0) return;
      if (entries.get(token) === e) entries.delete(token);
      e.indexer.stop();
    }, deps.stopAfterMs);
  }

  function activeCount() {
    return entries.size;
  }

  function stopAll() {
    for (const e of entries.values()) {
      if (e.stopTimer) deps.clearTimeout(e.stopTimer);
      e.indexer.stop();
    }
    entries.clear();
  }

  return { acquire, release, activeCount, stopAll };
}

// The process's registry: the chart's WSS is probed when its first indexer starts.
const registry = createRegistry({ wss: require('./wss').createWss() });

module.exports = {
  acquire: (venue) => registry.acquire(venue),
  release: (token) => registry.release(token),
  activeCount: () => registry.activeCount(),
  createRegistry,
  createLimiter,
  Indexer,
  liveFilters,
  historyFilters,
  BLOCKS_PER_SECOND,
  LOG_WINDOW,
  POLL_MS,
  WS_POLL_MS,
};
