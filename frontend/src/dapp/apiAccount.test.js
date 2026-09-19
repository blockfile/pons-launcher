// The account half of api.js (spec Addendum A): allowlisted bodies, the one
// scan exemption (a VERIFIED login signature), and response shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, getBytes, hexlify } from 'ethers';
import {
  buildBody,
  postChallenge,
  postLogin,
  getAccountSession,
  postLogout,
  getVault,
  putVault,
  deleteVault,
  MAX_VAULT_BYTES,
} from './api.js';
import { loginMessage, unlockMessage } from './account/messages.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const NONCE = '00112233445566778899aabbccddeeff';
const KEY_ID = `0x${'cd'.repeat(16)}`;
const b64 = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64');

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next;
  };
  fn.calls = calls;
  return fn;
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => (body === undefined ? Promise.reject(new SyntaxError('empty')) : body) });

function challengeFor(address) {
  const issuedAt = '2026-09-19T12:00:00.000Z';
  const expirationTime = '2026-09-19T12:05:00.000Z';
  // exactly the answer of POST /api/tp/account/nonce (backend/src/tp/accountContract.json)
  return { nonce: NONCE, issuedAt, expirationTime, message: loginMessage({ domain: '127.0.0.1:3199', address, uri: 'http://127.0.0.1:3199', nonce: NONCE, issuedAt, expirationTime }) };
}

test('the account kinds send exactly their allowlisted fields', () => {
  const a = Wallet.createRandom().address;
  assert.equal(buildBody('challenge', { address: a }), JSON.stringify({ address: a.toLowerCase() }));
  assert.equal(buildBody('logout', {}), '{}');
  const put = { baseRev: 0, kv: 1, keyId: KEY_ID, iv: b64(12), ct: b64(4112) };
  assert.equal(buildBody('vaultPut', put), JSON.stringify(put));
  assert.equal(buildBody('vaultDelete', { baseRev: 3 }), JSON.stringify({ baseRev: 3 }));
  assert.throws(() => buildBody('vaultPut', { ...put, rekey: true }), /not allowed/);
  assert.throws(() => buildBody('vaultPut', { ...put, plaintext: 'x' }), /not allowed/);
  assert.throws(() => buildBody('challenge', { address: a, signature: '0x' }), /not allowed/);
});

test('the ciphertext must be canonical base64 of 17 B to 256 KiB, the IV exactly 12 bytes', () => {
  const ok = { baseRev: 1, kv: 1, keyId: KEY_ID, iv: b64(12), ct: b64(64) };
  const bad = [
    { iv: b64(16) },
    { iv: 'AAAAAAAAAAAAAAA=' }, // 11 bytes
    { ct: b64(16) }, // shorter than a GCM tag + 1
    { ct: b64(MAX_VAULT_BYTES + 1) },
    { ct: `${b64(64)}${String.fromCharCode(10)}` },
    { ct: 'QQ==QQ==' },
    { ct: b64(64).replace(/w==$/, 'x==') }, // same bytes, non-canonical padding bits
    { kv: 2 },
    { keyId: '0x1234' },
    { baseRev: -1 },
    { baseRev: 1.5 },
    { baseRev: '1' },
  ];
  assert.doesNotThrow(() => buildBody('vaultPut', ok));
  assert.doesNotThrow(() => buildBody('vaultPut', { ...ok, ct: b64(MAX_VAULT_BYTES) }));
  for (const patch of bad) assert.throws(() => buildBody('vaultPut', { ...ok, ...patch }), undefined, JSON.stringify(patch).slice(0, 60));
});

test('the key-shape scan still guards the account kinds: a hex key in the ciphertext is refused, unechoed', () => {
  const key = Wallet.createRandom().privateKey;
  const bare = key.slice(2); // 64 hex characters are also 64 valid base64 characters
  const put = { baseRev: 0, kv: 1, keyId: KEY_ID, iv: b64(12) };
  for (const ct of [bare, `${bare}AAAA`, key]) {
    let err;
    try {
      buildBody('vaultPut', { ...put, ct });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'refused');
    assert.ok(!err.message.includes(bare), 'never echoed');
  }
  assert.throws(() => buildBody('challenge', { address: key }), /not an address/);
  assert.throws(() => buildBody('login', { nonce: bare.slice(0, 32), signature: key }), /not a sign-in signature/);
});

test('a login body can only come from postLogin: even a well-formed signature string is refused by buildBody', async () => {
  const w = Wallet.createRandom();
  const sig = (await w.signMessage(challengeFor(w.address).message)).toLowerCase();
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.throws(() => buildBody('login', { nonce: NONCE, signature: sig }), /verified by postLogin/);
  assert.throws(() => buildBody('login', { nonce: NONCE, signature: { hex: sig } }), /verified by postLogin/);
});

test('postLogin verifies before sending: only a signature by that account over that challenge leaves the page, canonical', async () => {
  const w = Wallet.createRandom();
  const ch = challengeFor(w.address);
  const sig = await w.signMessage(ch.message);
  // re-spell it high-s / v 0-1, as some wallets answer
  const b = getBytes(sig);
  const s = BigInt(hexlify(b.slice(32, 64)));
  const high = `${hexlify(b.slice(0, 32))}${(N - s).toString(16).padStart(64, '0')}0${b[64] === 27 ? 1 : 0}`;
  const fetch = fakeFetch([reply(200, { address: w.address.toLowerCase(), expiresAt: 1 })]);
  const out = await postLogin({ nonce: NONCE, signature: high, message: ch.message, address: w.address }, { fetch });
  assert.equal(out.address, w.address);
  assert.equal(fetch.calls[0].url, '/api/tp/account/login');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.body, JSON.stringify({ nonce: NONCE, signature: sig.toLowerCase() }));
});

test('the unlock signature can never ride the login exemption, and a stranger signature is never sent', async () => {
  const w = Wallet.createRandom();
  const other = Wallet.createRandom();
  const ch = challengeFor(w.address);
  const unlockSig = await w.signMessage(unlockMessage(w.address));
  const fetch = fakeFetch([]);
  const attempts = [
    { nonce: NONCE, signature: unlockSig, message: ch.message, address: w.address }, // unlock sig offered for the challenge
    { nonce: NONCE, signature: unlockSig, message: unlockMessage(w.address), address: w.address }, // the unlock message itself
    { nonce: NONCE, signature: await other.signMessage(ch.message), message: ch.message, address: w.address },
    { nonce: 'f'.repeat(32), signature: await w.signMessage(ch.message), message: ch.message, address: w.address },
    { nonce: NONCE, signature: `${(await w.signMessage(ch.message)).slice(0, -2)}${'00'.repeat(40)}`, message: ch.message, address: w.address },
  ];
  for (const a of attempts) {
    let err;
    try {
      await postLogin(a, { fetch });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'refused');
    assert.ok(!err.message.includes(a.signature.slice(2, 40)), 'never echoed');
  }
  assert.equal(fetch.calls.length, 0, 'nothing reached the network');
});

test('postChallenge, getAccountSession, postLogout, getVault, putVault and deleteVault speak the account routes', async () => {
  const w = Wallet.createRandom();
  const ch = challengeFor(w.address);
  const rec = { v: 2, kv: 1, keyId: KEY_ID, iv: b64(12), ct: b64(4112), rev: 4, updatedAt: 9 };
  const fetch = fakeFetch([
    reply(200, ch),
    reply(200, { address: w.address.toLowerCase(), expiresAt: 5, vault: { rev: 4, keyId: KEY_ID, updatedAt: 9, bytes: 4112 } }),
    reply(401, { error: 'not signed in', code: 'no_session' }),
    reply(204, undefined),
    reply(200, { vault: rec }),
    reply(200, { vault: null }),
    reply(200, { rev: 5, updatedAt: 10 }),
    reply(409, { error: 'conflict', code: 'conflict', rev: 6 }),
    reply(200, { deleted: true }),
  ]);
  const o = { fetch };
  assert.deepEqual(await postChallenge(w.address, o), ch);
  assert.deepEqual(await getAccountSession(o), { address: w.address, expiresAt: 5, vault: { rev: 4, keyId: KEY_ID, updatedAt: 9, bytes: 4112 } });
  assert.equal(await getAccountSession(o), null, '401 means signed out, not an error');
  assert.deepEqual(await postLogout(o), {});
  assert.deepEqual(await getVault(o), rec);
  assert.equal(await getVault(o), null);
  assert.deepEqual(await putVault({ baseRev: 4, kv: 1, keyId: KEY_ID, iv: rec.iv, ct: rec.ct }, o), { rev: 5, updatedAt: 10 });
  await assert.rejects(putVault({ baseRev: 4, kv: 1, keyId: KEY_ID, iv: rec.iv, ct: rec.ct }, o), (e) => e.cause.code === 'conflict' && e.cause.status === 409);
  assert.deepEqual(await deleteVault(5, o), { deleted: true });
  const routes = fetch.calls.map((c) => `${c.init.method} ${c.url}`);
  assert.deepEqual(routes, [
    'POST /api/tp/account/nonce',
    'GET /api/tp/account/me',
    'GET /api/tp/account/me',
    'POST /api/tp/account/logout',
    'GET /api/tp/account/vault',
    'GET /api/tp/account/vault',
    'PUT /api/tp/account/vault',
    'PUT /api/tp/account/vault',
    'DELETE /api/tp/account/vault',
  ]);
  assert.equal(fetch.calls[3].init.body, '{}', 'a JSON body, so the server CSRF guard sees application/json');
  assert.equal(fetch.calls[3].init.headers['content-type'], 'application/json');
  for (const c of fetch.calls) assert.equal(c.init.credentials, 'same-origin', 'the session cookie rides along');
});

test('malformed account answers are refused, not trusted', async () => {
  const o = (body) => ({ fetch: fakeFetch([reply(200, body)]) });
  await assert.rejects(getAccountSession(o({ address: 'nope' })), (e) => e.cause.code === 'bad_response');
  await assert.rejects(getAccountSession(o({ address: Wallet.createRandom().address, vault: { rev: 0, keyId: KEY_ID } })), (e) => e.cause.code === 'bad_response');
  await assert.rejects(getVault(o({})), (e) => e.cause.code === 'bad_response');
  await assert.rejects(getVault(o({ vault: { kv: 1, keyId: KEY_ID, iv: 'x', ct: b64(64), rev: 1 } })), (e) => e.cause.code === 'bad_response');
  await assert.rejects(postChallenge(Wallet.createRandom().address, o({ nonce: 'x', message: 'y' })), (e) => e.cause.code === 'bad_response');
});

test("a refusal's Retry-After (whole seconds) rides on the error as cause.retryAfterMs; anything else is left out", async () => {
  const withHead = (status, body, value) => ({ ...reply(status, body), headers: { get: (n) => (String(n).toLowerCase() === 'retry-after' ? value : null) } });
  const put = { baseRev: 1, kv: 1, keyId: KEY_ID, iv: b64(12), ct: b64(64) };
  const fetch = fakeFetch([
    withHead(429, { error: 'too many requests', code: 'rate_limited' }, '7'),
    withHead(429, { error: 'too many requests', code: 'rate_limited' }, 'Wed, 21 Oct 2026 07:28:00 GMT'),
    withHead(503, { error: 'saved wallets are unavailable right now', code: 'unavailable' }, null),
    reply(429, undefined),
  ]);
  const o = { fetch };
  await assert.rejects(putVault(put, o), (e) => e.cause.code === 'rate_limited' && e.cause.status === 429 && e.cause.retryAfterMs === 7000);
  await assert.rejects(putVault(put, o), (e) => e.cause.code === 'rate_limited' && !('retryAfterMs' in e.cause), 'an HTTP-date is not read');
  await assert.rejects(putVault(put, o), (e) => e.cause.code === 'unavailable' && e.cause.status === 503 && !('retryAfterMs' in e.cause));
  await assert.rejects(putVault(put, o), (e) => e.cause.code === 'http_429' && !('retryAfterMs' in e.cause), "a bodiless 429 (nginx) keeps api.js's http_ code");
});
