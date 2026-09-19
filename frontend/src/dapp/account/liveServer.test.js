// The page's REAL account client (api.js, account.js, vaultSync.js) against the
// REAL backend router (backend/src/tp/account.js + vaultStore.js) over HTTP — no
// fake on either side. This is the test that fails when the two halves drift
// apart (a renamed route, a renamed field, a different DELETE rule): every other
// account test here runs against fakeServer.js.
//
// A small "browser" stands in for Chromium: same-origin requests carry
// Sec-Fetch-Site, writes carry Origin, and a cookie jar keeps the __Host- cookie.
// Every wallet is Wallet.createRandom(), made here; nothing is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SigningKey, Wallet, computeAddress, getAddress } from 'ethers';
import * as api from '../api.js';
import { createAccount } from './account.js';
import { createVaultSync } from './vaultSync.js';
import { unlockMessage } from './messages.js';
import { fakeEip1193 } from './fakeEip1193.js';
import { boundApi } from './fakeServer.js';

// Test-only reach into the backend, as chain/constants.test.js does.
const require = createRequire(import.meta.url);
const express = require('express');
const { createAccountRouter, COOKIE_NAME } = require('../../../../backend/src/tp/account.js');

const ORIGIN = 'http://127.0.0.1:3199'; // the page origin the router is told (TP_SIWE_ORIGIN)
const subtle = webcrypto.subtle;
const OPEN_LIMITS = { noncesPerMin: 1000, loginsPerMin: 1000, readsPerMin: 1000, writesPerMinPerIp: 1000, writesPerMinPerAccount: 1000, createsPerHour: 1000 };

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-live-account-'));
  dirs.push(dir);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp/account', createAccountRouter({ dir, origin: ORIGIN, limits: OPEN_LIMITS }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { dir, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** One browser profile: its cookie jar, and every body it sent. */
function browser(port) {
  let cookie = null;
  const sent = [];
  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    const headers = { ...(init.headers || {}), 'sec-fetch-site': 'same-origin' };
    if (method !== 'GET' && method !== 'HEAD') headers.origin = ORIGIN;
    if (cookie) headers.cookie = cookie;
    if (init.body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(init.body));
      sent.push(String(init.body));
    }
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: String(url), method, headers }, (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c) => {
          text += c;
        });
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text }));
      });
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
    for (const line of res.headers['set-cookie'] || []) {
      const pair = line.split(';')[0];
      if (!pair.startsWith(`${COOKIE_NAME}=`)) continue;
      cookie = pair === `${COOKIE_NAME}=` ? null : pair; // cleared by the server, or set
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(res.text) };
  }
  return { fetch, sent };
}

function mapCache() {
  const m = new Map();
  return {
    m,
    get: async (a) => m.get(String(a).toLowerCase()) || null,
    put: async (a, e) => {
      m.set(String(a).toLowerCase(), { key: e.key, keyId: e.keyId, expiresAt: Date.now() + 60_000 });
    },
    remove: async (a) => {
      m.delete(String(a).toLowerCase());
    },
  };
}

/** One device's walletStore stand-in (two devices cannot share the real module). */
function memoryKeys() {
  const m = new Map();
  const subs = new Set();
  const emit = (type, list) => {
    if (list.length) for (const fn of [...subs]) fn({ type, addresses: list });
  };
  return {
    list: () => [...m.values()].map((w) => ({ ...w })),
    addresses: () => [...m.values()].map((w) => w.address),
    add(list) {
      const got = [];
      for (const x of list) {
        const address = computeAddress(new SigningKey(x.privateKey).publicKey);
        if (x.address && getAddress(x.address) !== address) throw new Error('key does not match');
        if (m.has(address.toLowerCase())) continue;
        m.set(address.toLowerCase(), { address, privateKey: x.privateKey });
        got.push(address);
      }
      emit('add', got);
      return { added: got.length, duplicates: list.length - got.length };
    },
    remove(a) {
      const w = m.get(String(a).toLowerCase());
      if (!w) return false;
      m.delete(String(a).toLowerCase());
      emit('remove', [w.address]);
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function device(port, wallet, walletOpts) {
  const b = browser(port);
  const provider = fakeEip1193(wallet, walletOpts);
  const account = createAccount({
    api: boundApi(api, b.fetch),
    discovery: { provider: (id) => (id === 'w' ? provider : null) },
    keyCache: mapCache(),
    origin: ORIGIN,
    subtle,
  });
  const keys = memoryKeys();
  const timers = [];
  function startSync() {
    const k = account.keyFor();
    return createVaultSync({
      api: boundApi(api, b.fetch),
      owner: k.address,
      key: k.key,
      keyId: k.keyId,
      keys, // no hub: the positions book is not what this test is about
      subtle,
      setTimeout: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout: () => {},
    });
  }
  return { b, provider, account, keys, startSync };
}

test('the real client and the real server: sign in, unlock, save, a second device reads it, a delete signs every device out', async () => {
  const srv = await startServer();
  try {
    const owner = Wallet.createRandom();
    const bundle = [Wallet.createRandom(), Wallet.createRandom()].map((w) => ({ address: w.address, privateKey: w.privateKey }));

    // device A: first visit — login + the double unlock signature
    const A = device(srv.port, owner);
    await A.account.resume();
    assert.equal(A.account.get().status, 'out', 'no cookie yet: signed out, not an error');
    assert.equal(await A.account.signIn('w'), true, A.account.get().error);
    assert.equal(await A.account.unlock('w'), true, A.account.get().error);
    assert.equal(A.account.get().status, 'unlocked');
    assert.equal(A.provider.signCount(), 3);
    const syncA = A.startSync();
    assert.equal((await syncA.load()).ok, true);
    A.keys.add(bundle);
    const saved = await syncA.flush();
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.rev, 1);

    // what the server holds is ciphertext: no key, no wallet address, in its own file
    const file = path.join(srv.dir, 'vaults', `${owner.address.toLowerCase()}.json`);
    const onDisk = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const w of bundle) {
      assert.ok(!onDisk.includes(w.privateKey.slice(2).toLowerCase()), 'no key on the server');
      assert.ok(!onDisk.includes(w.address.slice(2).toLowerCase()), 'no bundle address on the server');
    }

    // device B: the same wallet elsewhere — login + ONE unlock signature, the wallets arrive
    const B = device(srv.port, owner);
    await B.account.resume();
    assert.equal(await B.account.signIn('w'), true, B.account.get().error);
    assert.equal(await B.account.unlock('w'), true, B.account.get().error);
    assert.equal(B.provider.signCount(), 2, 'a copy exists: one unlock signature');
    assert.equal(B.account.keyFor().keyId, A.account.keyFor().keyId, 'the same key on both devices');
    const syncB = B.startSync();
    assert.equal((await syncB.load()).ok, true);
    assert.deepEqual(B.keys.addresses().sort(), bundle.map((w) => w.address).sort());

    // B deletes the copy: the server ends EVERY session of the address
    syncA.stop();
    syncB.stop();
    assert.equal(await B.account.deleteSaved(), true, B.account.get().error);
    assert.equal(B.account.get().status, 'out');
    assert.ok(!fs.existsSync(file), 'the copy is gone');
    assert.equal(await api.getAccountSession({ fetch: A.b.fetch }), null, "device A's session was ended too");

    // nothing that left either browser carries a key or the unlock signature
    const unlockSig = await owner.signMessage(unlockMessage(owner.address));
    const bodies = [...A.b.sent, ...B.b.sent].join(' ').toLowerCase();
    for (const w of bundle) assert.ok(!bodies.includes(w.privateKey.slice(2).toLowerCase()));
    assert.ok(!bodies.includes(unlockSig.slice(2, 66).toLowerCase()), 'the unlock signature never left the page');
  } finally {
    await srv.close();
  }
});

test('a Ledger-style (v = 0/1) high-s wallet signs in against the real server', async () => {
  const srv = await startServer();
  try {
    const d = device(srv.port, Wallet.createRandom(), { v01: true, highS: true });
    assert.equal(await d.account.signIn('w'), true, d.account.get().error);
    assert.equal(d.account.get().status, 'locked');
  } finally {
    await srv.close();
  }
});
