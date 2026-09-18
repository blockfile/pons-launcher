'use strict';

// GET /token/:ca, POST /wallets and GET /fees, over real HTTP on an ephemeral
// loopback port (no supertest — no new dependency). venue/state are stubbed per
// test through their module objects, so nothing here reaches a chain. The app
// mirrors routes/tp.test.js: express.json at app level (as server.js does), then
// the tp router.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { getAddress, hexlify, randomBytes } = require('ethers');

const venue = require('../tp/venue');
const state = require('../tp/state');
const { TpError } = require('../tp/errors');
const router = require('./tp');

const TOKEN = '0xd8865aa9052a5e2f59641bb613ca84ec9377b101';
const CURVE = '0x03ef670d7ec0e1c93e1a6cfa3bc24883c3492d81';
const VENUE = {
  kind: 'curve',
  token: TOKEN,
  name: 'Pons Test',
  symbol: 'PTEST',
  decimals: 18,
  totalSupply: '1000000000000000000000000000',
  pairToken: '0x0000000000000000000000000000000000000000',
  pairSymbol: 'ETH',
  pairDecimals: 18,
  nativeQuote: true,
  curve: CURVE,
  poolKey: null,
  poolId: null,
  pool: null,
  phase: 0,
  spenders: { approve: CURVE },
  formerCurve: null,
  hook: null,
  quoteIsCurrency0: null,
  poolFee: null,
  tokenIsToken0: null,
  router: null,
};

const randomAddress = () => getAddress(hexlify(randomBytes(20)));

/** Replace obj[name] for this test only. One stub per (obj, name) per test. */
function stub(t, obj, name, fn) {
  const original = obj[name];
  obj[name] = fn;
  t.after(() => {
    obj[name] = original;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/tp`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, body: await r.json() };
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// ── GET /token/:ca ──────────────────────────────────────────────────────────

test('GET /token/:ca answers {venue, mark} from the resolver and the mark reader', async (t) => {
  let asked = null;
  stub(t, venue, 'resolveVenue', async (ca) => {
    asked = ca;
    return VENUE;
  });
  stub(t, state, 'readMark', async (v) => {
    assert.equal(v, VENUE);
    return { block: 7, price: 1.5e-9, quoteReserve: '1', tokenReserve: '2', feeBps: 100 };
  });
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 200);
    assert.equal(asked, TOKEN);
    assert.deepEqual(body.venue, VENUE);
    assert.deepEqual(body.mark, { block: 7, price: 1.5e-9, quoteReserve: '1', tokenReserve: '2', feeBps: 100 });
  });
});

test('GET /token/:ca: a refusal is JSON {error, code} with the TpError status', async (t) => {
  let refusal = new TpError('not_pons', 'that is not a pons launch');
  stub(t, venue, 'resolveVenue', async () => {
    throw refusal;
  });
  await withServer(async (base) => {
    let r = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'that is not a pons launch', code: 'not_pons' });

    refusal = new TpError('migrating', 'mid-migration', 409);
    r = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'migrating');
  });
});

test('GET /token/:ca: a mark that will not read is mark: null, not a failed page', async (t) => {
  t.mock.method(console, 'warn', () => {});
  stub(t, venue, 'resolveVenue', async () => VENUE);
  stub(t, state, 'readMark', async () => {
    throw new Error('rpc timeout');
  });
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 200);
    assert.equal(body.mark, null);
    assert.deepEqual(body.venue, VENUE);
  });
});

test('an unexpected failure is 502 unavailable (errors.js sendError) and leaks no internals', async (t) => {
  t.mock.method(console, 'error', () => {});
  stub(t, venue, 'resolveVenue', async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:8545 secret-internal-host');
  });
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 502);
    assert.equal(body.code, 'unavailable');
    assert.equal(JSON.stringify(body).includes('secret-internal-host'), false);
  });
});

// ── POST /wallets ───────────────────────────────────────────────────────────

test('POST /wallets: validated, checksummed addresses go to readWallets; {venue, wallets} back', async (t) => {
  const a = randomAddress();
  const b = randomAddress();
  let got = null;
  stub(t, venue, 'resolveVenue', async (ca) => {
    assert.equal(ca, TOKEN);
    return VENUE;
  });
  stub(t, state, 'readWallets', async (v, addresses) => {
    got = { v, addresses };
    return addresses.map((address) => ({
      address,
      tokenBalance: '1',
      ethBalance: '2',
      nonce: 0,
      allowance: '0',
      permit2: null,
      pairBalance: null,
    }));
  });
  await withServer(async (base) => {
    const { status, body } = await postJson(`${base}/wallets`, { token: TOKEN, addresses: [a.toLowerCase(), b, a] });
    assert.equal(status, 200);
    assert.equal(got.v, VENUE);
    assert.deepEqual(got.addresses, [a, b]); // EIP-55, de-duplicated
    assert.deepEqual(body.venue, VENUE);
    assert.equal(body.wallets.length, 2);
    assert.equal(body.wallets[0].address, a);
  });
});

test('POST /wallets: 101 addresses is too_many, and no chain read happens', async (t) => {
  let resolved = false;
  stub(t, venue, 'resolveVenue', async () => {
    resolved = true;
    return VENUE;
  });
  stub(t, state, 'readWallets', async () => {
    throw new Error('must not be reached');
  });
  await withServer(async (base) => {
    const addresses = Array.from({ length: 101 }, randomAddress);
    const { status, body } = await postJson(`${base}/wallets`, { token: TOKEN, addresses });
    assert.equal(status, 400);
    assert.equal(body.code, 'too_many');
    assert.equal(resolved, false);
  });
});

test('POST /wallets: junk and bad-checksum addresses are bad_address naming the index only', async (t) => {
  stub(t, venue, 'resolveVenue', async () => VENUE);
  await withServer(async (base) => {
    let r = await postJson(`${base}/wallets`, { token: TOKEN, addresses: [randomAddress(), 'not-an-address'] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_address');
    assert.equal(r.body.error.includes('addresses[1]'), true);
    assert.equal(r.body.error.includes('not-an-address'), false);

    // the EIP-55 test vector with one letter's case flipped
    r = await postJson(`${base}/wallets`, { token: TOKEN, addresses: ['0x52908400098527886e0F7030069857D2E4169EE7'] });
    assert.equal(r.body.code, 'bad_address');
  });
});

test('POST /wallets: a body that is not {token, addresses[]} is bad_request', async (t) => {
  stub(t, venue, 'resolveVenue', async () => VENUE);
  await withServer(async (base) => {
    let r = await postJson(`${base}/wallets`, { token: TOKEN, addresses: 'nope' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_request');

    r = await postJson(`${base}/wallets`, [1, 2]);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'bad_request');
  });
});

// ── GET /fees ───────────────────────────────────────────────────────────────

test('GET /fees passes feeParams() through, ETH/USD included (a number, or null)', async (t) => {
  const fees = {
    maxFeePerGas: '40000000',
    maxPriorityFeePerGas: '0',
    baseFeePerGas: '20000000',
    block: 99,
    gasLimits: {
      approve: '100000',
      permit2Approve: '100000',
      sellCurve: '600000',
      sellV4: '500000',
      sellV1: '600000',
      pairSwap: '450000',
    },
    ethUsd: 3150.25,
  };
  let current = fees;
  stub(t, state, 'feeParams', async () => current);
  await withServer(async (base) => {
    let r = await getJson(`${base}/fees`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, fees);
    assert.equal(typeof r.body.ethUsd, 'number');

    current = { ...fees, ethUsd: null }; // price unavailable: still a 200 with the gas figures
    r = await getJson(`${base}/fees`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ethUsd, null);
    assert.equal(r.body.maxFeePerGas, '40000000');
  });
});
