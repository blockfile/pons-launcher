'use strict';

// tp/vaultStore.js: ciphertext blobs per address — validation, atomic 0600 writes,
// optimistic concurrency, the keyId guard, the one-deep .prev, the global caps, the
// session revocations, and the write lane: every disk call is async, one write runs
// at a time, and nothing waits on the event loop. The "ciphertext" here is random
// bytes: the store never looks inside it, so nothing real is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVaultStore, validatePut, canonicalBase64, writeFileAtomic, VAULT_LIMITS, MAX_PENDING_WRITES } = require('./vaultStore');
const { TpError } = require('./errors');

const T0 = Date.parse('2026-09-19T12:00:00.000Z');
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
test('the default caps: 256 KiB a vault, 5000 vaults, 512 MiB in total; 64 writes may wait', { skip: Boolean(process.env.TP_VAULT_MAX_BYTES || process.env.TP_VAULT_MAX_ACCOUNTS || process.env.TP_VAULT_MAX_TOTAL_BYTES) && 'a TP_VAULT_* cap is set' }, () => {
  assert.deepEqual({ ...VAULT_LIMITS }, { maxBytes: 262144, maxAccounts: 5000, maxTotalBytes: 536870912 });
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

test('validatePut: the good body, and each field refused on its own', () => {
  const good = body();
  const v = validatePut(good);
  assert.equal(v.bytes, 200);
  assert.equal(v.rekey, false);
  assert.equal(validatePut({ ...good, rekey: true }).rekey, true);

  const bad = [
    [{ ...good, plaintext: 'x' }, 'bad_request'],
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
    [{ ...good, rekey: 'yes' }, 'bad_request'],
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
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0 });
  assert.ok(fs.existsSync(path.join(dir, 'vaults')));
});

test('create, read back, meta; files 0600 in a 0700 directory; the record holds nothing but the envelope', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  assert.equal(await store.get(a), null);
  assert.equal(await store.meta(a), null);
  const input = validatePut(body());
  assert.deepEqual(await store.put(a, input), { rev: 1, updatedAt: T0, created: true });
  assert.deepEqual(await store.get(a), { v: 2, kv: 1, keyId: KEY_A, iv: input.iv, ct: input.ct, rev: 1, updatedAt: T0 });
  assert.deepEqual(await store.meta(a.toUpperCase().replace('0X', '0x')), { rev: 1, updatedAt: T0, keyId: KEY_A, bytes: 200 });

  const file = path.join(dir, 'vaults', `${a}.json`);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['ct', 'iv', 'keyId', 'kv', 'rev', 'updatedAt', 'v']);
  if (POSIX) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'vaults')).mode & 0o777, 0o700);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), [`${a}.json`], 'no tmp file left behind');
});

test('optimistic concurrency: a stale baseRev is 409 conflict carrying the current rev', async () => {
  const { store, clock } = open(tmpDir());
  const a = addr();
  await store.put(a, validatePut(body()));
  clock.t += 1000;
  assert.deepEqual(await store.put(a, validatePut(body({ baseRev: 1 }))), { rev: 2, updatedAt: T0 + 1000, created: false });
  const e = await rejection(store.put(a, validatePut(body({ baseRev: 1 }))), 'conflict', 409);
  assert.deepEqual(e.extra, { rev: 2 });
  await rejection(store.put(addr(), validatePut(body({ baseRev: 3 }))), 'conflict', 409);
});

test('a write under another keyId is 409 key_mismatch unless rekey; .prev keeps the version before', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  const first = validatePut(body());
  await store.put(a, first);
  await rejection(store.put(a, validatePut(body({ baseRev: 1, keyId: KEY_B }))), 'key_mismatch', 409);
  assert.equal((await store.get(a)).rev, 1, 'nothing changed');
  const second = validatePut(body({ baseRev: 1, keyId: KEY_B, rekey: true }));
  assert.equal((await store.put(a, second)).rev, 2);
  assert.equal((await store.get(a)).keyId, KEY_B);
  const prev = JSON.parse(fs.readFileSync(path.join(dir, 'vaults', `${a}.json.prev`), 'utf8'));
  assert.equal(prev.rev, 1);
  assert.equal(prev.ct, first.ct);
  assert.equal(prev.keyId, KEY_A);
});

test('the account cap refuses a NEW vault (507) but not an update; the byte cap refuses growth', async () => {
  const { store } = open(tmpDir(), { limits: { maxAccounts: 2 } });
  const [a, b, c] = [addr(), addr(), addr()];
  await store.put(a, validatePut(body()));
  await store.put(b, validatePut(body()));
  await rejection(store.put(c, validatePut(body())), 'store_full', 507);
  assert.equal((await store.put(a, validatePut(body({ baseRev: 1 })))).rev, 2, 'an existing account still saves');

  const small = open(tmpDir(), { limits: { maxTotalBytes: 2000 } }).store;
  const d = addr();
  await small.put(d, validatePut(body({ ctBytes: 600 })));
  await rejection(small.put(addr(), validatePut(body({ ctBytes: 900 }))), 'store_full', 507);
  assert.equal((await small.stats()).accounts, 1);
});

test('beforeCreate runs only for a write that creates, after every check, and can refuse it', async () => {
  const { store } = open(tmpDir(), { limits: { maxAccounts: 2 } });
  const a = addr();
  let calls = 0;
  const hooks = { beforeCreate: () => (calls += 1) };
  await store.put(a, validatePut(body()), hooks);
  await store.put(a, validatePut(body({ baseRev: 1 })), hooks);
  await rejection(store.put(a, validatePut(body())), 'conflict', 409);
  assert.equal(calls, 1, 'an update or a refused create is not a creation');

  const b = addr();
  const refuse = () => {
    throw new TpError('rate_limited', 'not now', 429);
  };
  await rejection(store.put(b, validatePut(body()), { beforeCreate: refuse }), 'rate_limited', 429);
  assert.equal(await store.get(b), null, 'a refused create writes nothing');
  assert.equal((await store.stats()).accounts, 1);
  await store.put(b, validatePut(body()), hooks);
  await rejection(store.put(addr(), validatePut(body()), hooks), 'store_full', 507);
  assert.equal(calls, 2, 'a full store refuses before the hook runs');
});

test('the tally survives a reopen, and a reopen sweeps stale tmp files', async () => {
  const dir = tmpDir();
  const { store } = open(dir);
  const a = addr();
  await store.put(a, validatePut(body()));
  await store.put(a, validatePut(body({ baseRev: 1, ctBytes: 300 })));
  await store.put(addr(), validatePut(body()));
  const before = await store.stats();
  assert.equal(before.accounts, 2);
  const onDisk = fs.readdirSync(path.join(dir, 'vaults')).reduce((n, f) => n + fs.statSync(path.join(dir, 'vaults', f)).size, 0);
  assert.equal(before.totalBytes, onDisk);

  const stale = path.join(dir, 'vaults', `${a}.json.123.abcdef.tmp`);
  fs.writeFileSync(stale, 'half a write');
  const reopened = open(dir).store;
  assert.deepEqual(await reopened.stats(), before);
  assert.ok(!fs.existsSync(stale), 'stale tmp swept');
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
  await store.put(a, validatePut(body()));
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
    await rejection(store.put(a, validatePut(body({ baseRev: 1 }))), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  t.mock.restoreAll();
  assert.deepEqual(await store.get(a), before);
  assert.deepEqual(await store.stats(), tally);
  assert.ok(fs.readdirSync(path.join(dir, 'vaults')).every((f) => !f.endsWith('.tmp')));
  assert.equal((await store.put(a, validatePut(body({ baseRev: 1 })))).rev, 2, 'the lane carries on after a failure');
});

test('delete: rev-checked, removes the vault AND its .prev, revokes the address sessions (persisted)', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const a = addr();
  await store.put(a, validatePut(body()));
  await store.put(a, validatePut(body({ baseRev: 1 })));
  await rejection(store.remove(a, 1), 'conflict', 409);
  assert.equal(await store.notBefore(a), 0);
  clock.t += 5000;
  assert.deepEqual(await store.remove(a, 2), { deleted: true });
  assert.equal(await store.get(a), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'vaults')), []);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0 });
  assert.equal(await store.notBefore(a), T0 + 5000);
  if (POSIX) assert.equal(fs.statSync(path.join(dir, 'revoked.json')).mode & 0o777, 0o600);

  const reopened = open(dir, { clock }).store;
  assert.equal(await reopened.notBefore(a), T0 + 5000, 'the revocation survives a restart');
  assert.deepEqual(await reopened.remove(a, 0), { deleted: false }, 'deleting nothing is not an error');
  clock.t += 25 * 3600_000;
  assert.equal(await reopened.notBefore(a), 0, 'a revocation older than any live session is forgotten');
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
    await rejection(store.put(b, validatePut(body())), 'unavailable', 503);
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
    await rejection(store.put(addr(), validatePut(body())), 'unavailable', 503);
    await rejection(store.notBefore(addr()), 'unavailable', 503);
  } finally {
    console.error = original;
  }
  fs.rmSync(blocker);
  fs.mkdirSync(blocker);
  assert.deepEqual(await store.stats(), { accounts: 0, totalBytes: 0 }, 'opened on the next call');
});

test('paths are built from a validated address only', async () => {
  const { store } = open(tmpDir());
  for (const bad of ['../../etc/passwd', '0x1234', `0x${'g'.repeat(40)}`, '', null]) {
    await assert.rejects(store.get(bad), /not an address/);
    await assert.rejects(store.put(bad, validatePut(body())), /not an address/);
    await assert.rejects(store.remove(bad, 0), /not an address/);
    await assert.rejects(store.notBefore(bad), /not an address/);
  }
});

// ── the write lane ───────────────────────────────────────────────────────────
test('a save never blocks the event loop: while its disk write is pending, timers run and reads answer', async (t) => {
  const { store } = open(tmpDir());
  const a = addr();
  const b = addr();
  await store.put(b, validatePut(body()));
  const held = holdRenames(t);

  let settled = false;
  const saving = store.put(a, validatePut(body()));
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
  await store.put(b, validatePut(body()));
  const held = holdRenames(t);

  let firstSettled = false;
  const first = store.put(a, validatePut(body()));
  first.then(
    () => (firstSettled = true),
    () => (firstSettled = true)
  );
  while (held.calls === 0 && !firstSettled) await turn();
  assert.equal(held.calls, 1, 'the first save reached the disk and waits there');
  const second = store.put(b, validatePut(body({ baseRev: 1 })));
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
  await store.put(a, validatePut(body()));
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => store.put(a, validatePut(body({ baseRev: 1 })))));
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
  const results = await Promise.allSettled([addr(), addr(), addr(), addr()].map((a) => store.put(a, validatePut(body()))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'store_full'));
  assert.equal((await store.stats()).accounts, 2);
});

test('deletes racing on two vaults both reach revoked.json', async () => {
  const dir = tmpDir();
  const { store, clock } = open(dir);
  const [a, b] = [addr(), addr()];
  await store.put(a, validatePut(body()));
  await store.put(b, validatePut(body()));
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
  const first = store.put(a, validatePut(body()));
  const second = store.put(b, validatePut(body()));
  await rejection(store.put(c, validatePut(body())), 'unavailable', 503);
  held.release();
  assert.equal((await first).rev, 1);
  assert.equal((await second).rev, 1);
  assert.equal((await store.put(c, validatePut(body()))).rev, 1);
});
