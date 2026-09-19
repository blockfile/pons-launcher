'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { createStreamHandler, parseSid, frame, PING_MS, REPLAY_MS, STATS_MS } = require('./stream');
const { TpError } = require('./errors');
const { createTokenSlots } = require('./limits');

const LF = String.fromCharCode(10); // never typed as an escape (memory: write-tool-escapes)
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const T0 = 1_699_999_200; // aligned for every interval

const venue = { kind: 'curve', token: TOKEN, curve: '0x' + '3'.repeat(40), decimals: 18, pairDecimals: 18, phase: 0 };

// ── fakes ───────────────────────────────────────────────────────────────────────

function fakeReq(query, ip = '203.0.113.7', headers = {}) {
  const req = new EventEmitter();
  req.query = query;
  req.ip = ip;
  req.socket = { remoteAddress: ip };
  req.headers = headers;
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200,
    headers: null,
    headersSent: false,
    chunks: [],
    body: undefined,
    writableLength: 0,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
      this.emit('close');
    },
  });
  return res;
}

/** Split the written text into {event, data} frames, checking the framing as it goes. */
function frames(res) {
  const text = res.chunks.join('');
  assert.ok(text === '' || text.endsWith(LF + LF), 'every frame ends with a blank line');
  return text
    .split(LF + LF)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(LF);
      assert.equal(lines.length, 2, 'exactly one event line and one data line');
      assert.ok(lines[0].startsWith('event: '));
      assert.ok(lines[1].startsWith('data: '));
      return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) };
    });
}

function fakeIndexer() {
  const ix = new EventEmitter();
  ix.venue = venue;
  ix.mark = { block: 9, price: 2e-9 };
  ix.st = { state: 'live', detail: 'live; loading 24 h of history', historySeconds: 3600 };
  ix.status = () => ({ ...ix.st });
  ix.barsCalls = [];
  ix.bars = (interval, limit) => {
    ix.barsCalls.push([interval, limit]);
    return [{ time: T0, open: 1, high: 2, low: 1, close: 2, volume: 0.5 }];
  };
  ix.recentTrades = (n) => [{ block: 1, logIndex: 0, tx: '0x' + 'a'.repeat(64), ts: T0, side: 'buy', tokenAmt: '1', quoteAmt: '1', price: 1, trader: OTHER, n }];
  ix.barAt = (interval, time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: interval });
  return ix;
}

function fakeSlots(max = 5) {
  const open = new Map();
  return {
    open,
    acquire(ip) {
      const n = open.get(ip) || 0;
      if (n >= max) return false;
      open.set(ip, n + 1);
      return true;
    },
    release(ip) {
      open.set(ip, (open.get(ip) || 1) - 1);
    },
  };
}

const sidOf = (n) => n.toString(16).padStart(32, '0');

function setup(over = {}) {
  const ix = fakeIndexer();
  const bus = new EventEmitter();
  const slots = fakeSlots();
  const released = [];
  const intervals = [];
  const timeouts = [];
  const clock = { t: 1_000_000 };
  let sids = 0;
  const handler = createStreamHandler({
    newSid: () => sidOf((sids += 1)),
    now: () => clock.t,
    resolveVenue: async () => venue,
    acquire: () => ix,
    release: (t) => released.push(t),
    receiptBus: bus,
    streamSlots: slots,
    tokenSlots: createTokenSlots({ perIp: 3 }),
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length - 1;
    },
    clearInterval: (h) => {
      intervals[h].cleared = true;
    },
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, cleared: false });
      return timeouts.length - 1;
    },
    clearTimeout: (h) => {
      timeouts[h].cleared = true;
    },
    ...over,
  });
  return { ix, bus, slots, released, intervals, timeouts, handler, clock };
}

// ── framing ─────────────────────────────────────────────────────────────────────

test('frame() is "event: name", one JSON data line, then a blank line', () => {
  const data = { price: 1e-9, note: 'two' + LF + 'lines' };
  const lines = frame('mark', data).split(LF);
  assert.equal(lines.length, 4, 'a newline inside the data never breaks the frame');
  assert.equal(lines[0], 'event: mark');
  assert.ok(lines[1].startsWith('data: '));
  assert.deepEqual(JSON.parse(lines[1].slice(6)), data);
  assert.deepEqual(lines.slice(2), ['', '']);
});

test('SSE headers, then a snapshot first', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN.toUpperCase().replace('0X', '0x'), interval: '15' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  assert.equal(res.flushed, true);
  const [first, ...rest] = frames(res);
  assert.equal(rest.length, 0);
  assert.equal(first.event, 'snapshot');
  assert.deepEqual(Object.keys(first.data).sort(), ['bars', 'interval', 'mark', 'sid', 'stats', 'status', 'trades', 'venue']);
  assert.equal(first.data.sid, sidOf(1), 'a fresh sid for a stream opened without one');
  assert.equal(first.data.interval, 15);
  assert.deepEqual(s.ix.barsCalls, [[15, 5760]], 'a day of 15 s bars');
  assert.equal(first.data.venue.token, TOKEN);
  assert.deepEqual(first.data.mark, { block: 9, price: 2e-9 });
  assert.equal(first.data.status.historySeconds, 3600);
});

test('forwards trades with one bar per touched bucket, mark, phase and status', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN, interval: '15' }), res);
  res.chunks.length = 0;

  const trades = [
    { block: 1, logIndex: 0, ts: T0 + 16, side: 'buy', price: 1 },
    { block: 1, logIndex: 1, ts: T0 + 3, side: 'sell', price: 1 },
    { block: 2, logIndex: 0, ts: T0 + 29, side: 'buy', price: 1 },
  ];
  s.ix.emit('trades', trades);
  s.ix.emit('mark', { block: 10, price: 3e-9 });
  s.ix.emit('phase', { ...venue, kind: 'graduated', phase: 2 });
  s.ix.emit('status', { state: 'catching_up', detail: 'upstream timeout', historySeconds: 3600 });

  const got = frames(res);
  assert.deepEqual(got.map((f) => f.event), ['trades', 'bar', 'bar', 'mark', 'phase', 'status']);
  assert.equal(got[0].data.length, 3);
  assert.deepEqual(got[1].data, { interval: 15, bar: { time: T0, open: 1, high: 1, low: 1, close: 1, volume: 15 } });
  assert.equal(got[2].data.bar.time, T0 + 15);
  assert.equal(got[4].data.kind, 'graduated');
  assert.equal(got[5].data.state, 'catching_up');
});

test('the snapshot holds a day of bars, except 1 s which holds its last hour', async () => {
  for (const [interval, limit] of [[1, 3600], [60, 1440], [300, 288], [3600, 24]]) {
    const s = setup();
    await s.handler(fakeReq({ token: TOKEN, interval: String(interval) }), fakeRes());
    assert.deepEqual(s.ix.barsCalls, [[interval, limit]]);
  }
});

test('a status whose history grew re-sends the snapshot, with the same sid', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  res.chunks.length = 0;
  s.ix.st = { state: 'live', detail: 'live', historySeconds: 86400 };
  s.ix.emit('status', s.ix.status());
  s.ix.emit('status', s.ix.status()); // same history: no second snapshot
  const got = frames(res);
  assert.deepEqual(got.map((f) => f.event), ['status', 'snapshot', 'status']);
  assert.equal(got[1].data.sid, sidOf(1));
});

// ── receipts: only the visitor's own ────────────────────────────────────────────

const RECEIPT = { token: TOKEN, hash: '0x' + 'b'.repeat(64), from: OTHER, status: 'landed', block: 12, gasUsed: '90000' };
const receiptsOf = (res) => frames(res).filter((f) => f.event === 'receipt').map((f) => f.data);

test("receipts reach only the stream whose sid sent them, never another viewer's", async () => {
  const s = setup();
  const mine = fakeRes();
  const theirs = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), mine); // sid 1
  await s.handler(fakeReq({ token: TOKEN }, '198.51.100.9'), theirs); // sid 2, same token
  mine.chunks.length = 0;
  theirs.chunks.length = 0;

  s.bus.emit('receipt', { ...RECEIPT, sid: sidOf(1) });
  s.bus.emit('receipt', { ...RECEIPT, sid: sidOf(1), token: OTHER }); // right sid, other token
  s.bus.emit('receipt', { ...RECEIPT }); // no sid: nobody
  s.bus.emit('receipt', { ...RECEIPT, sid: sidOf(3) }); // a sid with no stream

  const want = { hash: RECEIPT.hash, from: OTHER, status: 'landed', block: 12, gasUsed: '90000' };
  assert.deepEqual(receiptsOf(mine), [want], 'no token, no sid in what is sent');
  assert.deepEqual(receiptsOf(theirs), [], 'the other viewer of the token sees none of them');
});

test('?sid= keeps the sid, so every stream of one visitor hears its receipts', async () => {
  const s = setup();
  const first = fakeRes();
  await s.handler(fakeReq({ token: TOKEN, interval: '1' }), first);
  const sid = frames(first)[0].data.sid;
  const second = fakeRes(); // a timeframe switch opens this before closing the first
  await s.handler(fakeReq({ token: TOKEN, interval: '60', sid }), second);
  assert.equal(frames(second)[0].data.sid, sid);
  first.chunks.length = 0;
  second.chunks.length = 0;
  s.bus.emit('receipt', { ...RECEIPT, sid });
  assert.equal(receiptsOf(first).length, 1);
  assert.equal(receiptsOf(second).length, 1);
});

test('a stream reopened with ?sid= first replays what it missed in the last 150 s', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  const sid = frames(res)[0].data.sid;
  res.emit('close'); // the connection drops

  const old = { ...RECEIPT, sid, hash: '0x' + 'c'.repeat(64) };
  s.bus.emit('receipt', old); // lands while no stream is open
  s.clock.t += REPLAY_MS + 1;
  s.bus.emit('receipt', { ...RECEIPT, sid }); // lands 150 s later, still during the gap
  s.bus.emit('receipt', { ...RECEIPT, sid, token: OTHER, hash: '0x' + 'd'.repeat(64) });
  s.bus.emit('receipt', { ...RECEIPT, sid: sidOf(9), hash: '0x' + 'e'.repeat(64) });

  const back = fakeRes();
  await s.handler(fakeReq({ token: TOKEN, sid }), back);
  const got = frames(back);
  assert.deepEqual(got.map((f) => f.event), ['snapshot', 'receipt'], 'the snapshot, then the replay');
  assert.equal(got[1].data.hash, RECEIPT.hash, 'only this token and sid, and nothing older than 150 s');

  const fresh = fakeRes(); // a stream WITHOUT ?sid= never replays anything
  await s.handler(fakeReq({ token: TOKEN }), fresh);
  assert.deepEqual(frames(fresh).map((f) => f.event), ['snapshot']);
});

test('parseSid: absent is null, 32 lower-case hex passes, anything else is bad_request', () => {
  assert.equal(parseSid(undefined), null);
  assert.equal(parseSid(null), null);
  assert.equal(parseSid(''), null);
  assert.equal(parseSid('ab'.repeat(16)), 'ab'.repeat(16));
  for (const bad of ['AB'.repeat(16), 'ab'.repeat(15), 'ab'.repeat(17), 'zz'.repeat(16), 42, ['ab'.repeat(16)], {}]) {
    assert.throws(() => parseSid(bad), (err) => err instanceof TpError && err.code === 'bad_request', String(bad));
  }
});

test('a malformed ?sid= is a 400 and holds no slot', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN, sid: 'not-a-sid' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'bad_request');
  assert.equal(s.slots.open.size, 0);
});

test('without a newSid override every stream gets its own random 128-bit sid', async () => {
  const s = setup();
  const handler = createStreamHandler({
    resolveVenue: async () => venue,
    acquire: () => s.ix,
    release: () => {},
    receiptBus: s.bus,
    streamSlots: fakeSlots(),
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const a = fakeRes();
  const b = fakeRes();
  await handler(fakeReq({ token: TOKEN }), a);
  await handler(fakeReq({ token: TOKEN }), b);
  const [sa, sb] = [frames(a)[0].data.sid, frames(b)[0].data.sid];
  assert.match(sa, /^[0-9a-f]{32}$/);
  assert.match(sb, /^[0-9a-f]{32}$/);
  assert.notEqual(sa, sb);
});

test('pings every 15 s', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  res.chunks.length = 0;
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].ms, 15_000);
  assert.equal(PING_MS, 15_000);
  s.intervals[0].fn();
  s.intervals[0].fn();
  assert.deepEqual(frames(res), [
    { event: 'ping', data: {} },
    { event: 'ping', data: {} },
  ]);
});

test("the request's own 'close' does not end a live stream", async () => {
  const s = setup();
  const req = fakeReq({ token: TOKEN });
  const res = fakeRes();
  await s.handler(req, res);
  req.emit('close'); // Node may emit this once the empty GET body is consumed
  res.chunks.length = 0;
  s.ix.emit('mark', { block: 11, price: 1 });
  assert.deepEqual(frames(res).map((f) => f.event), ['mark']);
  assert.deepEqual(s.released, []);
});

test('the socket closing cleans up everything exactly once', async () => {
  const s = setup();
  const req = fakeReq({ token: TOKEN });
  const res = fakeRes();
  await s.handler(req, res);
  assert.equal(s.slots.open.get('203.0.113.7'), 1);
  res.emit('close');
  res.emit('close');
  assert.deepEqual(s.released, [TOKEN]);
  assert.equal(s.slots.open.get('203.0.113.7'), 0);
  assert.equal(s.intervals[0].cleared, true);
  for (const name of ['trades', 'mark', 'phase', 'status']) assert.equal(s.ix.listenerCount(name), 0, name);
  assert.equal(s.bus.listenerCount('receipt'), 1, "only the handler's replay recorder stays");
  const before = res.chunks.length;
  s.ix.emit('mark', { block: 1, price: 1 });
  assert.equal(res.chunks.length, before, 'nothing is written after close');
});

test('a client too far behind is dropped instead of buffered', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  res.writableLength = 3 * 1024 * 1024;
  s.ix.emit('mark', { block: 1, price: 1 });
  assert.equal(res.destroyed, true);
  assert.deepEqual(s.released, [TOKEN]);
});

// ── refusals ────────────────────────────────────────────────────────────────────

test('a bad token or interval is a 400 JSON error and holds no slot', async () => {
  const s = setup();
  let res = fakeRes();
  await s.handler(fakeReq({ token: 'nope' }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'token must be a 0x contract address', code: 'bad_address' });
  res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN, interval: '7' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'bad_request');
  assert.equal(s.slots.open.size, 0);
});

test('past 5 streams from one IP the 6th is refused with 429 before any lookup', async () => {
  let lookups = 0;
  const s = setup({
    resolveVenue: async () => {
      lookups += 1;
      return venue;
    },
  });
  for (let i = 0; i < 5; i++) await s.handler(fakeReq({ token: TOKEN }), fakeRes());
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.equal(lookups, 5);
  // another visitor is unaffected
  const other = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }, '198.51.100.9'), other);
  assert.equal(other.statusCode, 200);
});

test('a refused venue or a full indexer answers with its TpError and frees the slot', async () => {
  const notPons = setup({
    resolveVenue: async () => {
      throw new TpError('not_pons', 'not a pons token');
    },
  });
  let res = fakeRes();
  await notPons.handler(fakeReq({ token: TOKEN }), res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'not a pons token', code: 'not_pons' });
  assert.equal(notPons.slots.open.get('203.0.113.7'), 0);

  const full = setup({
    acquire: () => {
      throw new TpError('too_many', 'busy', 503);
    },
  });
  res = fakeRes();
  await full.handler(fakeReq({ token: TOKEN }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'too_many');
  assert.equal(full.slots.open.get('203.0.113.7'), 0);
});

test('an unexpected failure answers unavailable and leaks no internals', async () => {
  const s = setup({
    resolveVenue: async () => {
      throw new Error('ECONNRESET 10.0.0.5:8545 internal detail');
    },
  });
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  assert.ok(res.statusCode >= 500, 'a 5xx (errors.sendError)');
  assert.equal(res.body.code, 'unavailable');
  assert.doesNotMatch(res.body.error, /ECONNRESET|10[.]0[.]0[.]5/);
  assert.equal(s.slots.open.get('203.0.113.7'), 0);
});

test('behind nginx the slot is keyed by X-Real-IP, not the loopback peer', async () => {
  const s = setup();
  const req = fakeReq({ token: TOKEN }, '127.0.0.1', { 'x-real-ip': '198.51.100.20' });
  await s.handler(req, fakeRes());
  assert.equal(s.slots.open.get('198.51.100.20'), 1);
  assert.equal(s.slots.open.get('127.0.0.1'), undefined);
});

test('a client that leaves during the lookup is released and never sent headers', async () => {
  let resolve;
  const s = setup({ resolveVenue: () => new Promise((r) => (resolve = r)) });
  const req = fakeReq({ token: TOKEN });
  const res = fakeRes();
  const pending = s.handler(req, res);
  res.emit('close');
  resolve(venue);
  await pending;
  assert.equal(res.headersSent, false);
  assert.deepEqual(s.released, [TOKEN]);
  assert.equal(s.slots.open.get('203.0.113.7'), 0);
});

test('one IP streams at most 3 DISTINCT tokens: a 4th is refused 429 before any lookup; closing one frees it', async () => {
  let lookups = 0;
  const s = setup({
    resolveVenue: async (ca) => {
      lookups += 1;
      return { ...venue, token: ca };
    },
  });
  const tok = (n) => '0x' + String(n).repeat(40);
  const open = [];
  for (const n of [4, 5, 6]) {
    const res = fakeRes();
    await s.handler(fakeReq({ token: tok(n) }), res);
    assert.equal(res.statusCode, 200);
    open.push(res);
  }
  const again = fakeRes();
  await s.handler(fakeReq({ token: tok(5), interval: '60' }), again);
  assert.equal(again.statusCode, 200, 'a second stream of a token it already streams is not a new token');
  const res = fakeRes();
  await s.handler(fakeReq({ token: tok(7) }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'rate_limited');
  assert.match(res.body.error, /tokens/);
  assert.equal(lookups, 4, 'refused before the venue lookup');
  assert.equal(s.slots.open.get('203.0.113.7'), 4, 'the refused stream holds no stream slot');
  // another visitor is unaffected
  const other = fakeRes();
  await s.handler(fakeReq({ token: tok(7) }, '198.51.100.9'), other);
  assert.equal(other.statusCode, 200);
  // closing the only stream of a token frees that token
  open[0].emit('close');
  const later = fakeRes();
  await s.handler(fakeReq({ token: tok(7) }), later);
  assert.equal(later.statusCode, 200);
});

test('a refused venue frees the token slot too', async () => {
  const s = setup({
    resolveVenue: async () => {
      throw new TpError('not_pons', 'not a pons token');
    },
  });
  for (let n = 1; n <= 5; n++) {
    const res = fakeRes();
    await s.handler(fakeReq({ token: '0x' + String(n).repeat(40) }), res);
    assert.equal(res.statusCode, 400, 'never 429: each refusal released its token');
  }
});

// ── stats: the token header's live numbers ────────────────────────────────────

const STATS = { at: 1, since: 0, price: 2e-9, change: { m5: 0, h1: 0, h24: 0 }, volume: { m5: 0, h1: 0, h24: 0 }, complete: { m5: true, h1: true, h24: true }, figures: { progress: 0.5, raised: '1', liquidity: null } };

/** A setup whose statsFor answers STATS (with a call count) unless told otherwise. */
function statsSetup(statsFor) {
  const calls = [];
  const s = setup({
    statsFor:
      statsFor ||
      ((ix) => {
        calls.push(ix);
        return { ...STATS, n: calls.length };
      }),
  });
  return { ...s, calls };
}

const statsFrames = (res) => frames(res).filter((f) => f.event === 'stats');
const pending = (s) => s.timeouts.filter((t) => !t.cleared && !t.fired);
function fire(s) {
  const [t] = pending(s);
  t.fired = true;
  t.fn();
}

test('the snapshot carries stats from the indexer', async () => {
  const s = statsSetup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  const [snap] = frames(res);
  assert.deepEqual(snap.data.stats, { ...STATS, n: 1 });
  assert.equal(s.calls[0], s.ix, "asked about this stream's indexer");
});

test('trades and marks schedule ONE stats frame, at most one per second, trailing', async () => {
  const s = statsSetup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  res.chunks.length = 0;
  s.ix.emit('trades', [{ block: 1, logIndex: 0, ts: T0, side: 'buy', price: 1 }]);
  s.ix.emit('mark', { block: 2, price: 1 });
  s.ix.emit('mark', { block: 3, price: 1 });
  assert.equal(pending(s).length, 1, 'one timer for the whole burst');
  assert.equal(pending(s)[0].ms, STATS_MS, 'a second after the snapshot sent its stats');
  assert.equal(STATS_MS, 1000);
  assert.deepEqual(statsFrames(res), [], 'nothing is sent synchronously');
  s.clock.t += STATS_MS;
  fire(s);
  assert.deepEqual(statsFrames(res).map((f) => f.data.n), [2]);
  s.clock.t += 300;
  s.ix.emit('mark', { block: 4, price: 1 });
  assert.equal(pending(s)[0].ms, 700, 'the next one waits out the rest of the second');
  fire(s);
  assert.deepEqual(statsFrames(res).map((f) => f.data.n), [2, 3]);
});

test('a ping schedules stats too, so the windows roll forward without trades', async () => {
  const s = statsSetup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  res.chunks.length = 0;
  s.intervals[0].fn();
  assert.deepEqual(frames(res).map((f) => f.event), ['ping']);
  assert.equal(pending(s).length, 1);
  fire(s);
  assert.deepEqual(frames(res).map((f) => f.event), ['ping', 'stats']);
});

test('stats that cannot be computed send nothing and never break the stream', async () => {
  for (const statsFor of [() => null, () => { throw new Error('boom'); }]) {
    const s = statsSetup(statsFor);
    const res = fakeRes();
    await s.handler(fakeReq({ token: TOKEN }), res);
    assert.equal(frames(res)[0].data.stats, null);
    res.chunks.length = 0;
    s.ix.emit('mark', { block: 2, price: 1 });
    fire(s);
    assert.deepEqual(frames(res).map((f) => f.event), ['mark']);
  }
});

test('closing the stream cancels a pending stats frame', async () => {
  const s = statsSetup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  s.ix.emit('mark', { block: 2, price: 1 });
  assert.equal(pending(s).length, 1);
  res.emit('close');
  assert.equal(pending(s).length, 0, 'the timer was cleared');
});

test('by default an indexer without stats() streams stats: null (tokenInfo.streamStats)', async () => {
  const s = setup();
  const res = fakeRes();
  await s.handler(fakeReq({ token: TOKEN }), res);
  assert.equal(frames(res)[0].data.stats, null);
});
