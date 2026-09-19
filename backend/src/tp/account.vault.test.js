'use strict';

// GET/PUT/DELETE /api/tp/account/vault (tp/account.js over tp/vaultStore.js), and the
// vault half of GET /me, over real HTTP. Every signer is Wallet.createRandom(); the
// "ciphertext" is random bytes — the server never looks inside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Wallet } = require('ethers');

const { createAccountRouter, COOKIE_NAME } = require('./account');

const ORIGIN = 'https://dapp.account.test';
const T0 = Date.parse('2026-09-19T12:00:00.000Z');
const OPEN_LIMITS = { noncesPerMin: 1000, loginsPerMin: 1000, readsPerMin: 1000, writesPerMinPerIp: 1000, writesPerMinPerAccount: 1000, createsPerHour: 1000 };

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-acct-vault-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function startApp({ dir = tmpDir(), limits = {}, vaultLimits = {} } = {}) {
  const clock = { t: T0 };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp/account', createAccountRouter({ dir, origin: ORIGIN, now: () => clock.t, limits: { ...OPEN_LIMITS, ...limits }, vaultLimits }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, clock, dir, close: () => new Promise((resolve) => server.close(resolve)) };
}

function call(server, method, p, { body, headers = {}, cookie } = {}) {
  const { port } = server.address();
  const text = body === undefined ? undefined : JSON.stringify(body);
  const h = { 'sec-fetch-site': 'same-origin', ...headers };
  if (method !== 'GET') {
    h.origin = h.origin || ORIGIN;
    h['content-type'] = h['content-type'] || 'application/json';
  }
  if (cookie) h.cookie = cookie;
  // Node's client sends a DELETE body unframed unless told its length; browsers always send it.
  if (text !== undefined) h['content-length'] = Buffer.byteLength(text);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        out += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null, headers: res.headers }));
    });
    req.on('error', reject);
    if (text !== undefined) req.write(text);
    req.end();
  });
}

async function login(server, wallet, headers = {}) {
  const n = await call(server, 'POST', '/api/tp/account/nonce', { body: { address: wallet.address }, headers });
  const l = await call(server, 'POST', '/api/tp/account/login', { body: { nonce: n.json.nonce, signature: await wallet.signMessage(n.json.message) }, headers });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const line = l.headers['set-cookie'].find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return line.split(';')[0];
}

const KEY_A = `0x${crypto.randomBytes(16).toString('hex')}`;
const KEY_B = `0x${crypto.randomBytes(16).toString('hex')}`;
/** A PUT body with `ctBytes` random bytes standing in for the AES-GCM ciphertext. */
function envelope(baseRev, { ctBytes = 300, ...over } = {}) {
  return { baseRev, kv: 1, keyId: KEY_A, iv: crypto.randomBytes(12).toString('base64'), ct: crypto.randomBytes(ctBytes).toString('base64'), ...over };
}
const put = (server, cookie, body, headers) => call(server, 'PUT', '/api/tp/account/vault', { body, cookie, headers });

test('without a session every vault route is 401 no_session', async () => {
  const app = await startApp();
  try {
    for (const [m, b] of [['GET'], ['PUT', envelope(0)], ['DELETE', { baseRev: 0 }]]) {
      const r = await call(app.server, m, '/api/tp/account/vault', { body: b });
      assert.equal(r.status, 401, m);
      assert.equal(r.json.code, 'no_session', m);
    }
  } finally {
    await app.close();
  }
});

test('create, read, update: rev counts up; /me carries the vault meta; answers are no-store', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const cookie = await login(app.server, w);
    const empty = await call(app.server, 'GET', '/api/tp/account/vault', { cookie });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { vault: null });
    assert.equal(empty.headers['cache-control'], 'no-store');
    assert.equal((await call(app.server, 'GET', '/api/tp/account/me', { cookie })).json.vault, null);

    const first = envelope(0);
    const created = await put(app.server, cookie, first);
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.deepEqual(created.json, { rev: 1, updatedAt: T0 });

    const read = await call(app.server, 'GET', '/api/tp/account/vault', { cookie });
    assert.deepEqual(read.json, { vault: { v: 2, kv: 1, keyId: KEY_A, iv: first.iv, ct: first.ct, rev: 1, updatedAt: T0 } });

    app.clock.t += 2000;
    assert.deepEqual((await put(app.server, cookie, envelope(1, { ctBytes: 500 }))).json, { rev: 2, updatedAt: T0 + 2000 });
    const me = await call(app.server, 'GET', '/api/tp/account/me', { cookie });
    assert.deepEqual(me.json, { address: w.address, expiresAt: T0 + 24 * 3600_000, vault: { rev: 2, updatedAt: T0 + 2000, keyId: KEY_A, bytes: 500 } });
  } finally {
    await app.close();
  }
});

test('a stale baseRev is 409 conflict {rev}; another keyId is 409 key_mismatch with no override (rekey is refused)', async () => {
  const app = await startApp();
  try {
    const cookie = await login(app.server, Wallet.createRandom());
    await put(app.server, cookie, envelope(0));
    await put(app.server, cookie, envelope(1));
    const stale = await put(app.server, cookie, envelope(1));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.code, 'conflict');
    assert.equal(stale.json.rev, 2);
    const again = await put(app.server, cookie, envelope(0));
    assert.equal(again.json.code, 'conflict', 'a second "create" is a conflict, not an overwrite');

    const other = await put(app.server, cookie, envelope(2, { keyId: KEY_B }));
    assert.equal(other.status, 409);
    assert.equal(other.json.code, 'key_mismatch');
    const rekey = await put(app.server, cookie, envelope(2, { keyId: KEY_B, rekey: true }));
    assert.equal(rekey.status, 400, 'there is no rekey field');
    assert.equal(rekey.json.code, 'bad_request');
    const read = await call(app.server, 'GET', '/api/tp/account/vault', { cookie });
    assert.equal(read.json.vault.rev, 2);
    assert.equal(read.json.vault.keyId, KEY_A, 'nothing changed');
  } finally {
    await app.close();
  }
});

test('a second session writing garbage under the public keyId cannot push the owner copy out of .prev', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const owner = await login(app.server, w);
    const mine = envelope(0);
    await put(app.server, owner, mine);
    // Another session of the same address (a phished login signature): it reads the
    // keyId from /me and overwrites, again and again.
    app.clock.t += 1000;
    const thief = await login(app.server, w);
    const { keyId } = (await call(app.server, 'GET', '/api/tp/account/me', { cookie: thief })).json.vault;
    for (let rev = 1; rev <= 4; rev++) assert.equal((await put(app.server, thief, envelope(rev, { keyId }))).status, 200);
    const file = path.join(app.dir, 'vaults', `${w.address.toLowerCase()}.json`);
    assert.equal(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).ct, mine.ct, 'the owner copy is still in .prev');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 5);
  } finally {
    await app.close();
  }
});

test('each session reaches its own address only: the body cannot name another vault', async () => {
  const app = await startApp();
  try {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const ca = await login(app.server, a);
    const cb = await login(app.server, b);
    await put(app.server, ca, envelope(0));
    assert.deepEqual((await call(app.server, 'GET', '/api/tp/account/vault', { cookie: cb })).json, { vault: null });
    const smuggled = await put(app.server, cb, { ...envelope(0), address: a.address });
    assert.equal(smuggled.status, 400);
    assert.equal(smuggled.json.code, 'bad_request');
    assert.ok(fs.existsSync(path.join(app.dir, 'vaults', `${a.address.toLowerCase()}.json`)));
    assert.ok(!fs.existsSync(path.join(app.dir, 'vaults', `${b.address.toLowerCase()}.json`)));
  } finally {
    await app.close();
  }
});

test('DELETE: rev-checked; keeps a deleted copy, clears the cookie and revokes every session of the address', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const here = await login(app.server, w);
    const elsewhere = await login(app.server, w);
    const saved = envelope(0);
    await put(app.server, here, saved);
    const stale = await call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 0 }, cookie: here });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.rev, 1);
    const bad = await call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 'x' }, cookie: here });
    assert.equal(bad.status, 400);

    app.clock.t += 1000;
    const del = await call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 1 }, cookie: here });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { deleted: true });
    assert.ok(del.headers['set-cookie'].some((l) => l.startsWith(`${COOKIE_NAME}=;`)), 'cookie cleared');
    for (const cookie of [here, elsewhere]) {
      const r = await call(app.server, 'GET', '/api/tp/account/vault', { cookie });
      assert.equal(r.status, 401, 'a session issued before the delete is revoked');
    }
    // The deleted list is kept, whole, for the operator's hand restore.
    const a = w.address.toLowerCase();
    const kept = fs.readdirSync(path.join(app.dir, 'deleted'));
    assert.deepEqual(kept, [`${a}.${T0 + 1000}`]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app.dir, 'deleted', kept[0], `${a}.json`), 'utf8')).ct, saved.ct);
    assert.ok(!fs.existsSync(path.join(app.dir, 'vaults', `${a}.json`)));

    // Starting over: a new sign-in, then a list under a new key.
    app.clock.t += 1;
    const fresh = await login(app.server, w);
    assert.deepEqual((await call(app.server, 'GET', '/api/tp/account/vault', { cookie: fresh })).json, { vault: null });
    const again = await put(app.server, fresh, envelope(0, { keyId: KEY_B }));
    assert.equal(again.status, 200);
    assert.equal(again.json.rev, 1);
  } finally {
    await app.close();
  }
});

test('a PUT that slipped past requireSession while the DELETE was still queued is refused 401', async (t) => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const cookie = await login(app.server, w);
    const a = w.address.toLowerCase();
    assert.equal((await put(app.server, cookie, envelope(0))).json.rev, 1);

    // An unrelated account's save holds the store's write lane, exactly as any other
    // visitor's save does on a live box.
    const real = fs.promises.rename;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.mock.method(fs.promises, 'rename', async (from, to) => {
      await gate;
      return real(from, to);
    });
    const otherCookie = await login(app.server, Wallet.createRandom());
    const busy = put(app.server, otherCookie, envelope(0));
    await new Promise((r) => setTimeout(r, 50));

    app.clock.t += 1000;
    const del = call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 1 }, cookie });
    await new Promise((r) => setTimeout(r, 50));
    // The thief's requireSession runs in the window where the DELETE has not reached
    // the front of the lane, so it still passes; the store must refuse it anyway.
    const stolen = put(app.server, cookie, envelope(0, { keyId: KEY_B }));
    await new Promise((r) => setTimeout(r, 50));
    release();

    assert.equal((await busy).status, 200);
    assert.deepEqual((await del).json, { deleted: true });
    const thief = await stolen;
    assert.equal(thief.status, 401, JSON.stringify(thief.json));
    assert.equal(thief.json.code, 'no_session');
    assert.ok(!fs.existsSync(path.join(app.dir, 'vaults', `${a}.json`)), 'the list did not come back under the thief key');
    t.mock.restoreAll();
  } finally {
    await app.close();
  }
});

test('a list saved after a Delete is kept by its own Delete: one phished sign-in deleting it loses neither list', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const a = w.address.toLowerCase();
    const del = (cookie, baseRev) => call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev }, cookie });
    // The owner deletes L1 to start over, signs in again and saves L2 under a new key.
    const owner = await login(app.server, w);
    const l1 = envelope(0);
    await put(app.server, owner, l1);
    app.clock.t += 1000;
    assert.equal((await del(owner, 1)).status, 200);
    app.clock.t += 1000;
    const owner2 = await login(app.server, w);
    const l2 = envelope(0, { keyId: KEY_B });
    assert.equal((await put(app.server, owner2, l2)).status, 200);
    // A thief with ONE phished sign-in deletes L2.
    app.clock.t += 1000;
    const thief = await login(app.server, w);
    assert.deepEqual((await del(thief, 1)).json, { deleted: true });

    const kept = fs.readdirSync(path.join(app.dir, 'deleted')).sort();
    assert.deepEqual(kept, [`${a}.${T0 + 1000}`, `${a}.${T0 + 3000}`]);
    const ctOf = (name) => JSON.parse(fs.readFileSync(path.join(app.dir, 'deleted', name, `${a}.json`), 'utf8')).ct;
    assert.equal(ctOf(kept[0]), l1.ct, 'L1 is still kept');
    assert.equal(ctOf(kept[1]), l2.ct, 'and so is L2');
  } finally {
    await app.close();
  }
});

test('DELETE with nothing stored still signs the address out: 200 {deleted: false}, cookie cleared, every session revoked', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const here = await login(app.server, w);
    const elsewhere = await login(app.server, w);
    app.clock.t += 1000;
    const del = await call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 0 }, cookie: here });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { deleted: false });
    assert.ok(del.headers['set-cookie'].some((l) => l.startsWith(`${COOKIE_NAME}=;`)), 'cookie cleared');
    for (const cookie of [here, elsewhere]) {
      const r = await call(app.server, 'GET', '/api/tp/account/me', { cookie });
      assert.equal(r.status, 401, 'a session issued before the delete is revoked');
      assert.equal(r.json.code, 'no_session');
    }
  } finally {
    await app.close();
  }
});

test('an over-size ciphertext is 413 too_large; a full store is 507 store_full', async () => {
  const app = await startApp({ vaultLimits: { maxBytes: 1024, maxAccounts: 1 } });
  try {
    const cookie = await login(app.server, Wallet.createRandom());
    const big = await put(app.server, cookie, envelope(0, { ctBytes: 1025 }));
    assert.equal(big.status, 413);
    assert.equal(big.json.code, 'too_large');
    assert.equal((await put(app.server, cookie, envelope(0, { ctBytes: 1024 }))).status, 200);
    const second = await login(app.server, Wallet.createRandom());
    const full = await put(app.server, second, envelope(0));
    assert.equal(full.status, 507);
    assert.equal(full.json.code, 'store_full');
  } finally {
    await app.close();
  }
});

test('new vaults per IP per hour are capped, and only a real creation is charged', async () => {
  const app = await startApp({ limits: { createsPerHour: 2 } });
  try {
    const ip = { 'x-real-ip': '198.51.100.20' };
    for (let i = 0; i < 2; i++) {
      const cookie = await login(app.server, Wallet.createRandom(), ip);
      assert.equal((await put(app.server, cookie, envelope(0), ip)).status, 200, `vault ${i + 1}`);
      // updates and refused creates cost nothing
      assert.equal((await put(app.server, cookie, envelope(1), ip)).status, 200);
      assert.equal((await put(app.server, cookie, envelope(0), ip)).status, 409);
    }
    const third = await login(app.server, Wallet.createRandom(), ip);
    const refused = await put(app.server, third, envelope(0), ip);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.code, 'rate_limited');
    assert.ok(Number(refused.headers['retry-after']) >= 1);
    const otherIp = await put(app.server, third, envelope(0), { 'x-real-ip': '198.51.100.21' });
    assert.equal(otherIp.status, 200, 'another IP still creates');
  } finally {
    await app.close();
  }
});

test('two tabs saving at once over HTTP: one save lands, the other is 409 conflict {rev}', async () => {
  const app = await startApp();
  try {
    const cookie = await login(app.server, Wallet.createRandom());
    await put(app.server, cookie, envelope(0));
    const [x, y] = await Promise.all([put(app.server, cookie, envelope(1)), put(app.server, cookie, envelope(1))]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    const lost = x.status === 409 ? x : y;
    assert.equal(lost.json.code, 'conflict');
    assert.equal(lost.json.rev, 2);
  } finally {
    await app.close();
  }
});

test('creates racing from one IP cannot both slip under the hourly creation cap', async () => {
  const app = await startApp({ limits: { createsPerHour: 1 } });
  try {
    const ip = { 'x-real-ip': '198.51.100.40' };
    const [ca, cb] = [await login(app.server, Wallet.createRandom(), ip), await login(app.server, Wallet.createRandom(), ip)];
    const [x, y] = await Promise.all([put(app.server, ca, envelope(0), ip), put(app.server, cb, envelope(0), ip)]);
    assert.deepEqual([x.status, y.status].sort(), [200, 429]);
  } finally {
    await app.close();
  }
});

test('a save waiting on a slow disk holds up nothing else: other requests answer meanwhile', async (t) => {
  const app = await startApp();
  let release = () => {};
  try {
    const a = await login(app.server, Wallet.createRandom());
    const b = await login(app.server, Wallet.createRandom());
    await put(app.server, b, envelope(0));
    const real = fs.promises.rename;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let renames = 0;
    t.mock.method(fs.promises, 'rename', async (from, to) => {
      renames += 1;
      await gate;
      return real(from, to);
    });
    let settled = false;
    const saving = put(app.server, a, envelope(0)).finally(() => {
      settled = true;
    });
    while (renames === 0 && !settled) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renames, 1, 'the save reached the disk and waits there');
    const other = await call(app.server, 'GET', '/api/tp/account/me', { cookie: b });
    assert.equal(other.status, 200, 'another visitor is answered while the save waits');
    assert.equal(other.json.vault.rev, 1);
    const read = await call(app.server, 'GET', '/api/tp/account/vault', { cookie: a });
    assert.deepEqual(read.json, { vault: null }, 'the save has not landed yet');
    release();
    assert.equal((await saving).status, 200);
    assert.equal((await call(app.server, 'GET', '/api/tp/account/vault', { cookie: a })).json.vault.rev, 1);
  } finally {
    release(); // a failed assertion must not leave a request hanging on the held disk
    await app.close();
  }
});

test('writes are limited per signed-in ADDRESS, whatever IP they come from', async () => {
  const app = await startApp({ limits: { writesPerMinPerAccount: 3 } });
  try {
    const cookie = await login(app.server, Wallet.createRandom());
    await put(app.server, cookie, envelope(0), { 'x-real-ip': '198.51.100.30' });
    await put(app.server, cookie, envelope(1), { 'x-real-ip': '198.51.100.31' });
    await put(app.server, cookie, envelope(2), { 'x-real-ip': '198.51.100.32' });
    const fourth = await put(app.server, cookie, envelope(3), { 'x-real-ip': '198.51.100.33' });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.json.code, 'rate_limited');
  } finally {
    await app.close();
  }
});

test('CSRF: a vault PUT or DELETE from a foreign Origin → 403, even with a valid cookie', async () => {
  const app = await startApp();
  try {
    const cookie = await login(app.server, Wallet.createRandom());
    const r = await put(app.server, cookie, envelope(0), { origin: 'https://rhbond.xyz' });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'forbidden');
    const d = await call(app.server, 'DELETE', '/api/tp/account/vault', { body: { baseRev: 0 }, cookie, headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(d.status, 403);
    assert.equal((await call(app.server, 'GET', '/api/tp/account/vault', { cookie })).json.vault, null, 'nothing was written');
  } finally {
    await app.close();
  }
});

test('the store lives under the configured dir: vaults/ 0700, files 0600, a session.key beside it', async () => {
  const app = await startApp();
  try {
    const w = Wallet.createRandom();
    const cookie = await login(app.server, w);
    await put(app.server, cookie, envelope(0));
    const file = path.join(app.dir, 'vaults', `${w.address.toLowerCase()}.json`);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(path.join(app.dir, 'session.key')));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(app.dir, 'vaults')).mode & 0o777, 0o700);
    }
  } finally {
    await app.close();
  }
});
