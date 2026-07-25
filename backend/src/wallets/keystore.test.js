'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-keystore-'));
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'correct horse battery staple';

const keystore = require('./keystore');

test('generates wallets and never exposes keys in list()', () => {
  const made = keystore.generate(3, { label: 'bundle', role: 'bundle' });
  assert.equal(made.length, 3);

  const listed = keystore.list();
  assert.equal(listed.length, 3);
  for (const w of listed) {
    assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(w.ciphertext, undefined);
    assert.equal(w.privateKey, undefined);
  }
});

test('round-trips a key through encryption', () => {
  const [w] = keystore.generate(1, { role: 'bundle' });
  const signer = keystore.signer(w.id);
  assert.equal(signer.address, w.address);
  assert.equal(keystore.exportKey(w.id).address, w.address);
});

test('the stored file contains no plaintext key', () => {
  const [w] = keystore.generate(1, { role: 'bundle' });
  const { privateKey } = keystore.exportKey(w.id);
  const raw = fs.readFileSync(process.env.KEYSTORE_PATH, 'utf8');
  assert.ok(!raw.includes(privateKey), 'private key must not appear in the keystore file');
  assert.ok(!raw.includes(privateKey.slice(2)), 'unprefixed key must not appear either');
});

test('imports a key and rejects a duplicate', () => {
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const [imported] = keystore.importKeys([key], { role: 'bundle' });
  assert.match(imported.address, /^0x/);
  assert.throws(() => keystore.importKeys([key], { role: 'bundle' }), /already in the keystore/);
});

test('allows only one dev wallet', () => {
  keystore.generate(1, { role: 'dev' });
  assert.equal(keystore.devWallet().role, 'dev');
  assert.throws(() => keystore.generate(1, { role: 'dev' }), /dev wallet already exists/);
});

test('separates dev from bundle wallets', () => {
  assert.ok(keystore.bundleWallets().length >= 3);
  assert.ok(keystore.bundleWallets().every((w) => w.role === 'bundle'));
});

test('exportAll returns a usable key for every wallet', () => {
  const before = keystore.list();
  const backup = keystore.exportAll();

  assert.equal(backup.length, before.length);
  for (const w of backup) {
    // A backup is only worth having if each entry restores its own wallet.
    assert.match(w.privateKey, /^0x[0-9a-f]{64}$/i);
    assert.equal(new Wallet(w.privateKey).address, w.address);
    assert.ok(w.role && w.id);
  }
});

test('removes a wallet', () => {
  const [w] = keystore.generate(1, { role: 'bundle' });
  keystore.remove(w.id);
  assert.throws(() => keystore.signer(w.id), /no wallet/);
});

test('a wrong passphrase fails closed rather than returning garbage', () => {
  const [w] = keystore.generate(1, { role: 'bundle' });

  // Reload the module graph under a different passphrase — same file on disk.
  delete require.cache[require.resolve('./keystore')];
  delete require.cache[require.resolve('../config')];
  process.env.KEYSTORE_PASSPHRASE = 'wrong passphrase entirely';
  const reopened = require('./keystore');

  assert.throws(() => reopened.signer(w.id), /wrong KEYSTORE_PASSPHRASE/);

  // Public metadata still reads fine — only key material is protected.
  assert.ok(reopened.list().some((x) => x.id === w.id));
});

test('two users cannot see each other wallets', () => {
  const a = keystore.keystoreFor('alice');
  const b = keystore.keystoreFor('bob');

  const [aw] = a.generate(1, { role: 'dev' });
  const [bw] = b.generate(1, { role: 'dev' });

  assert.ok(a.list().some((w) => w.id === aw.id));
  assert.ok(!a.list().some((w) => w.id === bw.id));
  assert.ok(!b.list().some((w) => w.id === aw.id));

  // The isolation is structural: a foreign id is simply not in this store.
  assert.throws(() => a.signer(bw.id), /no wallet/);
  assert.throws(() => a.exportKey(bw.id), /no wallet/);
  assert.throws(() => a.remove(bw.id), /no wallet/);
});

test('each user gets their own dev wallet', () => {
  // The "only one dev wallet" rule is per user, not per deployment.
  const a = keystore.keystoreFor('alice');
  assert.throws(() => a.generate(1, { role: 'dev' }), /already exists/);
  assert.equal(keystore.keystoreFor('carol').generate(1, { role: 'dev' }).length, 1);
});

test('the default user reads the original path', () => {
  const legacy = keystore.keystoreFor('default');
  assert.deepEqual(
    legacy.list().map((w) => w.id).sort(),
    keystore.list().map((w) => w.id).sort()
  );
});
