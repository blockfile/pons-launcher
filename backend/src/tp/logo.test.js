'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createLogoStore, parseGateways, sniffImage, DEFAULT_GATEWAYS, DEFAULTS, LOGO_HEADERS } = require('./logo');

const GW = [
  { prefix: 'https://gw-a.test/ipfs/', timeoutMs: 1000 },
  { prefix: 'https://gw-b.test/ipfs/', timeoutMs: 1000 },
];
const V0 = 'QmPmVbpMQzDW5kA84Q3N7hRyuz43xTf329DGNP8W1xULGQ'; // dag-pb: not verifiable
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (n = 64) => Buffer.concat([Buffer.from(PNG_MAGIC), crypto.randomBytes(n)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

/** An independent base32 encoder, to build raw CIDs (bafkrei...) of test bytes. */
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(value >> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
const rawCidOf = (bytes) => 'b' + base32([0x01, 0x55, 0x12, 0x20, ...crypto.createHash('sha256').update(bytes).digest()]);

/**
 * A fake fetch: `routes` maps a URL to a function (init) -> Response (or a thrown error).
 * Records every call; an unknown URL answers 404.
 */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('nope', { status: 404 });
    return route(init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (bytes, headers = {}) => () => new Response(bytes, { status: 200, headers });

function store(over = {}) {
  return createLogoStore({ gateways: GW, maxBytes: 1024 * 1024, cacheBytes: 8 * 1024 * 1024, retryMs: 60_000, concurrency: 3, ...over });
}

// ── configuration ────────────────────────────────────────────────────────────

test('parseGateways: https prefixes ending in / with a per-gateway timeout; anything else is dropped', () => {
  assert.deepEqual(parseGateways(DEFAULT_GATEWAYS.join(',')), [
    { prefix: 'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/', timeoutMs: 4000 },
    { prefix: 'https://ipfs.filebase.io/ipfs/', timeoutMs: 4000 },
    { prefix: 'https://gateway.pinata.cloud/ipfs/', timeoutMs: 10000 },
  ]);
  assert.deepEqual(parseGateways(' https://a.test/ipfs/ , https://b.test/x/|999999, https://c.test/ipfs/|abc'), [
    { prefix: 'https://a.test/ipfs/', timeoutMs: 4000 },
    { prefix: 'https://b.test/x/', timeoutMs: 30000 },
    { prefix: 'https://c.test/ipfs/', timeoutMs: 4000 },
  ]);
  for (const bad of [
    'http://a.test/ipfs/',
    'https://a.test/ipfs',
    'https://a.test/ipfs/?x=1',
    'https://u:p@a.test/ipfs/',
    'https://a.test:8443/ipfs/',
    'https://A.test/ipfs/',
    'file:///etc/',
    'not a url',
  ]) {
    assert.deepEqual(parseGateways(bad), [], bad);
  }
  assert.deepEqual(parseGateways(undefined), []);
});

test('sniffImage: PNG, JPEG, GIF and WebP by magic bytes — never SVG or HTML', () => {
  assert.equal(sniffImage(png()), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF87a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF1234WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('RIFF1234WAVEfmt ')), null);
  assert.equal(sniffImage(SVG), null);
  assert.equal(sniffImage(Buffer.from('<!doctype html><html></html>')), null);
  assert.equal(sniffImage(Buffer.from(PNG_MAGIC.slice(0, 7))), null, 'a truncated signature');
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage(null), null);
});

test('LOGO_HEADERS: nosniff, a CSP that runs nothing, same-origin embedding only', () => {
  assert.deepEqual(LOGO_HEADERS, {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
});

test('backend/.env.example documents every TP_LOGO_* setting, with the defaults this module uses', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const lines = text.split(String.fromCharCode(10)).map((l) => l.trimEnd());
  for (const line of [
    '# TP_LOGO_GATEWAYS=' + DEFAULT_GATEWAYS.join(','),
    '# TP_LOGO_MAX_BYTES=' + DEFAULTS.maxBytes,
    '# TP_LOGO_CACHE_BYTES=' + DEFAULTS.cacheBytes,
    '# TP_LOGO_RETRY_MS=' + DEFAULTS.retryMs,
    '# TP_LOGO_CONCURRENCY=' + DEFAULTS.concurrency,
  ]) {
    assert.ok(lines.includes(line), line);
  }
  assert.equal(DEFAULTS.maxBytes, 1024 * 1024, "the spec's 1 MB cap");
});

// ── fetching ─────────────────────────────────────────────────────────────────

test('a logo comes from the first gateway, as <prefix><cid>, with redirects NOT followed', async () => {
  const bytes = png();
  const fetch = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: ok(bytes, { 'content-type': 'text/html' }) });
  const r = await store({ fetch }).getLogo(V0);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'image/png', 'the sniffed type, not the one the gateway claimed');
  assert.ok(r.bytes.equals(bytes));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.redirect, 'manual');
  assert.ok(fetch.calls[0].init.signal instanceof AbortSignal);
});

test('a gateway that fails — 5xx, 3xx, a refused connection, a timeout — passes to the next', async () => {
  const bytes = png();
  const b = 'https://gw-b.test/ipfs/' + V0;
  const failures = [
    () => new Response('down', { status: 502 }),
    () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    () => {
      throw new TypeError('fetch failed');
    },
    (init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  ];
  for (const fail of failures) {
    const fetch = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: fail, [b]: ok(bytes) });
    const gateways = [{ ...GW[0], timeoutMs: 20 }, GW[1]];
    const r = await store({ fetch, gateways }).getLogo(V0);
    assert.equal(r.ok, true, String(fail));
    assert.deepEqual(fetch.calls.map((c) => c.url), ['https://gw-a.test/ipfs/' + V0, b], 'the redirect target is never fetched');
  }
});

test('451 is FINAL: no other gateway is asked and the CID is never retried', async () => {
  let now = 0;
  const fetch = fakeFetch({
    ['https://gw-a.test/ipfs/' + V0]: () => new Response('blocked', { status: 451 }),
    ['https://gw-b.test/ipfs/' + V0]: ok(png()),
  });
  const s = store({ fetch, now: () => now });
  assert.deepEqual(await s.getLogo(V0), { ok: false, permanent: true, reason: 'blocked' });
  now += 10 * 365 * 86_400_000;
  assert.equal((await s.getLogo(V0)).ok, false);
  assert.equal(fetch.calls.length, 1);
});

test('over the byte cap — declared or streamed — is refused, and a streamed download is cut off', async () => {
  const big = png(2048);
  const declared = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: ok(big, { 'content-length': String(big.length) }) });
  let r = await store({ fetch: declared, maxBytes: 1024, gateways: [GW[0]] }).getLogo(V0);
  assert.deepEqual(r, { ok: false, permanent: false, reason: 'too_large' });

  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(pulled === 1 ? Buffer.from(PNG_MAGIC) : new Uint8Array(512));
        },
      }),
      { status: 200 }
    );
  const streamed = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: endless });
  r = await store({ fetch: streamed, maxBytes: 1024, gateways: [GW[0]] }).getLogo(V0);
  assert.equal(r.reason, 'too_large');
  assert.ok(pulled < 10, `stopped after ${pulled} chunks, not read to the end`);
});

test('an SVG or HTML answer is refused whatever its Content-Type', async () => {
  for (const body of [SVG, Buffer.from('<html><body>gateway error</body></html>')]) {
    const fetch = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: ok(body, { 'content-type': 'image/png' }) });
    const r = await store({ fetch, gateways: [GW[0]] }).getLogo(V0);
    assert.deepEqual(r, { ok: false, permanent: false, reason: 'not_image' });
  }
});

test('a raw CID is VERIFIED: bytes whose sha256 differs are refused and the next gateway is asked', async () => {
  const real = png();
  const cid = rawCidOf(real);
  const fetch = fakeFetch({ ['https://gw-a.test/ipfs/' + cid]: ok(png()), ['https://gw-b.test/ipfs/' + cid]: ok(real) });
  const r = await store({ fetch }).getLogo(cid);
  assert.equal(r.ok, true);
  assert.ok(r.bytes.equals(real));
  assert.equal(fetch.calls.length, 2);

  const liar = fakeFetch({ ['https://gw-a.test/ipfs/' + cid]: ok(png()) });
  assert.equal((await store({ fetch: liar, gateways: [GW[0]] }).getLogo(cid)).reason, 'hash_mismatch');
});

test('cached by CID: a second request fetches nothing, concurrent ones share one fetch', async () => {
  const fetch = fakeFetch({ ['https://gw-a.test/ipfs/' + V0]: ok(png()) });
  const s = store({ fetch });
  const [a, b] = await Promise.all([s.getLogo(V0), s.getLogo(V0)]);
  assert.ok(a.ok && b.ok);
  assert.equal((await s.getLogo(V0)).ok, true);
  assert.equal(fetch.calls.length, 1);
});

test('a failed CID is not retried for retryMs, then it is', async () => {
  let now = 0;
  let up = false;
  const fetch = fakeFetch({
    ['https://gw-a.test/ipfs/' + V0]: () => (up ? new Response(png(), { status: 200 }) : new Response('x', { status: 504 })),
  });
  const s = store({ fetch, now: () => now, retryMs: 60_000, gateways: [GW[0]] });
  assert.deepEqual(await s.getLogo(V0), { ok: false, permanent: false, reason: 'http_504' });
  up = true;
  now += 59_999;
  assert.equal((await s.getLogo(V0)).ok, false);
  assert.equal(fetch.calls.length, 1);
  now += 1;
  assert.equal((await s.getLogo(V0)).ok, true);
  assert.equal(fetch.calls.length, 2);
});

test('a malformed CID fetches nothing and is permanent', async () => {
  const fetch = fakeFetch();
  const s = store({ fetch });
  for (const bad of ['', 'Qm123', '../../etc/passwd', 'bafkrei' + '/x'.repeat(26), null]) {
    assert.deepEqual(await s.getLogo(bad), { ok: false, permanent: true, reason: 'bad_cid' });
  }
  assert.equal(fetch.calls.length, 0);
});

test('the byte budget evicts the least recently used logo', async () => {
  const imgs = [png(600), png(600), png(600)];
  const cids = imgs.map(rawCidOf);
  const routes = {};
  cids.forEach((c, i) => {
    routes['https://gw-a.test/ipfs/' + c] = ok(imgs[i]);
  });
  const fetch = fakeFetch(routes);
  const s = store({ fetch, cacheBytes: 1400 }); // two logos fit
  await s.getLogo(cids[0]);
  await s.getLogo(cids[1]);
  await s.getLogo(cids[0]); // touch 0: 1 is now the oldest
  await s.getLogo(cids[2]); // evicts 1
  assert.ok(s.heldBytes() <= 1400);
  const before = fetch.calls.length;
  await s.getLogo(cids[0]);
  assert.equal(fetch.calls.length, before, '0 is still held');
  await s.getLogo(cids[1]);
  assert.equal(fetch.calls.length, before + 1, '1 was evicted and fetched again');
});

test('at most `concurrency` gateway requests are in flight at once', async () => {
  let active = 0;
  let peak = 0;
  const imgs = Array.from({ length: 6 }, () => png());
  const routes = {};
  for (const img of imgs) {
    routes['https://gw-a.test/ipfs/' + rawCidOf(img)] = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response(img, { status: 200 });
    };
  }
  const s = store({ fetch: fakeFetch(routes), concurrency: 2 });
  const results = await Promise.all(imgs.map((img) => s.getLogo(rawCidOf(img))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(peak, 2);
});
