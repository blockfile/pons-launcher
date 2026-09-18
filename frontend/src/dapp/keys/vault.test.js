import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import { addWallets, addresses, clearWallets } from './walletStore.js';
import { hasVault, saveVault, unlockVault, wipeVault, VAULT_KEY, PBKDF2_ITERATIONS } from './vault.js';

// WebCrypto: Node 20+ exposes it as globalThis.crypto; set it explicitly in case.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

/** A Map-backed localStorage. `broken: true` throws on every call, like a private window. */
function fakeStorage({ broken = false } = {}) {
  const m = new Map();
  const guard = () => {
    if (broken) throw new Error('SecurityError: storage disabled');
  };
  return {
    map: m,
    getItem: (k) => (guard(), m.has(k) ? m.get(k) : null),
    setItem: (k, v) => (guard(), void m.set(k, String(v))),
    removeItem: (k) => (guard(), void m.delete(k)),
  };
}

function useStorage(s) {
  Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  return s;
}

function fresh(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  });
}

const PASS = 'correct horse battery';

test('PBKDF2 runs at 600 000 iterations and the record lives under tp.vault.v1', () => {
  assert.equal(PBKDF2_ITERATIONS, 600000);
  assert.equal(VAULT_KEY, 'tp.vault.v1');
});

test('save -> wrong passphrase -> right passphrase -> wipe', async () => {
  const s = useStorage(fakeStorage());
  clearWallets();
  const list = fresh(2);
  addWallets(list);
  assert.equal(hasVault(), false);

  assert.equal(await saveVault(PASS), 2);
  assert.equal(hasVault(), true);

  const raw = s.map.get('tp.vault.v1');
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec).sort(), ['ct', 'iv', 'salt', 'v']);
  assert.equal(rec.v, 1);
  assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
  assert.equal(Buffer.from(rec.iv, 'base64').length, 12);
  for (const w of list) {
    assert.ok(!raw.toLowerCase().includes(w.privateKey.slice(2).toLowerCase()), 'no key in clear');
    assert.ok(!raw.toLowerCase().includes(w.address.slice(2).toLowerCase()), 'no address in clear');
  }

  clearWallets();
  await assert.rejects(unlockVault('not the passphrase'), { message: 'wrong passphrase' });
  assert.deepEqual(addresses(), []);

  assert.equal(await unlockVault(PASS), 2);
  assert.deepEqual(addresses(), list.map((w) => w.address));

  wipeVault();
  assert.equal(hasVault(), false);
  await assert.rejects(unlockVault(PASS), { message: 'no wallets are saved on this device' });
});

test('every save uses a fresh salt and IV', async () => {
  const s = useStorage(fakeStorage());
  clearWallets();
  addWallets(fresh(1));
  await saveVault(PASS);
  const first = JSON.parse(s.map.get('tp.vault.v1'));
  await saveVault(PASS);
  const second = JSON.parse(s.map.get('tp.vault.v1'));
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ct, second.ct);
});

test('refuses a short passphrase and an empty store', async () => {
  useStorage(fakeStorage());
  clearWallets();
  await assert.rejects(saveVault('short'), /at least 10 characters/);
  await assert.rejects(saveVault('nine-char'), /at least 10 characters/, 'the vault enforces the dialog minimum');
  await assert.rejects(saveVault(PASS), /no wallets to remember/);
  assert.equal(hasVault(), false);
});

test('a corrupted record is unreadable, not a crash', async () => {
  const s = useStorage(fakeStorage());
  s.map.set('tp.vault.v1', '{"v":1,"salt":"@@","iv":"x","ct":"y"}');
  await assert.rejects(unlockVault(PASS), /unreadable/);
  s.map.set('tp.vault.v1', 'not json');
  await assert.rejects(unlockVault(PASS), /unreadable/);
});

test('storage that throws: no vault, save reports it, wipe is silent', async () => {
  useStorage(fakeStorage({ broken: true }));
  clearWallets();
  addWallets(fresh(1));
  assert.equal(hasVault(), false);
  await assert.rejects(saveVault(PASS), /refused to store/);
  assert.doesNotThrow(() => wipeVault());
  await assert.rejects(unlockVault(PASS), /no wallets are saved/);
});
