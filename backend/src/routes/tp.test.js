'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { Interface, Wallet } = require('ethers');

const router = require('./tp');
const { TpError } = require('../tp/errors');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp', router);
  // Stands in for the console's auth-gated routers: nothing under /api/tp may reach it.
  app.use('/api', (req, res) => res.status(401).json({ error: 'CONSOLE ROUTER REACHED' }));
  return app;
}

let server;

test.before(async () => {
  server = http.createServer(makeApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

test.after(() => server.close());

function call(method, p) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

function routeLayer(method, p) {
  return router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]);
}

// The interface contract's route table.
const CONTRACT_ROUTES = [
  ['get', '/token/:ca', 'readLimit'],
  ['post', '/wallets', 'readLimit'],
  ['get', '/fees', 'readLimit'],
  ['post', '/quote', 'readLimit'],
  ['post', '/quote/pair', 'readLimit'],
  ['post', '/broadcast', 'broadcastLimit'],
  ['get', '/stream', null],
];

test('every contract route is registered, behind the right limiter', () => {
  for (const [method, p, limiter] of CONTRACT_ROUTES) {
    const layer = routeLayer(method, p);
    assert.ok(layer, `${method.toUpperCase()} ${p} is registered`);
    if (limiter) {
      assert.equal(layer.route.stack[0].handle, router.limiters[limiter], `${method.toUpperCase()} ${p} → ${limiter}`);
    }
  }
});

test('a route whose module has not landed answers 501 {error, code: unavailable}', async () => {
  const stubs = CONTRACT_ROUTES.filter(([method, p]) => {
    const layer = routeLayer(method, p);
    return router.notYet && layer.route.stack[layer.route.stack.length - 1].handle === router.notYet;
  });
  for (const [method, p] of stubs) {
    const url = `/api/tp${p.replace(':ca', '0x0000000000000000000000000000000000000001')}`;
    const r = await call(method.toUpperCase(), url);
    assert.equal(r.status, 501, url);
    assert.deepEqual(r.json, { error: 'not available yet', code: 'unavailable' }, url);
  }
});

test('an unknown /api/tp path is answered 404 by the tp router itself — never the console', async () => {
  for (const p of ['/api/tp/nope', '/api/tp', '/api/tp/token', '/api/tp/../v4/wallets/backup']) {
    const r = await call('GET', p);
    assert.equal(r.status, 404, p);
    assert.deepEqual(r.json, { error: 'not found' }, p);
  }
});

// Each test below uses its own client IP: the limiter's buckets live for the process.
function fakeReq(ip, txs) {
  return { socket: { remoteAddress: ip }, headers: {}, body: { token: '0x01', txs } };
}

function runLimiter(mw, req) {
  let passed = null;
  mw(req, { set() {} }, (err) => {
    passed = err || 'next';
  });
  return passed;
}

const LIMITS_FROM_ENV =
  Boolean(process.env.TP_BROADCAST_TX_PER_MIN || process.env.TP_APPROVE_TX_PER_MIN) &&
  'TP_BROADCAST_TX_PER_MIN or TP_APPROVE_TX_PER_MIN is set';

// '0x00' is not a transaction, so it is charged to the sell bucket.
const sells = (n) => new Array(n).fill('0x00');

test('the broadcast limiter charges one token per raw transaction (600 sell tx/min per IP)', { skip: LIMITS_FROM_ENV }, () => {
  const mw = router.limiters.broadcastLimit;
  for (let i = 0; i < 6; i++) assert.equal(runLimiter(mw, fakeReq('203.0.113.50', sells(100))), 'next', `click ${i + 1}`);
  // 50, not 1: a single token refills every 100 ms, fifty take 5 s — no timing flake
  const refused = runLimiter(mw, fakeReq('203.0.113.50', sells(50)));
  assert.ok(refused instanceof TpError);
  assert.equal(refused.code, 'rate_limited');
});

test('approvals have their own 300/min bucket: arming 100 wallets never spends the sell budget', { skip: LIMITS_FROM_ENV }, async () => {
  const mw = router.limiters.broadcastLimit;
  // One approval signed offline with a throwaway key; the limiter reads only its selector.
  const approve = await Wallet.createRandom().signTransaction({
    type: 2,
    chainId: 4663,
    nonce: 0,
    to: `0x${'11'.repeat(20)}`,
    data: new Interface(['function approve(address spender, uint256 amount) returns (bool)']).encodeFunctionData('approve', [
      `0x${'22'.repeat(20)}`,
      1n,
    ]),
    gasLimit: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 0n,
  });
  const arm = fakeReq('203.0.113.51', new Array(100).fill(approve));
  for (let i = 0; i < 3; i++) assert.equal(runLimiter(mw, arm), 'next', `arm batch ${i + 1}`);
  const armRefused = runLimiter(mw, arm);
  assert.ok(armRefused instanceof TpError, 'a 4th hundred approvals inside the minute is refused');
  // the same visitor's sell clicks still get the whole sell budget
  for (let i = 0; i < 6; i++) assert.equal(runLimiter(mw, fakeReq('203.0.113.51', sells(100))), 'next', `sell click ${i + 1}`);
});
