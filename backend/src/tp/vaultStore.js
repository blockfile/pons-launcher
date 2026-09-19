'use strict';

// The dApp account's encrypted wallet lists: one ciphertext blob per signed-in
// address (spec Addendum v2 A, "Sync"). tp/account.js serves it as
// GET/PUT/DELETE /api/tp/account/vault.
//
// THE SERVER CANNOT READ WHAT IT STORES. The browser encrypts with an AES-GCM key it
// derived from a wallet signature that never leaves the browser; this file keeps
// {v, kv, keyId, iv, ct, rev, updatedAt} in the clear, plus `writer` (the issue time
// of the session that wrote the version: a timestamp, never returned). keyId is a
// public HKDF output of that key: equal keyIds mean "the same key", which lets a
// write under a different key be refused (key_mismatch) without anything here being
// able to decrypt. There is NO override: the only way to store a list under a new
// key is DELETE, then create.
//
// A SESSION CAN DAMAGE A LIST, BUT NOT DESTROY IT. Anyone holding a session for an
// address (a phished login signature included) can overwrite its list with garbage
// under the same keyId (keyId is public to the session) or delete it. So:
//   - the one-deep .prev keeps the list AS IT STOOD BEFORE THE CURRENT SESSION BEGAN
//     WRITING: a write rotates the outgoing version into .prev only when a DIFFERENT
//     session wrote that version (or there is no .prev yet). One session, however
//     many writes, cannot push the older copy out of .prev;
//   - a DELETE moves the list and its .prev into deleted/ and keeps them there for
//     TP_VAULT_KEEP_DELETED_DAYS (30; 0 = erase at once). At most two deletions of an
//     address are kept inside that window: the FIRST, which nothing replaces, so
//     deleting again cannot flush it, and the LATEST, which each new deletion
//     replaces, so a list made after the first deletion is kept by its own. A DELETE
//     also revokes every session of the address (a new one needs a new login
//     signature), so losing a list takes two phished sign-ins, one after the other
//     (delete it; then save and delete again), the same bar as pushing the owner's
//     copy out of .prev.
// Restoring is by hand, on the server (README "Take-profit dApp": cp + pm2 restart).
//
// ON DISK, under <TP_ACCOUNTS_DIR> (0700 directories, 0600 files):
//   vaults/0x<40 lower hex>.json         the list
//   vaults/0x<40 lower hex>.json.prev    the copy before the current session's writes
//   deleted/0x<40 lower hex>.<ms>/       a deleted list: the same two files, as they
//                                        were, copied in whole (<ms> = deletion time;
//                                        at most two per address, first and latest)
//   revoked.log                          one appended line per revocation, last wins
//   revoked.json                         the compacted snapshot the log is replayed over
// Paths are built only from a validated lower-case address. Every write is tmp +
// fsync + rename (retried on Windows' transient EPERM/EBUSY) + a best-effort
// directory fsync; a deleted/ entry is built under a .tmp name and renamed in whole.
//
// A REVOCATION IS AN O(1) WRITE. revoked.log takes ONE ~60-byte line per DELETE
// (open 'a' + write + fsync), so the cost of a DELETE does not grow with the number of
// addresses that deleted before it. SIWE identities are free, and a no-op DELETE
// (nothing stored) still signs the address out, so rewriting the whole map each time
// was quadratic: at 10 logins/min/IP one attacker parked ~14k revocations a day and
// every later DELETE stringified all of them ON THE EVENT LOOP (measured: 132 ms at
// 144k entries, against 1.4 ms for the largest PUT the design allows). The log is
// compacted into revoked.json — the pruned map, written whole — only when it passes
// TP_VAULT_REVOKED_LOG_MAX_BYTES (1 MiB, ~17k lines), and the snapshot is written
// before the log is unlinked, so a crash between the two only replays what the
// snapshot already holds.
//
// NEVER ON THE EVENT LOOP. This store runs in the one pm2 process that also answers
// /api/tp/broadcast, where latency is the only thing that counts (spec). Every disk
// call is async (fs.promises), opening included: nothing here fsyncs, sleeps or
// retries synchronously, so a vault save never stalls a sell click.
//
// ONE WRITE AT A TIME: the write lane. put(), remove() (and with remove the
// revocation write) and the erasing of expired deleted copies run one after
// another on a single promise chain: each reads the current record, compares its rev
// and writes, and the next starts only when it has finished. That keeps the rev
// check atomic, as a per-address lock would; being store-wide it also keeps the
// global caps exact and the revocation file whole with no reservation bookkeeping, and it
// keeps at most ONE libuv threadpool thread busy with vault I/O, so the other three
// stay free for the DNS lookups and file reads the rest of the server needs. Saves
// are background work (the page debounces them), so one at a time costs nothing a
// visitor sees. At most MAX_PENDING_WRITES wait in the lane; past that a write is
// 503 'unavailable' at once (the page retries), so a flood cannot pile ciphertext up
// in memory. Reads (get, meta) do not wait for the lane: every write is tmp +
// rename, so a read sees the old record or the new one, never half. (A read waits
// only when a kept deleted copy has expired: the erase runs in the lane first.)
//
// CONCURRENCY: optimistic, on an integer `rev` (0 = no vault). A write names the rev
// it read (baseRev); anything else is 409 conflict carrying the current rev.
// ecosystem.config.js runs exactly one process, so the lane is the only writer.
//
// CAPS (env-tunable): TP_VAULT_MAX_BYTES of ciphertext per vault (256 KiB),
// TP_VAULT_MAX_ACCOUNTS vaults (5000) and TP_VAULT_MAX_TOTAL_BYTES on disk across
// every vault, .prev and kept deleted copy (512 MiB): SIWE identities cost nothing
// to make, so without global caps the disk could be filled. Tallied once when the
// store opens (on its first use), then kept incrementally.
//
// TOMBSTONES HAVE THEIR OWN BUDGET. The total splits in two: deleted/ may hold
// TP_VAULT_MAX_DELETED_BYTES (a quarter of the total, 64 MiB), and LIVE vaults and
// their .prev files have the rest. A live save is therefore never refused for room
// another address's deleted copies are holding — before the split, ~768 free
// identities that each created, saved and deleted a max-size list parked the whole
// 512 MiB for TP_VAULT_KEEP_DELETED_DAYS and every later save answered 507. A DELETE
// is still never refused for space: when its copy does not fit, expired copies are
// erased first and then the oldest copies that can be spared — an address's LATEST
// copy before anyone's FIRST, so the copy a victim can never replace is the last
// thing to go.

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
const DELETED_DIR_RE = /^(0x[0-9a-f]{40})\.([0-9]{1,15})$/;
const PUT_FIELDS = new Set(['baseRev', 'kv', 'keyId', 'iv', 'ct']);
const MAX_REV = 2 ** 31 - 1;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DAY_MS = 24 * 3600_000;
// A session issued before a revocation is dead anyway once this much time has passed.
const REVOCATION_KEEP_MS = DAY_MS + 60_000;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Writes waiting in (or running on) the lane before the next one is refused.
const MAX_PENDING_WRITES = 64;
// revoked.log is compacted into revoked.json past this (~17k lines).
const REVOKED_LOG_MAX_BYTES = 1024 * 1024;

const posInt = (v, d) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : d;
};
const days = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 && n <= 3650 ? n : d;
};

const MAX_TOTAL_BYTES = posInt(process.env.TP_VAULT_MAX_TOTAL_BYTES, 536870912);
// Of the total, what deleted/ may hold; the live vaults have the rest.
const deletedShare = (total) => Math.floor(total / 4);

const VAULT_LIMITS = Object.freeze({
  maxBytes: posInt(process.env.TP_VAULT_MAX_BYTES, 262144),
  maxAccounts: posInt(process.env.TP_VAULT_MAX_ACCOUNTS, 5000),
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxDeletedBytes: posInt(process.env.TP_VAULT_MAX_DELETED_BYTES, deletedShare(MAX_TOTAL_BYTES)),
  keepDeletedMs: days(process.env.TP_VAULT_KEEP_DELETED_DAYS, 30) * DAY_MS,
  revokedLogMaxBytes: posInt(process.env.TP_VAULT_REVOKED_LOG_MAX_BYTES, REVOKED_LOG_MAX_BYTES),
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
 * A PUT body, checked field by field: {baseRev, kv, keyId, iv, ct} and nothing else
 * (there is no `rekey`). -> {baseRev, kv, keyId, iv, ct, bytes} or a TpError (400, or
 * 413 too_large).
 */
function validatePut(body, { maxBytes = VAULT_LIMITS.maxBytes } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TpError('bad_request', 'expected a JSON body {baseRev, kv, keyId, iv, ct}');
  }
  for (const k of Object.keys(body)) {
    if (!PUT_FIELDS.has(k)) throw new TpError('bad_request', `unexpected field "${k.slice(0, 32)}"`);
  }
  const { baseRev, kv, keyId, iv, ct } = body;
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
  return { baseRev, kv, keyId, iv, ct, bytes: ctBytes.length };
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

/** Bytes of the regular files directly inside `dir`. */
async function dirBytes(dir) {
  let n = 0;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    if (ent.isFile()) n += (await fsp.stat(path.join(dir, ent.name))).size;
  }
  return n;
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
 * The store under `dir`. Creating it touches nothing: the directories are made,
 * swept and tallied on first use (async), and a failed open is tried again next
 * time. Every method but `limits` returns a Promise; disk failures reject with 503
 * 'unavailable', a bad address with a TypeError.
 *
 * get(address)                  -> {v, kv, keyId, iv, ct, rev, updatedAt} | null
 * meta(address)                 -> {rev, updatedAt, keyId, bytes} | null
 * put(address, validated, {writer, beforeCreate?}) -> {rev, updatedAt, created}
 *     validated = validatePut(body); writer = the writing session's issuedAt (ms).
 *     beforeCreate() runs inside the lane, only for a write that is about to CREATE a
 *     vault, after every check has passed; it may throw (a TpError) to refuse it,
 *     and then nothing is written
 * remove(address, baseRev, {writer}) -> {deleted}: keeps a deleted copy (as the latest of
 *                                  at most two), revokes every session of `address`
 * notBefore(address)            -> ms: sessions issued at or before it are revoked (0 = none)
 * deletedCopies(address)        -> [{deletedAt, dir}] of the kept deleted copies, oldest
 *                                  first (none: [])
 * stats()                       -> {accounts, totalBytes, liveBytes, deletedBytes, deleted}
 * limits                        -> the caps in force
 *
 * put() and remove() also refuse, inside the lane, a write whose session was revoked
 * while it waited: `requireSession` can only read the revocations as they stood when
 * the request arrived, and the lane is store-wide and FIFO, so any write admitted
 * while a DELETE was still QUEUED would otherwise run after it under a session that
 * DELETE has revoked (401 no_session; the cookie is cleared by the next request's
 * requireSession, which is the only place that holds the response).
 */
function createVaultStore({ dir, limits = {}, now = Date.now, maxPending = MAX_PENDING_WRITES } = {}) {
  if (!dir) throw new TypeError('createVaultStore: dir is required');
  const lim = { ...VAULT_LIMITS, ...limits };
  // A caller that narrows the total without saying what deleted/ may have gets the
  // same share of it that the defaults give.
  if (limits.maxDeletedBytes === undefined && limits.maxTotalBytes !== undefined) {
    lim.maxDeletedBytes = deletedShare(lim.maxTotalBytes);
  }
  const liveBudget = Math.max(0, lim.maxTotalBytes - lim.maxDeletedBytes);
  const root = path.resolve(dir);
  const vaultDir = path.join(root, 'vaults');
  const deletedDir = path.join(root, 'deleted');
  const revokedFile = path.join(root, 'revoked.json');
  const revokedLog = path.join(root, 'revoked.log');

  let accounts = 0;
  let liveBytes = 0; // vaults/ (every .json and .json.prev)
  let deletedBytes = 0; // deleted/ (the kept copies)
  let revokedLogBytes = 0;
  const revoked = new Map(); // lower address -> ms
  const deleted = new Map(); // deleted/ dir name -> {address, deletedAt, bytes}
  let nextPurgeAt = Infinity;

  // Open: make the directories, sweep tmp files a crash left behind, tally what is on
  // disk, load the revocations and erase expired deleted copies. Once; a failure is
  // retried by the next call.
  async function openStore() {
    await fsp.mkdir(vaultDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(deletedDir, { recursive: true, mode: 0o700 });
    let n = 0;
    let live = 0;
    let gone = 0;
    for (const ent of await fsp.readdir(vaultDir, { withFileTypes: true })) {
      const p = path.join(vaultDir, ent.name);
      if (ent.name.endsWith('.tmp')) {
        await fsp.unlink(p).catch(noop); // a sweep is best effort
        continue;
      }
      if (!ent.isFile() || !VAULT_FILE_RE.test(ent.name)) continue;
      live += (await fsp.stat(p)).size;
      if (ent.name.endsWith('.json')) n += 1;
    }
    const kept = new Map();
    for (const ent of await fsp.readdir(deletedDir, { withFileTypes: true })) {
      const p = path.join(deletedDir, ent.name);
      if (ent.name.endsWith('.tmp')) {
        await fsp.rm(p, { recursive: true, force: true }).catch(noop);
        continue;
      }
      const m = DELETED_DIR_RE.exec(ent.name);
      if (!m || !ent.isDirectory()) continue;
      const size = await dirBytes(p);
      kept.set(ent.name, { address: m[1], deletedAt: Number(m[2]), bytes: size });
      gone += size;
    }
    for (const name of await fsp.readdir(root)) {
      if (name.startsWith('revoked.json.') && name.endsWith('.tmp')) await fsp.unlink(path.join(root, name)).catch(noop);
    }
    // The compacted snapshot first, then the log replayed over it (last line wins).
    const loaded = new Map();
    const takeEntry = (a, t) => {
      if (LOWER_ADDRESS_RE.test(a) && Number.isSafeInteger(t) && t > 0) loaded.set(a, t);
    };
    const rawRevoked = await readIfExists(revokedFile);
    if (rawRevoked) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawRevoked.toString('utf8'));
      } catch (_err) {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [a, t] of Object.entries(parsed)) takeEntry(a, t);
      }
    }
    const rawLog = await readIfExists(revokedLog);
    revokedLogBytes = rawLog ? rawLog.length : 0;
    if (rawLog) {
      for (const line of rawLog.toString('utf8').split('\n')) {
        if (!line) continue;
        let entry = null;
        try {
          entry = JSON.parse(line);
        } catch (_err) {
          continue; // a torn last line: the rest of the log still counts
        }
        if (entry && typeof entry === 'object') takeEntry(entry.a, entry.t);
      }
    }
    accounts = n;
    liveBytes = live;
    deletedBytes = gone;
    for (const [a, t] of loaded) revoked.set(a, t);
    pruneRevoked();
    for (const [name, d] of kept) deleted.set(name, d);
    await purgeExpired();
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

  /** Erase one kept deleted copy; the tally follows only once it is gone. */
  async function eraseKept(name) {
    const d = deleted.get(name);
    await fsp.rm(path.join(deletedDir, name), { recursive: true, force: true });
    deleted.delete(name);
    deletedBytes -= d.bytes;
  }

  /** Erase every kept deleted copy older than keepDeletedMs (all of them at 0). */
  async function purgeExpired() {
    const cutoff = now() - lim.keepDeletedMs;
    let erased = false;
    nextPurgeAt = Infinity;
    for (const [name, d] of [...deleted]) {
      if (lim.keepDeletedMs > 0 && d.deletedAt > cutoff) {
        nextPurgeAt = Math.min(nextPurgeAt, d.deletedAt + lim.keepDeletedMs);
        continue;
      }
      await eraseKept(name);
      erased = true;
    }
    if (erased) await fsyncDir(deletedDir);
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

  /** Before a read: erase what expired, in the lane, when something has. Never fails the read. */
  async function maybePurge() {
    await guarded('open', ready);
    if (now() < nextPurgeAt) return;
    await inLane('purge', async () => {
      if (now() >= nextPurgeAt) await purgeExpired();
    }).catch(noop); // guarded() logged a disk failure; a full lane just waits for next time
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
    await maybePurge();
    return guarded('read', async () => {
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

  /**
   * A session that a DELETE revoked while this write waited in the lane. Read straight
   * from the map, not through notBefore(): that ages a revocation out after
   * REVOCATION_KEEP_MS, and here stricter is right (pruneRevoked keeps the map bounded
   * on the same schedule, so nothing grows).
   */
  function refuseRevoked(a, writer) {
    if (writer <= (revoked.get(a) || 0)) throw new TpError('no_session', 'not signed in', 401);
  }

  function requireWriter(what, writer) {
    if (!Number.isSafeInteger(writer) || writer <= 0) {
      throw new TypeError(`vaultStore.${what}: writer must be the session issue time (ms)`);
    }
  }

  async function put(address, input, { writer, beforeCreate } = {}) {
    const a = lower(address);
    requireWriter('put', writer);
    return inLane('write', async () => {
      refuseRevoked(a, writer);
      if (now() >= nextPurgeAt) await purgeExpired();
      const { file, raw: oldRaw, record: old } = await current(a);
      const rev = old ? old.rev : 0;
      if (input.baseRev !== rev) throw conflict(rev);
      if (old && old.keyId !== input.keyId) {
        throw new TpError('key_mismatch', 'these saved wallets were locked with a different key — nothing changed', 409);
      }
      const record = {
        v: ENVELOPE_VERSION,
        kv: input.kv,
        keyId: input.keyId,
        iv: input.iv,
        ct: input.ct,
        rev: rev + 1,
        updatedAt: now(),
        writer,
      };
      const raw = Buffer.from(JSON.stringify(record), 'utf8');
      const prevFile = `${file}.prev`;
      const oldPrevSize = old ? (await sizeOrNull(prevFile)) || 0 : 0;
      // .prev takes the outgoing version only when ANOTHER session wrote it (or there
      // is no .prev yet): a session's own writes never push the older copy out.
      const rotate = Boolean(old) && (oldPrevSize === 0 || old.writer !== writer);
      let delta = raw.length - (old ? oldRaw.length : 0);
      if (rotate) delta += oldRaw.length - oldPrevSize;
      if (!old && accounts >= lim.maxAccounts) throw storeFull();
      // Only what is LIVE is charged here: another address's deleted copies have their
      // own budget and can never refuse this save.
      if (delta > 0 && liveBytes + delta > liveBudget) throw storeFull();
      if (!old && beforeCreate) beforeCreate();
      // Each tally update follows the write it accounts for: a failure between the two
      // writes leaves the files and the tally consistent.
      if (rotate) {
        await writeFileAtomic(prevFile, oldRaw);
        liveBytes += oldRaw.length - oldPrevSize;
      }
      await writeFileAtomic(file, raw);
      liveBytes += raw.length - (old ? oldRaw.length : 0);
      if (!old) accounts += 1;
      return { rev: record.rev, updatedAt: record.updatedAt, created: !old };
    });
  }

  /** Forget revocations older than any session that could still be live. */
  function pruneRevoked() {
    const t = now();
    for (const [a, at] of revoked) if (at < t - REVOCATION_KEEP_MS) revoked.delete(a);
  }

  /**
   * Runs inside the lane only (remove), so two revocations never race for the file.
   * ONE appended line, whatever the size of the map: see the header. The whole map is
   * written only when the log has grown past its cap, and the snapshot lands before
   * the log goes, so a crash in between replays lines the snapshot already holds.
   */
  async function persistRevoked(a, t) {
    const line = `${JSON.stringify({ a, t })}\n`;
    if (revokedLogBytes + line.length > lim.revokedLogMaxBytes) {
      pruneRevoked();
      await writeFileAtomic(revokedFile, JSON.stringify(Object.fromEntries(revoked)));
      await fsp.unlink(revokedLog).catch(noop);
      revokedLogBytes = 0;
      return;
    }
    const fresh = revokedLogBytes === 0;
    const fh = await fsp.open(revokedLog, 'a', 0o600);
    try {
      await fh.writeFile(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
    revokedLogBytes += line.length;
    if (fresh) await fsyncDir(root);
  }

  /** The kept deleted copies of `a`, oldest first. */
  function keptFor(a) {
    const out = [];
    for (const [name, d] of deleted) if (d.address === a) out.push({ name, ...d });
    return out.sort((x, y) => x.deletedAt - y.deletedAt);
  }

  /**
   * Room in the deleted budget for `bytes`, so a DELETE is never refused for space:
   * expired copies first, then the oldest copies that can be spared. An address's
   * LATEST copy goes before anyone's FIRST, because the first is the one nothing
   * replaces — the copy a victim of a stolen session still has. A copy larger than
   * the whole budget is kept anyway (one over is better than losing the list).
   */
  async function makeDeletedRoom(bytes) {
    if (deletedBytes + bytes <= lim.maxDeletedBytes) return;
    await purgeExpired();
    if (deletedBytes + bytes <= lim.maxDeletedBytes) return;
    const byAddress = new Map();
    for (const [name, d] of deleted) {
      const mine = byAddress.get(d.address) || [];
      mine.push({ name, ...d });
      byAddress.set(d.address, mine);
    }
    const order = [];
    for (const mine of byAddress.values()) {
      mine.sort((x, y) => x.deletedAt - y.deletedAt);
      for (const d of mine.slice(1)) order.push({ name: d.name, deletedAt: d.deletedAt, spare: 0 });
      order.push({ name: mine[0].name, deletedAt: mine[0].deletedAt, spare: 1 });
    }
    order.sort((x, y) => x.spare - y.spare || x.deletedAt - y.deletedAt);
    let erased = 0;
    let freed = 0;
    for (const d of order) {
      if (deletedBytes + bytes <= lim.maxDeletedBytes) break;
      freed += deleted.get(d.name).bytes;
      await eraseKept(d.name);
      erased += 1;
    }
    if (erased) {
      await fsyncDir(deletedDir);
      // No address: this line is for the operator's disk, not for tracing a visitor.
      console.error(`[tp] vault store: deleted/ is full — erased ${erased} kept copy(ies), ${freed} bytes`);
    }
  }

  /**
   * Copy the list and its .prev into deleted/<a>.<ms>/, in whole (built under a .tmp
   * name). Two deletions of one address in one millisecond get <ms> and <ms + 1>.
   */
  async function keepDeleted(a, curRaw, prevRaw) {
    await makeDeletedRoom((curRaw ? curRaw.length : 0) + (prevRaw ? prevRaw.length : 0));
    let deletedAt = now();
    while (deleted.has(`${a}.${deletedAt}`)) deletedAt += 1;
    const name = `${a}.${deletedAt}`;
    const tmp = path.join(deletedDir, `${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.mkdir(tmp, { mode: 0o700 });
    try {
      if (curRaw) await writeFileAtomic(path.join(tmp, `${a}.json`), curRaw);
      if (prevRaw) await writeFileAtomic(path.join(tmp, `${a}.json.prev`), prevRaw);
      await renameWithRetry(tmp, path.join(deletedDir, name));
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(noop);
      throw err;
    }
    await fsyncDir(deletedDir);
    const bytes = (curRaw ? curRaw.length : 0) + (prevRaw ? prevRaw.length : 0);
    deleted.set(name, { address: a, deletedAt, bytes });
    deletedBytes += bytes;
    nextPurgeAt = Math.min(nextPurgeAt, deletedAt + lim.keepDeletedMs);
  }

  async function remove(address, baseRev, { writer } = {}) {
    const a = lower(address);
    requireWriter('remove', writer);
    return inLane('delete', async () => {
      refuseRevoked(a, writer);
      const { file, raw: oldRaw, record: old } = await current(a);
      const rev = old ? old.rev : 0;
      if (baseRev !== rev) throw conflict(rev);
      // Revoke first: if that cannot be written, nothing is deleted.
      const at = now();
      revoked.set(a, at);
      await persistRevoked(a, at);
      await purgeExpired();
      const prevFile = `${file}.prev`;
      const prevRaw = await readIfExists(prevFile);
      if (!old && !prevRaw) return { deleted: false };
      // Two deleted copies of an address are kept inside the window: the FIRST and the
      // LATEST. This one becomes the latest, and the one it replaces is erased only once
      // this copy is safely down (and before the list itself goes, so a failure here
      // loses nothing). So deleting again (a stolen session, once more) cannot flush the
      // first, and a list made after the first deletion is kept by its own deletion:
      // losing it takes one more sign-in, a new list and another delete.
      if (lim.keepDeletedMs > 0) {
        const kept = keptFor(a);
        await keepDeleted(a, oldRaw, prevRaw);
        // Every copy but the first: one, or more after a delete that failed right here.
        for (const d of kept.slice(1)) await eraseKept(d.name);
        if (kept.length > 1) await fsyncDir(deletedDir);
      }
      if (prevRaw) {
        await fsp.unlink(prevFile);
        liveBytes -= prevRaw.length;
      }
      if (old) {
        await fsp.unlink(file);
        liveBytes -= oldRaw.length;
        accounts -= 1;
      }
      await fsyncDir(vaultDir);
      return { deleted: Boolean(old) };
    });
  }

  async function notBefore(address) {
    const a = lower(address);
    await guarded('open', ready);
    const t = revoked.get(a);
    if (!t) return 0;
    return t < now() - REVOCATION_KEEP_MS ? 0 : t;
  }

  async function deletedCopies(address) {
    const a = lower(address);
    await maybePurge();
    return keptFor(a).map((d) => ({ deletedAt: d.deletedAt, dir: path.join(deletedDir, d.name) }));
  }

  async function stats() {
    await guarded('open', ready);
    return { accounts, totalBytes: liveBytes + deletedBytes, liveBytes, deletedBytes, deleted: deleted.size };
  }

  return { get, meta, put, remove, notBefore, deletedCopies, stats, limits: Object.freeze(lim) };
}

module.exports = {
  createVaultStore,
  validatePut,
  canonicalBase64,
  writeFileAtomic,
  VAULT_LIMITS,
  ENVELOPE_VERSION,
  MAX_PENDING_WRITES,
  REVOKED_LOG_MAX_BYTES,
};
