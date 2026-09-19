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
const tokenInfo = require('../tp/tokenInfo');
const providers = require('../tp/providers');
const C = require('../tp/constants');
const { fakeChain } = require('../tp/test-helpers/fakeChain');
const { TpError } = require('../tp/errors');
const router = require('./tp');

// GET /token/:ca also starts the token-info read (and a v1 pool's balance read) in the
// background, through the dApp's read provider. Offline by default in this file: that
// provider refuses every call, so such a read fails at once and caches nothing. A test
// that wants a chain stubs tpReadProvider itself (stub() restores this default after it).
const refuse = async () => {
  throw new Error('offline test: no chain');
};
providers.tpReadProvider = () => ({ call: refuse, getBlockNumber: refuse });

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

// What tokenInfo.readTokenInfo reads for VENUE (a v2 curve), and a v1 venue of the same token.
const PHANTOM = 168n * 10n ** 16n;
const THRESHOLD = 42n * 10n ** 17n;
const DEPLOYER = '0xf50a3fb0ab1ec4c6d5bff7d59be3e9c1e1b6d3a1';
const POOL = '0x2d0e0c8b1fdf4cb2b1f4a5ad0e1c4f5a6b7c8d9e';
const ZERO = '0x0000000000000000000000000000000000000000';
const V1_VENUE = { ...VENUE, kind: 'v1', curve: null, pool: POOL };
const BALANCE_OF = 'function balanceOf(address) view returns (uint256)';

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** getJson, or 'waited' when no answer comes within `ms`. */
async function getJsonWithin(url, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve('waited'), ms);
  });
  try {
    return await Promise.race([getJson(url), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A chain that answers VENUE's token-info multicall. */
function infoChain() {
  const chain = fakeChain();
  const curveSig = (name) => C.ABI.CURVE.find((s) => s.startsWith(`function ${name}(`));
  chain.on(TOKEN, C.ABI.PONS_TOKEN[0], () => [DEPLOYER, '', 'A token.', ['', '', '', '', '']]);
  chain.on(C.PONS_V2_FACTORY, C.ABI.V2_FACTORY[0], () => [
    [TOKEN, CURVE, DEPLOYER, DEPLOYER, ZERO, THRESHOLD, 10000, 200, 100, false, 0, 0n, 0n, 0n, true],
  ]);
  chain.on(CURVE, curveSig('launchedAt'), () => [1789821655n]);
  chain.on(CURVE, curveSig('phantomQuote'), () => [PHANTOM]);
  chain.on(CURVE, curveSig('launchSupply'), () => [10n ** 27n]);
  return chain;
}

test('GET /token/:ca also answers {info, figures}: the info as far as it has read when the mark answers', async (t) => {
  tokenInfo._clearCache();
  t.after(() => tokenInfo._clearCache());
  const chain = infoChain();
  stub(t, providers, 'tpReadProvider', () => chain.provider);
  stub(t, venue, 'resolveVenue', async () => VENUE);
  let marks = 0;
  stub(t, state, 'readMark', async (v) => {
    assert.equal(v, VENUE);
    marks += 1;
    await later(20); // the mark's own round trips: the info's one multicall answers first
    return { block: 7, price: 2e-9, quoteReserve: (PHANTOM + 21n * 10n ** 17n).toString(), tokenReserve: '1', feeBps: 100 };
  });
  await withServer(async (base) => {
    let { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 200);
    assert.deepEqual(body.venue, VENUE, 'the venue is unchanged');
    assert.equal(body.mark.block, 7, 'the mark is unchanged');
    assert.deepEqual(body.info, JSON.parse(JSON.stringify(tokenInfo.cachedInfo(TOKEN))));
    assert.equal(body.info.description, 'A token.');
    assert.equal(body.info.launchedAt, 1789821655);
    assert.deepEqual(body.figures, { progress: 0.5, raised: (21n * 10n ** 17n).toString(), liquidity: null });
    ({ status, body } = await getJson(`${base}/token/${TOKEN}`));
    assert.equal(status, 200);
    assert.equal(body.info.description, 'A token.');
    assert.equal(chain.count('aggregate3'), 1, 'cached forever: a second load reads only the mark');
    assert.equal(marks, 2);
  });
});

test("GET /token/:ca waits for nothing but the venue and the mark: it is the sell click's stale-mark fallback", async (t) => {
  tokenInfo._clearCache();
  let calls = 0;
  const order = [];
  let release;
  const hung = new Promise((resolve, reject) => {
    release = () => reject(new Error('released'));
  });
  hung.catch(() => {});
  // Every chain read hangs until the test ends: an info read and a pool read that never answer.
  stub(t, providers, 'tpReadProvider', () => ({
    call: () => {
      calls += 1;
      order.push('header read');
      return hung;
    },
  }));
  t.after(async () => {
    release();
    await new Promise((resolve) => setImmediate(resolve));
    tokenInfo._clearCache();
  });
  stub(t, venue, 'resolveVenue', async () => V1_VENUE);
  stub(t, state, 'readMark', async () => {
    order.push('mark');
    return { block: 7, price: 1e-9, sqrtPriceX96: '1', liquidity: '1', tick: 0 };
  });
  await withServer(async (base) => {
    for (const round of [1, 2]) {
      const r = await getJsonWithin(`${base}/token/${TOKEN}`, 2000);
      assert.notEqual(r, 'waited', `load ${round}: GET /token waited on a read that has not answered`);
      assert.equal(r.status, 200);
      assert.equal(r.body.mark.block, 7, 'the mark answered without them');
      assert.equal(r.body.info, null);
      assert.deepEqual(r.body.figures, { progress: null, raised: null, liquidity: null });
    }
    assert.equal(calls, 2, 'the info read and the pool read each started once, then joined');
    assert.deepEqual(order.slice(0, 2), ['mark', 'header read'], "the mark read starts first, ahead of the header's reads");
  });
});

test("GET /token/:ca: a v1 token's liquidity is its pool's balances, once read", async (t) => {
  tokenInfo._clearCache();
  t.after(() => tokenInfo._clearCache());
  const chain = fakeChain();
  chain.on(C.WETH, BALANCE_OF, () => [5096n * 10n ** 14n]);
  chain.on(TOKEN, BALANCE_OF, () => [7363n * 10n ** 23n]);
  stub(t, providers, 'tpReadProvider', () => chain.provider);
  stub(t, venue, 'resolveVenue', async () => V1_VENUE);
  stub(t, state, 'readMark', async () => {
    await later(20);
    return { block: 7, price: 1e-9, sqrtPriceX96: '1', liquidity: '1', tick: 0 };
  });
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 200);
    assert.deepEqual(body.figures, {
      progress: null,
      raised: null,
      liquidity: { quote: (5096n * 10n ** 14n).toString(), token: (7363n * 10n ** 23n).toString() },
    });
  });
});

test('GET /token/:ca: an info that will not read is info: null; the venue and the mark still answer', async (t) => {
  tokenInfo._clearCache();
  // This file's offline provider: the info read fails.
  stub(t, venue, 'resolveVenue', async () => VENUE);
  stub(t, state, 'readMark', async () => {
    await later(20); // the failed read has long answered
    return { block: 7, price: 1e-9, quoteReserve: '1', tokenReserve: '2', feeBps: 100 };
  });
  await withServer(async (base) => {
    const { status, body } = await getJson(`${base}/token/${TOKEN}`);
    assert.equal(status, 200);
    assert.equal(body.info, null);
    assert.deepEqual(body.figures, { progress: null, raised: null, liquidity: null });
    assert.equal(body.mark.block, 7);
    assert.deepEqual(body.venue, VENUE);
  });
  assert.equal(tokenInfo.cachedInfo(TOKEN), null, 'a failed read is not cached: the next load reads again');
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
