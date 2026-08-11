'use strict';

// The archive: what a delete now does, and what makes it undoable.
//
// Kept apart from keystore.test.js because that file ends with adoptLegacy,
// which renames the default keystore out from under everything before it — and
// because these tests are about one property the rest of the suite does not
// cover: that a deleted key is still there, still encrypted, and still only
// this user's.

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
