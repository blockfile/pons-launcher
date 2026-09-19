'use strict';

// Offline tests for scripts/lib/tpWireAudit.js (the judge of what a real browser
// sent the real account API in scripts/tp-account-browser.js). No network, no
// server. Every key and signature is made here from Wallet.createRandom() and
// never printed. No escape sequences (memory: write-tool-escapes).
//
// Not in `npm test`'s glob (src/** only): run it by path,
//   cd backend && node --test scripts/lib/tpWireAudit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');

const {
  SESSION_COOKIE,
  parseSetCookie,
  cookieValues,
  sessionCookieProblems,
  clearsSession,
  auditAccountWire,
  secretNeedles,
  addressNeedle,
  countNeedles,
  hexRuns,
  classifyMessage,
  loginNamesOrigin,
} = require('./tpWireAudit');

const LF = String.fromCharCode(10);
const ORIGIN = 'http://127.0.0.1:3199';
const VALUE = 'v1.0123456789abcdef0123456789abcdef01234567.1789000000000.1789086400000.AbC-dEf_123';
const LIVE = `${SESSION_COOKIE}=${VALUE}; Max-Age=86400; Path=/; Expires=Mon, 21 Sep 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
const CLEARED = `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`;
const SIG = '0x' + 'ab'.repeat(65);
const NOW = Date.parse('2026-09-19T12:00:00.000Z');

// One browser's account traffic, the way the harness records it.
function traffic() {
  const same = { 'sec-fetch-site': 'same-origin' };
  const write = { ...same, origin: ORIGIN, 'content-type': 'application/json' };
  const cookie = `other=1; ${SESSION_COOKIE}=${VALUE}`;
  let seq = 0;
  const e = (method, path, headers, body, status, extra = {}) => ({
    seq: ++seq,
    method,
    path,
    headers,
    body,
    status,
    setCookies: [],
    responseBody: '',
    ...extra,
  });
  return [
    e('GET', '/api/tp/account/me', same, '', 401, { responseBody: '{"error":"x","code":"no_session"}' }),
    e('POST', '/api/tp/account/nonce', write, '{"address":"0x1111111111111111111111111111111111111111"}', 200),
    e('POST', '/api/tp/account/login', write, JSON.stringify({ nonce: 'a'.repeat(32), signature: SIG }), 200, { setCookies: [LIVE] }),
    e('GET', '/api/tp/account/me', { ...same, cookie }, '', 200),
    e('GET', '/api/tp/account/vault', { ...same, cookie }, '', 200),
    e('PUT', '/api/tp/account/vault', { ...write, cookie }, '{"baseRev":0,"kv":1,"keyId":"0x00","iv":"AA==","ct":"AA=="}', 200),
    e('PUT', '/api/tp/account/vault', { ...write, cookie }, '{"baseRev":0,"kv":1,"keyId":"0x00","iv":"AA==","ct":"AA=="}', 409, {
      responseBody: '{"error":"x","code":"conflict","rev":1}',
    }),
    e('GET', '/api/tp/fees', same, '', 503),
    e('POST', '/api/tp/account/logout', { ...write, cookie }, '{}', 204, { setCookies: [CLEARED] }),
    e('GET', '/api/tp/account/me', same, '', 401, { responseBody: '{"error":"x","code":"no_session"}' }),
  ];
}

const audit = (entries) => auditAccountWire(entries, { origin: ORIGIN, nowMs: NOW });

test('parseSetCookie reads the name, the value and every attribute of an Express cookie line', () => {
  const c = parseSetCookie(LIVE);
  assert.equal(c.name, SESSION_COOKIE);
  assert.equal(c.value, VALUE);
  assert.deepEqual(c.attrs, {
    secure: true,
    httponly: true,
    samesite: 'strict',
    path: '/',
    domain: null,
    maxAge: 86400,
    expires: 'Mon, 21 Sep 2026 12:00:00 GMT',
  });
  assert.equal(parseSetCookie('a=b; Domain=rhbond.xyz; SameSite=Lax').attrs.domain, 'rhbond.xyz');
});

test('cookieValues finds every value of one name in a Cookie header, and nothing in an absent one', () => {
  assert.deepEqual(cookieValues(`a=1; ${SESSION_COOKIE}=x; b=2`, SESSION_COOKIE), ['x']);
  assert.deepEqual(cookieValues(`${SESSION_COOKIE}=x; ${SESSION_COOKIE}=y`, SESSION_COOKIE), ['x', 'y']);
  assert.deepEqual(cookieValues('a=1', SESSION_COOKIE), []);
  assert.deepEqual(cookieValues(undefined, SESSION_COOKIE), []);
});

test('sessionCookieProblems accepts the __Host- cookie Part 01 sets and names each departure', () => {
  assert.deepEqual(sessionCookieProblems([LIVE]), []);
  assert.deepEqual(sessionCookieProblems(['other=1', LIVE]), []);
  assert.deepEqual(sessionCookieProblems([]), [`the answer set 0 ${SESSION_COOKIE} cookies, not 1`]);
  assert.deepEqual(sessionCookieProblems([LIVE, LIVE]), [`the answer set 2 ${SESSION_COOKIE} cookies, not 1`]);
  assert.deepEqual(sessionCookieProblems([LIVE.replace('; Secure', '')]), ['no Secure']);
  assert.deepEqual(sessionCookieProblems([LIVE.replace('; HttpOnly', '')]), ['no HttpOnly']);
  assert.deepEqual(sessionCookieProblems([LIVE.replace('SameSite=Strict', 'SameSite=Lax')]), ['SameSite is lax, not strict']);
  assert.deepEqual(sessionCookieProblems([LIVE.replace('Path=/', 'Path=/api/tp/account')]), ['Path is /api/tp/account, not /']);
  assert.deepEqual(sessionCookieProblems([`${LIVE}; Domain=rhbond.xyz`]), ['it names a Domain (a __Host- cookie must not)']);
  assert.deepEqual(sessionCookieProblems([LIVE.replace('Max-Age=86400', 'Max-Age=604800')]), ['Max-Age is not in 1..86400 seconds']);
  assert.deepEqual(sessionCookieProblems([LIVE.replace(VALUE, '')]), ['the session value is empty or not token-shaped']);
});

test('clearsSession: Express clearCookie and Max-Age=0 clear it; a live cookie does not', () => {
  assert.equal(clearsSession([CLEARED], NOW), true);
  assert.equal(clearsSession([`${SESSION_COOKIE}=; Max-Age=0; Path=/`], NOW), true);
  assert.equal(clearsSession([LIVE], NOW), false);
  assert.equal(clearsSession([], NOW), false);
});

test('auditAccountWire passes one browser that signs in, saves, loses a race, signs out and probes again', () => {
  const { problems, stats } = audit(traffic());
  assert.deepEqual(problems, []);
  assert.equal(stats.account, 9);
  assert.equal(stats.logins, 1);
  assert.equal(stats.logouts, 1);
  assert.equal(stats.puts, 1);
  assert.equal(stats.conflicts, 1);
  assert.equal(stats.withCookie, 5);
  assert.equal(stats.probes, 2);
  assert.equal(stats.byRoute['PUT /api/tp/account/vault 409'], 1);
  assert.equal(Object.keys(stats.byRoute).some((k) => k.includes('/fees')), false);
});

test('auditAccountWire names what a browser or the server got wrong', () => {
  const cases = [
    ['a write with no Origin', (t) => delete t[5].headers.origin, 'PUT /api/tp/account/vault (#6): Origin is missing, not http://127.0.0.1:3199'],
    ['a write from another origin', (t) => (t[1].headers.origin = 'https://evil.example'), 'POST /api/tp/account/nonce (#2): Origin is "https://evil.example", not http://127.0.0.1:3199'],
    ['Sec-Fetch-Site cross-site', (t) => (t[4].headers['sec-fetch-site'] = 'cross-site'), 'GET /api/tp/account/vault (#5): Sec-Fetch-Site is "cross-site", not same-origin'],
    ['no Sec-Fetch-Site', (t) => delete t[3].headers['sec-fetch-site'], 'GET /api/tp/account/me (#4): Sec-Fetch-Site is missing, not same-origin'],
    ['a Referer', (t) => (t[3].headers.referer = 'http://127.0.0.1:3199/'), 'GET /api/tp/account/me (#4): carried a Referer (the page sets Referrer-Policy: no-referrer)'],
    ['text/plain', (t) => (t[5].headers['content-type'] = 'text/plain'), 'PUT /api/tp/account/vault (#6): Content-Type is not application/json'],
    ['a save without the cookie', (t) => delete t[5].headers.cookie, 'PUT /api/tp/account/vault (#6): was sent without the session cookie'],
    ['a cookie no sign-in set', (t) => (t[4].headers.cookie = `${SESSION_COOKIE}=v1.forged`), 'GET /api/tp/account/vault (#5): carried a session cookie that no sign-in of this run set'],
    ['the cookie twice', (t) => (t[4].headers.cookie = `${SESSION_COOKIE}=${VALUE}; ${SESSION_COOKIE}=${VALUE}`), 'GET /api/tp/account/vault (#5): carried the session cookie more than once'],
    ['a login that sends the message too', (t) => (t[2].body = JSON.stringify({ nonce: 'a'.repeat(32), signature: SIG, message: 'x' })), 'POST /api/tp/account/login (#3): the body is not exactly {nonce, signature}'],
    ['an upper-case signature', (t) => (t[2].body = JSON.stringify({ nonce: 'a'.repeat(32), signature: SIG.toUpperCase().replace('0X', '0x') })), 'POST /api/tp/account/login (#3): the signature is not 0x + 130 lower-case hex'],
    ['a lax session cookie', (t) => (t[2].setCookies = [LIVE.replace('SameSite=Strict', 'SameSite=Lax')]), 'POST /api/tp/account/login (#3): session cookie: SameSite is lax, not strict'],
    ['a save that asks to rekey', (t) => (t[5].body = '{"baseRev":0,"kv":1,"keyId":"0x00","iv":"AA==","ct":"AA==","rekey":true}'), 'PUT /api/tp/account/vault (#6): the body is not exactly {baseRev, kv, keyId, iv, ct}'],
    ['a challenge with an extra field', (t) => (t[1].body = '{"address":"0x1","origin":"x"}'), 'POST /api/tp/account/nonce (#2): the body is not exactly {address}'],
    ['a refused write', (t) => Object.assign(t[5], { status: 403, responseBody: '{"error":"x","code":"forbidden"}' }), 'PUT /api/tp/account/vault (#6): answered 403 forbidden'],
    ['a 409 that is not a conflict', (t) => (t[6].responseBody = '{"error":"x","code":"key_mismatch"}'), 'PUT /api/tp/account/vault (#7): answered 409 key_mismatch'],
    ['a 401 although the cookie was sent', (t) => Object.assign(t[3], { status: 401, responseBody: '{"code":"no_session"}' }), 'GET /api/tp/account/me (#4): answered 401 no_session'],
    ['a logout that keeps the cookie', (t) => (t[8].setCookies = []), 'POST /api/tp/account/logout (#9): logout did not clear the session cookie'],
    ['a logout answered 200', (t) => (t[8].status = 200), 'POST /api/tp/account/logout (#9): logout answered 200, not 204'],
  ];
  for (const [what, mutate, want] of cases) {
    const t = traffic();
    mutate(t);
    const { problems } = audit(t);
    assert.ok(problems.includes(want), `${what}: expected "${want}", got ${JSON.stringify(problems)}`);
  }
});

test('auditAccountWire knows the contract routes only: POST /challenge and GET /session are neither the sign-in nor the session', () => {
  const t = traffic();
  for (const e of t) e.path = e.path.replace('/account/nonce', '/account/challenge').replace('/account/me', '/account/session');
  const { problems, stats } = audit(t);
  assert.ok(problems.length > 0, 'a transcript under other route names is not a clean run');
  assert.equal(stats.probes, 0);
});

test("auditAccountWire notices a run with no sign-in, and a sign-in whose cookie never came back", () => {
  const noLogin = traffic().filter((e) => e.seq === 1);
  assert.deepEqual(audit(noLogin).problems, ['no sign-in was answered 200']);
  const unused = traffic().slice(0, 3);
  assert.deepEqual(audit(unused).problems, ["a sign-in's session cookie never came back on a later request"]);
});

test('secretNeedles + countNeedles find a key in hex (any case) and base64, and nothing in unrelated text', () => {
  const w = Wallet.createRandom();
  const needles = secretNeedles(w.privateKey);
  const bare = w.privateKey.slice(2);
  const b64 = Buffer.from(bare, 'hex').toString('base64');
  const b64url = Buffer.from(bare, 'hex').toString('base64url');
  assert.equal(countNeedles([`{"k":"${bare.toUpperCase()}"}`], needles), 1);
  assert.equal(countNeedles([`x ${b64} y`], needles), 1);
  assert.equal(countNeedles([`x ${b64url} y`], needles), 1);
  assert.equal(countNeedles(['{"baseRev":1,"kv":1}', ''], needles), 0);
  assert.throws(() => secretNeedles('0x1234'), /at least 32 bytes/);
});

test("secretNeedles of a signature also finds its r, its s and r || s (the unlock key material) alone", async () => {
  const w = Wallet.createRandom();
  const sig = await w.signMessage('unlock');
  const bare = sig.slice(2);
  const needles = secretNeedles(sig);
  assert.equal(countNeedles([bare], needles) >= 1, true);
  assert.equal(countNeedles([`r=${bare.slice(0, 64)}`], needles), 1);
  assert.equal(countNeedles([`s=${bare.slice(64, 128)}`], needles), 1);
  assert.equal(countNeedles([Buffer.from(bare.slice(0, 128), 'hex').toString('base64')], needles), 1);
  assert.equal(countNeedles([Buffer.from(bare.slice(0, 128), 'hex').toString('base64url')], needles), 1);
  assert.equal(countNeedles([`a${w.address}b`], needles), 0);
});

test('addressNeedle matches an address without 0x in any case', () => {
  const a = Wallet.createRandom().address;
  assert.equal(countNeedles([`{"wallets":["${a.slice(2).toLowerCase()}"]}`], [addressNeedle(a)]), 1);
  assert.equal(countNeedles([a.toUpperCase()], [addressNeedle(a)]), 1);
  assert.throws(() => addressNeedle('0x12'), /not an address/);
});

test('hexRuns picks out 0x + 130-hex signatures and nothing shorter or longer', () => {
  const body = JSON.stringify({ nonce: 'a'.repeat(32), signature: SIG, keyId: '0x' + 'c'.repeat(32), key: '0x' + 'd'.repeat(64), long: '0x' + 'e'.repeat(131) });
  assert.deepEqual(hexRuns(body, 130), [SIG]);
  assert.deepEqual(hexRuns('nothing here', 130), []);
});

test("classifyMessage tells the unlock message from a sign-in by the Nonce line; loginNamesOrigin checks the page's name", () => {
  const unlock = ['dapp.rhbond.xyz wants you to sign in with your Ethereum account:', '0xA', '', 'Unlock.', '', 'URI: https://dapp.rhbond.xyz/vault', 'Version: 1', 'Chain ID: 4663', 'Nonce: vaultkeyv1', 'Issued At: 2026-09-19T00:00:00Z'].join(LF);
  const login = ['127.0.0.1:3199 wants you to sign in with your Ethereum account:', '0xA', '', 'Sign in.', '', `URI: ${ORIGIN}`, 'Version: 1', 'Chain ID: 4663', `Nonce: ${'0f'.repeat(16)}`, 'Issued At: 2026-09-19T12:00:00.000Z'].join(LF);
  assert.equal(classifyMessage(unlock), 'unlock');
  assert.equal(classifyMessage(login), 'login');
  assert.equal(classifyMessage('hello'), 'other');
  assert.equal(classifyMessage(login.replace('0f'.repeat(16), 'NOTHEX')), 'other');
  assert.equal(loginNamesOrigin(login, ORIGIN), true);
  assert.equal(loginNamesOrigin(login, 'https://dapp.rhbond.xyz'), false);
  assert.equal(loginNamesOrigin(login.replace(`URI: ${ORIGIN}`, 'URI: http://127.0.0.1:3000'), ORIGIN), false);
});
