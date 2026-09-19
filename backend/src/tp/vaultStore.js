'use strict';

// The dApp account's encrypted wallet lists: one ciphertext blob per signed-in
// address (spec Addendum v2 A, "Sync"). tp/account.js serves it as
// GET/PUT/DELETE /api/tp/account/vault.
//
// THE SERVER CANNOT READ WHAT IT STORES. The browser encrypts with an AES-GCM key it
// derived from a wallet signature that never leaves the browser; this file keeps
// {v, kv, keyId, iv, ct, rev, updatedAt} and nothing else in the clear. keyId is a
// public HKDF output of that key: equal keyIds mean "the same key", which lets a
// write under a different key be refused (key_mismatch) without anything here being
// able to decrypt.
//
// ON DISK: <TP_ACCOUNTS_DIR>/vaults/0x<40 lower hex>.json (0600, dir 0700) plus a
// one-deep .json.prev — the version before the last write, so one bad overwrite can
// be undone by hand. Paths are built only from a validated lower-case address.
// Every write is tmp + fsync + rename (retried on Windows' transient EPERM/EBUSY) +
// a best-effort directory fsync. <TP_ACCOUNTS_DIR>/revoked.json holds, per address,
// the time its sessions were last revoked (a vault DELETE): a session issued at or
// before it is dead.
//
// NEVER ON THE EVENT LOOP. This store runs in the one pm2 process that also answers
// /api/tp/broadcast, where latency is the only thing that counts (spec). Every disk
// call is async (fs.promises), opening included: nothing here fsyncs, sleeps or
// retries synchronously, so a vault save never stalls a sell click.
//
// ONE WRITE AT A TIME — the write lane. put() and remove() (and with remove the
// revoked.json write) run one after another on a single promise chain: each reads
// the current record, compares its rev and writes, and the next starts only when it
// has finished. That keeps the rev check atomic, as a per-address lock would; being
// store-wide it also keeps the global caps exact and revoked.json whole with no
// reservation bookkeeping, and it keeps at most ONE libuv threadpool thread busy with
// vault I/O, so the other three stay free for the DNS lookups and file reads the rest
// of the server needs. Saves are background work (the page debounces them), so one at
// a time costs nothing a visitor sees. At most MAX_PENDING_WRITES wait in the lane;
// past that a write is 503 'unavailable' at once (the page retries), so a flood cannot
// pile ciphertext up in memory. Reads (get, meta) do not wait for the lane: every
// write is tmp + rename, so a read sees the old record or the new one, never half.
//
// CONCURRENCY: optimistic, on an integer `rev` (0 = no vault). A write names the rev
// it read (baseRev); anything else is 409 conflict carrying the current rev.
// ecosystem.config.js runs exactly one process, so the lane is the only writer.
//
// CAPS (env-tunable): TP_VAULT_MAX_BYTES of ciphertext per vault (256 KiB),
// TP_VAULT_MAX_ACCOUNTS vaults (5000) and TP_VAULT_MAX_TOTAL_BYTES on disk across
// every vault and .prev (512 MiB): SIWE identities cost nothing to make, so without
// global caps the disk could be filled. Tallied once when the store opens (on its
// first use), then kept incrementally.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TpError } = require('./errors');

// Every disk call goes through this object at call time (fsp.rename(...), never a
// destructured copy), so a test can stand in for one of them.
const fsp = fs.promises;

const ENVELOPE_VERSION = 2;
const LOWER_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const KEY_ID_RE = /^0x[0-9a-f]{32}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const VAULT_FILE_RE = /^0x[0-9a-f]{40}\.json(\.prev)?$/;
const PUT_FIELDS = new Set(['baseRev', 'kv', 'keyId', 'iv', 'ct', 'rekey']);
const MAX_REV = 2 ** 31 - 1;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
// A session issued before a revocation is dead anyway once this much time has passed.
const REVOCATION_KEEP_MS = 24 * 3600_000 + 60_000;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Writes waiting in (or running on) the lane before the next one is refused.
const MAX_PENDING_WRITES = 64;

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : d;
};

const VAULT_LIMITS = Object.freeze({
  maxBytes: posInt(process.env.TP_VAULT_MAX_BYTES, 262144),
  maxAccounts: posInt(process.env.TP_VAULT_MAX_ACCOUNTS, 5000),
  maxTotalBytes: posInt(process.env.TP_VAULT_MAX_TOTAL_BYTES, 536870912),
});

const noop = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Buffer of a CANONICAL base64 string (what Buffer#toString('base64') writes), else null. */
function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.toString('base64') === value ? buf : null;
}

/**
 * A PUT body, checked field by field: {baseRev, kv, keyId, iv, ct, rekey?} and nothing
 * else. -> {baseRev, kv, keyId, iv, ct, rekey, bytes} or a TpError (400, or 413 too_large).
 */
function validatePut(body, { maxBytes = VAULT_LIMITS.maxBytes } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TpError('bad_request', 'expected a JSON body {baseRev, kv, keyId, iv, ct}');
  }
  for (const k of Object.keys(body)) {
    if (!PUT_FIELDS.has(k)) throw new TpError('bad_request', `unexpected field "${k.slice(0, 32)}"`);
  }
  const { baseRev, kv, keyId, iv, ct, rekey } = body;
  if (!Number.isSafeInteger(baseRev) || baseRev < 0 || baseRev > MAX_REV) {
    throw new TpError('bad_request', 'baseRev must be the rev you read (0 for a new vault)');
  }
  if (!Number.isSafeInteger(kv) || kv < 1 || kv > 255) throw new TpError('bad_request', 'kv must be an integer 1-255');
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw new TpError('bad_request', 'keyId must be 0x + 32 lower-case hex');
  const ivBytes = canonicalBase64(iv);
  if (!ivBytes || ivBytes.length !== IV_BYTES) throw new TpError('bad_request', 'iv must be 12 bytes of canonical base64');
  if (typeof ct !== 'string') throw new TpError('bad_request', 'ct must be canonical base64');
  if (ct.length > 4 * Math.ceil(maxBytes / 3)) throw new TpError('too_large', `saved wallets are over ${maxBytes} bytes`, 413);
  const ctBytes = canonicalBase64(ct);
  if (!ctBytes || ctBytes.length <= GCM_TAG_BYTES) throw new TpError('bad_request', 'ct must be canonical base64 of an AES-GCM ciphertext');
  if (ctBytes.length > maxBytes) throw new TpError('too_large', `saved wallets are over ${maxBytes} bytes`, 413);
  if (rekey !== undefined && typeof rekey !== 'boolean') throw new TpError('bad_request', 'rekey must be true or false');
  return { baseRev, kv, keyId, iv, ct, rekey: rekey === true, bytes: ctBytes.length };
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err.code) || attempt >= 5) throw err;
      await sleep(10 * 2 ** attempt);
    }
  }
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fsp.open(dir, 'r');
    await fh.sync();
  } catch (_err) {
    // Windows cannot fsync a directory; the rename is still atomic there.
  } finally {
    if (fh) await fh.close().catch(noop);
  }
}

/**
 * tmp (O_EXCL, 0600) + fsync + rename over `file` + directory fsync, all async.
 * Never leaves the tmp behind.
 */
async function writeFileAtomic(file, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.unlink(tmp).catch(noop); // already renamed, or never created
    throw err;
  }
  await fsyncDir(path.dirname(file));
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** The size of `file`, or null when there is none. */
async function sizeOrNull(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Disk errors become 503 'unavailable' (logged); a TpError passes through untouched. */
async function guarded(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TpError) throw err;
    console.error(`[tp] vault store ${what} failed: ${err && err.message ? err.message : String(err)}`);
    throw new TpError('unavailable', 'saved wallets are unavailable right now — try again', 503);
  }
}

/**
 * The store under `dir`. Creating it touches nothing: the directory is made, swept
 * and tallied on first use (async), and a failed open is tried again next time.
 * Every method but `limits` returns a Promise; disk failures reject with 503
 * 'unavailable', a bad address with a TypeError.
 *
 * get(address)                  -> {v, kv, keyId, iv, ct, rev, updatedAt} | null
 * meta(address)                 -> {rev, updatedAt, keyId, bytes} | null
 * put(address, validated, {beforeCreate?}) -> {rev, updatedAt, created}
 *     (validated = validatePut(body)); beforeCreate() runs inside the lane, only for a
 *     write that is about to CREATE a vault, after every check has passed — it may
 *     throw (a TpError) to refuse it, and then nothing is written
 * remove(address, baseRev)      -> {deleted}   — also revokes every session of `address`
 * notBefore(address)            -> ms: sessions issued at or before it are revoked (0 = none)
 * stats()                       -> {accounts, totalBytes}
 * limits                        -> {maxBytes, maxAccounts, maxTotalBytes} in force
 */
function createVaultStore({ dir, limits = {}, now = Date.now, maxPending = MAX_PENDING_WRITES } = {}) {
  if (!dir) throw new TypeError('createVaultStore: dir is required');
  const lim = { ...VAULT_LIMITS, ...limits };
  const root = path.resolve(dir);
  const vaultDir = path.join(root, 'vaults');
  const revokedFile = path.join(root, 'revoked.json');

  let accounts = 0;
  let totalBytes = 0;
  const revoked = new Map(); // lower address -> ms

  // Open: make the directory, sweep tmp files a crash left behind, tally what is on
  // disk and load the revocations. Once; a failure is retried by the next call.
  async function openStore() {
    await fsp.mkdir(vaultDir, { recursive: true, mode: 0o700 });
    let n = 0;
    let bytes = 0;
    for (const ent of await fsp.readdir(vaultDir, { withFileTypes: true })) {
      const p = path.join(vaultDir, ent.name);
      if (ent.name.endsWith('.tmp')) {
        await fsp.unlink(p).catch(noop); // a sweep is best effort
        continue;
      }
      if (!ent.isFile() || !VAULT_FILE_RE.test(ent.name)) continue;
      bytes += (await fsp.stat(p)).size;
      if (ent.name.endsWith('.json')) n += 1;
    }
    for (const name of await fsp.readdir(root)) {
      if (name.startsWith('revoked.json.') && name.endsWith('.tmp')) await fsp.unlink(path.join(root, name)).catch(noop);
    }
    const loaded = new Map();
    const rawRevoked = await readIfExists(revokedFile);
    if (rawRevoked) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawRevoked.toString('utf8'));
      } catch (_err) {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [a, t] of Object.entries(parsed)) {
          if (LOWER_ADDRESS_RE.test(a) && Number.isSafeInteger(t) && t > 0) loaded.set(a, t);
        }
      }
    }
    accounts = n;
    totalBytes = bytes;
    for (const [a, t] of loaded) revoked.set(a, t);
  }
  let opening = null;
  function ready() {
    if (!opening) {
      opening = openStore().catch((err) => {
        opening = null;
        throw err;
      });
    }
    return opening;
  }

  // The write lane (see the header): one write at a time, store-wide.
  let lane = Promise.resolve();
  let pending = 0;
  function inLane(what, fn) {
    if (pending >= maxPending) {
      return Promise.reject(new TpError('unavailable', 'saved wallets are busy right now — try again in a moment', 503));
    }
    pending += 1;
    const run = lane.then(() =>
      guarded(what, async () => {
        await ready();
        return fn();
      })
    );
    lane = run.then(noop, noop);
    return run.finally(() => {
      pending -= 1;
    });
  }

  function lower(address) {
    const a = String(address).toLowerCase();
    if (!LOWER_ADDRESS_RE.test(a)) throw new TypeError('vaultStore: not an address');
    return a;
  }
  const fileFor = (a) => path.join(vaultDir, `${a}.json`);

  function parseRecord(raw, file) {
    let rec;
    try {
      rec = JSON.parse(raw.toString('utf8'));
    } catch (_err) {
      throw new Error(`${path.basename(file)} is not JSON`);
    }
    if (!rec || !Number.isSafeInteger(rec.rev) || rec.rev < 1 || typeof rec.ct !== 'string' || typeof rec.keyId !== 'string') {
      throw new Error(`${path.basename(file)} is not a vault record`);
    }
    return rec;
  }

  async function current(a) {
    const file = fileFor(a);
    const raw = await readIfExists(file);
    return { file, raw, record: raw ? parseRecord(raw, file) : null };
  }

  const conflict = (rev) =>
    new TpError('conflict', 'your saved wallets changed on another device — reload them and try again', 409, { rev });
  const storeFull = () =>
    new TpError('store_full', 'this server holds all the saved wallet lists it can — try again later', 507);

  async function get(address) {
    const a = lower(address);
    return guarded('read', async () => {
      await ready();
      const { record } = await current(a);
      if (!record) return null;
      const { v, kv, keyId, iv, ct, rev, updatedAt } = record;
      return { v, kv, keyId, iv, ct, rev, updatedAt };
    });
  }

  async function meta(address) {
    const r = await get(address);
    return r ? { rev: r.rev, updatedAt: r.updatedAt, keyId: r.keyId, bytes: Buffer.byteLength(r.ct, 'base64') } : null;
  }

  async function put(address, input, { beforeCreate } = {}) {
    const a = lower(address);
    return inLane('write', async () => {
      const { file, raw: oldRaw, record: old } = await current(a);
      const rev = old ? old.rev : 0;
      if (input.baseRev !== rev) throw conflict(rev);
      if (old && old.keyId !== input.keyId && !input.rekey) {
        throw new TpError('key_mismatch', 'these saved wallets were locked with a different key — nothing changed', 409);
      }
      const record = { v: ENVELOPE_VERSION, kv: input.kv, keyId: input.keyId, iv: input.iv, ct: input.ct, rev: rev + 1, updatedAt: now() };
      const raw = Buffer.from(JSON.stringify(record), 'utf8');
      const prevFile = `${file}.prev`;
      const oldPrevSize = old ? (await sizeOrNull(prevFile)) || 0 : 0;
      // After: cur = new, prev = the old cur (or the untouched old prev when creating).
      const delta = old ? raw.length - oldPrevSize : raw.length;
      if (!old && accounts >= lim.maxAccounts) throw storeFull();
      if (delta > 0 && totalBytes + delta > lim.maxTotalBytes) throw storeFull();
      if (!old && beforeCreate) beforeCreate();
      // Each tally update follows the write it accounts for: a failure between the two
      // writes leaves the files and the tally consistent.
      if (old) {
        await writeFileAtomic(prevFile, oldRaw);
        totalBytes += oldRaw.length - oldPrevSize;
      }
      await writeFileAtomic(file, raw);
      totalBytes += raw.length - (old ? oldRaw.length : 0);
      if (!old) accounts += 1;
      return { rev: record.rev, updatedAt: record.updatedAt, created: !old };
    });
  }

  // Runs inside the lane only (remove), so two revocations never race for the file.
  async function persistRevoked() {
    const t = now();
    for (const [a, at] of revoked) if (at < t - REVOCATION_KEEP_MS) revoked.delete(a);
    await writeFileAtomic(revokedFile, JSON.stringify(Object.fromEntries(revoked)));
  }

  async function remove(address, baseRev) {
    const a = lower(address);
    return inLane('delete', async () => {
      const { file, raw: oldRaw, record: old } = await current(a);
      const rev = old ? old.rev : 0;
      if (baseRev !== rev) throw conflict(rev);
      // Revoke first: if that cannot be written, nothing is deleted.
      revoked.set(a, now());
      await persistRevoked();
      const prevFile = `${file}.prev`;
      const prevSize = await sizeOrNull(prevFile);
      if (prevSize !== null) {
        await fsp.unlink(prevFile);
        totalBytes -= prevSize;
      }
      if (!old) return { deleted: false };
      await fsp.unlink(file);
      totalBytes -= oldRaw.length;
      accounts -= 1;
      await fsyncDir(vaultDir);
      return { deleted: true };
    });
  }

  async function notBefore(address) {
    const a = lower(address);
    await guarded('open', ready);
    const t = revoked.get(a);
    if (!t) return 0;
    return t < now() - REVOCATION_KEEP_MS ? 0 : t;
  }

  async function stats() {
    await guarded('open', ready);
    return { accounts, totalBytes };
  }

  return { get, meta, put, remove, notBefore, stats, limits: Object.freeze(lim) };
}

module.exports = {
  createVaultStore,
  validatePut,
  canonicalBase64,
  writeFileAtomic,
  VAULT_LIMITS,
  ENVELOPE_VERSION,
  MAX_PENDING_WRITES,
};
