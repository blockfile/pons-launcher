'use strict';

// tp/safeFetch.js: the SSRF-safe https GET for logos on ordinary https hosts. Offline:
// the DNS lookup and https.request are fakes, so every hop, every address and every
// option the real request would get is visible here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { safeGet, vetUrl, isForbiddenAddress, pinnedLookup, MAX_REDIRECTS, TIMEOUT_MS } = require('./safeFetch');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A DNS stand-in: name -> [addresses]; every name asked is logged. */
function fakeLookup(table, asked = []) {
  return async (host) => {
    asked.push(host);
    if (!(host in table)) throw new Error('ENOTFOUND');
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/**
 * An https.request stand-in answering `steps` in order: {status, headers, chunks} or
 * {hang: true} (never answers) or {error: true}. Every options object is logged in
 * `seen`, and every request in `reqs`, so a test can see that it was destroyed.
 */
function fakeRequest(steps, seen = [], reqs = []) {
  return (options, onResponse) => {
    seen.push(options);
    const req = new EventEmitter();
    reqs.push(req);
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
    };
    req.end = () => {
      const step = steps.shift();
      if (!step || step.hang) return;
      if (step.error) {
        setImmediate(() => req.emit('error', new Error('ECONNRESET')));
        return;
      }
      const res = Readable.from(step.chunks || []);
      res.statusCode = step.status;
      res.headers = step.headers || {};
      setImmediate(() => onResponse(res));
    };
    return req;
  };
}

const PUBLIC = { 'logo.example.com': ['93.184.216.34'], 'cdn.example.org': ['2606:4700:4700::1111'] };

test('isForbiddenAddress: every private, local, reserved or IPv4-carrying range is refused; public unicast is not', () => {
  const forbidden = [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.100.100.200', '0.0.0.0', '0.1.2.3',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.8', '192.0.2.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '192.88.99.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::808:808',
    '64:ff9b:1::1', '100::1', '2001::1', '2001:db8::1', '2002:7f00:1::', 'fc00::1',
    'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', 'not-an-ip', '', 'localhost',
    '::ffff:0:7f00:1', '::ffff:0:808:808', '2001:2::1', '3fff::1', '5f00::1',
  ];
  for (const a of forbidden) assert.equal(isForbiddenAddress(a), true, a);
  const allowed = ['8.8.8.8', '1.1.1.1', '46.225.60.163', '93.184.216.34', '172.32.0.1', '100.128.0.1', '11.0.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'];
  for (const a of allowed) assert.equal(isForbiddenAddress(a), false, a);
});

test('vetUrl: https on 443 to a DNS name only; the fragment is dropped', () => {
  assert.equal(vetUrl('https://pbs.twimg.com/media/x.png').href, 'https://pbs.twimg.com/media/x.png');
  assert.equal(vetUrl('  https://Logo.Example.COM:443/a.png?w=64#frag ').href, 'https://logo.example.com/a.png?w=64');
  for (const bad of [
    'http://logo.example.com/a.png',
    'https://logo.example.com:8443/a.png',
    'https://user:pw@logo.example.com/a.png',
    'https://user@logo.example.com/a.png',
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://2130706433/a.png',
    'https://0x7f.1/a.png',
    'https://localhost/a.png',
    'https://a.localhost/a.png',
    'https://intranet/a.png',
    'ftp://logo.example.com/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    `https://logo.example.com/${'a'.repeat(300)}`,
    '',
    null,
    42,
  ]) {
    assert.equal(vetUrl(bad), null, String(bad));
  }
});

test('a name that resolves to ANY private address is refused before a connection is made', async () => {
  const seen = [];
  for (const table of [
    { 'logo.example.com': ['10.0.0.5'] },
    { 'logo.example.com': ['93.184.216.34', '127.0.0.1'] },
    { 'logo.example.com': ['::ffff:169.254.169.254'] },
    { 'logo.example.com': ['fd00:ec2::254'] },
  ]) {
    const r = await safeGet('https://logo.example.com/a.png', { lookup: fakeLookup(table), request: fakeRequest([], seen) });
    assert.deepEqual(r, { ok: false, reason: 'forbidden_address' });
  }
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup: fakeLookup({}), request: fakeRequest([], seen) }), { ok: false, reason: 'dns_failed' });
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup: async () => [], request: fakeRequest([], seen) }), { ok: false, reason: 'dns_failed' });
  assert.equal(seen.length, 0, 'nothing was connected to');
  assert.deepEqual(await safeGet('http://logo.example.com/a.png'), { ok: false, reason: 'bad_url' });
});

test('the connection is pinned to the vetted address; SNI, the certificate and Host keep the name', async () => {
  const seen = [];
  const asked = [];
  const r = await safeGet('https://logo.example.com/a.png?w=64', {
    lookup: fakeLookup(PUBLIC, asked),
    request: fakeRequest([{ status: 200, headers: { 'content-length': String(PNG.length) }, chunks: [PNG] }], seen),
  });
  assert.equal(r.ok, true);
  assert.ok(r.bytes.equals(PNG));
  assert.equal(r.url, 'https://logo.example.com/a.png?w=64');
  assert.deepEqual(asked, ['logo.example.com'], 'one DNS lookup, made here');
  const o = seen[0];
  assert.equal(o.hostname, 'logo.example.com');
  assert.equal(o.servername, 'logo.example.com');
  assert.equal(o.headers.host, 'logo.example.com');
  assert.equal(o.port, 443);
  assert.equal(o.path, '/a.png?w=64');
  assert.equal(o.method, 'GET');
  assert.equal(o.agent, false);
  assert.equal(o.headers['accept-encoding'], 'identity');
  // Whatever the socket asks the lookup, it gets the vetted address, never a new answer.
  const got = [];
  o.lookup('logo.example.com', { all: true }, (err, list) => got.push([err, list]));
  o.lookup('logo.example.com', { family: 0 }, (err, address, family) => got.push([err, address, family]));
  o.lookup('logo.example.com', (err, address, family) => got.push([err, address, family]));
  assert.deepEqual(got, [
    [null, [{ address: '93.184.216.34', family: 4 }]],
    [null, '93.184.216.34', 4],
    [null, '93.184.216.34', 4],
  ]);
  assert.deepEqual(asked, ['logo.example.com'], 'the pinned lookup asked DNS nothing');
});

test('pinnedLookup answers an IPv6 address with family 6', () => {
  const got = [];
  pinnedLookup({ address: '2606:4700:4700::1111', family: 6 })('x', {}, (e, a, f) => got.push([a, f]));
  assert.deepEqual(got, [['2606:4700:4700::1111', 6]]);
});

test('size: a declared or streamed body over maxBytes is refused and the download stopped', async () => {
  const seen = [];
  const declared = await safeGet('https://logo.example.com/a.png', {
    maxBytes: 10,
    lookup: fakeLookup(PUBLIC),
    request: fakeRequest([{ status: 200, headers: { 'content-length': '11' }, chunks: [PNG] }], seen),
  });
  assert.deepEqual(declared, { ok: false, reason: 'too_large' });
  assert.equal(seen.length, 1);
  const streamed = await safeGet('https://logo.example.com/a.png', {
    maxBytes: 10,
    lookup: fakeLookup(PUBLIC),
    request: fakeRequest([{ status: 200, chunks: [PNG.subarray(0, 6), PNG.subarray(6)] }]),
  });
  assert.deepEqual(streamed, { ok: false, reason: 'too_large' });
  const exact = await safeGet('https://logo.example.com/a.png', {
    maxBytes: PNG.length,
    lookup: fakeLookup(PUBLIC),
    request: fakeRequest([{ status: 200, chunks: [PNG] }]),
  });
  assert.equal(exact.ok, true);
});

test('a non-200 answer or a broken connection is a failure, never a partial body, and never a live socket', async () => {
  const lookup = fakeLookup(PUBLIC);
  const ends = [];
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup, request: fakeRequest([{ status: 404, chunks: [PNG] }], [], ends) }), { ok: false, reason: 'http_404' });
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup, request: fakeRequest([{ status: 206, chunks: [PNG] }], [], ends) }), { ok: false, reason: 'http_206' });
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup, request: fakeRequest([{ error: true }]) }), { ok: false, reason: 'fetch_failed' });
  assert.deepEqual(await safeGet('https://logo.example.com/a.png', { lookup, request: fakeRequest([{ status: 302 }], [], ends) }), { ok: false, reason: 'http_302' });
  // The hop's deadline is gone once safeGet has answered, so a body left draining would
  // trickle from an attacker-chosen host with no cap and no clock: destroy the request.
  assert.deepEqual(ends.map((r) => r.destroyed), [true, true, true], 'a refused answer leaves no socket reading');

  const hops = [];
  const chain = await safeGet('https://logo.example.com/a.png', {
    lookup,
    request: fakeRequest(
      [
        { status: 302, headers: { location: '/1.png' } },
        { status: 302, headers: { location: '/2.png' } },
        { status: 302, headers: { location: '/3.png' } },
      ],
      [],
      hops
    ),
  });
  assert.deepEqual(chain, { ok: false, reason: 'too_many_redirects' });
  assert.deepEqual(hops.map((r) => r.destroyed), [true, true, true], 'every redirect hop is destroyed, not drained');
});

test(`redirects: at most ${MAX_REDIRECTS}, each hop vetted again from the top (scheme, port, name, DNS)`, async () => {
  const table = { ...PUBLIC, 'inside.example.net': ['10.1.1.1'] };
  const asked = [];
  const seen = [];
  const two = await safeGet('https://logo.example.com/a.png', {
    lookup: fakeLookup(table, asked),
    request: fakeRequest(
      [
        { status: 301, headers: { location: 'https://cdn.example.org/b.png' } },
        { status: 302, headers: { location: '/c.png' } },
        { status: 200, chunks: [PNG] },
      ],
      seen
    ),
  });
  assert.equal(two.ok, true);
  assert.equal(two.url, 'https://cdn.example.org/c.png', 'a relative Location resolves against the hop that sent it');
  assert.deepEqual(asked, ['logo.example.com', 'cdn.example.org', 'cdn.example.org'], 'every hop is resolved and vetted again');
  assert.deepEqual(seen.map((o) => `${o.hostname}${o.path}`), ['logo.example.com/a.png', 'cdn.example.org/b.png', 'cdn.example.org/c.png']);

  const three = await safeGet('https://logo.example.com/a.png', {
    lookup: fakeLookup(table),
    request: fakeRequest([
      { status: 302, headers: { location: '/1.png' } },
      { status: 302, headers: { location: '/2.png' } },
      { status: 302, headers: { location: '/3.png' } },
      { status: 200, chunks: [PNG] },
    ]),
  });
  assert.deepEqual(three, { ok: false, reason: 'too_many_redirects' });

  for (const location of ['http://cdn.example.org/b.png', 'https://cdn.example.org:444/b.png', 'https://127.0.0.1/b.png', 'https://u:p@cdn.example.org/b.png']) {
    const r = await safeGet('https://logo.example.com/a.png', {
      lookup: fakeLookup(table),
      request: fakeRequest([{ status: 302, headers: { location } }, { status: 200, chunks: [PNG] }]),
    });
    assert.deepEqual(r, { ok: false, reason: 'bad_redirect' }, location);
  }
  const inside = [];
  const toPrivate = await safeGet('https://logo.example.com/a.png', {
    lookup: fakeLookup(table),
    request: fakeRequest([{ status: 307, headers: { location: 'https://inside.example.net/secret' } }, { status: 200, chunks: [PNG] }], inside),
  });
  assert.deepEqual(toPrivate, { ok: false, reason: 'forbidden_address' });
  assert.equal(inside.length, 1, 'the private hop was never connected to');
});

test(`one deadline (${TIMEOUT_MS} ms by default) covers every lookup and every hop`, async () => {
  const hung = [];
  const slowBody = await safeGet('https://logo.example.com/a.png', { timeoutMs: 40, lookup: fakeLookup(PUBLIC), request: fakeRequest([{ hang: true }], hung) });
  assert.deepEqual(slowBody, { ok: false, reason: 'timeout' });
  const slowDns = await safeGet('https://logo.example.com/a.png', { timeoutMs: 40, lookup: () => new Promise(() => {}), request: fakeRequest([]) });
  assert.deepEqual(slowDns, { ok: false, reason: 'timeout' });
  assert.equal(TIMEOUT_MS, 5000);
});
