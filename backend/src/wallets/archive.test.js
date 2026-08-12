'use strict';

// The archive: what a delete now does, and what makes it undoable.
//
// Kept apart from keystore.test.js because that file ends with adoptLegacy,
// which renames the default keystore out from under everything before it — and
// because these tests are about one property the rest of the suite does not
// cover: that a deleted key is still there, still encrypted, and still only
// this user's.
//
// And, at the bottom, the one place where that stops being true: the archive is
// capped, so past MAX_ARCHIVED a delete DESTROYS an older key. Those tests are
// here rather than beside a route because the destruction happens in the
// keystore and the routes cannot see it — routes/wallets.archive.test.js covers
// the log line the operator is left with.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-archive-'));
// Set before config.js is first required (by keystore.js, below) — it reads
// process.env at load time. Nothing here may touch backend/data.
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
process.env.HISTORY_PATH = path.join(dir, 'launches.json');
process.env.KEYSTORE_PASSPHRASE = 'correct horse battery staple';

const keystore = require('./keystore');

const archiveFile = (userId) => keystore.archivePathFor(userId);
const readArchive = (userId) => JSON.parse(fs.readFileSync(archiveFile(userId), 'utf8'));

test('deleting a wallet archives it instead of destroying the key', () => {
  const ks = keystore.keystoreFor('archie');
  const [w] = ks.generate(1, { label: 'bundle', role: 'bundle' });
  const { privateKey } = ks.exportKey(w.id);

  const out = ks.remove(w.id);
  assert.equal(out.archived, true);
  assert.equal(out.address, w.address);

  // Gone from the live store, by every route out of it.
  assert.ok(!ks.list().some((x) => x.id === w.id));
  assert.throws(() => ks.signer(w.id), /no wallet/);
  assert.throws(() => ks.exportKey(w.id), /no wallet/);

  // And present in the archive, carrying what it was.
  const [entry] = ks.archived();
  assert.equal(entry.id, w.id);
  assert.equal(entry.address, w.address);
  assert.equal(entry.label, w.label);
  assert.equal(entry.role, 'bundle');
  assert.equal(entry.createdAt, w.createdAt, 'the original createdAt is kept');
  assert.match(entry.deletedAt, /^\d{4}-\d\d-\d\dT/);

  // The listing is metadata and nothing else — this is the property that keeps
  // a "recently deleted" panel from becoming a key viewer.
  assert.equal(entry.privateKey, undefined);
  assert.equal(entry.ciphertext, undefined);
  assert.equal(entry.iv, undefined);
  assert.equal(entry.tag, undefined);
  assert.equal(Object.keys(entry).length, 6);

  // The key the archive is holding is the one that was deleted — the fact the
  // whole feature rests on. Put back, checked, and deleted again.
  assert.equal(ks.restore(w.id).address, w.address);
  assert.equal(ks.exportKey(w.id).privateKey, privateKey);
  ks.remove(w.id);
});

test('restoring puts the wallet back, key and identity intact', () => {
  const ks = keystore.keystoreFor('rita');
  const [w] = ks.generate(1, { label: 'bundle', role: 'bundle' });
  const before = ks.exportKey(w.id).privateKey;

  ks.remove(w.id);
  const back = ks.restore(w.id);

  assert.equal(back.id, w.id, 'the same wallet, not a copy with a new id');
  assert.equal(back.address, w.address);
  assert.equal(back.createdAt, w.createdAt);
  assert.equal(back.role, 'bundle');
  assert.equal(back.deletedAt, undefined, 'no longer deleted');

  // The restored key still signs for its address — the whole point of keeping it.
  assert.equal(ks.exportKey(w.id).privateKey, before);
  assert.equal(new Wallet(before).address, w.address);
  assert.equal(ks.signer(w.id).address, w.address);
  assert.ok(ks.list().some((x) => x.id === w.id));

  // And it is out of the archive, so it cannot be restored twice.
  assert.ok(!ks.archived().some((x) => x.id === w.id));
  assert.throws(() => ks.restore(w.id), /no archived wallet/);
});

test('restoring a dev wallet fails clearly when one already exists', () => {
  const ks = keystore.keystoreFor('devy');
  const [first] = ks.generate(1, { role: 'dev' });
  ks.remove(first.id);

  // The replacement an operator rotating an exposed key would have made.
  const [second] = ks.generate(1, { role: 'dev' });

  assert.throws(() => ks.restore(first.id), /a dev wallet already exists — delete it first/);
  // Refused, not half-done: the archive still holds it and the live dev wallet
  // is untouched.
  assert.ok(ks.archived().some((x) => x.id === first.id));
  assert.equal(ks.devWallet().id, second.id);

  // Delete the replacement and the original goes back in — the rule is "one
  // dev wallet", not "no restores".
  ks.remove(second.id);
  assert.equal(ks.restore(first.id).id, first.id);
  assert.equal(ks.devWallet().id, first.id);
});

test('restoring refuses an address the live keystore already holds', () => {
  const ks = keystore.keystoreFor('dupe');
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const [w] = ks.importKeys([key], { role: 'bundle' });
  ks.remove(w.id);
  // Re-imported from the operator's own backup while the archived copy sat there.
  ks.importKeys([key], { role: 'bundle' });

  assert.throws(() => ks.restore(w.id), /already in the keystore/);
});

test('purging destroys an archived key for good', () => {
  const ks = keystore.keystoreFor('purgy');
  const [w] = ks.generate(1, { role: 'bundle' });
  ks.remove(w.id);

  const out = ks.purge(w.id);
  assert.equal(out.purged, w.id);
  assert.equal(out.address, w.address);

  assert.ok(!ks.archived().some((x) => x.id === w.id));
  assert.throws(() => ks.restore(w.id), /no archived wallet/);
  assert.throws(() => ks.purge(w.id), /no archived wallet/);

  // Nothing of it is left on disk — this is the call that means "destroy".
  const raw = fs.readFileSync(archiveFile('purgy'), 'utf8');
  assert.ok(!raw.includes(w.address), 'a purged wallet leaves no trace in the archive file');
});

test('deleting the same wallet twice leaves one archived entry', () => {
  const ks = keystore.keystoreFor('twice');
  const [w] = ks.generate(1, { role: 'bundle' });
  ks.remove(w.id);
  ks.restore(w.id);
  ks.remove(w.id);

  assert.equal(ks.archived().filter((x) => x.address === w.address).length, 1);
});

test('one user can never see or restore another user archived wallet', () => {
  const alice = keystore.keystoreFor('alice');
  const bob = keystore.keystoreFor('bob');

  const [aw] = alice.generate(1, { role: 'dev' });
  alice.remove(aw.id);
  const [bw] = bob.generate(1, { role: 'bundle' });
  bob.remove(bw.id);

  // Separate files, and each holds only its own.
  assert.notEqual(archiveFile('alice'), archiveFile('bob'));
  assert.ok(alice.archived().some((x) => x.id === aw.id));
  assert.ok(!alice.archived().some((x) => x.id === bw.id));
  assert.ok(!bob.archived().some((x) => x.id === aw.id));

  // The isolation is structural: a foreign id is simply not in this archive,
  // so guessing one gets the same answer as inventing one.
  assert.throws(() => bob.restore(aw.id), /no archived wallet/);
  assert.throws(() => bob.purge(aw.id), /no archived wallet/);
  assert.throws(() => alice.restore(bw.id), /no archived wallet/);
  assert.throws(() => alice.purge(bw.id), /no archived wallet/);

  // Bob purging his own must not disturb Alice's.
  bob.purge(bw.id);
  assert.ok(alice.archived().some((x) => x.id === aw.id));

  // Nor does either file mention the other's address.
  assert.ok(!fs.readFileSync(archiveFile('bob'), 'utf8').includes(aw.address));
  assert.ok(!fs.readFileSync(archiveFile('alice'), 'utf8').includes(bw.address));
});

// ── who this account is, for the sell gate ─────────────────────────────────
//
// The factory records the wallet that launched a token and never updates it, so
// "is this token ours?" cannot be asked of the current dev wallet alone —
// rotating it made the picker refuse eight of the operator's own tokens. The
// answer is the live keystore UNION this archive, which is exactly where a
// rotated-away wallet ends up. See evm/v2/holdings.js.

test('ownedAddresses is the live keystore plus the archive, deduplicated', () => {
  const ks = keystore.keystoreFor('owner');
  const [dev] = ks.generate(1, { role: 'dev' });
  const [b1, b2] = ks.generate(2, { role: 'bundle' });

  assert.deepEqual(
    [...ks.ownedAddresses()].sort(),
    [dev.address, b1.address, b2.address].sort(),
    'the live keystore, while nothing has been deleted'
  );

  // The rotation this exists for: the dev wallet is deleted and replaced, and
  // the old one has to keep counting or its launches become unsellable.
  ks.remove(dev.id);
  const [newDev] = ks.generate(1, { role: 'dev' });
  const after = ks.ownedAddresses();
  assert.ok(after.includes(newDev.address), 'the wallet signing today');
  assert.ok(after.includes(dev.address), 'and the one that actually launched the tokens');
  assert.equal(after.length, 4);

  // No keys, ever — this is a membership test, not a way to read the archive.
  assert.ok(after.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)));

  // Restoring must not double-count: one address, whichever file it is in.
  ks.remove(newDev.id);
  ks.restore(dev.id);
  const restored = ks.ownedAddresses();
  assert.equal(new Set(restored).size, restored.length);
  assert.equal(restored.length, 4);

  // And a purge is a real destruction here too: the address stops being ours,
  // so a token it launched stops being offered. Narrower, never wrong.
  ks.purge(newDev.id);
  assert.ok(!ks.ownedAddresses().includes(newDev.address));
});

test('one account archive never widens another account owned set', () => {
  const ann = keystore.keystoreFor('ann');
  const ben = keystore.keystoreFor('ben');

  const [aDev] = ann.generate(1, { role: 'dev' });
  ann.remove(aDev.id);
  ann.generate(1, { role: 'dev' });
  const [bDev] = ben.generate(1, { role: 'dev' });

  // Ann rotated; her old dev wallet is hers and nobody else's. Ben's owned set
  // is the only thing gating Ben's sells, so this is what stops "or has held"
  // from meaning "or anyone has held".
  assert.ok(ann.ownedAddresses().includes(aDev.address));
  assert.ok(!ben.ownedAddresses().includes(aDev.address));
  assert.ok(!ann.ownedAddresses().includes(bDev.address));
});

test('the archive lives beside the keystore, one file per user', () => {
  assert.equal(path.dirname(archiveFile('alice')), dir);
  assert.equal(path.basename(archiveFile('alice')), 'wallets.archive.alice.keystore.json');
  // 'default' keeps a fixed name rather than reusing the live keystore's path.
  assert.equal(path.basename(archiveFile('default')), 'wallets.archive.keystore.json');
  assert.notEqual(archiveFile('default'), process.env.KEYSTORE_PATH);
});

test('archived key material is encrypted at rest exactly as the live keystore is', () => {
  const ks = keystore.keystoreFor('crypto');
  const [w] = ks.generate(1, { role: 'bundle' });
  const { privateKey } = ks.exportKey(w.id);
  ks.remove(w.id);

  const raw = fs.readFileSync(archiveFile('crypto'), 'utf8');
  assert.ok(!raw.includes(privateKey), 'private key must not appear in the archive file');
  assert.ok(!raw.includes(privateKey.slice(2)), 'unprefixed key must not appear either');

  const live = JSON.parse(fs.readFileSync(path.join(dir, 'wallets.crypto.keystore.json'), 'utf8'));
  const archive = readArchive('crypto');

  // Same envelope, same KDF parameters — the archive is the keystore's own
  // encryption applied to a second file, not a second scheme.
  assert.equal(archive.version, live.version);
  assert.deepEqual(
    { ...archive.kdf, salt: undefined },
    { ...live.kdf, salt: undefined },
    'scrypt parameters must match the live keystore'
  );
  assert.match(archive.kdf.salt, /^[0-9a-f]{64}$/);
  assert.notEqual(archive.kdf.salt, live.kdf.salt, 'each file carries its own salt');

  const [record] = archive.wallets;
  assert.match(record.iv, /^[0-9a-f]{24}$/, 'AES-GCM 96-bit IV');
  assert.match(record.tag, /^[0-9a-f]{32}$/, 'AES-GCM 128-bit auth tag');
  assert.match(record.ciphertext, /^[0-9a-f]+$/);
  assert.equal(record.privateKey, undefined);

  // A fresh IV per record, the same as the live store — two deletes of two
  // wallets must not reuse one.
  const [second] = ks.generate(1, { role: 'bundle' });
  ks.remove(second.id);
  const ivs = readArchive('crypto').wallets.map((x) => x.iv);
  assert.equal(new Set(ivs).size, ivs.length);

  // And it round-trips: encrypted at rest, readable by this process.
  assert.equal(ks.restore(w.id).address, w.address);
  assert.equal(ks.exportKey(w.id).privateKey, privateKey);
});

// ── the cap ────────────────────────────────────────────────────────────────
// Everything above is about a key surviving a delete. These are about the case
// where it does not: the archive holds MAX_ARCHIVED wallets, and the delete
// that overflows it destroys the oldest key outright. That is the operator's
// decision and it is irreversible, so what is asserted here is not only that
// the number is right but that the destruction is REPORTED — the return value
// and the server log are the only things standing between an evicted key and no
// record of it ever existing.

/** Deterministic, distinct, valid secp256k1 keys — 1, 2, 3… as 32 bytes. */
const keyFor = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;

test('the archive is capped at 100, and the 101st delete evicts the oldest', () => {
  const ks = keystore.keystoreFor('capped');
  assert.equal(keystore.MAX_ARCHIVED, 100);

  const made = ks.importKeys(
    Array.from({ length: 101 }, (_, i) => keyFor(i + 1)),
    { role: 'bundle' }
  );

  // The first hundred fill it exactly, and filling it destroys nothing.
  for (const w of made.slice(0, 100)) assert.deepEqual(ks.remove(w.id).evicted, []);
  assert.equal(ks.archived().length, 100);

  const oldest = made[0];
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let out;
  try {
    out = ks.remove(made[100].id);
  } finally {
    console.warn = realWarn;
  }

  // One key destroyed, and it is the one deleted first.
  assert.equal(out.evicted.length, 1);
  assert.equal(out.evicted[0].id, oldest.id);
  assert.equal(out.evicted[0].address, oldest.address);
  assert.match(out.evicted[0].deletedAt, /^\d{4}-\d\d-\d\dT/);
  // The report is metadata, like every other view out of this module. An
  // eviction is not an excuse to hand a key to a caller that never asked.
  assert.equal(Object.keys(out.evicted[0]).length, 6);
  assert.equal(out.evicted[0].privateKey, undefined);
  assert.equal(out.evicted[0].ciphertext, undefined);

  // Never silent. This warning is written at the point of destruction, so it
  // happens whatever the caller does with the return value.
  assert.equal(warned.filter((m) => m.includes('ARCHIVED KEY EVICTED')).length, 1);
  assert.ok(warned.some((m) => m.includes(oldest.address)));

  // Exactly a hundred kept — not 99, not 101.
  const left = ks.archived();
  assert.equal(left.length, 100);

  // And the eviction is a real destruction, the same as purge: gone from the
  // list, unrestorable, and absent from the file on disk.
  assert.ok(!left.some((e) => e.id === oldest.id));
  assert.throws(() => ks.restore(oldest.id), /no archived wallet/);
  const raw = fs.readFileSync(archiveFile('capped'), 'utf8');
  assert.ok(!raw.includes(oldest.address), 'an evicted wallet leaves no trace in the archive file');

  // The survivors are the last hundred deleted, newest first.
  assert.deepEqual(
    left.map((e) => e.address),
    made.slice(1).map((w) => w.address).reverse()
  );
});

test('an evicted wallet stops counting as ours, and nothing pretends otherwise', () => {
  // The honest edge of the sell gate. A dev wallet rotated away long enough ago
  // can be evicted from the full archive, and once it is, the account has no
  // record of ever holding it — so a token it launched is no longer offered.
  // That is a narrower list, not a wrong one; the operator's route back is to
  // re-import the key (or restore it before the cap reaches it), which is what
  // the refusal message points at.
  const ks = keystore.keystoreFor('capped'); // already overflowed, above
  const evicted = new Wallet(keyFor(1)).address; // the first delete, the one destroyed
  const survivor = new Wallet(keyFor(2)).address;

  const owned = ks.ownedAddresses();
  assert.ok(!owned.includes(evicted), 'a destroyed key is not a wallet this account holds');
  assert.ok(owned.includes(survivor), 'everything still archived is still ours');
});

test('eviction takes the oldest deletedAt, not merely the last line in the file', () => {
  const ks = keystore.keystoreFor('shuffled');

  // One real delete, to get a well-formed encrypted record to copy. Nothing
  // here ever decrypts an evicted entry — the ordering is the whole subject —
  // so the fillers share its envelope and differ in the fields that decide.
  const [seed] = ks.importKeys([keyFor(7)], { role: 'bundle' });
  ks.remove(seed.id);
  const [record] = readArchive('shuffled').wallets;

  // A full archive whose FILE ORDER is deliberately wrong: the oldest delete
  // sits in the middle, where trusting the array's tail would miss it.
  const oldestId = 'filler-50';
  const store = readArchive('shuffled');
  store.wallets = Array.from({ length: keystore.MAX_ARCHIVED }, (_, i) => ({
    ...record,
    id: `filler-${i}`,
    address: `0x${String(i).padStart(40, '0')}`,
    deletedAt: `2026-0${i === 50 ? '1' : '2'}-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
  }));
  fs.writeFileSync(archiveFile('shuffled'), JSON.stringify(store, null, 2));
  ks._reset();

  const [extra] = ks.importKeys([keyFor(8)], { role: 'bundle' });
  const out = ks.remove(extra.id);

  assert.equal(out.evicted.length, 1);
  assert.equal(out.evicted[0].id, oldestId, 'the oldest deletedAt is what goes');
  assert.equal(ks.archived().length, keystore.MAX_ARCHIVED);
  assert.ok(!ks.archived().some((e) => e.id === oldestId));
});

// Last: this reloads the module graph under a different passphrase, which every
// test above would otherwise inherit.
test('the archive fails closed under a wrong passphrase, like the keystore', () => {
  const ks = keystore.keystoreFor('closed');
  const [w] = ks.generate(1, { role: 'bundle' });
  ks.remove(w.id);

  delete require.cache[require.resolve('./keystore')];
  delete require.cache[require.resolve('../config')];
  process.env.KEYSTORE_PASSPHRASE = 'wrong passphrase entirely';
  const reopened = require('./keystore').keystoreFor('closed');

  // The GCM tag means a wrong passphrase throws rather than restoring a wallet
  // whose key is garbage — which would be signed with.
  assert.throws(() => reopened.restore(w.id), /wrong KEYSTORE_PASSPHRASE/);
  // Metadata still reads, exactly as list() does on the live store: only key
  // material is protected.
  assert.ok(reopened.archived().some((x) => x.id === w.id));
});
