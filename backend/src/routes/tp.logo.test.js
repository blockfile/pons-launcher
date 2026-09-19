'use strict';

// GET /api/tp/logo/:ca over real HTTP on an ephemeral loopback port. venue, tokenInfo
// and logo are stubbed through their module objects: nothing here reaches a chain or a
// gateway. The app mirrors routes/tp.reads.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const venue = require('../tp/venue');
const tokenInfo = require('../tp/tokenInfo');
const logo = require('../tp/logo');
const { TpError } = require('../tp/errors');
const router = require('./tp');

const TOKEN = '0xd8865aa9052a5e2f59641bb613ca84ec9377b101';
const CID = 'bafkreif2nctwv7yv2iuqzw3jfrpe6iq6ko4vqxe7valfgejqtaox26pms4';
const VENUE = { kind: 'curve', token: TOKEN, curve: '0x03ef670d7ec0e1c93e1a6cfa3bc24883c3492d81' };
const INFO = { token: TOKEN, logo: { cid: CID, path: '/api/tp/logo/' + TOKEN } };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);

/** Replace obj[name] for this test only. */
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
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/tp`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubChain(t, { info = INFO, got = { ok: true, bytes: PNG, type: 'image/png', verified: true } } = {}) {
  const asked = [];
  stub(t, venue, 'cachedVenue', async (ca) => {
    assert.equal(ca, TOKEN);
    return VENUE;
  });
  stub(t, tokenInfo, 'readTokenInfo', async (v) => {
    assert.equal(v, VENUE);
    return info;
  });
  stub(t, logo, 'getLogo', async (cid) => {
    asked.push(cid);
    return got;
  });
  return asked;
}

test("GET /logo/:ca serves the token's IPFS logo: sniffed type, immutable cache, nosniff, CSP, same-origin", async (t) => {
  const asked = stubChain(t);
  await withServer(async (base) => {
    const r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
  });
  assert.deepEqual(asked, [CID], "the CID from the token's info — the request carries no URL");
});

test('a token with no IPFS logo is a 404 cached for a day, and no gateway is asked', async (t) => {
  const asked = stubChain(t, { info: { ...INFO, logo: null } });
  await withServer(async (base) => {
    const r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await r.json(), { error: 'this token has no logo that can be shown' });
  });
  assert.deepEqual(asked, []);
});

test('a logo the gateways could not serve is a 404 not cached; a blocked (451) one is cached a day', async (t) => {
  // One stub, whose answer changes in place: stubbing getLogo twice in one test would
  // leave the first stub installed afterwards (t.after runs its hooks first-in first-out).
  const got = { ok: false, permanent: false, reason: 'timeout' };
  stubChain(t, { got });
  await withServer(async (base) => {
    let r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    Object.assign(got, { permanent: true, reason: 'blocked' });
    r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
  });
});

test('a token that is not pons is refused with its TpError JSON before any fetch', async (t) => {
  let asked = 0;
  stub(t, venue, 'cachedVenue', async () => {
    throw new TpError('not_pons', 'that is not a pons launch');
  });
  stub(t, logo, 'getLogo', async () => {
    asked += 1;
    return { ok: false };
  });
  await withServer(async (base) => {
    const r = await fetch(`${base}/logo/0x0000000000000000000000000000000000000001`);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'that is not a pons launch', code: 'not_pons' });
  });
  assert.equal(asked, 0);
});

test('an unverified (dag-pb) logo is served cached for a day, never immutable', async (t) => {
  const got = { ok: true, bytes: PNG, type: 'image/png', verified: false };
  stubChain(t, { got });
  await withServer(async (base) => {
    let r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
    delete got.verified;
    r = await fetch(`${base}/logo/${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400', 'no verdict is not a verified one');
    await r.arrayBuffer();
  });
});
