import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, webcrypto } from 'node:crypto';
import { Wallet, getBytes, hexlify } from 'ethers';
import { canonicalSignature, signerOf } from './signature.js';
import { deriveVaultKey, keyFromRs } from './unlockKey.js';
import { unlockMessage } from './messages.js';
import { fakeEip1193 } from './fakeEip1193.js';

const subtle = webcrypto.subtle;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

async function unlockSig(wallet, opts) {
  const p = fakeEip1193(wallet, opts);
  return p.request({ method: 'personal_sign', params: [hexlify(new TextEncoder().encode(unlockMessage(wallet.address))), wallet.address] });
}

test('golden: keyId and the AES key are HKDF-SHA256 with the frozen salt and info strings', async () => {
  const rs = new Uint8Array(64).map((_, i) => i + 1); // fixed bytes, not a signature of anything
  const { key, keyId } = await keyFromRs(rs, ADDR, subtle);
  // FROZEN: changing the salt or an info string changes every user's key.
  assert.equal(keyId, '0x664fefd1952dc67340248afda3e2fd96');
  // The AES key is HKDF(ikm, salt, 'rhbond-tp/vault/aes-gcm-256/v1/' + owner): Node's own HKDF
  // gives the same bytes, so ciphertext from one decrypts with the other.
  const owner = ADDR.toLowerCase();
  const raw = new Uint8Array(hkdfSync('sha256', rs, 'rhbond-tp/vault/salt/v1', `rhbond-tp/vault/aes-gcm-256/v1/${owner}`, 32));
  const ref = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, ref, new TextEncoder().encode('golden'));
  assert.equal(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)), 'golden');
});

test('the derived key is AES-GCM-256, not extractable, encrypt/decrypt only', async () => {
  const w = Wallet.createRandom();
  const { key } = await deriveVaultKey({ signature: await unlockSig(w), address: w.address, subtle });
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  assert.equal(key.extractable, false);
  assert.deepEqual([...key.usages].sort(), ['decrypt', 'encrypt']);
  await assert.rejects(subtle.exportKey('raw', key));
});

test('one key from all four spellings of the signature: v 27/28 or 0/1, low or high s', async () => {
  const w = Wallet.createRandom();
  const ids = new Set();
  for (const opts of [{}, { v01: true }, { highS: true }, { highS: true, v01: true }]) {
    const { keyId } = await deriveVaultKey({ signature: await unlockSig(w, opts), address: w.address, subtle });
    ids.add(keyId);
  }
  assert.equal(ids.size, 1);
});

test('different accounts get different keys; a hedged wallet gets a new key every time', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const ka = await deriveVaultKey({ signature: await unlockSig(a), address: a.address, subtle });
  const kb = await deriveVaultKey({ signature: await unlockSig(b), address: b.address, subtle });
  assert.notEqual(ka.keyId, kb.keyId);
  const h1 = await deriveVaultKey({ signature: await unlockSig(a, { hedged: true }), address: a.address, subtle });
  const h2 = await deriveVaultKey({ signature: await unlockSig(a, { hedged: true }), address: a.address, subtle });
  assert.notEqual(h1.keyId, h2.keyId, 'valid signatures, different bytes: exactly what the double sign must catch');
});

test('nothing is derived from a signature by another account or over another message', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  await assert.rejects(deriveVaultKey({ signature: await unlockSig(b), address: a.address, subtle }), (e) => e.cause.code === 'wrong_signer');
  const overOther = await a.signMessage('something else');
  await assert.rejects(deriveVaultKey({ signature: overOther, address: a.address, subtle }), (e) => e.cause.code === 'wrong_signer');
});

test('canonicalSignature: low s, v 27/28, 132 lower-case characters; smart-wallet and junk refused', async () => {
  const w = Wallet.createRandom();
  const low = await w.signMessage('x');
  const b = getBytes(low);
  const s = BigInt(hexlify(b.slice(32, 64)));
  const high = `${hexlify(b.slice(0, 32))}${(N - s).toString(16).padStart(64, '0')}${(b[64] === 27 ? 28 : 27).toString(16)}`;
  const c1 = canonicalSignature(low);
  const c2 = canonicalSignature(high.toUpperCase().replace('0X', '0x'));
  assert.equal(c1.serialized, low.toLowerCase());
  assert.equal(c2.serialized, c1.serialized);
  assert.match(c1.serialized, /^0x[0-9a-f]{130}$/);
  assert.equal(signerOf('x', c2), w.address);
  assert.equal(c1.rs.length, 64);
  assert.throws(() => canonicalSignature(`${low}${'00'.repeat(100)}`), (e) => e.cause.code === 'smart_wallet');
  for (const bad of [low.slice(0, -2), '0x', 'nope', `${low.slice(0, -2)}05`, `0x${'00'.repeat(64)}1b`, 42]) {
    assert.throws(() => canonicalSignature(bad), (e) => e.cause.code === 'bad_signature', String(bad));
  }
});

test('errors never carry the signature', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const sig = await unlockSig(b);
  try {
    await deriveVaultKey({ signature: sig, address: a.address, subtle });
    assert.fail('should refuse');
  } catch (e) {
    assert.ok(!e.message.includes(sig.slice(2, 40)));
  }
});
