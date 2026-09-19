'use strict';

// tp/account.js: the SIWE login, the session token and cookie, the CSRF guard, and
// the /api/tp/account routes over real HTTP. Every signer is Wallet.createRandom(),
// made here and dropped at the end; nothing is ever printed.
//
// No escape sequences on purpose (memory: write-tool-escapes): LF and CR are built
// with String.fromCharCode.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Wallet, Signature, getBytes, hexlify, concat, toBeHex, verifyMessage } = require('ethers');

const account = require('./account');
const {
  createAccountRouter,
  buildLoginMessage,
  parseOrigin,
  canonicalSignature,
  recoverSigner,
  createChallenges,
  createSessions,
  readSessionCookie,
  loadSessionSecret,
  COOKIE_NAME,
} = account;

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ORIGIN = 'https://dapp.account.test';
const T0 = Date.parse('2026-09-19T12:00:00.000Z');
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-account-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── an app with only the account router, on a fake clock ─────────────────────
async function startApp({ dir = tmpDir(), origin = ORIGIN, limits = { noncesPerMin: 1000, loginsPerMin: 1000, readsPerMin: 1000, writesPerMinPerIp: 1000 } } = {}) {
  const clock = { t: T0 };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp/account', createAccountRouter({ dir, origin, now: () => clock.t, limits }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, clock, dir, close: () => new Promise((resolve) => server.close(resolve)) };
}

// http.request, not fetch: the tests set Origin, Cookie and Sec-Fetch-Site themselves.
function call(server, method, p, { body, headers = {}, cookie } = {}) {
  const { port } = server.address();
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const h = { ...headers };
  if (text !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        out += c;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = out ? JSON.parse(out) : null;
        } catch (_err) {
          json = null;
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

// What the dApp page sends: same-origin, JSON, its own Origin.
const PAGE = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
const post = (server, p, body, extra = {}) => call(server, 'POST', p, { body, headers: { ...PAGE, ...(extra.headers || {}) }, cookie: extra.cookie });
const get = (server, p, extra = {}) => call(server, 'GET', p, { headers: { 'sec-fetch-site': 'same-origin', ...(extra.headers || {}) }, cookie: extra.cookie });

function sessionCookieFrom(res) {
  const set = res.headers['set-cookie'] || [];
  const line = set.find((l) => l.startsWith(`${COOKIE_NAME}=`));
  return line ? line.split(';')[0] : null;
}

/** A full login as `wallet`; returns {cookie, nonceRes, loginRes}. */
async function login(server, wallet, { sign = (msg) => wallet.signMessage(msg), ip } = {}) {
  const headers = ip ? { 'x-real-ip': ip } : {};
  const nonceRes = await post(server, '/api/tp/account/nonce', { address: wallet.address }, { headers });
  assert.equal(nonceRes.status, 200, JSON.stringify(nonceRes.json));
  const signature = await sign(nonceRes.json.message);
  const loginRes = await post(server, '/api/tp/account/login', { nonce: nonceRes.json.nonce, signature }, { headers });
  return { cookie: sessionCookieFrom(loginRes), nonceRes, loginRes };
}

// A signature's high-s twin: s := n - s, parity flipped. Valid, and refused by ethers'
// verifyMessage (its Signature.s getter throws 'non-canonical s').
function highS(signature) {
  const sig = Signature.from(signature);
  const s = N - BigInt(sig.s);
  const v = sig.v === 27 ? 28 : 27;
  return hexlify(concat([sig.r, toBeHex(s, 32), new Uint8Array([v])]));
}

// ── the message ──────────────────────────────────────────────────────────────
test('the login message is the exact EIP-4361 text: LF only, ASCII only (golden)', () => {
  const msg = buildLoginMessage({
    domain: 'dapp.rhbond.xyz',
    origin: 'https://dapp.rhbond.xyz',
    address: '0x52908400098527886E0F7030069857D2E4169EE7',
    nonce: '0123456789abcdef0123456789abcdef',
    issuedAt: '2026-09-19T12:00:00.000Z',
    expirationTime: '2026-09-19T12:05:00.000Z',
  });
  const golden = [
    'dapp.rhbond.xyz wants you to sign in with your Ethereum account:',
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '',
    'Sign in to rhbond take-profit to sync your encrypted wallet list. Keeps this browser signed in for 24 hours. This is not a transaction and costs nothing.',
    '',
    'URI: https://dapp.rhbond.xyz',
    'Version: 1',
    'Chain ID: 4663',
    'Nonce: 0123456789abcdef0123456789abcdef',
    'Issued At: 2026-09-19T12:00:00.000Z',
    'Expiration Time: 2026-09-19T12:05:00.000Z',
  ].join(LF);
  assert.equal(msg, golden);
  assert.ok(!msg.includes(CR));
  assert.ok([...msg].every((ch) => ch.charCodeAt(0) < 128), 'ASCII only');
  assert.equal(
    crypto.createHash('sha256').update(msg).digest('hex'),
    crypto.createHash('sha256').update(golden).digest('hex')
  );
});

test('parseOrigin: a bare http(s) origin, the SIWE domain keeps a port', () => {
  assert.deepEqual(parseOrigin('https://dapp.rhbond.xyz'), { origin: 'https://dapp.rhbond.xyz', domain: 'dapp.rhbond.xyz' });
  assert.deepEqual(parseOrigin('https://dapp.rhbond.xyz/'), { origin: 'https://dapp.rhbond.xyz', domain: 'dapp.rhbond.xyz' });
  assert.deepEqual(parseOrigin('http://127.0.0.1:3199'), { origin: 'http://127.0.0.1:3199', domain: '127.0.0.1:3199' });
  for (const bad of ['', 'dapp.rhbond.xyz', 'https://dapp.rhbond.xyz/vault', 'ftp://x.test', 'https://u:p@x.test', 'https://X.test', undefined]) {
    assert.throws(() => parseOrigin(bad), /TP_SIWE_ORIGIN/, String(bad));
  }
});

// ── signatures ───────────────────────────────────────────────────────────────
test('canonicalSignature: v 27/28 and 0/1 are one signature; high-s folds to low-s', async () => {
  const w = Wallet.createRandom();
  const msg = 'hello';
  const sig = await w.signMessage(msg);
  const c = canonicalSignature(sig);
  assert.ok(c);
  assert.equal(recoverSigner(msg, c), w.address.toLowerCase());

  const bytes = getBytes(sig);
  const zeroOne = hexlify(concat([bytes.slice(0, 64), new Uint8Array([bytes[64] - 27])]));
  assert.deepEqual(canonicalSignature(zeroOne), c);

  const twin = highS(sig);
  assert.notEqual(twin.toLowerCase(), sig.toLowerCase());
  assert.throws(() => verifyMessage(msg, twin), /non-canonical s/, 'ethers itself refuses high-s');
  assert.deepEqual(canonicalSignature(twin), c);
  assert.equal(recoverSigner(msg, canonicalSignature(twin)), w.address.toLowerCase());
});

test('canonicalSignature refuses 64 bytes, a long wrapper, a bad v, r or s out of range', async () => {
  const sig = await Wallet.createRandom().signMessage('x');
  assert.equal(canonicalSignature(sig.slice(0, 130)), null, '64 bytes');
  assert.equal(canonicalSignature(sig + '00'.repeat(32)), null, 'an ERC-6492-style wrapper');
  assert.equal(canonicalSignature(`${sig.slice(0, 130)}1d`), null, 'v = 29');
  assert.equal(canonicalSignature(`${sig.slice(0, 130)}02`), null, 'v = 2');
  assert.equal(canonicalSignature(`0x${'00'.repeat(32)}${sig.slice(66)}`), null, 'r = 0');
  assert.equal(canonicalSignature(`0x${sig.slice(2, 66)}${N.toString(16)}1b`), null, 's = n');
  assert.equal(canonicalSignature(12), null);
  assert.equal(canonicalSignature(`0x${'zz'.repeat(65)}`), null);
});

// ── challenges, sessions, cookie, secret ─────────────────────────────────────
test('challenges: single use, 5 outstanding per IP (oldest goes), a global cap, expired ones pruned', () => {
  const clock = { t: T0 };
  const c = createChallenges({ now: () => clock.t, perIp: 5, max: 8 });
  const rec = (ip, ttl = 300_000) => ({ address: '0x', message: 'm', expiresAt: clock.t + ttl, ip });
  for (let i = 0; i < 6; i++) c.add(`a${i}`, rec('1.1.1.1'));
  assert.equal(c.take('a0'), null, 'the 6th challenge of one IP evicts its oldest');
  assert.ok(c.take('a1'));
  assert.equal(c.take('a1'), null, 'single use');
  for (let i = 0; i < 6; i++) c.add(`b${i}`, rec(`2.2.2.${i}`));
  assert.equal(c.size(), 8, 'the global cap holds');
  clock.t += 300_001;
  c.add('fresh', rec('3.3.3.3'));
  assert.equal(c.size(), 1, 'every expired challenge is pruned on the next add');
});

test('sessions: round trip; any tampered field, a foreign secret, expiry or a future iat → null', () => {
  const clock = { t: T0 };
  const secret = crypto.randomBytes(32);
  const s = createSessions({ secret, now: () => clock.t });
  const addr = Wallet.createRandom().address;
  const { token, expiresAt } = s.issue(addr);
  assert.deepEqual(s.verify(token), { address: addr.toLowerCase(), issuedAt: T0, expiresAt });
  assert.equal(expiresAt, T0 + 24 * 3600_000);

  const parts = token.split('.');
  const other = Wallet.createRandom().address.slice(2).toLowerCase();
  const swap = (i, v) => parts.map((p, j) => (j === i ? v : p)).join('.');
  assert.equal(s.verify(swap(1, other)), null, 'address');
  assert.equal(s.verify(swap(2, String(T0 + 1))), null, 'iat');
  assert.equal(s.verify(swap(3, String(expiresAt + 1000))), null, 'exp');
  assert.equal(s.verify(swap(4, parts[4].replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')))), null, 'mac');
  assert.equal(s.verify(swap(0, 'v2')), null, 'version');
  assert.equal(createSessions({ secret: crypto.randomBytes(32), now: () => clock.t }).verify(token), null, 'foreign secret');
  assert.equal(s.verify(null), null);

  clock.t = expiresAt;
  assert.equal(s.verify(token), null, 'expired at exp');
  clock.t = T0 - 120_000;
  assert.equal(s.verify(token), null, 'issued more than a minute in the future');
  assert.throws(() => createSessions({ secret: Buffer.alloc(16) }), /32 bytes/);
});

test('readSessionCookie: the one cookie, or null for a duplicate, an oversize header or a bad value', () => {
  const req = (cookie) => ({ headers: { cookie } });
  assert.equal(readSessionCookie(req(`a=1; ${COOKIE_NAME}=v1.abc_-9; b=2`)), 'v1.abc_-9');
  assert.equal(readSessionCookie(req(`${COOKIE_NAME}=x; ${COOKIE_NAME}=y`)), null, 'duplicate name');
  assert.equal(readSessionCookie(req(`${COOKIE_NAME}=a b`)), null, 'space in value');
  assert.equal(readSessionCookie(req(`${COOKIE_NAME}=${'a'.repeat(257)}`)), null, 'over 256 chars');
  assert.equal(readSessionCookie(req(`x=${'a'.repeat(9000)}; ${COOKIE_NAME}=ok`)), null, 'header over 8 KiB');
  assert.equal(readSessionCookie(req(undefined)), null);
  assert.equal(readSessionCookie({ headers: {} }), null);
});

test('loadSessionSecret: 32 bytes made once (0600), reused, an empty file replaced, a wrong length refused', () => {
  const dir = path.join(tmpDir(), 'nested', 'accounts');
  const a = loadSessionSecret(dir);
  assert.equal(a.length, 32);
  assert.ok(loadSessionSecret(dir).equals(a), 'the same secret after a "restart"');
  const file = path.join(dir, 'session.key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, Buffer.alloc(0));
  const b = loadSessionSecret(dir);
  assert.equal(b.length, 32);
  assert.ok(!b.equals(a));
  fs.writeFileSync(file, Buffer.alloc(31));
  assert.throws(() => loadSessionSecret(dir), /31 bytes/);
});

// ── the routes ───────────────────────────────────────────────────────────────
test('nonce -> login -> me: the server-built message, a __Host- cookie, the session reads back', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const lower = { address: w.address.toLowerCase() };
    const n = await post(app.server, '/api/tp/account/nonce', lower);
    assert.equal(n.status, 200);
    assert.deepEqual(Object.keys(n.json).sort(), ['expirationTime', 'issuedAt', 'message', 'nonce']);
    assert.match(n.json.nonce, /^[0-9a-f]{32}$/);
    assert.equal(n.json.issuedAt, '2026-09-19T12:00:00.000Z');
    assert.equal(n.json.expirationTime, '2026-09-19T12:05:00.000Z');
    assert.equal(
      n.json.message,
      buildLoginMessage({ domain: 'dapp.account.test', origin: ORIGIN, address: w.address, nonce: n.json.nonce, issuedAt: n.json.issuedAt, expirationTime: n.json.expirationTime })
    );
    assert.equal(n.headers['cache-control'], 'no-store');

    const l = await post(app.server, '/api/tp/account/login', { nonce: n.json.nonce, signature: await w.signMessage(n.json.message) });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.deepEqual(l.json, { address: w.address, expiresAt: T0 + 24 * 3600_000 });
    const line = l.headers['set-cookie'].find((c) => c.startsWith(`${COOKIE_NAME}=`));
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=86400']) assert.ok(line.includes(attr), `${attr} in ${line}`);
    assert.ok(!/Domain=/i.test(line), 'a __Host- cookie has no Domain');

    const me = await get(app.server, '/api/tp/account/me', { cookie: sessionCookieFrom(l) });
    assert.equal(me.status, 200);
    assert.equal(me.json.address, w.address);
    assert.equal(me.json.expiresAt, T0 + 24 * 3600_000);
  } finally {
    await app.close();
  }
});

test('login refuses a replay, an expired challenge, another signer, another message, a malformed signature', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const first = await login(app.server, w);
    assert.equal(first.loginRes.status, 200);
    const replay = await post(app.server, '/api/tp/account/login', { nonce: first.nonceRes.json.nonce, signature: await w.signMessage(first.nonceRes.json.message) });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.code, 'unknown_nonce');

    const n = await post(app.server, '/api/tp/account/nonce', { address: w.address });
    app.clock.t += 5 * 60_000 + 1;
    const late = await post(app.server, '/api/tp/account/login', { nonce: n.json.nonce, signature: await w.signMessage(n.json.message) });
    assert.equal(late.status, 401);
    assert.equal(late.json.code, 'challenge_expired');

    const intruder = await login(app.server, w, { sign: (msg) => Wallet.createRandom().signMessage(msg) });
    assert.equal(intruder.loginRes.status, 401);
    assert.equal(intruder.loginRes.json.code, 'bad_signature');
    assert.equal(intruder.cookie, null);

    // The unlock message is a different text: its signature can never log in.
    const unlock = await login(app.server, w, { sign: () => w.signMessage(`dapp.rhbond.xyz wants you to sign in with your Ethereum account:${LF}${w.address}`) });
    assert.equal(unlock.loginRes.json.code, 'bad_signature');

    const short = await login(app.server, w, { sign: async (msg) => (await w.signMessage(msg)).slice(0, 130) });
    assert.equal(short.loginRes.json.code, 'bad_signature');
    const long = await login(app.server, w, { sign: async (msg) => (await w.signMessage(msg)) + 'ab'.repeat(40) });
    assert.equal(long.loginRes.json.code, 'bad_signature');

    const bogus = await post(app.server, '/api/tp/account/login', { nonce: 'f'.repeat(32), signature: '0x00' });
    assert.equal(bogus.json.code, 'unknown_nonce');
  } finally {
    await app.close();
  }
});

test('a failed login still burns its nonce', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const n = await post(app.server, '/api/tp/account/nonce', { address: w.address });
    const bad = await post(app.server, '/api/tp/account/login', { nonce: n.json.nonce, signature: '0x12' });
    assert.equal(bad.json.code, 'bad_signature');
    const retry = await post(app.server, '/api/tp/account/login', { nonce: n.json.nonce, signature: await w.signMessage(n.json.message) });
    assert.equal(retry.json.code, 'unknown_nonce');
  } finally {
    await app.close();
  }
});

test('login accepts v = 0/1 and a high-s signature (canonicalised before recovery)', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const zeroOne = await login(app.server, w, {
      sign: async (msg) => {
        const b = getBytes(await w.signMessage(msg));
        return hexlify(concat([b.slice(0, 64), new Uint8Array([b[64] - 27])]));
      },
    });
    assert.equal(zeroOne.loginRes.status, 200);
    const high = await login(app.server, w, { sign: async (msg) => highS(await w.signMessage(msg)) });
    assert.equal(high.loginRes.status, 200);
  } finally {
    await app.close();
  }
});

test('challenge and login bodies are strict: unknown fields, a bad address, a bad checksum → 400', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const extra = await post(app.server, '/api/tp/account/nonce', { address: w.address, message: 'mine' });
    assert.equal(extra.status, 400);
    assert.equal(extra.json.code, 'bad_request');
    assert.equal((await post(app.server, '/api/tp/account/nonce', { address: '0x1234' })).json.code, 'bad_address');
    const flipped = w.address.replace(/[a-f]/, (ch) => ch.toUpperCase());
    if (flipped !== w.address) assert.equal((await post(app.server, '/api/tp/account/nonce', { address: flipped })).json.code, 'bad_address');
    assert.equal((await post(app.server, '/api/tp/account/nonce', [w.address])).status, 400);
    const loginExtra = await post(app.server, '/api/tp/account/login', { nonce: 'a'.repeat(32), signature: '0x', message: 'x' });
    assert.equal(loginExtra.json.code, 'bad_request');
  } finally {
    await app.close();
  }
});

test('me: no cookie → 401 no_session; a tampered or expired cookie → 401 and the cookie is cleared', async () => {
  const app = await startApp();
  try {
    const none = await get(app.server, '/api/tp/account/me');
    assert.equal(none.status, 401);
    assert.equal(none.json.code, 'no_session');

    const { cookie } = await login(app.server, Wallet.createRandom());
    const tampered = cookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    const t = await get(app.server, '/api/tp/account/me', { cookie: tampered });
    assert.equal(t.status, 401);
    assert.ok((t.headers['set-cookie'] || []).some((l) => l.startsWith(`${COOKIE_NAME}=;`)), 'cleared');

    app.clock.t += 24 * 3600_000;
    const expired = await get(app.server, '/api/tp/account/me', { cookie });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.code, 'no_session');
  } finally {
    await app.close();
  }
});

test('logout clears the cookie (204)', async () => {
  const app = await startApp();
  try {
    const { cookie } = await login(app.server, Wallet.createRandom());
    const out = await post(app.server, '/api/tp/account/logout', {}, { cookie });
    assert.equal(out.status, 204);
    const line = (out.headers['set-cookie'] || []).find((l) => l.startsWith(`${COOKIE_NAME}=`));
    assert.ok(line && line.includes('Expires=Thu, 01 Jan 1970'), line);
    assert.ok(line.includes('Path=/') && line.includes('Secure') && line.includes('HttpOnly'), line);
  } finally {
    await app.close();
  }
});

test('a session survives a restart: a second router on the same dir honours the cookie', async () => {
  const dir = tmpDir();
  const one = await startApp({ dir });
  const w = Wallet.createRandom();
  let cookie;
  try {
    ({ cookie } = await login(one.server, w));
  } finally {
    await one.close();
  }
  const two = await startApp({ dir });
  try {
    const me = await get(two.server, '/api/tp/account/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.address, w.address);
  } finally {
    await two.close();
  }
});

// ── CSRF ─────────────────────────────────────────────────────────────────────
test('CSRF: a POST without Origin, from a foreign Origin, or cross-site → 403; not JSON → 415', async () => {
  const app = await startApp();
  try {
    const body = { address: Wallet.createRandom().address };
    const cases = [
      [{ 'sec-fetch-site': 'same-origin' }, 403, 'no Origin'],
      [{ origin: 'https://rhbond.xyz', 'sec-fetch-site': 'same-site' }, 403, 'the console host (same SITE)'],
      [{ origin: 'https://evil.test' }, 403, 'foreign Origin, no Sec-Fetch-Site'],
      [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'cross-site'],
      [{ origin: 'null' }, 403, 'opaque origin'],
    ];
    for (const [headers, status, why] of cases) {
      const r = await call(app.server, 'POST', '/api/tp/account/nonce', { body, headers });
      assert.equal(r.status, status, why);
      assert.equal(r.json.code, 'forbidden', why);
    }
    const form = await call(app.server, 'POST', '/api/tp/account/nonce', { body: 'address=0x', headers: { ...PAGE, 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const plain = await call(app.server, 'POST', '/api/tp/account/logout', { body: '{}', headers: { ...PAGE, 'content-type': 'text/plain' } });
    assert.equal(plain.status, 415);
  } finally {
    await app.close();
  }
});

test('CSRF: a GET from another site → 403; a GET with no Sec-Fetch-Site (old browser) is judged by its cookie', async () => {
  const app = await startApp();
  try {
    const cross = await call(app.server, 'GET', '/api/tp/account/me', { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(cross.status, 403);
    const old = await call(app.server, 'GET', '/api/tp/account/me');
    assert.equal(old.status, 401);
    assert.equal(old.json.code, 'no_session');
  } finally {
    await app.close();
  }
});

// ── limits and failure modes ─────────────────────────────────────────────────
test('POST /nonce is limited to 10 a minute per IP (default), then 429 with Retry-After', { skip: Boolean(process.env.TP_ACCOUNT_NONCES_PER_MIN) && 'TP_ACCOUNT_NONCES_PER_MIN is set' }, async () => {
  const app = await startApp({ limits: {} });
  try {
    const address = Wallet.createRandom().address;
    const headers = { 'x-real-ip': '198.51.100.7' };
    for (let i = 0; i < 10; i++) assert.equal((await post(app.server, '/api/tp/account/nonce', { address }, { headers })).status, 200, `nonce ${i + 1}`);
    const r = await post(app.server, '/api/tp/account/nonce', { address }, { headers });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'rate_limited');
    assert.ok(Number(r.headers['retry-after']) >= 1);
    // another IP is not affected
    assert.equal((await post(app.server, '/api/tp/account/nonce', { address }, { headers: { 'x-real-ip': '198.51.100.8' } })).status, 200);
  } finally {
    await app.close();
  }
});

test('a bad TP_SIWE_ORIGIN never throws at mount: every account route answers 503 unavailable', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let app;
  try {
    app = await startApp({ origin: 'dapp.rhbond.xyz' });
    for (const [m, p] of [['GET', '/api/tp/account/me'], ['POST', '/api/tp/account/nonce']]) {
      const r = await call(app.server, m, p, { body: m === 'POST' ? {} : undefined, headers: PAGE });
      assert.equal(r.status, 503, p);
      assert.equal(r.json.code, 'unavailable', p);
    }
  } finally {
    console.error = original;
    if (app) await app.close();
  }
  assert.equal(errors.filter((e) => e.includes('TP_SIWE_ORIGIN')).length, 1, 'logged once');
});

test('an unwritable accounts dir answers 503 on login, and nothing below it is created', async () => {
  const blocker = path.join(tmpDir(), 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  const original = console.error;
  console.error = () => {};
  const app = await startApp({ dir: path.join(blocker, 'accounts') });
  try {
    const { loginRes } = await login(app.server, Wallet.createRandom());
    assert.equal(loginRes.status, 503);
    assert.equal(loginRes.json.code, 'unavailable');
  } finally {
    console.error = original;
    await app.close();
  }
});

test('an unknown account path → 404 from the account router itself', async () => {
  const app = await startApp();
  try {
    const r = await get(app.server, '/api/tp/account/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'not found' });
  } finally {
    await app.close();
  }
});
