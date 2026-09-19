'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AbiCoder, zeroPadValue } = require('ethers');

const { createRegistry, createLimiter, liveFilters } = require('./indexer');
const { TOPICS, POOL_MANAGER } = require('./constants');
const { TpError } = require('./errors');

const abi = AbiCoder.defaultAbiCoder();
const pad = (a) => zeroPadValue(a, 32);

const CURVE = '0x1df4f56471c8c4540afa3b5f324e75a66bacdf9d';
const TOKEN = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc';
const ALICE = '0xd1df06767842f9222746facaa191446c9f473cc9';
const POOL_ID = '0x06e308b77bdafd691d179645296ce8c40e33c6af4a879a913efc7eedc402581c';
const T0 = 1_700_000_000;

// Venue shapes as Task 2 builds them (every key present, null when it does not apply).
const curveVenue = {
  kind: 'curve',
  token: TOKEN,
  curve: CURVE,
  formerCurve: null,
  poolKey: null,
  poolId: null,
  pool: null,
  decimals: 18,
  pairDecimals: 18,
  nativeQuote: true,
  phase: 0,
};
const gradVenue = {
  kind: 'graduated',
  token: TOKEN,
  curve: null,
  formerCurve: CURVE,
  pool: null,
  decimals: 18,
  pairDecimals: 18,
  nativeQuote: true,
  phase: 2,
  poolId: POOL_ID,
  poolKey: {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: TOKEN,
    fee: 0,
    tickSpacing: 200,
    hooks: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  },
};
const MARK = { block: 1, price: 1e-8, quoteReserve: '1', tokenReserve: '1' };

// ── fakes ───────────────────────────────────────────────────────────────────────

/** A chain whose blocks are 10 per second: block n is at T0 + floor(n / 10). */
function fakeChain({ head }) {
  const chain = {
    head,
    logs: [],
    timeline: [],
    active: 0,
    maxActive: 0,
    failNext: 0,
    tsOf: (n) => T0 + Math.floor(n / 10),
    async getBlockNumber() {
      chain.timeline.push({ m: 'getBlockNumber' });
      return chain.head;
    },
    async getLogs(f) {
      chain.active += 1;
      chain.maxActive = Math.max(chain.maxActive, chain.active);
      await Promise.resolve();
      chain.active -= 1;
      chain.timeline.push({ m: 'getLogs', ...f });
      if (chain.failNext > 0) {
        chain.failNext -= 1;
        throw new Error('upstream timeout');
      }
      const first = Array.isArray(f.topics[0]) ? f.topics[0] : [f.topics[0]];
      return chain.logs.filter(
        (l) =>
          l.address === f.address &&
          first.includes(l.topics[0]) &&
          (f.topics[1] == null || l.topics[1] === f.topics[1]) &&
          l.blockNumber >= f.fromBlock &&
          l.blockNumber <= f.toBlock
      );
    },
    async getBlock(n) {
      chain.timeline.push({ m: 'getBlock', n });
      return { number: n, timestamp: chain.tsOf(n) };
    },
    calls(m) {
      return chain.timeline.filter((c) => c.m === m);
    },
  };
  return chain;
}

function fakeClock(start = 5_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), fn, seq });
      return seq;
    },
    clearTimeout: (h) => {
      timers.delete(h);
    },
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        let next = null;
        for (const [h, t] of timers) {
          if (t.at > end) continue;
          if (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq)) next = { h, t };
        }
        if (!next) break;
        timers.delete(next.h);
        now = next.t.at;
        next.t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

let txSeq = 0;
function curveLog(side, block, index = 0) {
  txSeq += 1;
  const buy = side === 'buy';
  return {
    address: CURVE,
    topics: buy ? [TOPICS.CURVE_BUY, pad(ROUTER), pad(ALICE)] : [TOPICS.CURVE_SELL, pad(ALICE), pad(ROUTER)],
    data: abi.encode(
      ['uint256', 'uint256', 'uint256', 'uint256'],
      buy ? [10n ** 15n, 10n ** 23n, 0n, 0n] : [10n ** 23n, 10n ** 15n, 0n, 0n]
    ),
    blockNumber: block,
    index,
    transactionHash: '0x' + txSeq.toString(16).padStart(64, '0'),
  };
}

function v4Log(block, index = 0) {
  txSeq += 1;
  return {
    address: POOL_MANAGER,
    topics: [TOPICS.V4_SWAP, POOL_ID, pad(ROUTER)],
    data: abi.encode(
      ['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'],
      [-(10n ** 16n), 10n ** 21n, 2n ** 96n, 10n ** 21n, 0, 10_000]
    ),
    blockNumber: block,
    index,
    transactionHash: '0x' + txSeq.toString(16).padStart(64, '0'),
  };
}

/** A stand-in for wss.js createWss(): the test decides when it is live and what it pushes. */
function fakeWss({ live = true } = {}) {
  const w = {
    up: live,
    started: 0,
    entries: [],
    handlers: [],
    start() {
      w.started += 1;
    },
    live: () => w.up,
    watch(filter, onLog) {
      const entry = { filter, onLog, on: true };
      w.entries.push(entry);
      return () => {
        entry.on = false;
      };
    },
    onChange(fn) {
      w.handlers.push(fn);
      return () => {};
    },
    push(block) {
      for (const e of w.entries) if (e.on) e.onLog(block);
    },
    setLive(up) {
      w.up = up;
      for (const fn of w.handlers) fn(up);
    },
    watched() {
      return w.entries.filter((e) => e.on).map((e) => e.filter);
    },
  };
  return w;
}

function setup({ head = 40_000, venue = curveVenue, refreshPhase, maxTokens = 30, wss } = {}) {
  const chain = fakeChain({ head });
  const clock = fakeClock();
  const marks = [];
  const phases = [];
  const reg = createRegistry({
    provider: chain,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    readMark: async (v, opts) => {
      marks.push({ venue: v, opts });
      return MARK;
    },
    refreshPhase:
      refreshPhase ||
      (async (v, opts) => {
        phases.push({ venue: v, opts });
        return v;
      }),
    maxTokens,
    wss,
  });
  return { chain, clock, reg, marks, phases, venue };
}

function watch(ix, timeline) {
  const seen = { trades: [], status: [], mark: [], phase: [] };
  for (const name of Object.keys(seen)) {
    ix.on(name, (data) => {
      seen[name].push(data);
      if (timeline) timeline.push({ m: 'event:' + name, data });
    });
  }
  return seen;
}

// ── backfill ─────────────────────────────────────────────────────────────────────

test('the last hour loads first: four sequential 10k windows, newest first', async () => {
  const s = setup({ head: 1_000_000 });
  s.chain.logs.push(curveLog('buy', 999_990), curveLog('sell', 975_000), curveLog('buy', 964_001));
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix, s.chain.timeline);
  await s.clock.advance(0);

  const windows = s.chain.calls('getLogs').map((c) => [c.fromBlock, c.toBlock]);
  assert.deepEqual(windows.slice(0, 4), [
    [990_001, 1_000_000],
    [980_001, 990_000],
    [970_001, 980_000],
    [964_001, 970_000],
  ]);
  assert.equal(s.chain.maxActive, 1, 'never two getLogs at once');

  // "history: 1 h" is announced before any window older than the hour is read
  const tl = s.chain.timeline;
  const hourAt = tl.findIndex((e) => e.m === 'event:status' && e.data.historySeconds === 3600);
  const olderAt = tl.findIndex((e) => e.m === 'getLogs' && e.fromBlock < 964_001);
  assert.ok(hourAt >= 0, 'announced the first hour');
  assert.ok(olderAt === -1 || hourAt < olderAt, 'the hour is announced before the 24 h fill starts');
  assert.equal(seen.status.find((x) => x.historySeconds === 3600).state, 'live');

  // history is charted and listed, but never emitted as live trades
  assert.equal(seen.trades.length, 0);
  assert.deepEqual(ix.recentTrades(10).map((t) => t.block), [964_001, 975_000, 999_990]);
  assert.deepEqual(
    ix.bars(1, 10).map((b) => b.time),
    [s.chain.tsOf(964_001), s.chain.tsOf(975_000), s.chain.tsOf(999_990)]
  );
  assert.deepEqual(ix.mark, MARK, 'a mark is read once the hour is in');
  s.reg.stopAll();
});

test('the rest of 24 h fills one window per 400 ms, contiguous, and is announced', async () => {
  const s = setup({ head: 1_000_000 });
  s.chain.logs.push(curveLog('buy', 200_000));
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  await s.clock.advance(40_000);

  const hist = s.chain
    .calls('getLogs')
    .map((c) => [c.fromBlock, c.toBlock])
    .sort((a, b) => a[0] - b[0]);
  assert.equal(hist[0][0], 1_000_000 - 864_000 + 1, 'reaches 24 h back');
  for (let i = 0; i < hist.length; i++) {
    assert.ok(hist[i][1] - hist[i][0] + 1 <= 10_000, 'no window wider than 10k blocks');
    if (i > 0) assert.equal(hist[i][0], hist[i - 1][1] + 1, 'windows are contiguous');
  }
  assert.equal(hist.at(-1)[1], 1_000_000);
  assert.ok(seen.status.some((x) => x.historySeconds === 86400));
  assert.equal(ix.bars(1, 5)[0].time, s.chain.tsOf(200_000));
  s.reg.stopAll();
});

// Measured on the chain's public RPC (2026-09-19): ONE 10k-block history window of a
// busy graduated pool (311 swaps) took 88-119 s, 70 s of it in 290 sequential getBlock
// timestamp reads (the trades spanned ~290 distinct seconds, so bisection saved
// little). History windows beyond `olderThan` answer only after `ms` of fake time here.
function slowHistory(s, { olderThan, ms }) {
  const inner = s.chain.getLogs.bind(s.chain);
  s.chain.getLogs = async (f) => {
    if (f.toBlock < olderThan) await new Promise((resolve) => s.clock.setTimeout(resolve, ms));
    return inner(f);
  };
}

test('a slow 24 h history window never holds up the live poll', async () => {
  const s = setup({ head: 1_000_000 });
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  slowHistory(s, { olderThan: 964_001, ms: 120_000 }); // every window older than the hour
  await s.clock.advance(0);
  assert.ok(seen.status.some((x) => x.historySeconds === 3600), 'the hour is in');
  await s.clock.advance(400); // the 24 h fill is now inside a 2-minute window

  s.chain.logs.push(curveLog('buy', 1_000_004));
  s.chain.head = 1_000_005;
  await s.clock.advance(400);
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [1_000_004], 'charted within one poll');
  s.chain.logs.push(curveLog('sell', 1_000_009));
  s.chain.head = 1_000_010;
  await s.clock.advance(400);
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [1_000_004, 1_000_009], 'and at every poll after');
  s.reg.stopAll();
});

test('live trades flow while the first hour is still loading; the hour follows as history', async () => {
  const s = setup({ head: 1_000_000 });
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  slowHistory(s, { olderThan: 1_000_001, ms: 90_000 }); // every history window: 90 s
  await s.clock.advance(0);
  assert.equal(seen.status.at(-1).state, 'backfilling');

  s.chain.logs.push(curveLog('buy', 1_000_003));
  s.chain.head = 1_000_004;
  await s.clock.advance(400);
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [1_000_003], 'a live trade does not wait for the hour');
  assert.equal(seen.status.at(-1).state, 'backfilling', 'the hour is still loading');

  s.chain.logs.push(curveLog('sell', 995_000));
  await s.clock.advance(4 * 90_000);
  assert.ok(seen.status.some((x) => x.historySeconds === 3600), 'the hour is announced when it is in');
  assert.deepEqual(ix.recentTrades(10).map((t) => t.block), [995_000, 1_000_003]);
  assert.equal(seen.trades.flat().length, 1, 'history is never emitted as live trades');
  s.reg.stopAll();
});

test('the chart limiter serves live calls first and never gives history its last slot', async () => {
  const limit = createLimiter(2);
  const open = [];
  const job = (name) => () => new Promise((resolve) => open.push({ name, resolve }));
  const finish = (name) => open.splice(open.findIndex((j) => j.name === name), 1)[0].resolve();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const names = () => open.map((j) => j.name);

  limit(job('h1'));
  limit(job('h2'));
  limit(job('h3'));
  await settle();
  assert.deepEqual(names(), ['h1'], 'history leaves one of the two slots free');
  const l1 = limit(job('l1'), { urgent: true });
  await settle();
  assert.deepEqual(names(), ['h1', 'l1'], 'a live call starts at once');
  limit(job('l2'), { urgent: true });
  await settle();
  assert.deepEqual(names(), ['h1', 'l1'], 'two slots, both busy');
  finish('h1');
  await settle();
  assert.deepEqual(names(), ['l1', 'l2'], 'the freed slot goes to the waiting live call, not to history');
  finish('l1');
  finish('l2');
  await settle();
  assert.deepEqual(names(), ['h2']);
  finish('h2');
  await settle();
  finish('h3');
  await settle();
  assert.equal(open.length, 0);
  await l1;

  const one = createLimiter(1);
  one(job('solo'));
  await settle();
  assert.deepEqual(names(), ['solo'], 'with a single slot, history still runs');
  finish('solo');
});

// ── live ─────────────────────────────────────────────────────────────────────────

test('live: polls from lastBlock+1, stamps by bisection, emits one batch then a mark', async () => {
  const s = setup();
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  const blocksBefore = s.chain.calls('getBlock').length;
  const marksBefore = seen.mark.length;

  // three blocks in the same second (10 blocks per second)
  s.chain.logs.push(curveLog('buy', 40_001, 0), curveLog('sell', 40_005, 2), curveLog('buy', 40_009, 1));
  s.chain.head = 40_010;
  await s.clock.advance(400);

  const live = s.chain.calls('getLogs').filter((c) => c.fromBlock > 40_000);
  assert.deepEqual(live.map((c) => [c.address, c.fromBlock, c.toBlock]), [[CURVE, 40_001, 40_010]]);
  assert.deepEqual(live[0].topics, liveFilters(curveVenue)[0].topics);
  assert.equal(s.chain.calls('getBlock').length - blocksBefore, 2, 'first and last block only');

  assert.equal(seen.trades.length, 1, 'one batch');
  const batch = seen.trades[0];
  assert.deepEqual(batch.map((t) => [t.block, t.side]), [[40_001, 'buy'], [40_005, 'sell'], [40_009, 'buy']]);
  for (const t of batch) assert.equal(t.ts, T0 + 4000);
  assert.equal(seen.mark.length, marksBefore + 1, 'a mark follows the batch');
  const last = s.marks.at(-1);
  assert.equal(last.opts.provider, s.chain, 'the mark is read on the chart provider');
  assert.equal(last.opts.blockTag, 40_010, 'at the newest head seen');
  s.reg.stopAll();
});

test('a log the node returns twice is charted once', async () => {
  const s = setup();
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  const log = curveLog('buy', 40_002);
  s.chain.logs.push(log, { ...log });
  s.chain.head = 40_003;
  await s.clock.advance(400);
  assert.equal(seen.trades.flat().length, 1);
  assert.equal(ix.bars(1, 5)[0].volume, 0.001);
  s.reg.stopAll();
});

test('a catch-up across several windows reaches the browser as one batch', async () => {
  const s = setup();
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  s.chain.logs.push(curveLog('buy', 45_000), curveLog('buy', 55_000), curveLog('sell', 65_000));
  s.chain.head = 65_000;
  await s.clock.advance(400);
  const live = s.chain.calls('getLogs').filter((c) => c.fromBlock > 40_000);
  assert.deepEqual(live.map((c) => [c.fromBlock, c.toBlock]), [
    [40_001, 50_000],
    [50_001, 60_000],
    [60_001, 65_000],
  ]);
  assert.equal(seen.trades.length, 1);
  assert.equal(seen.trades[0].length, 3);
  s.reg.stopAll();
});

test('RPC errors: catching_up with backoff, then live again without losing the trade', async () => {
  const s = setup();
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  await s.clock.advance(400); // the history loop's last window (head 40,000 is under a day): the failures below are the live poll's
  s.chain.logs.push(curveLog('buy', 40_004));
  s.chain.head = 40_005;
  s.chain.failNext = 2;
  await s.clock.advance(400); // fails → retry in 800
  assert.equal(seen.status.at(-1).state, 'catching_up');
  assert.match(seen.status.at(-1).detail, /upstream timeout/);
  await s.clock.advance(800); // fails → retry in 1600
  assert.equal(seen.trades.length, 0);
  await s.clock.advance(1_599);
  assert.equal(seen.trades.length, 0, 'still backing off');
  await s.clock.advance(1);
  assert.equal(seen.trades.flat().length, 1);
  assert.equal(seen.status.at(-1).state, 'live');
  s.reg.stopAll();
});

// The chain's public RPC (measured 2026-09-19): its newest ~10,000 blocks come from a
// "main backend" that searches at most 2,000 of them per eth_getLogs; older blocks come
// from a log store that takes 10,000. A range with more than 2,000 of the newest blocks
// is refused — with that message when it lies wholly among them, and as a bare
// "internal server errror" when it straddles the line. A fixed 10k window over the
// newest blocks is refused on every retry, so the first hour never loads and the chart
// never goes live.
function publicRpcLimits(chain, { recent = 10_000, recentMax = 2_000 } = {}) {
  const inner = chain.getLogs.bind(chain);
  chain.refused = 0;
  chain.getLogs = async (f) => {
    const boundary = chain.head - recent;
    const recentPart = f.toBlock - Math.max(f.fromBlock, boundary + 1) + 1;
    if (recentPart > recentMax) {
      chain.refused += 1;
      if (f.fromBlock <= boundary) {
        throw new Error('could not coalesce error (error={ "code": -32000, "message": "internal server errror" })');
      }
      throw new Error(`requested logs from ${recentPart - 1} blocks from main backend but only allowed to search ${recentMax} blocks from main backend per request`);
    }
    return inner(f);
  };
  return chain;
}

test('an RPC that refuses a wide window over its newest blocks: the window is split, the hour loads and live follows', async () => {
  const s = setup({ head: 1_000_000 });
  publicRpcLimits(s.chain);
  s.chain.logs.push(curveLog('buy', 999_990), curveLog('sell', 992_000), curveLog('buy', 990_400), curveLog('sell', 975_000));
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);

  assert.ok(s.chain.refused > 0, 'the node did refuse the full window');
  const hour = seen.status.find((x) => x.historySeconds === 3600);
  assert.ok(hour, 'the first hour loaded');
  assert.equal(hour.state, 'live');
  assert.deepEqual(ix.recentTrades(10).map((t) => t.block), [975_000, 990_400, 992_000, 999_990], 'nothing lost across the splits');
  for (const c of s.chain.calls('getLogs')) assert.ok(c.toBlock - c.fromBlock + 1 <= 10_000);

  // and live trades flow
  s.chain.logs.push(curveLog('buy', 1_000_004));
  s.chain.head = 1_000_005;
  await s.clock.advance(400);
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [1_000_004]);
  s.reg.stopAll();
});

test('a rate limit or a timeout is not split: it backs off as before', async () => {
  const s = setup();
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  await s.clock.advance(400); // the history loop's last window: from here only live polls read
  const before = s.chain.calls('getLogs').length;
  s.chain.head = 40_005;
  const inner = s.chain.getLogs.bind(s.chain);
  let refuse = 1;
  s.chain.getLogs = async (f) => {
    if (refuse > 0) {
      refuse -= 1;
      s.chain.timeline.push({ m: 'getLogs', ...f });
      throw new Error('server response 429 Too Many Requests');
    }
    return inner(f);
  };
  await s.clock.advance(400);
  assert.equal(s.chain.calls('getLogs').length - before, 1, 'one call, no split');
  assert.equal(seen.status.at(-1).state, 'catching_up');
  s.reg.stopAll();
});

// ── graduation ───────────────────────────────────────────────────────────────────

test('a curve that graduates switches to the pool filter with no gap', async () => {
  let graduated = false;
  const s = setup({ refreshPhase: async () => (graduated ? gradVenue : curveVenue) });
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  await s.clock.advance(10_000); // first check: still a curve, confirmed at block 40,000

  s.chain.logs.push(v4Log(40_100));
  s.chain.head = 40_300;
  graduated = true;
  await s.clock.advance(10_000);
  await s.clock.advance(400);

  assert.equal(seen.phase.length, 1);
  assert.equal(seen.phase[0].kind, 'graduated');
  assert.equal(ix.venue.kind, 'graduated');
  assert.equal(s.marks.at(-1).venue.kind, 'graduated', 'the mark follows the new venue');
  const pool = s.chain.calls('getLogs').filter((c) => c.address === POOL_MANAGER);
  assert.ok(pool.length > 0, 'reads the PoolManager now');
  assert.deepEqual(pool[0].topics, [TOPICS.V4_SWAP, POOL_ID]);
  assert.equal(pool[0].fromBlock, 40_000 - 50, 'from just before the last confirmed curve block');
  const traded = seen.trades.flat();
  assert.deepEqual(traded.map((t) => [t.block, t.side]), [[40_100, 'buy']]);
  s.chain.head = 40_400;
  await s.clock.advance(400);
  const liveAfter = s.chain.calls('getLogs').filter((c) => c.fromBlock > 40_300);
  assert.ok(liveAfter.length > 0);
  assert.ok(liveAfter.every((c) => c.address === POOL_MANAGER), 'no more curve polls');
  s.reg.stopAll();
});

test('a curve that goes quiet after trading re-reads its phase early', async () => {
  const s = setup();
  s.reg.acquire(curveVenue);
  await s.clock.advance(0);
  s.chain.logs.push(curveLog('buy', 40_002));
  s.chain.head = 40_003;
  await s.clock.advance(400);
  assert.equal(s.phases.length, 0);
  await s.clock.advance(2_400);
  assert.equal(s.phases.length, 1, 'checked ~2 s after the last trade, not at 10 s');
  assert.equal(s.phases[0].opts.provider, s.chain, 'phase reads ride the chart provider too');
  s.reg.stopAll();
});

test("a graduated token's history also reads its former curve; live polls do not", async () => {
  const s = setup({ venue: gradVenue });
  s.chain.logs.push(curveLog('buy', 30_000), v4Log(35_000));
  const ix = s.reg.acquire(gradVenue);
  await s.clock.advance(0);
  assert.deepEqual(ix.recentTrades(10).map((t) => t.block), [30_000, 35_000]);
  const hist = s.chain.calls('getLogs');
  assert.ok(hist.some((c) => c.address === CURVE), 'history reads the former curve');
  s.chain.head = 40_100;
  await s.clock.advance(400);
  const live = s.chain.calls('getLogs').filter((c) => c.fromBlock > 40_000);
  assert.ok(live.length > 0);
  assert.ok(live.every((c) => c.address === POOL_MANAGER), 'live polls read only the pool');
  s.reg.stopAll();
});

test('graduated and v1 venues never re-read their phase', async () => {
  const s = setup({ venue: gradVenue });
  s.reg.acquire(gradVenue);
  await s.clock.advance(0);
  await s.clock.advance(30_000);
  assert.equal(s.phases.length, 0);
  s.reg.stopAll();
});

// ── WSS push (wss.js) ────────────────────────────────────────────────────────────

const livePolls = (s) => s.chain.calls('getLogs').filter((c) => c.fromBlock > 40_000).length;

test('with the WSS live, quiet polls relax to 2 s and a pushed log is read at once', async () => {
  const wss = fakeWss();
  const s = setup({ wss });
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0); // the first live tick; the hour loads on the history loop
  assert.equal(wss.started, 1, 'the probe starts with the first indexer');
  assert.deepEqual(wss.watched(), liveFilters(curveVenue), 'its live filter is watched');
  // The live poll keeps the socket's 2 s safety pace from its first tick; the 24 h fill
  // (its last window at 400 ms) runs on its own loop and pace.

  s.chain.head = 40_020;
  await s.clock.advance(1_999);
  assert.equal(livePolls(s), 0, 'no poll inside the 2 s safety pace');
  s.chain.logs.push(curveLog('buy', 40_015));
  wss.push(40_015);
  await s.clock.advance(0);
  assert.equal(livePolls(s), 1, 'woken at once');
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [40_015]);
  s.reg.stopAll();
});

test('a pushed block the HTTP node has not served yet is re-read every 200 ms', async () => {
  const wss = fakeWss();
  const s = setup({ wss });
  const ix = s.reg.acquire(curveVenue);
  const seen = watch(ix);
  await s.clock.advance(0);
  await s.clock.advance(400);
  wss.push(40_003); // this RPC node still says 40,000
  await s.clock.advance(200);
  assert.equal(livePolls(s), 0, 'nothing to read yet');
  s.chain.logs.push(curveLog('buy', 40_003));
  s.chain.head = 40_003;
  await s.clock.advance(200);
  assert.deepEqual(seen.trades.flat().map((t) => t.block), [40_003], '200 ms later, not at the 2 s poll');
  s.reg.stopAll();
});

test('the socket going down puts a sleeping indexer back on 400 ms polls', async () => {
  const wss = fakeWss();
  const s = setup({ wss });
  s.reg.acquire(curveVenue);
  await s.clock.advance(0);
  await s.clock.advance(400); // the next tick is 2 s away
  s.chain.head = 40_010;
  wss.setLive(false);
  await s.clock.advance(400);
  assert.equal(livePolls(s), 1, 'polled 400 ms after the socket went down');
  await s.clock.advance(400);
  assert.equal(s.chain.calls('getBlockNumber').length >= 3, true, 'and every 400 ms after that');
  s.reg.stopAll();
});

test('watches follow the venue: re-subscribed on graduation, dropped on stop', async () => {
  let graduated = false;
  const wss = fakeWss();
  const s = setup({ wss, refreshPhase: async () => (graduated ? gradVenue : curveVenue) });
  const ix = s.reg.acquire(curveVenue);
  await s.clock.advance(0);
  assert.deepEqual(wss.watched(), liveFilters(curveVenue));
  graduated = true;
  await s.clock.advance(12_000); // the 10 s phase check
  assert.equal(ix.venue.kind, 'graduated');
  assert.deepEqual(wss.watched(), liveFilters(gradVenue), 'the curve filter dropped, the pool filter watched');
  s.reg.release(TOKEN);
  await s.clock.advance(300_000);
  assert.equal(s.reg.activeCount(), 0);
  assert.deepEqual(wss.watched(), [], 'a stopped indexer watches nothing');
});

// ── registry ─────────────────────────────────────────────────────────────────────

test('acquire is ref-counted and stops 5 min after the last release', async () => {
  const s = setup();
  const MIXED = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const a = s.reg.acquire({ ...curveVenue, token: MIXED });
  const b = s.reg.acquire({ ...curveVenue, token: '0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' });
  assert.equal(a, b, 'one indexer per token, whatever the case');
  assert.equal(s.reg.activeCount(), 1);
  await s.clock.advance(0);

  s.reg.release(MIXED);
  s.reg.release(MIXED.toUpperCase().replace('0X', '0x'));
  await s.clock.advance(299_999);
  assert.equal(s.reg.activeCount(), 1, 'still warm inside the 5 minutes');
  await s.clock.advance(1);
  assert.equal(s.reg.activeCount(), 0);
  const calls = s.chain.timeline.length;
  await s.clock.advance(10_000);
  assert.equal(s.chain.timeline.length, calls, 'a stopped indexer makes no calls');
});

test('a viewer returning inside 5 min gets the same warm indexer', async () => {
  const s = setup();
  const a = s.reg.acquire(curveVenue);
  await s.clock.advance(0);
  s.reg.release(TOKEN);
  await s.clock.advance(100_000);
  assert.equal(s.reg.acquire(curveVenue), a);
  await s.clock.advance(400_000);
  assert.equal(s.reg.activeCount(), 1);
  s.reg.stopAll();
});

test('past TP_MAX_TOKENS a new token is refused with too_many / 503 unless one is idle', async () => {
  const s = setup({ maxTokens: 2 });
  const tok = (n) => ({ ...curveVenue, token: '0x' + String(n).repeat(40) });
  s.reg.acquire(tok(2));
  s.reg.acquire(tok(3));
  assert.throws(
    () => s.reg.acquire(tok(4)),
    (err) => err instanceof TpError && err.code === 'too_many' && err.status === 503
  );
  s.reg.release(tok(2).token); // idle, lingering
  s.reg.acquire(tok(4)); // evicts the idle one
  assert.equal(s.reg.activeCount(), 2);
  s.reg.stopAll();
});

test('TP_MAX_TOKENS comes from the environment, default 30', () => {
  const saved = process.env.TP_MAX_TOKENS;
  try {
    delete process.env.TP_MAX_TOKENS;
    const clock = fakeClock();
    const deps = { provider: fakeChain({ head: 1 }), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now };
    const r30 = createRegistry(deps);
    for (let i = 0; i < 30; i++) r30.acquire({ ...curveVenue, token: '0x' + i.toString(16).padStart(40, '0') });
    assert.throws(() => r30.acquire({ ...curveVenue, token: '0x' + 'f'.repeat(40) }), /30 tokens/);
    r30.stopAll();
    process.env.TP_MAX_TOKENS = '1';
    const r1 = createRegistry(deps);
    r1.acquire(curveVenue);
    assert.throws(() => r1.acquire({ ...curveVenue, token: '0x' + 'e'.repeat(40) }), /1 tokens/);
    r1.stopAll();
  } finally {
    if (saved === undefined) delete process.env.TP_MAX_TOKENS;
    else process.env.TP_MAX_TOKENS = saved;
  }
});
