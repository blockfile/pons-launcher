'use strict';

// GET /api/tp/stream through the real router on a loopback port. Lives in src/routes
// (not src/tp) because it requires ./tp — the Task 1 isolation rule keeps src/tp/**
// from requiring ../routes/*. venue / indexer are replaced through their module
// objects (stream.js looks them up at call time), so nothing reaches a chain.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const express = require('express');

const router = require('./tp');
const venueMod = require('../tp/venue');
const indexerMod = require('../tp/indexer');
const { streamSlots } = require('../tp/limits');

const LF = String.fromCharCode(10); // never typed as an escape (memory: write-tool-escapes)
const TOKEN = '0x' + '1'.repeat(40);
const VENUE = { kind: 'curve', token: TOKEN, curve: '0x' + '3'.repeat(40), decimals: 18, pairDecimals: 18, phase: 0 };

let server;
let base;

function fakeIndexer() {
  const ix = new EventEmitter();
  Object.assign(ix, {
    venue: VENUE,
    mark: null,
    bars: () => [],
    barAt: () => null,
    recentTrades: () => [],
    status: () => ({ state: 'live', detail: 'live', historySeconds: 3600 }),
  });
  return ix;
}

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' })); // as server.js does, app-wide
  app.use('/api/tp', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/tp`;
});

test.after(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

test('GET /stream is registered with no read limiter in front', () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/stream' && l.route.methods.get);
  assert.ok(layer, 'GET /stream is registered');
  assert.equal(layer.route.stack.length, 1, 'one handler: stream.js enforces its own per-IP slots');
  if (router.notYet) assert.notEqual(layer.route.stack[0].handle, router.notYet, 'no longer the placeholder');
});

test('a bad token is a 400 bad_address JSON answer', async () => {
  const r = await fetch(`${base}/stream?token=nope`);
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'token must be a 0x contract address', code: 'bad_address' });
});

test('a bad interval is a 400 bad_request JSON answer', async () => {
  const r = await fetch(`${base}/stream?token=${TOKEN}&interval=7`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'bad_request');
});

test('a malformed sid is a 400 bad_request JSON answer', async () => {
  const r = await fetch(`${base}/stream?token=${TOKEN}&sid=nope`);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'bad_request');
});

test('an open stream: SSE headers, a snapshot, live events, and cleanup on disconnect', async (t) => {
  const ix = fakeIndexer();
  const released = [];
  t.mock.method(venueMod, 'resolveVenue', async () => VENUE);
  t.mock.method(indexerMod, 'acquire', () => ix);
  t.mock.method(indexerMod, 'release', (token) => released.push(token));

  const ac = new AbortController();
  const r = await fetch(`${base}/stream?token=${TOKEN}&interval=60`, { signal: ac.signal });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-type').startsWith('text/event-stream'));
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal(r.headers.get('x-accel-buffering'), 'no');

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const readFrame = async () => {
    while (!text.includes(LF + LF)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended early');
      text += decoder.decode(value, { stream: true });
    }
    const at = text.indexOf(LF + LF);
    const block = text.slice(0, at);
    text = text.slice(at + 2);
    const [ev, data] = block.split(LF);
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
  };

  const first = await readFrame();
  assert.equal(first.event, 'snapshot');
  assert.equal(first.data.interval, 60);
  assert.equal(first.data.venue.token, TOKEN);
  assert.match(first.data.sid, /^[0-9a-f]{32}$/, 'the sid the browser puts in its broadcasts');

  // the stream stays open after the request is fully read
  await new Promise((resolve) => setTimeout(resolve, 50));
  ix.emit('mark', { block: 5, price: 1e-9 });
  assert.deepEqual(await readFrame(), { event: 'mark', data: { block: 5, price: 1e-9 } });
  assert.equal(streamSlots.count('127.0.0.1'), 1);

  ac.abort();
  for (let i = 0; i < 100 && released.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(released, [TOKEN]);
  assert.equal(streamSlots.count('127.0.0.1'), 0);
  assert.equal(ix.listenerCount('mark'), 0);
});
