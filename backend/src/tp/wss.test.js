'use strict';

// Offline: the WebSocket is a fake class that answers JSON-RPC in microtasks, the
// clock is fake, nothing leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWss, wssUrl } = require('./wss');
const { TOPICS, POOL_MANAGER } = require('./constants');

const URL = 'wss://node.example/secret-key/';
const CURVE = '0x' + 'c'.repeat(40);
const F = { address: CURVE, topics: [[TOPICS.CURVE_BUY, TOPICS.CURVE_SELL]] };
const hex = (n) => '0x' + n.toString(16);

// ── fakes ───────────────────────────────────────────────────────────────────────

/** A fake WebSocket class. opts: refuse, chainId, refuseLogs, pushBeforeAnswer. */
function fakeSockets(opts = {}) {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.subs = new Map(); // subscription id -> eth_subscribe params
      this.closed = false;
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.seq = 0;
      sockets.push(this);
      queueMicrotask(() => {
        if (opts.refuse) {
          this.fire('error', {});
          this.fire('close', {});
        } else {
          this.fire('open', {});
        }
      });
    }

    addEventListener(type, fn) {
      this.listeners[type].push(fn);
    }

    fire(type, ev) {
      for (const fn of this.listeners[type]) fn(ev);
    }

    message(obj) {
      this.fire('message', { data: JSON.stringify(obj) });
    }

    send(text) {
      const msg = JSON.parse(text);
      this.sent.push(msg);
      const answer = (result) => queueMicrotask(() => this.message({ jsonrpc: '2.0', id: msg.id, result }));
      const refuse = (message) =>
        queueMicrotask(() => this.message({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message } }));
      if (msg.method === 'eth_chainId') return answer(opts.chainId || '0x1237');
      if (msg.method === 'eth_subscribe') {
        if (msg.params[0] === 'logs' && opts.refuseLogs) return refuse('logs subscriptions are not supported');
        this.seq += 1;
        const id = hex(0xa000 + this.seq);
        this.subs.set(id, msg.params);
        if (opts.pushBeforeAnswer && msg.params[0] === 'logs' && msg.params[1].address === CURVE) {
          // the notification and the answer land in one read, notification first
          queueMicrotask(() => {
            this.message({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result: { blockNumber: hex(777) } } });
            this.message({ jsonrpc: '2.0', id: msg.id, result: id });
          });
          return undefined;
        }
        return answer(id);
      }
      if (msg.method === 'eth_unsubscribe') {
        this.subs.delete(msg.params[0]);
        return answer(true);
      }
      return refuse('unknown method');
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      queueMicrotask(() => this.fire('close', {}));
    }

    notify(kind, match, result) {
      for (const [id, params] of this.subs) {
        if (params[0] !== kind || !match(params)) continue;
        this.message({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: id, result } });
      }
    }

    head(n) {
      this.notify('newHeads', () => true, { number: hex(n) });
    }

    log(address, block, extra = {}) {
      this.notify('logs', (p) => p[1].address === address, { address, blockNumber: hex(block), removed: false, ...extra });
    }

    subscribed(kind) {
      return [...this.subs.values()].filter((p) => p[0] === kind);
    }
  }
  return { FakeWS, sockets };
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

function setup(opts = {}, over = {}) {
  const env = fakeSockets(opts);
  const clock = fakeClock();
  const logs = [];
  const changes = [];
  const wss = createWss({
    url: () => URL,
    WebSocket: env.FakeWS,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: (m) => logs.push(m),
    ...over,
  });
  wss.onChange((up) => changes.push(up));
  return { env, clock, logs, changes, wss };
}

async function goLive(opts) {
  const h = setup(opts);
  h.wss.start();
  await h.clock.advance(0); // open, chain id, newHeads, the logs probe: waiting for a head
  assert.equal(h.wss.live(), false, 'not live before a head arrives');
  h.sock = h.env.sockets[0];
  h.sock.head(100);
  await h.clock.advance(0);
  assert.equal(h.wss.live(), true);
  return h;
}

// ── the URL ─────────────────────────────────────────────────────────────────────

test('wssUrl: explicit, off, or the chart RPC URL as ws(s); nothing else', () => {
  assert.equal(wssUrl({ TP_CHART_WSS_URL: 'wss://a.example/k/' }, 'https://x.example/'), 'wss://a.example/k/');
  assert.equal(wssUrl({ TP_CHART_WSS_URL: ' OFF ' }, 'https://x.example/k/'), null);
  assert.equal(wssUrl({ TP_CHART_WSS_URL: 'ftp://nope' }, 'https://x.example/'), null);
  assert.equal(wssUrl({}, 'https://x.example/k/'), 'wss://x.example/k/');
  assert.equal(wssUrl({ TP_CHART_RPC_URL: 'http://127.0.0.1:8546' }, 'https://x.example/'), 'ws://127.0.0.1:8546');
  assert.equal(wssUrl({}, ''), null);
});

// ── the probe ───────────────────────────────────────────────────────────────────

test('the probe: chain id, newHeads, a logs subscription, then a head: live, logged without the URL', async () => {
  const h = await goLive();
  const calls = h.sock.sent.map((m) => (m.method === 'eth_subscribe' ? `${m.method}:${m.params[0]}` : m.method));
  assert.deepEqual(calls, ['eth_chainId', 'eth_subscribe:newHeads', 'eth_subscribe:logs', 'eth_unsubscribe']);
  assert.deepEqual(h.sock.sent[2].params[1], { address: POOL_MANAGER, topics: [TOPICS.V4_SWAP, '0x' + '0'.repeat(64)] });
  assert.equal(h.sock.url, URL);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /chart WSS live/);
  assert.ok(h.logs.every((m) => !m.includes('secret-key')), 'the URL carries the endpoint key');
  assert.deepEqual(h.changes, [true]);
  h.wss.stop();
});

test('a wrong chain is refused: closed, polling, re-probed after 5 min, the reason logged once', async () => {
  const h = setup({ chainId: '0x1' });
  h.wss.start();
  await h.clock.advance(0);
  assert.equal(h.wss.live(), false);
  assert.equal(h.env.sockets[0].closed, true);
  assert.deepEqual(h.logs, ['[tp] chart WSS unavailable (chain 1, not 4663); the chart polls; next probe in 5 min']);
  await h.clock.advance(299_999);
  assert.equal(h.env.sockets.length, 1);
  await h.clock.advance(1);
  assert.equal(h.env.sockets.length, 2, 're-probed after 5 min');
  assert.equal(h.logs.length, 1, 'the same failure is not logged again');
  assert.deepEqual(h.changes, []);
  h.wss.stop();
});

test('no head within 5 s is a failed probe', async () => {
  const h = setup();
  h.wss.start();
  await h.clock.advance(4_999);
  assert.equal(h.env.sockets[0].closed, false, 'still waiting for a head');
  await h.clock.advance(1);
  assert.equal(h.wss.live(), false);
  assert.equal(h.env.sockets[0].closed, true);
  assert.match(h.logs[0], /unavailable \(no head within 5 s\)/);
  h.wss.stop();
});

test('an endpoint that refuses logs subscriptions is not used', async () => {
  const h = setup({ refuseLogs: true });
  h.wss.start();
  await h.clock.advance(0);
  assert.equal(h.wss.live(), false);
  assert.match(h.logs[0], /unavailable \(logs subscriptions are not supported\)/);
  h.wss.stop();
});

test('a refused connection: polling, nothing thrown, retried later', async () => {
  const h = setup({ refuse: true });
  h.wss.start();
  await h.clock.advance(0);
  assert.equal(h.wss.live(), false);
  assert.match(h.logs[0], /unavailable \(socket (error|closed)\)/);
  await h.clock.advance(300_000);
  assert.equal(h.env.sockets.length, 2);
  h.wss.stop();
});

test('a WebSocket constructor that throws (a malformed URL) is a failed probe, not a crash', async () => {
  let built = 0;
  class Throws {
    constructor() {
      built += 1;
      throw new SyntaxError('Invalid URL');
    }
  }
  const h = setup({}, { WebSocket: Throws });
  h.wss.start();
  await h.clock.advance(0);
  assert.equal(h.wss.live(), false);
  assert.deepEqual(h.logs, ['[tp] chart WSS unavailable (Invalid URL); the chart polls; next probe in 5 min']);
  await h.clock.advance(300_000);
  assert.equal(built, 2, 'probed again 5 min later');
  h.wss.stop();
});

test('no WebSocket global or no URL: polling only, logged once, never probed again', async () => {
  const noWs = setup({}, { WebSocket: undefined });
  noWs.wss.start();
  noWs.wss.start();
  await noWs.clock.advance(600_000);
  assert.deepEqual(noWs.logs, ['[tp] chart WSS off: this Node has no WebSocket global (Node 22+); the chart polls every 400 ms']);

  const off = setup({}, { url: () => null });
  off.wss.start();
  await off.clock.advance(600_000);
  assert.equal(off.env.sockets.length, 0);
  assert.deepEqual(off.logs, ['[tp] chart WSS off: the chart polls every 400 ms']);
});

// ── watches ─────────────────────────────────────────────────────────────────────

test('watch: subscribes the filter while live, passes pushed block numbers, ignores removed logs', async () => {
  const h = await goLive();
  const got = [];
  const off = h.wss.watch(F, (n) => got.push(n));
  await h.clock.advance(0);
  assert.deepEqual(h.sock.subscribed('logs'), [['logs', F]]);

  h.sock.log(CURVE, 40_001);
  h.sock.log(CURVE, 40_002, { removed: true });
  h.sock.log('0x' + 'd'.repeat(40), 40_003);
  assert.deepEqual(got, [40_001]);

  off();
  await h.clock.advance(0);
  assert.equal(h.sock.sent.at(-1).method, 'eth_unsubscribe');
  assert.deepEqual(h.sock.subscribed('logs'), []);
  h.wss.stop();
});

test('a watch made before the socket is live is subscribed when it goes live', async () => {
  const h = setup();
  const got = [];
  h.wss.watch(F, (n) => got.push(n));
  h.wss.start();
  await h.clock.advance(0);
  const sock = h.env.sockets[0];
  assert.deepEqual(sock.subscribed('logs'), [], 'nothing but the probe before live');
  sock.head(100);
  await h.clock.advance(0);
  assert.deepEqual(sock.subscribed('logs'), [['logs', F]]);
  sock.log(CURVE, 50_000);
  assert.deepEqual(got, [50_000]);
  h.wss.stop();
});

test('a notification that beats its eth_subscribe answer is still delivered', async () => {
  const h = await goLive({ pushBeforeAnswer: true });
  const got = [];
  h.wss.watch(F, (n) => got.push(n));
  await h.clock.advance(0);
  assert.deepEqual(got, [777]);
  h.wss.stop();
});

// ── losing the socket ───────────────────────────────────────────────────────────

test('3 s without a head drops a live socket; the re-probe re-subscribes every watch', async () => {
  const h = await goLive();
  h.wss.watch(F, () => {});
  await h.clock.advance(2_000);
  h.sock.head(101);
  await h.clock.advance(2_999);
  assert.equal(h.wss.live(), true, 'the last head was 2.999 s ago');
  await h.clock.advance(1);
  assert.equal(h.wss.live(), false);
  assert.deepEqual(h.changes, [true, false]);
  assert.equal(h.sock.closed, true);
  assert.match(h.logs.at(-1), /chart WSS lost \(no head for 3 s\); back to 400 ms polls/);

  await h.clock.advance(300_000);
  const next = h.env.sockets[1];
  assert.ok(next, 're-probed');
  next.head(200);
  await h.clock.advance(0);
  assert.equal(h.wss.live(), true);
  assert.deepEqual(next.subscribed('logs'), [['logs', F]]);
  assert.deepEqual(h.changes, [true, false, true]);
  h.wss.stop();
});

test('a socket error while live drops it at once and fails nothing else', async () => {
  const h = await goLive();
  h.sock.fire('error', {});
  await h.clock.advance(0);
  assert.equal(h.wss.live(), false);
  assert.deepEqual(h.changes, [true, false]);
  assert.match(h.logs.at(-1), /lost \(socket error\)/);
  h.wss.stop();
});

test('stop(): closes the socket and cancels the re-probe', async () => {
  const h = setup({ chainId: '0x1' });
  h.wss.start();
  await h.clock.advance(0);
  h.wss.stop();
  await h.clock.advance(600_000);
  assert.equal(h.env.sockets.length, 1);

  const live = await goLive();
  live.wss.stop();
  await live.clock.advance(0);
  assert.equal(live.sock.closed, true);
  assert.equal(live.wss.live(), false);
});
