'use strict';

// The page's receipts, end to end: the REAL frontend api.js (broadcast + openStream)
// against the REAL router (POST /broadcast -> watchReceipts -> receiptBus -> GET /stream)
// on a loopback port. Only the chain (the send/read providers), the venue lookup and the
// chart indexer are fakes on their module objects.
//
// The server forwards a receipt only to the stream whose sid the broadcast carried
// (tp/stream.js). A page that sends no sid gets no receipt at all, and its rows settle
// only through the 20 s missed-receipt sweep. Covered here: an approval broadcast that
// goes out on load BEFORE the stream has connected still reaches the page (the per-sid
// replay), a broadcast while the stream is open arrives live, and another visitor's
// stream of the same token hears neither.

process.env.TP_SEQUENCER_URL = ''; // never send a test transaction anywhere (see tp.broadcast.test.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { once, EventEmitter } = require('node:events');
const { pathToFileURL } = require('url');
const express = require('express');
const { Interface, Transaction, Wallet } = require('ethers');

const router = require('./tp');
const venueMod = require('../tp/venue');
const indexerMod = require('../tp/indexer');
const providersMod = require('../tp/providers');

const API = path.resolve(__dirname, '../../../frontend/src/dapp/api.js');
const TOKEN = '0x' + '1'.repeat(40);
const CURVE = '0x' + '2'.repeat(40);
const ZERO = '0x' + '0'.repeat(40);
const VENUE = { kind: 'curve', token: TOKEN, curve: CURVE, pairToken: ZERO, nativeQuote: true, phase: 0, decimals: 18, pairDecimals: 18, spenders: { approve: CURVE } };
const curveI = new Interface(['function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)']);

const chain = {
  sent: [],
  async send(method, params) {
    assert.equal(method, 'eth_sendRawTransaction');
    this.sent.push(params[0]);
    return Transaction.from(params[0]).hash;
  },
  async getTransactionReceipt(hash) {
    const raw = this.sent.find((r) => Transaction.from(r).hash.toLowerCase() === hash);
    return raw ? { from: Transaction.from(raw).from, status: 1, blockNumber: 88, gasUsed: 50000n } : null;
  },
};

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

const saved = { ...venueMod };
const savedIx = { acquire: indexerMod.acquire, release: indexerMod.release };
const savedProv = { tpSendProvider: providersMod.tpSendProvider, tpReadProvider: providersMod.tpReadProvider };
let server;
let origin;
let api;

test.before(async () => {
  venueMod.resolveVenue = async () => VENUE;
  venueMod.cachedVenue = async () => VENUE;
  venueMod.refreshPhase = async (v) => v;
  indexerMod.acquire = () => fakeIndexer();
  indexerMod.release = () => {};
  providersMod.tpSendProvider = () => chain;
  providersMod.tpReadProvider = () => chain;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp', router);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  if (fs.existsSync(API)) api = await import(pathToFileURL(API).href);
});

test.after(() => {
  Object.assign(venueMod, saved);
  Object.assign(indexerMod, savedIx);
  Object.assign(providersMod, savedProv);
  server.closeAllConnections();
  server.close();
});

const viaServer = (url, init) => fetch(origin + url, init);

async function waitFor(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

const sell = (w, nonce) =>
  w.signTransaction({
    type: 2,
    chainId: 4663,
    nonce,
    to: CURVE,
    data: curveI.encodeFunctionData('sell', [10n ** 18n, 1n, w.address]),
    value: 0n,
    gasLimit: 300000n,
    maxFeePerGas: 10n ** 9n,
    maxPriorityFeePerGas: 0n,
  });

test("the page's receipts reach its own stream — even for a broadcast sent before the stream connected", async (t) => {
  if (!api) return t.skip('frontend/src/dapp/api.js is not in this checkout');
  const w = Wallet.createRandom();

  // 1. On load: the approvals go out while no stream is open yet.
  const early = await sell(w, 0);
  const r1 = await api.broadcast(TOKEN, [early], { fetch: viaServer });
  assert.equal(r1.results[0].ok, true);
  const earlyHash = Transaction.from(early).hash.toLowerCase();

  // 2. The page's stream opens (and a stranger watches the same token).
  const mine = [];
  const theirs = [];
  const close = api.openStream(TOKEN, 1, (name, data) => mine.push([name, data]), { fetch: viaServer, idleMs: 0 });
  const stranger = new AbortController();
  t.after(() => {
    close();
    stranger.abort();
  });
  const other = await fetch(`${origin}/api/tp/stream?token=${TOKEN}&interval=1`, { signal: stranger.signal });
  const reader = other.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      theirs.push(dec.decode(value));
    }
  })();

  await waitFor(() => mine.some(([n, d]) => n === 'receipt' && d.hash === earlyHash));
  const snap = mine.find(([n]) => n === 'snapshot');
  assert.equal(snap[1].sid, api.sidFor(TOKEN), 'the stream runs on the sid the broadcast carried');

  // 3. A sell while the stream is open arrives live.
  const live = await sell(w, 1);
  await api.broadcast(TOKEN, [live], { fetch: viaServer });
  const liveHash = Transaction.from(live).hash.toLowerCase();
  await waitFor(() => mine.some(([n, d]) => n === 'receipt' && d.hash === liveHash));
  const got = mine.filter(([n]) => n === 'receipt').map(([, d]) => d);
  assert.deepEqual(
    got.map((d) => [d.hash, d.status, d.block]),
    [
      [earlyHash, 'landed', 88],
      [liveHash, 'landed', 88],
    ]
  );

  // Another visitor's stream of the same token hears neither.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!theirs.join('').includes('event: receipt'), 'a stranger never hears this visitor receipts');
});
