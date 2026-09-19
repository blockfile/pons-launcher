import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import { MAX_PLAIN_BYTES, PAD_BYTES, fromB64, open, seal } from './envelope.js';
import { keyFromRs } from './unlockKey.js';

const subtle = webcrypto.subtle;
const randomKey = async (owner) => (await keyFromRs(webcrypto.getRandomValues(new Uint8Array(64)), owner, subtle)).key;

function plainFor(owner, n) {
  const wallets = Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey, tags: ['0123456789abcdef'] };
  });
  return { v: 2, owner: owner.toLowerCase(), savedAt: 5, wallets, removed: {}, positions: {} };
}

test('seal pads to 4 KiB blocks, uses a fresh IV, and open returns the plaintext', async () => {
  const owner = Wallet.createRandom().address;
  const key = await randomKey(owner);
  const plain = plainFor(owner, 3);
  const a = await seal({ key, owner, plain, subtle });
  const b = await seal({ key, owner, plain, subtle });
  assert.equal(a.kv, 1);
  assert.equal(fromB64(a.iv).length, 12);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(fromB64(a.ct).length, PAD_BYTES + 16, 'one padded block plus the GCM tag');
  assert.deepEqual(await open({ key, owner, envelope: a, subtle }), plain);
  const big = plainFor(owner, 40); // ~6.8 KB of JSON
  assert.equal(fromB64((await seal({ key, owner, plain: big, subtle })).ct).length, 2 * PAD_BYTES + 16);
});

test('the size does not tell 1 wallet from 20', async () => {
  const owner = Wallet.createRandom().address;
  const key = await randomKey(owner);
  const one = await seal({ key, owner, plain: plainFor(owner, 1), subtle });
  const twenty = await seal({ key, owner, plain: plainFor(owner, 20), subtle });
  assert.equal(one.ct.length, twenty.ct.length);
});

test("the ciphertext is bound to its account: another owner, another key or a flipped byte does not open", async () => {
  const owner = Wallet.createRandom().address;
  const other = Wallet.createRandom().address;
  const key = await randomKey(owner);
  const env = await seal({ key, owner, plain: plainFor(owner, 1), subtle });
  await assert.rejects(open({ key, owner: other, envelope: env, subtle }), (e) => e.cause.code === 'undecryptable');
  await assert.rejects(open({ key: await randomKey(owner), owner, envelope: env, subtle }), (e) => e.cause.code === 'undecryptable');
  const bytes = fromB64(env.ct);
  bytes[10] ^= 1;
  const flipped = { ...env, ct: Buffer.from(bytes).toString('base64') };
  await assert.rejects(open({ key, owner, envelope: flipped, subtle }), (e) => e.cause.code === 'undecryptable');
  await assert.rejects(open({ key, owner, envelope: { ...env, kv: 2 }, subtle }), (e) => e.cause.code === 'unreadable');
});

test('a plaintext for another owner is unreadable even under the right key', async () => {
  const owner = Wallet.createRandom().address;
  const key = await randomKey(owner);
  const env = await seal({ key, owner, plain: { ...plainFor(owner, 1), owner: '0x' + '1'.repeat(40) }, subtle });
  await assert.rejects(open({ key, owner, envelope: env, subtle }), (e) => e.cause.code === 'unreadable');
});

test('more than the 252 KiB plaintext budget is refused before encrypting', async () => {
  const owner = Wallet.createRandom().address;
  const key = await randomKey(owner);
  assert.equal(MAX_PLAIN_BYTES, 258048);
  const plain = { v: 2, owner: owner.toLowerCase(), savedAt: 1, wallets: [], removed: {}, positions: { pad: 'x'.repeat(MAX_PLAIN_BYTES) } };
  await assert.rejects(seal({ key, owner, plain, subtle }), (e) => e.cause.code === 'too_large');
});
