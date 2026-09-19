'use strict';

// tp/vaultStore.js: ciphertext blobs per address — validation, atomic 0600 writes,
// optimistic concurrency, the keyId guard (no override), the session-scoped .prev,
// the kept deleted copies, the global caps, the session revocations, and the write
// lane: every disk call is async, one write runs at a time, and nothing waits on the
// event loop. The "ciphertext" here is random bytes: the store never looks inside
// it, so nothing real is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVaultStore, validatePut, canonicalBase64, writeFileAtomic, VAULT_LIMITS, MAX_PENDING_WRITES } = require('./vaultStore');
const { TpError } = require('./errors');

const T0 = Date.parse('2026-09-19T12:00:00.000Z');
const DAY = 24 * 3600_000;
const POSIX = process.platform !== 'win32';

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-vault-'));
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const addr = () => `0x${crypto.randomBytes(20).toString('hex')}`;
const keyId = () => `0x${crypto.randomBytes(16).toString('hex')}`;
const b64 = (n) => crypto.randomBytes(n).toString('base64');
const turn = () => new Promise((resolve) => setImmediate(resolve));

const KEY_A = keyId();
const KEY_B = keyId();
// Two sessions of one address: the writer is the session's issue time (ms).
const S1 = T0 - 60_000;
const S2 = T0 - 30_000;
const BY_S1 = { writer: S1 };
const BY_S2 = { writer: S2 };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A PUT body with `ctBytes` random bytes of stand-in ciphertext. */
function body({ ctBytes = 200, ...over } = {}) {
  return { baseRev: 0, kv: 1, keyId: KEY_A, iv: b64(12), ct: b64(ctBytes), ...over };
}

function open(dir, extra = {}) {
  const clock = extra.clock || { t: T0 };
  return { store: createVaultStore({ dir, now: () => clock.t, limits: extra.limits, maxPending: extra.maxPending }), clock };
}

function refusal(fn, code, status) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TpError, `expected TpError ${code}, got ${caught && caught.message}`);
  assert.equal(caught.code, code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

async function rejection(promise, code, status) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof TpError, `expected TpError ${code}, got ${caught && caught.message}`);
  assert.equal(caught.code, code);
  if (status) assert.equal(caught.status, status);
  return caught;
}

/** fs.promises.rename held until release() — a disk that has not answered yet. */
function holdRenames(t) {
  const real = fs.promises.rename;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const held = { calls: 0, release: () => release() };
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    held.calls += 1;
    await gate;
    return real(from, to);
  });
  return held;
}

// ── validation ───────────────────────────────────────────────────────────────
test('the default caps: 256 KiB a vault, 5000 vaults, 512 MiB in total, deleted copies kept 30 days; 64 writes may wait', { skip: Object.keys(process.env).some((k) => k.startsWith('TP_VAULT_')) && 'a TP_VAULT_* setting is set' }, () => {
  assert.deepEqual({ ...VAULT_LIMITS }, { maxBytes: 262144, maxAccounts: 5000, maxTotalBytes: 536870912, keepDeletedMs: 30 * DAY });
  assert.equal(MAX_PENDING_WRITES, 64);
});

test('canonicalBase64: only what Buffer#toString("base64") would write', () => {
  assert.deepEqual(canonicalBase64('AAA='), Buffer.from([0, 0]));
  assert.equal(canonicalBase64('AAB='), null, 'non-zero padding bits');
  assert.equal(canonicalBase64('AA-_'), null, 'base64url alphabet');
  assert.equal(canonicalBase64('AAA'), null, 'unpadded');
  assert.equal(canonicalBase64(' AAA='), null);
  assert.equal(canonicalBase64(''), null);
  assert.equal(canonicalBase64(42), null);
});

test('validatePut: the good body, and each field refused on its own — rekey is not a field', () => {
  const good = body();
  const v = validatePut(good);
  assert.equal(v.bytes, 200);
  assert.deepEqual(Object.keys(v).sort(), ['baseRev', 'bytes', 'ct', 'iv', 'keyId', 'kv']);

  const bad = [
    [{ ...good, rekey: true }, 'bad_request'],
    [{ ...good, rekey: false }, 'bad_request'],
    [{ ...good, plaintext: 'x' }, 'bad_request'],
    [{ ...good, writer: 1 }, 'bad_request'],
    [{ ...good, baseRev: -1 }, 'bad_request'],
    [{ ...good, baseRev: 1.5 }, 'bad_request'],
    [{ ...good, baseRev: '0' }, 'bad_request'],
    [{ ...good, kv: 0 }, 'bad_request'],
    [{ ...good, kv: 256 }, 'bad_request'],
    [{ ...good, keyId: KEY_A.toUpperCase().replace('0X', '0x') }, 'bad_request'],
    [{ ...good, keyId: `${KEY_A}00` }, 'bad_request'],
    [{ ...good, iv: b64(16) }, 'bad_request'],
    [{ ...good, iv: 'AAB=' }, 'bad_request'],
    [{ ...good, ct: b64(16) }, 'bad_request'],
    [{ ...good, ct: 'AAB=' }, 'bad_request'],
    [{ ...good, ct: 12 }, 'bad_request'],
    [[good], 'bad_request'],
    [null, 'bad_request'],
  ];
  for (const [b, code] of bad) refusal(() => validatePut(b), code, 400);
});

test('validatePut: a ciphertext over maxBytes is 413 too_large, checked before it is decoded', () => {
  refusal(() => validatePut(body({ ctBytes: 1025 }), { maxBytes: 1024 }), 'too_large', 413);
  assert.equal(validatePut(body({ ctBytes: 1024 }), { maxBytes: 1024 }).bytes, 1024);
  refusal(() => validatePut({ ...body(), ct: 'A'.repeat(4000) }, { maxBytes: 1024 }), 'too_large', 413);
});

// ── the store ────────────────────────────────────────────────────────────────
test('creating the store touches nothing; the first call makes the directory', async () => {
  const dir = path.join(tmpDir(), 'accounts');
  const { store } = open(dir);
  assert.ok(!fs.existsSync(dir), 'nothing on disk until the store is used');
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0, deleted: 0 });
  assert.ok(fs.existsSync(path.join(dir, 'vaults')));
  assert.ok(fs.existsSync(path.join(dir, 'deleted')));
});

test('create, read back, meta; files 0600 in a 0700 directory; the record holds the envelope and its writer only', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  assert.equal(await store.get(a), null);
  assert.equal(await store.meta(a), null);
  const input = validatePut(body());
  assert.deepEqual(await store.put(a, input, BY_S1), { rev: 1, updatedAt: T0, created: true });
  assert.deepEqual(await store.get(a), { v: 2, kv: 1, keyId: KEY_A, iv: input.iv, ct: input.ct, rev: 1, updatedAt: T0 });
  assert.deepEqual(await store.meta(a.toUpperCase().replace('0X', '0x')), { rev: 1, updatedAt: T0, keyId: KEY_A, bytes: 200 });

  const file = path.join(dir, 'vaults', `${a}.json`);
  const rec = readJson(file);
  assert.deepEqual(Object.keys(rec).sort(), ['ct', 'iv', 'keyId', 'kv', 'rev', 'updatedAt', 'v', 'writer']);
  assert.equal(rec.writer, S1);
  if (POSIX) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'vaults')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'deleted')).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), [`${a}.json`], 'no tmp file left behind');
});

test('put needs the writing session: no writer, no write', async () => {
  const { store } = open(tmpDir());
  for (const opts of [undefined, {}, { writer: 0 }, { writer: '1' }, { writer: 1.5 }]) {
    await assert.rejects(store.put(addr(), validatePut(body()), opts), /writer/);
  }
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0, deleted: 0 });
});

test('optimistic concurrency: a stale baseRev is 409 conflict carrying the current rev', async () => {
  const { store, clock } = open(tmpDir());
  const a = addr();
  await store.put(a, validatePut(body()), BY_S1);
  clock.t += 1000;
  assert.deepEqual(await store.put(a, validatePut(body({ baseRev: 1 })), BY_S1), { rev: 2, updatedAt: T0 + 1000, created: false });
  const e = await rejection(store.put(a, validatePut(body({ baseRev: 1 })), BY_S1), 'conflict', 409);
  assert.deepEqual(e.extra, { rev: 2 });
  await rejection(store.put(addr(), validatePut(body({ baseRev: 3 })), BY_S1), 'conflict', 409);
});

test('a write under another keyId is 409 key_mismatch, always: there is no override', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  const first = validatePut(body());
  await store.put(a, first, BY_S1);
  await rejection(store.put(a, validatePut(body({ baseRev: 1, keyId: KEY_B })), BY_S1), 'key_mismatch', 409);
  await rejection(store.put(a, validatePut(body({ baseRev: 1, keyId: KEY_B })), BY_S2), 'key_mismatch', 409);
  assert.equal((await store.get(a)).rev, 1, 'nothing changed');
  assert.equal((await store.get(a)).ct, first.ct);
  assert.ok(!fs.existsSync(path.join(dir, 'vaults', `${a}.json.prev`)));
});

test('.prev keeps the copy from before the current session: its own writes, however many, never push it out', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  const prevCt = () => readJson(path.join(dir, 'vaults', `${a}.json.prev`)).ct;
  // The owner's session: a create and one more save (a new vault's first overwrite
  // always fills .prev).
  const l1 = validatePut(body());
  await store.put(a, l1, BY_S1);
  const l2 = validatePut(body({ baseRev: 1 }));
  await store.put(a, l2, BY_S1);
  assert.equal(prevCt(), l1.ct);
  // A second session (a stolen one) overwrites under the same public keyId, 5 times:
  // its first write moves the owner's latest copy into .prev, and there it stays.
  for (let rev = 2; rev < 7; rev++) await store.put(a, validatePut(body({ baseRev: rev })), BY_S2);
  assert.equal((await store.get(a)).rev, 7);
  assert.equal(prevCt(), l2.ct, 'the owner copy survives any number of writes by one session');
  // The owner's next save (another session again) moves .prev on, as a one-deep copy should.
  await store.put(a, validatePut(body({ baseRev: 7 })), BY_S1);
  assert.equal(readJson(path.join(dir, 'vaults', `${a}.json.prev`)).writer, S2);
  const onDisk = fs.readdirSync(path.join(dir, 'vaults')).reduce((n, f) => n + fs.statSync(path.join(dir, 'vaults', f)).size, 0);
  assert.equal((await store.stats()).totalBytes, onDisk, 'the tally follows the rotations');
});

test('the account cap refuses a NEW vault (507) but not an update; the byte cap refuses growth', async () => {
  const { store } = open(tmpDir(), { limits: { maxAccounts: 2 } });
  const [a, b, c] = [addr(), addr(), addr()];
  await store.put(a, validatePut(body()), BY_S1);
  await store.put(b, validatePut(body()), BY_S1);
  await rejection(store.put(c, validatePut(body()), BY_S1), 'store_full', 507);
  assert.equal((await store.put(a, validatePut(body({ baseRev: 1 })), BY_S1)).rev, 2, 'an existing account still saves');

  const small = open(tmpDir(), { limits: { maxTotalBytes: 2000 } }).store;
  const d = addr();
  await small.put(d, validatePut(body({ ctBytes: 600 })), BY_S1);
  await rejection(small.put(addr(), validatePut(body({ ctBytes: 900 })), BY_S1), 'store_full', 507);
  assert.equal((await small.stats()).accounts, 1);
});

test('beforeCreate runs only for a write that creates, after every check, and can refuse it', async () => {
  const { store } = open(tmpDir(), { limits: { maxAccounts: 2 } });
  const a = addr();
  let calls = 0;
  const hooks = { ...BY_S1, beforeCreate: () => (calls += 1) };
  await store.put(a, validatePut(body()), hooks);
  await store.put(a, validatePut(body({ baseRev: 1 })), hooks);
  await rejection(store.put(a, validatePut(body()), BY_S1), 'conflict', 409);
  assert.equal(calls, 1, 'an update or a refused create is not a creation');

  const b = addr();
  const refuse = () => {
    throw new TpError('rate_limited', 'not now', 429);
  };
  await rejection(store.put(b, validatePut(body()), { ...BY_S1, beforeCreate: refuse }), 'rate_limited', 429);
  assert.equal(await store.get(b), null, 'a refused create writes nothing');
  assert.equal((await store.stats()).accounts, 1);
  await store.put(b, validatePut(body()), hooks);
  await rejection(store.put(addr(), validatePut(body()), hooks), 'store_full', 507);
  assert.equal(calls, 2, 'a full store refuses before the hook runs');
});

test('the tally survives a reopen, and a reopen sweeps stale tmp files and half-built deleted copies', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  await store.put(a, validatePut(body()), BY_S1);
  await store.put(a, validatePut(body({ baseRev: 1, ctBytes: 300 })), BY_S1);
  const b = addr();
  await store.put(b, validatePut(body()), BY_S1);
  await store.remove(b, 1);
  await store.put(addr(), validatePut(body()), BY_S1);
  const before = await store.stats();
  assert.deepEqual({ accounts: before.accounts, deleted: before.deleted }, { accounts: 2, deleted: 1 });
  const sizes = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? sizes(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
  assert.equal(before.totalBytes, sizes(path.join(dir, 'vaults')) + sizes(path.join(dir, 'deleted')));

  const stale = path.join(dir, 'vaults', `${a}.json.123.abcdef.tmp`);
  fs.writeFileSync(stale, 'half a write');
  const half = path.join(dir, 'deleted', `${a}.${T0}.123.abcdef.tmp`);
  fs.mkdirSync(half);
  fs.writeFileSync(path.join(half, `${a}.json`), 'half a copy');
  const reopened = open(dir, { clock }).store;
  assert.deepEqual(await reopened.stats(), before);
  assert.ok(!fs.existsSync(stale), 'stale tmp swept');
  assert.ok(!fs.existsSync(half), 'half-built deleted copy swept');
});

test('writeFileAtomic retries a transient EPERM from rename (Windows AV / indexer) and leaves no tmp', async (t) => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  const real = fs.promises.rename;
  let calls = 0;
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    calls += 1;
    if (calls <= 2) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
    return real(from, to);
  });
  await writeFileAtomic(file, '{"ok":true}');
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('a failed write leaves the old vault intact and no tmp file', async (t) => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  await store.put(a, validatePut(body()), BY_S1);
  const before = await store.get(a);
  const tally = await store.stats();
  t.mock.method(fs.promises, 'rename', async () => {
    const err = new Error('ENOSPC: no space left on device');
    err.code = 'ENOSPC';
    throw err;
  });
  const original = console.error;
  console.error = () => {};
  try {
    await rejection(store.put(a, validatePut(body({ baseRev: 1 })), BY_S1), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  t.mock.restoreAll();
  assert.deepEqual(await store.get(a), before);
  assert.deepEqual(await store.stats(), tally);
  assert.ok(fs.readdirSync(path.join(dir, 'vaults')).every((f) => !f.endsWith('.tmp')));
  assert.equal((await store.put(a, validatePut(body({ baseRev: 1 })), BY_S1)).rev, 2, 'the lane carries on after a failure');
});

test('delete: rev-checked; the vault and its .prev move whole into deleted/<address>.<ms>/; every session revoked (persisted)', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  await store.put(a, validatePut(body()), BY_S1);
  await store.put(a, validatePut(body({ baseRev: 1 })), BY_S1);
  const cur = fs.readFileSync(path.join(dir, 'vaults', `${a}.json`));
  const prev = fs.readFileSync(path.join(dir, 'vaults', `${a}.json.prev`));
  await rejection(store.remove(a, 1), 'conflict', 409);
  assert.equal(await store.notBefore(a), 0);
  clock.t += 5000;
  assert.deepEqual(await store.remove(a, 2), { deleted: true });
  assert.equal(await store.get(a), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), []);
  const kept = path.join(dir, 'deleted', `${a}.${T0 + 5000}`);
  assert.deepEqual(await store.deletedCopies(a), [{ deletedAt: T0 + 5000, dir: kept }]);
  assert.ok(fs.readFileSync(path.join(kept, `${a}.json`)).equals(cur), 'the list, byte for byte');
  assert.ok(fs.readFileSync(path.join(kept, `${a}.json.prev`)).equals(prev), 'its .prev, byte for byte');
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: cur.length + prev.length, deleted: 1 });
  assert.equal(await store.notBefore(a), T0 + 5000);
  if (POSIX) {
    assert.equal(fs.statSync(path.join(dir, 'revoked.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(kept, `${a}.json`)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(kept).mode & 0o777, 0o700);
  }

  const reopened = open(dir, { clock }).store;
  assert.equal(await reopened.notBefore(a), T0 + 5000, 'the revocation survives a restart');
  assert.deepEqual(await reopened.remove(a, 0), { deleted: false }, 'deleting nothing is not an error');
  clock.t += 25 * 3600_000;
  assert.equal(await reopened.notBefore(a), 0, 'a revocation older than any live session is forgotten');
});

test('a hand restore is a copy back: the deleted list reads back after a restart', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  const input = validatePut(body());
  await store.put(a, input, BY_S1);
  await store.remove(a, 1);
  const [{ dir: kept }] = await store.deletedCopies(a);
  fs.copyFileSync(path.join(kept, `${a}.json`), path.join(dir, 'vaults', `${a}.json`));
  const restarted = open(dir, { clock }).store;
  assert.deepEqual(await restarted.get(a), { v: 2, kv: 1, keyId: KEY_A, iv: input.iv, ct: input.ct, rev: 1, updatedAt: T0 });
  assert.equal((await restarted.stats()).accounts, 1);
});

/** Bytes of every file under `d`, recursively. */
const treeBytes = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? treeBytes(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);

test('a list made after a deletion is kept by its own deletion: another session deleting it loses neither list', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  const file = path.join(dir, 'vaults', `${a}.json`);
  // The owner saves L1, then deletes it to start over under a new key.
  await store.put(a, validatePut(body()), BY_S1);
  const l1 = fs.readFileSync(file);
  clock.t += 1000;
  await store.remove(a, 1);
  // A new sign-in, a new list L2 (saved twice, so it has a .prev of its own).
  const owner2 = { writer: T0 + 2000 };
  clock.t += 1000;
  await store.put(a, validatePut(body({ keyId: KEY_B })), owner2);
  await store.put(a, validatePut(body({ baseRev: 1, keyId: KEY_B })), owner2);
  const l2 = fs.readFileSync(file);
  const l2prev = fs.readFileSync(`${file}.prev`);
  // ONE phished sign-in deletes L2.
  clock.t += 1000;
  assert.deepEqual(await store.remove(a, 2), { deleted: true });

  const kept = await store.deletedCopies(a);
  assert.deepEqual(kept, [
    { deletedAt: T0 + 1000, dir: path.join(dir, 'deleted', `${a}.${T0 + 1000}`) },
    { deletedAt: T0 + 3000, dir: path.join(dir, 'deleted', `${a}.${T0 + 3000}`) },
  ]);
  assert.ok(fs.readFileSync(path.join(kept[0].dir, `${a}.json`)).equals(l1), 'L1, byte for byte');
  assert.ok(fs.readFileSync(path.join(kept[1].dir, `${a}.json`)).equals(l2), 'L2, byte for byte');
  assert.ok(fs.readFileSync(path.join(kept[1].dir, `${a}.json.prev`)).equals(l2prev), "L2's .prev, byte for byte");
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), []);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: l1.length + l2.length + l2prev.length, deleted: 2 });
});

test('the first deletion in the keep window is never replaced: a later one takes only the latest slot; each is erased when its own window passes', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  const lists = [];
  const deleteOne = async () => {
    clock.t += 1000;
    const input = validatePut(body({ keyId: lists.length % 2 ? KEY_B : KEY_A }));
    await store.put(a, input, BY_S2);
    lists.push({ ct: input.ct, deletedAt: clock.t });
    assert.deepEqual(await store.remove(a, 1), { deleted: true });
  };
  const keptCts = async () => (await store.deletedCopies(a)).map((d) => readJson(path.join(d.dir, `${a}.json`)).ct);

  await deleteOne();
  await deleteOne();
  const [first, second] = await store.deletedCopies(a);
  // A third and a fourth deletion (a stolen session, again and again): each replaces
  // the latest slot only, so the first stays and at most two are kept.
  await deleteOne();
  assert.deepEqual(await keptCts(), [lists[0].ct, lists[2].ct]);
  assert.ok(!fs.existsSync(second.dir), 'the replaced latest copy is erased from disk');
  await deleteOne();
  assert.deepEqual(await keptCts(), [lists[0].ct, lists[3].ct]);
  assert.deepEqual((await store.deletedCopies(a))[0], first, 'still the first deletion');
  assert.equal(fs.readdirSync(path.join(dir, 'deleted')).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), []);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: treeBytes(path.join(dir, 'deleted')), deleted: 2 });

  // 30 days after the first deletion, the next read erases it; the latest stays and
  // is now the first: the next deletion is kept beside it.
  clock.t = first.deletedAt + 30 * DAY;
  assert.equal(await store.get(a), null);
  assert.ok(!fs.existsSync(first.dir), 'erased from disk');
  assert.deepEqual(await keptCts(), [lists[3].ct]);
  await deleteOne();
  assert.deepEqual(await keptCts(), [lists[3].ct, lists[4].ct]);

  // Once every window has passed, nothing is kept.
  clock.t = lists[4].deletedAt + 30 * DAY;
  assert.deepEqual(await store.deletedCopies(a), []);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0, deleted: 0 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'deleted')), []);
});

test('deletions of one address inside one millisecond never collide on a name', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  const cts = [];
  for (let i = 0; i < 3; i++) {
    const input = validatePut(body());
    await store.put(a, input, BY_S1);
    cts.push(input.ct);
    assert.deepEqual(await store.remove(a, 1), { deleted: true });
  }
  const kept = await store.deletedCopies(a);
  assert.deepEqual(kept.map((d) => d.deletedAt), [T0, T0 + 2]);
  assert.deepEqual(kept.map((d) => readJson(path.join(d.dir, `${a}.json`)).ct), [cts[0], cts[2]]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'deleted')).sort(), [`${a}.${T0}`, `${a}.${T0 + 2}`]);
});

test('a delete that fails while replacing the latest slot loses nothing, and the next one trims back to two', async (t) => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  for (let i = 0; i < 2; i++) {
    clock.t += 1000;
    await store.put(a, validatePut(body()), BY_S1);
    await store.remove(a, 1);
  }
  const [first] = await store.deletedCopies(a);
  clock.t += 1000;
  const input = validatePut(body());
  await store.put(a, input, BY_S1);
  t.mock.method(fs.promises, 'rm', async () => {
    const err = new Error('EIO: i/o error, rm');
    err.code = 'EIO';
    throw err;
  });
  const original = console.error;
  console.error = () => {};
  try {
    await rejection(store.remove(a, 1), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  t.mock.restoreAll();
  assert.equal((await store.get(a)).ct, input.ct, 'the list is still there');
  assert.equal((await store.deletedCopies(a)).length, 3, 'and so is every copy');

  clock.t += 1000;
  assert.deepEqual(await store.remove(a, 1), { deleted: true });
  const kept = await store.deletedCopies(a);
  assert.deepEqual(kept.map((d) => d.deletedAt), [first.deletedAt, clock.t]);
  assert.equal(readJson(path.join(kept[1].dir, `${a}.json`)).ct, input.ct);
  assert.equal(fs.readdirSync(path.join(dir, 'deleted')).length, 2);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: treeBytes(path.join(dir, 'deleted')), deleted: 2 });
});

test('keepDeletedMs 0 erases at once, and a reopen at 0 erases what an earlier setting kept', async () => {
  const dir = tmpDir();
  const keep = open(dir);
  const a = addr();
  await keep.store.put(a, validatePut(body()), BY_S1);
  await keep.store.remove(a, 1);
  assert.equal(fs.readdirSync(path.join(dir, 'deleted')).length, 1);

  const none = open(dir, { clock: keep.clock, limits: { keepDeletedMs: 0 } }).store;
  assert.deepEqual(await none.stats(), { accounts: 0, totalBytes: 0, deleted: 0 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'deleted')), [], 'erased at open');
  const b = addr();
  await none.put(b, validatePut(body()), BY_S1);
  assert.deepEqual(await none.remove(b, 1), { deleted: true });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'deleted')), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), []);
  assert.deepEqual(await none.stats(), { accounts: 0, totalBytes: 0, deleted: 0 });
});

test('a full store erases expired deleted copies before it refuses a write', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir, { limits: { maxTotalBytes: 1500, keepDeletedMs: DAY } });
  const a = addr();
  await store.put(a, validatePut(body({ ctBytes: 500 })), BY_S1);
  await store.remove(a, 1);
  await rejection(store.put(addr(), validatePut(body({ ctBytes: 500 })), BY_S1), 'store_full', 507);
  clock.t += DAY;
  // No read in between: the write itself makes the room.
  assert.equal((await store.put(addr(), validatePut(body({ ctBytes: 500 })), BY_S1)).created, true);
  assert.equal((await store.stats()).deleted, 0);
});

test('an unreadable or corrupt vault answers 503 unavailable, never a guess', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  await store.stats(); // opens the store: vaults/ exists from here
  const a = addr();
  const b = addr();
  fs.mkdirSync(path.join(dir, 'vaults', `${a}.json`));
  fs.writeFileSync(path.join(dir, 'vaults', `${b}.json`), '{"rev": "x"');
  const original = console.error;
  const logged = [];
  console.error = (...m) => logged.push(m.join(' '));
  try {
    await rejection(store.get(a), 'unavailable', 503);
    await rejection(store.put(b, validatePut(body()), BY_S1), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
});

test('an accounts dir that cannot be made answers 503 on every call, and is tried again next time', async () => {
  const parent = tmpDir();
  const blocker = path.join(parent, 'not-a-dir');
  fs.writeFileSync(blocker, 'a file where the directory should be');
  const { store } = open(path.join(blocker, 'accounts'));
  const original = console.error;
  console.error = () => {};
  try {
    await rejection(store.stats(), 'unavailable', 503);
    await rejection(store.put(addr(), validatePut(body()), BY_S1), 'unavailable', 503);
    await rejection(store.notBefore(addr()), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  fs.rmSync(blocker);
  fs.mkdirSync(blocker);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0, deleted: 0 }, 'opened on the next call');
});

test('paths are built from a validated address only', async () => {
  const { store } = open(tmpDir());
  for (const bad of ['../../etc/passwd', '0x1234', `0x${'g'.repeat(40)}`, '', null]) {
    await assert.rejects(store.get(bad), /not an address/);
    await assert.rejects(store.put(bad, validatePut(body()), BY_S1), /not an address/);
    await assert.rejects(store.remove(bad, 0), /not an address/);
    await assert.rejects(store.notBefore(bad), /not an address/);
    await assert.rejects(store.deletedCopies(bad), /not an address/);
  }
});

// ── the write lane ───────────────────────────────────────────────────────────
test('a save never blocks the event loop: while its disk write is pending, timers run and reads answer', async (t) => {
  const { store } = open(tmpDir());
  const a = addr();
  const b = addr();
  await store.put(b, validatePut(body()), BY_S1);
  const held = holdRenames(t);

  let settled = false;
  const saving = store.put(a, validatePut(body()), BY_S1);
  saving.then(
    () => (settled = true),
    () => (settled = true)
  );
  let turns = 0;
  while (held.calls === 0 && !settled) {
    await turn(); // each turn is a trip round the event loop: it keeps going
    turns += 1;
  }
  assert.equal(held.calls, 1, 'the save reached the disk and waits there');
  assert.ok(turns > 0);
  assert.equal(settled, false, 'the save is still waiting on the disk');
  assert.equal((await store.get(b)).rev, 1, 'another vault reads meanwhile');
  assert.equal(await store.get(a), null, 'the vault being written reads as before the write');
  assert.equal((await store.stats()).accounts, 1, 'the tally counts only what has landed');

  held.release();
  assert.deepEqual(await saving, { rev: 1, updatedAt: T0, created: true });
  assert.equal((await store.get(a)).rev, 1);
});

test('one write at a time: a second save waits in the lane until the first has landed', async (t) => {
  const { store } = open(tmpDir());
  const a = addr();
  const b = addr();
  await store.put(b, validatePut(body()), BY_S1);
  const held = holdRenames(t);

  let firstSettled = false;
  const first = store.put(a, validatePut(body()), BY_S1);
  first.then(
    () => (firstSettled = true),
    () => (firstSettled = true)
  );
  while (held.calls === 0 && !firstSettled) await turn();
  assert.equal(held.calls, 1, 'the first save reached the disk and waits there');
  const second = store.put(b, validatePut(body({ baseRev: 1 })), BY_S1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(held.calls, 1, 'the second save has not reached the disk');
  held.release();
  assert.equal((await first).rev, 1);
  assert.equal((await second).rev, 2);
  assert.equal(held.calls, 3, 'then it wrote its .prev and its vault');
});

test('saves racing on one vault with one baseRev: exactly one wins, the rest are 409 conflict', async () => {
  const { store } = open(tmpDir());
  const a = addr();
  await store.put(a, validatePut(body()), BY_S1);
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => store.put(a, validatePut(body({ baseRev: 1 })), BY_S1)));
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1);
  assert.equal(won[0].value.rev, 2);
  for (const r of results.filter((x) => x.status === 'rejected')) {
    assert.equal(r.reason.code, 'conflict');
    assert.deepEqual(r.reason.extra, { rev: 2 });
  }
  assert.equal((await store.get(a)).rev, 2);
});

test('creates racing for the last places cannot pass the account cap together', async () => {
  const { store } = open(tmpDir(), { limits: { maxAccounts: 2 } });
  const results = await Promise.allSettled([addr(), addr(), addr(), addr()].map((a) => store.put(a, validatePut(body()), BY_S1)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'store_full'));
  assert.equal((await store.stats()).accounts, 2);
});

test('deletes racing on two vaults both reach revoked.json', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const [a, b] = [addr(), addr()];
  await store.put(a, validatePut(body()), BY_S1);
  await store.put(b, validatePut(body()), BY_S1);
  clock.t += 1000;
  assert.deepEqual(await Promise.all([store.remove(a, 1), store.remove(b, 1)]), [{ deleted: true }, { deleted: true }]);
  const reopened = open(dir, { clock }).store;
  assert.equal(await reopened.notBefore(a), T0 + 1000);
  assert.equal(await reopened.notBefore(b), T0 + 1000);
});

test('a full lane refuses the next write at once with 503 unavailable, and frees up as writes land', async (t) => {
  const { store } = open(tmpDir(), { maxPending: 2 });
  await store.stats();
  const held = holdRenames(t);
  const [a, b, c] = [addr(), addr(), addr()];
  const first = store.put(a, validatePut(body()), BY_S1);
  const second = store.put(b, validatePut(body()), BY_S1);
  await rejection(store.put(c, validatePut(body()), BY_S1), 'unavailable', 503);
  held.release();
  assert.equal((await first).rev, 1);
  assert.equal((await second).rev, 1);
  assert.equal((await store.put(c, validatePut(body()), BY_S1)).rev, 1);
});
