import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import { KEY_TTL_MS, createKeyCache } from './keyCache.js';

/**
 * A minimal asynchronous IndexedDB: open() with onupgradeneeded/onsuccess, one
 * object store with get/put/delete, transactions that complete after their
 * request. Values are kept by reference, as a structured clone of a CryptoKey
 * would come back. `refusePut` makes put() throw like a DataCloneError.
 */
function fakeIndexedDB({ refusePut = false } = {}) {
  const dbs = new Map();
  const later = (fn) => setImmediate(fn);
  function request(run) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      try {
        req.result = run();
        if (req.onsuccess) req.onsuccess();
      } catch (e) {
        req.error = e;
        if (req.onerror) req.onerror();
      }
    });
    return req;
  }
  return {
    dbs,
    open(name) {
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          const stores = new Map();
          db = {
            stores,
            objectStoreNames: { contains: (n) => stores.has(n) },
            createObjectStore(n, { keyPath }) {
              stores.set(n, { keyPath, rows: new Map() });
            },
            transaction(n) {
              const st = stores.get(n);
              const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
              let pending = 0;
              const settle = () => {
                pending -= 1;
                if (pending === 0) later(() => tx.oncomplete && tx.oncomplete());
              };
              const wrap = (fn) => {
                pending += 1;
                const r = request(fn);
                const on = { s: null, e: null };
                Object.defineProperty(r, 'onsuccess', { get: () => on.s, set: (f) => { on.s = () => { f && f(); settle(); }; } });
                Object.defineProperty(r, 'onerror', { get: () => on.e, set: (f) => { on.e = () => { f && f(); settle(); }; } });
                return r;
              };
              tx.objectStore = () => ({
                get: (k) => wrap(() => st.rows.get(k)),
                put: (v) => {
                  if (refusePut) throw new Error('DataCloneError');
                  return wrap(() => {
                    st.rows.set(v[st.keyPath], v);
                    return v[st.keyPath];
                  });
                },
                delete: (k) => wrap(() => {
                  st.rows.delete(k);
                }),
              });
              return tx;
            },
          };
          dbs.set(name, db);
        }
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

async function aesKey() {
  return webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const KEY_ID = `0x${'ab'.repeat(16)}`;

test('put then get returns the same CryptoKey and keyId from IndexedDB tp-account/keys', async () => {
  const idb = fakeIndexedDB();
  const cache = createKeyCache({ indexedDB: idb, now: () => 1000 });
  const addr = Wallet.createRandom().address;
  const key = await aesKey();
  await cache.put(addr, { key, keyId: KEY_ID });
  const rows = idb.dbs.get('tp-account').stores.get('keys').rows;
  assert.deepEqual([...rows.keys()], [addr.toLowerCase()]);
  assert.equal(rows.get(addr.toLowerCase()).expiresAt, 1000 + KEY_TTL_MS);
  const got = await cache.get(addr.toUpperCase().replace('0X', '0x'));
  assert.equal(got.key, key);
  assert.equal(got.keyId, KEY_ID);
  // a second cache (a reload, a new tab) reads the same database
  const again = await createKeyCache({ indexedDB: idb, now: () => 2000 }).get(addr);
  assert.equal(again.key, key);
});

test('a key expires after 12 hours and is deleted when read', async () => {
  const idb = fakeIndexedDB();
  let t = 0;
  const cache = createKeyCache({ indexedDB: idb, now: () => t });
  const addr = Wallet.createRandom().address;
  await cache.put(addr, { key: await aesKey(), keyId: KEY_ID });
  t = KEY_TTL_MS - 1;
  assert.ok(await cache.get(addr));
  t = KEY_TTL_MS;
  assert.equal(await cache.get(addr), null);
  assert.equal(idb.dbs.get('tp-account').stores.get('keys').rows.size, 0, 'the expired record is gone');
  assert.equal(KEY_TTL_MS, 12 * 60 * 60 * 1000);
});

test('remove deletes the key; a malformed record reads as none and is deleted', async () => {
  const idb = fakeIndexedDB();
  const cache = createKeyCache({ indexedDB: idb });
  const a = Wallet.createRandom().address;
  await cache.put(a, { key: await aesKey(), keyId: KEY_ID });
  await cache.remove(a);
  assert.equal(await cache.get(a), null);
  const b = Wallet.createRandom().address.toLowerCase();
  await cache.put(b, { key: await aesKey(), keyId: KEY_ID });
  idb.dbs.get('tp-account').stores.get('keys').rows.get(b).keyId = 'not a key id';
  assert.equal(await cache.get(b), null);
  assert.equal(idb.dbs.get('tp-account').stores.get('keys').rows.has(b), false);
});

test('no IndexedDB, or one that throws or refuses the key: the key lives in this tab only, and nothing throws', async () => {
  const throwing = { open: () => { throw new Error('SecurityError'); } };
  for (const indexedDB of [null, throwing, fakeIndexedDB({ refusePut: true })]) {
    const cache = createKeyCache({ indexedDB });
    const addr = Wallet.createRandom().address;
    const key = await aesKey();
    await cache.put(addr, { key, keyId: KEY_ID });
    assert.equal((await cache.get(addr)).key, key);
    await cache.remove(addr);
    assert.equal(await cache.get(addr), null);
  }
});

test('put ignores a malformed address or keyId instead of storing it', async () => {
  const idb = fakeIndexedDB();
  const cache = createKeyCache({ indexedDB: idb });
  await cache.put('not-an-address', { key: await aesKey(), keyId: KEY_ID });
  const addr = Wallet.createRandom().address;
  await cache.put(addr, { key: await aesKey(), keyId: '0x1234' });
  assert.equal(await cache.get(addr), null);
});
