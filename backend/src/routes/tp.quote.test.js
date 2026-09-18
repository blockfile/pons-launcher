'use strict';

// POST /api/tp/quote and /api/tp/quote/pair, end to end through express on a
// loopback port, through the REAL router (Task 1's readLimit, wrap and sendError).
// The send-path venue lookup (venue.cachedVenue), venue.refreshPhase and the read
// provider are swapped for fakes on their module objects, so no request leaves
// the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { Interface } = require('ethers');

const C = require('../tp/constants');
const venueMod = require('../tp/venue');
const providersMod = require('../tp/providers');
const tpRoutes = require('./tp');

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const ZERO = '0x0000000000000000000000000000000000000000';
const A1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';

const mc = new Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const curveI = new Interface([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function graduated() view returns (bool)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
]);
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const v4Q = new Interface([
  `function quoteExactInputSingle(tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);
const v3Q = new Interface([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

const curveVenue = { kind: 'curve', token: TOKEN, curve: CURVE, pairToken: ZERO, nativeQuote: true, spenders: { approve: CURVE } };
const gradVenue = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: ZERO,
  nativeQuote: true,
  poolKey: { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
  poolId: '0x' + '11'.repeat(32),
  spenders: { approve: C.PERMIT2, permit2Router: C.UNIVERSAL_ROUTER },
};

/** A chain where the curve has graduated and the pool pays 1 wei of ETH per 1000 tokens. */
const fakeChain = {
  async call({ to, data }) {
    assert.equal(to.toLowerCase(), C.MULTICALL3);
    const inner = mc.decodeFunctionData('aggregate3', data)[0];
    const out = inner.map((c) => {
      const target = c.target.toLowerCase();
      if (target === CURVE) {
        const name = curveI.parseTransaction({ data: c.callData }).name;
        if (name === 'getReserves') return [true, curveI.encodeFunctionResult('getReserves', [1n, 0n])];
        if (name === 'graduated') return [true, curveI.encodeFunctionResult('graduated', [true])];
        return [true, curveI.encodeFunctionResult(name, [0n])];
      }
      if (target === C.V4_QUOTER) {
        const [p] = v4Q.decodeFunctionData('quoteExactInputSingle', c.callData);
        return [true, v4Q.encodeFunctionResult('quoteExactInputSingle', [BigInt(p.exactAmount) / 1000n, 1n])];
      }
      if (target === C.QUOTER_V2) {
        const [, amountIn] = v3Q.decodeFunctionData('quoteExactInput', c.callData);
        return [true, v3Q.encodeFunctionResult('quoteExactInput', [BigInt(amountIn) * 2n, [], [], 0n])];
      }
      return [false, '0x'];
    });
    return mc.encodeFunctionResult('aggregate3', [out]);
  },
};

const saved = {
  cachedVenue: venueMod.cachedVenue,
  refreshPhase: venueMod.refreshPhase,
  tpReadProvider: providersMod.tpReadProvider,
};
let server;
let base;

test.before(async () => {
  providersMod.tpReadProvider = () => fakeChain;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp', tpRoutes);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/tp`;
});

test.after(() => {
  Object.assign(venueMod, { cachedVenue: saved.cachedVenue, refreshPhase: saved.refreshPhase });
  providersMod.tpReadProvider = saved.tpReadProvider;
  server.close();
  server.closeAllConnections();
});

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('POST /quote and /quote/pair are wired: readLimit first, no longer the notYet placeholder', () => {
  for (const p of ['/quote', '/quote/pair']) {
    const layer = tpRoutes.stack.find((l) => l.route && l.route.path === p && l.route.methods.post);
    assert.ok(layer, `POST ${p} is registered`);
    assert.equal(layer.route.stack[0].handle, tpRoutes.limiters.readLimit, `POST ${p}: readLimit is the first handler`);
    const last = layer.route.stack[layer.route.stack.length - 1].handle;
    if (tpRoutes.notYet) assert.notEqual(last, tpRoutes.notYet, `POST ${p} is no longer the placeholder`);
  }
});

test('POST /quote quotes the venue the token resolves to', async () => {
  venueMod.cachedVenue = async (ca) => {
    assert.equal(ca, TOKEN);
    return gradVenue;
  };
  const r = await post('/quote', { token: TOKEN, sells: [{ address: A1, amount: '1000000' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.quotes, [{ address: A1, amountOut: '1000', impactBps: 0, ok: true, reason: null }]);
});

test('POST /quote re-reads the phase once when the curve has graduated, then quotes the pool', async () => {
  let refreshed = 0;
  venueMod.cachedVenue = async () => curveVenue;
  venueMod.refreshPhase = async (v) => {
    refreshed += 1;
    assert.equal(v, curveVenue);
    return gradVenue;
  };
  const r = await post('/quote', { token: TOKEN, sells: [{ address: A1, amount: '1000000' }] });
  assert.equal(r.status, 200);
  assert.equal(refreshed, 1);
  assert.equal(r.body.quotes[0].ok, true);
  assert.equal(r.body.quotes[0].amountOut, '1000');
});

test('POST /quote refuses a bad token and a bad sells list with {error, code}', async () => {
  venueMod.cachedVenue = async () => gradVenue;
  let r = await post('/quote', { token: 'nope', sells: [] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'bad_address');
  r = await post('/quote', { token: TOKEN, sells: [{ address: A1, amount: '-1' }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'bad_request');
  assert.equal(typeof r.body.error, 'string');
});

test('POST /quote answers 502 unavailable for an unexpected failure (the router\'s sendError)', async () => {
  venueMod.cachedVenue = async () => {
    throw new Error('ECONNRESET');
  };
  const r = await post('/quote', { token: TOKEN, sells: [{ address: A1, amount: '1' }] });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'the chain did not answer in time — try again', code: 'unavailable' });
});

test('POST /quote/pair returns the route quote', async () => {
  const r = await post('/quote/pair', { pairToken: AMZN, amount: '1000000' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.path, [AMZN, C.USDG, C.WETH]);
  assert.equal(r.body.amountOut, '2000000');
  assert.equal(r.body.ok, true);
});

test('POST /quote/pair refuses ETH as a pair', async () => {
  const r = await post('/quote/pair', { pairToken: ZERO, amount: '1' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'bad_request');
});
