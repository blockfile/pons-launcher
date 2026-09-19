import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed, OFFLINE_STATUS } from './feed.js';
import { createHub } from './hub.js';

// ── fakes: no network. A stream is a recorded callback the test drives. ──
const X = '0x' + '1'.repeat(40);
const Y = '0x' + '2'.repeat(40);

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function fakeSession(token) {
  const s = {
    venue: { token },
    live: [],
    marks: [],
    receipts: [],
    trades: [],
    reconnects: 0,
    setLive: (on) => s.live.push(on),
    onMark: (m) => s.marks.push(m),
    onReceipt: (r) => s.receipts.push(r),
    onTrades: (t) => s.trades.push(t),
    onReconnect: () => {
      s.reconnects += 1;
    },
  };
  return s;
}

function harness() {
  const streams = [];
  const polls = [];
  const api = {
    getTokenAnswer: null,
    tokenReads: [],
    openStream(token, interval, onEvent) {
      const st = { token, interval, emit: onEvent, closed: false };
      streams.push(st);
      return () => {
        st.closed = true;
      };
    },
    async getToken(token) {
      api.tokenReads.push(token);
      if (typeof api.getTokenAnswer === 'function') return api.getTokenAnswer(token);
      throw new Error('429 too many requests');
    },
  };
  const hub = createHub();
  const heard = [];
  for (const name of ['snapshot', 'mark', 'bar', 'trades', 'phase', 'status']) hub.on(name, (d) => heard.push([name, d]));
  let session = null;
  const marks = [];
  const venues = [];
  const timers = {
    setInterval: (fn) => {
      polls.push(fn);
      return polls.length;
    },
    clearInterval: (id) => {
      polls[id - 1] = null;
    },
  };
  const feed = createFeed({
    api,
    hub,
    getSession: () => session,
    setMark: (m) => marks.push(m),
    followVenue: (v) => venues.push(v),
    timers,
  });
  return {
    feed,
    api,
    streams,
    heard,
    marks,
    venues,
    use: (s) => {
      session = s;
    },
    poll: async () => {
      for (const fn of [...polls]) if (fn) await fn(); // the polls running now, not ones opened meanwhile
      await flush();
    },
  };
}

const snap = (token, over = {}) => ({ interval: 1, mark: { block: 5, token }, venue: { token, kind: 'curve' }, bars: [], ...over });

test("a token switch never inherits the old token's liveness; a refused stream leaves the new session offline", async () => {
  const h = harness();
  const sx = fakeSession(X);
  h.use(sx);
  h.feed.open(X);
  h.feed.setTimeframe(1);
  h.streams[0].emit('snapshot', snap(X));
  assert.equal(h.feed.isLive(X), true);
  assert.deepEqual(sx.live, [true]);

  // openToken(Y): the new session is created while X's stream is still live.
  const sy = fakeSession(Y);
  h.use(sy);
  assert.equal(h.feed.isLive(Y), false, 'what App hands the new session');
  // The [token] effect: the old token's feed closes, the new one opens.
  h.feed.close();
  assert.equal(h.streams[0].closed, true);
  h.feed.open(Y);
  h.feed.setTimeframe(1);
  // Y's stream is refused (3 distinct tokens per IP, a shared NAT's 5 streams).
  h.streams[1].emit('stream:error', { status: 429 });
  h.streams[1].emit('stream:retry', { attempt: 1 });
  assert.ok(!sy.live.includes(true), 'the new session never believes it is live');
  assert.equal(h.feed.isLive(Y), false);
  assert.ok(h.heard.some(([n, d]) => n === 'status' && d === OFFLINE_STATUS), 'the chart says live data is paused');
});

test("events of the old token's stream in the switch window never reach the new session or the page", async () => {
  const h = harness();
  h.use(fakeSession(X));
  h.feed.open(X);
  h.feed.setTimeframe(1);
  h.streams[0].emit('snapshot', snap(X));
  const before = { heard: h.heard.length, marks: h.marks.length, venues: h.venues.length };
  const sy = fakeSession(Y);
  h.use(sy); // openToken(Y) ran; the [token] cleanup has not yet
  h.streams[0].emit('mark', { block: 6, token: X });
  h.streams[0].emit('snapshot', snap(X, { mark: { block: 7, token: X } }));
  h.streams[0].emit('trades', [{ block: 8 }]);
  h.streams[0].emit('bar', { interval: 1 });
  h.streams[0].emit('receipt', { hash: '0xab' });
  assert.deepEqual(sy.marks, [], "X's mark never prices Y's floors");
  assert.deepEqual(sy.trades, []);
  assert.deepEqual(sy.receipts, []);
  assert.equal(h.marks.length, before.marks, 'nor becomes the page mark');
  assert.equal(h.heard.length, before.heard, "nor draws on Y's chart");
  assert.equal(h.venues.length, before.venues);
});

test('the same token re-opened keeps its live stream', () => {
  const h = harness();
  h.use(fakeSession(X));
  h.feed.open(X);
  h.feed.setTimeframe(1);
  h.streams[0].emit('snapshot', snap(X));
  h.use(fakeSession(X.toUpperCase().replace('0X', '0x')));
  assert.equal(h.feed.isLive(X.toUpperCase().replace('0X', '0x')), true);
});

test('a pending stream for a timeframe already left is closed, never promoted; the newest one replaces the live one', () => {
  const h = harness();
  const s = fakeSession(X);
  h.use(s);
  h.feed.open(X);
  h.feed.setTimeframe(1);
  const [one] = h.streams;
  one.emit('snapshot', snap(X));
  h.feed.setTimeframe(15);
  h.feed.setTimeframe(60);
  const [, fifteen, sixty] = h.streams;
  assert.equal(fifteen.closed, true, 'the timeframe the visitor already left');
  assert.equal(one.closed, false, 'make-before-break: the live stream keeps feeding the page');
  const snaps = h.heard.filter(([n]) => n === 'snapshot').length;
  fifteen.emit('snapshot', snap(X, { interval: 15 }));
  assert.equal(h.heard.filter(([n]) => n === 'snapshot').length, snaps, 'a late snapshot of a left timeframe never paints');
  sixty.emit('snapshot', snap(X, { interval: 60 }));
  assert.equal(one.closed, true, 'the new stream took over');
  one.emit('mark', { block: 99 });
  assert.ok(!s.marks.some((m) => m.block === 99), 'nothing from a closed stream');
});

test('with no live stream the mark and the venue are polled; a live stream stops the poll', async () => {
  const h = harness();
  const s = fakeSession(X);
  h.use(s);
  h.feed.open(X);
  h.feed.setTimeframe(1);
  h.api.getTokenAnswer = () => ({ venue: { token: X, kind: 'graduated' }, mark: { block: 42 } });
  await h.poll();
  assert.deepEqual(h.api.tokenReads, [X]);
  assert.deepEqual(s.marks.at(-1), { block: 42 });
  assert.deepEqual(h.marks.at(-1), { block: 42 });
  assert.deepEqual(h.venues.at(-1), { token: X, kind: 'graduated' }, 'a graduation is still followed');
  assert.ok(h.heard.some(([n, d]) => n === 'mark' && d.block === 42));
  h.streams[0].emit('snapshot', snap(X));
  await h.poll();
  assert.equal(h.api.tokenReads.length, 1, 'no poll while the stream is live');
});

test('a poll answer for a token already left is dropped', async () => {
  const h = harness();
  h.use(fakeSession(X));
  h.feed.open(X);
  let answer;
  h.api.getTokenAnswer = () => new Promise((r) => (answer = r));
  const pending = h.poll();
  await flush();
  const sy = fakeSession(Y);
  h.use(sy);
  h.feed.close();
  h.feed.open(Y);
  answer({ venue: { token: X }, mark: { block: 1 } });
  await pending;
  assert.deepEqual(sy.marks, []);
  assert.deepEqual(h.marks, []);
  assert.deepEqual(h.venues, []);
});

test("a live stream's retry marks the page offline; its reconnect snapshot settles the gap and goes live again", () => {
  const h = harness();
  const s = fakeSession(X);
  h.use(s);
  h.feed.open(X);
  h.feed.setTimeframe(1);
  h.streams[0].emit('snapshot', snap(X));
  h.streams[0].emit('stream:retry', { attempt: 1 });
  assert.deepEqual(s.live, [true, false]);
  assert.equal(h.feed.isLive(X), false);
  h.streams[0].emit('snapshot', snap(X));
  assert.equal(s.reconnects, 1, 'the missed-receipt sweep runs');
  assert.deepEqual(s.live, [true, false, true]);
  assert.deepEqual(h.venues.at(-1), { token: X, kind: 'curve' }, 'a snapshot names the venue: followed');
});
