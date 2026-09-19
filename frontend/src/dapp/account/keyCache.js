/**
 * Where an unlocked account key waits between page loads, so a refresh or a new
 * tab does not ask the wallet again (spec Addendum A, "Staying unlocked").
 *
 *   IndexedDB database 'tp-account' version 1, object store 'keys', keyPath 'address'
 *   record {address: lower-case 0x, key: CryptoKey, keyId: '0x' + 32 hex, expiresAt: ms}
 *
 * The key is a NON-EXTRACTABLE WebCrypto key: IndexedDB keeps the CryptoKey
 * object (structured clone), and nothing, this page included, can read its bytes
 * back out. It can still be USED by script running on this origin while it is
 * cached — which is why it expires after 12 hours (a browser cannot report
 * "closed"), and Lock and Disconnect delete it.
 *
 * An expired or malformed record is deleted WHEN IT IS READ and, so that the 12 hours
 * hold for a record nothing ever reads again, by a sweep over the whole store on every
 * page load. The reader alone was not enough: a visitor who unlocks and closes the tab
 * loses their session cookie 24 h later, so resume() gets a 401 and never asks the
 * cache for that address again — the CryptoKey then sat in IndexedDB for weeks, usable
 * by an XSS or a malicious extension that opens the database itself. Making the cache
 * opens the database, which is what makes the sweep run at all.
 *
 * When IndexedDB is missing or throws (some private windows) the cache keeps the key in
 * this tab's memory only: unlocking then lasts until the tab closes, as the passphrase
 * vault always did. No failure here ever throws to the caller.
 */
export const KEY_TTL_MS = 12 * 60 * 60 * 1000;
export const DB_NAME = 'tp-account';
export const STORE = 'keys';

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const KEY_ID_RE = /^0x[0-9a-f]{32}$/;

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * @param {{indexedDB?: IDBFactory|null, now?: () => number, ttlMs?: number}} [deps]
 * @returns {{
 *   get(address: string): Promise<{key: CryptoKey, keyId: string, expiresAt: number}|null>,
 *   put(address: string, entry: {key: CryptoKey, keyId: string}): Promise<void>,
 *   remove(address: string): Promise<void>,
 * }}
 */
export function createKeyCache({ indexedDB = globalThis.indexedDB, now = () => Date.now(), ttlMs = KEY_TTL_MS } = {}) {
  const memory = new Map();
  let opening = null;

  const stale = (r) => !r || !Number.isFinite(r.expiresAt) || r.expiresAt <= now();

  /**
   * Every expired or malformed record, gone. ONE readwrite cursor, so a record another
   * tab has just refreshed cannot be deleted between reading it and deleting it.
   * Best effort throughout: it must never delay or break the get/put beside it.
   */
  function sweepExpired(db) {
    for (const [a, r] of memory) if (stale(r)) memory.delete(a);
    if (!db || !db.objectStoreNames.contains(STORE)) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (typeof store.openCursor !== 'function') return; // no cursors: the reader still deletes
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (stale(cur.value)) cur.delete();
      cur.continue();
    };
    req.onerror = () => {};
    tx.onerror = () => {};
    tx.onabort = () => {};
  }

  function openDb() {
    if (!opening) {
      opening = new Promise((resolve) => {
        let req;
        try {
          if (!indexedDB || typeof indexedDB.open !== 'function') {
            resolve(null);
            return;
          }
          req = indexedDB.open(DB_NAME, 1);
        } catch {
          resolve(null);
          return;
        }
        req.onupgradeneeded = () => {
          try {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'address' });
          } catch {
            // the open below fails and the cache falls back to memory
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          try {
            sweepExpired(db);
          } catch {
            // a sweep is never worth failing the open for
          }
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }
    return opening;
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    if (!db) throw new Error('IndexedDB unavailable');
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(STORE, mode);
      done(fn(tx.objectStore(STORE))).then(
        (r) => {
          result = r;
        },
        () => {}
      );
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  const norm = (address) => String(address).toLowerCase();

  async function remove(address) {
    const a = norm(address);
    memory.delete(a);
    try {
      await withStore('readwrite', (s) => s.delete(a));
    } catch {
      // nothing stored there, or no IndexedDB: memory is already clear
    }
  }

  async function get(address) {
    const a = norm(address);
    if (!ADDRESS_RE.test(a)) return null;
    let rec = memory.get(a) || null;
    if (!rec) {
      try {
        rec = (await withStore('readonly', (s) => s.get(a))) || null;
      } catch {
        rec = null;
      }
    }
    if (!rec) return null;
    const fine =
      rec.address === a &&
      rec.key &&
      typeof rec.key === 'object' &&
      typeof rec.keyId === 'string' &&
      KEY_ID_RE.test(rec.keyId) &&
      Number.isFinite(rec.expiresAt) &&
      rec.expiresAt > now();
    if (!fine) {
      await remove(a);
      return null;
    }
    return { key: rec.key, keyId: rec.keyId, expiresAt: rec.expiresAt };
  }

  async function put(address, { key, keyId }) {
    const a = norm(address);
    if (!ADDRESS_RE.test(a) || typeof keyId !== 'string' || !KEY_ID_RE.test(keyId) || !key) return;
    const rec = { address: a, key, keyId, expiresAt: now() + ttlMs };
    try {
      await withStore('readwrite', (s) => s.put(rec));
      memory.delete(a);
    } catch {
      memory.set(a, rec); // no IndexedDB (or it refused the key): this tab only
    }
  }

  // Open eagerly, so the sweep above runs on EVERY page load. openDb() is lazy
  // otherwise, and the visitor this matters for is exactly the one whose session has
  // expired: their page never calls get(), put() or remove(), so nothing would open
  // the database and the stale record would live on. openDb() never rejects.
  void openDb();

  return { get, put, remove };
}
