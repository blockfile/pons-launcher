/**
 * The account copy's ciphertext (spec Addendum A, "Sync").
 *
 *   plaintext  JSON {v: 2, owner, savedAt, wallets: [{address, privateKey, tags}],
 *              removed: {address: {at, tags}}, positions: {token: {wallet: record}}}
 *              (vaultSync.js: the wallet set; positionsMap.js: the records),
 *              padded with spaces to a multiple of 4 KiB so the size does not
 *              tell how many wallets it holds (JSON.parse ignores the spaces)
 *   cipher     AES-GCM-256 with the account key (unlockKey.js), a fresh random
 *              12-byte IV per save, additionalData 'rhbond-tp/vault/v2/' + owner + '/kv1'
 *              (binds the ciphertext to its account and key version: a copy moved
 *              to another account does not decrypt)
 *   sent as    {kv: 1, iv: base64, ct: base64}; the server adds keyId, rev, updatedAt
 *
 * The largest plaintext is 252 KiB (the server's 256 KiB cap minus the 16-byte
 * GCM tag, rounded down to the padding block). Plaintext bytes are zeroed after
 * use; the JSON string itself cannot be (JavaScript strings are immutable), the
 * same limit keys/vault.js lives with.
 */
import { toUtf8Bytes } from 'ethers';

export const KEY_VERSION = 1;
export const PAD_BYTES = 4096;
export const MAX_CT_BYTES = 262144;
export const MAX_PLAIN_BYTES = Math.floor((MAX_CT_BYTES - 16) / PAD_BYTES) * PAD_BYTES;
const SPACE = 0x20;

function fail(message, code) {
  return new Error(message, { cause: { code } });
}

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** additionalData for an account's copy. */
export function aadFor(owner) {
  return toUtf8Bytes(`rhbond-tp/vault/v2/${String(owner).toLowerCase()}/kv${KEY_VERSION}`);
}

/**
 * Encrypt a plaintext object for `owner`.
 * @returns {Promise<{kv: 1, iv: string, ct: string}>}
 * @throws cause.code 'too_large' when the JSON exceeds MAX_PLAIN_BYTES
 */
export async function seal({ key, owner, plain, subtle = globalThis.crypto.subtle, getRandomValues = (b) => globalThis.crypto.getRandomValues(b) }) {
  const json = toUtf8Bytes(JSON.stringify(plain));
  if (json.length > MAX_PLAIN_BYTES) {
    json.fill(0);
    throw fail('too many wallets to save in the account (the copy is limited to 256 KiB)', 'too_large');
  }
  const padded = new Uint8Array(Math.max(PAD_BYTES, Math.ceil(json.length / PAD_BYTES) * PAD_BYTES)).fill(SPACE);
  padded.set(json);
  json.fill(0);
  const iv = getRandomValues(new Uint8Array(12));
  try {
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(owner) }, key, padded));
    return { kv: KEY_VERSION, iv: toB64(iv), ct: toB64(ct) };
  } finally {
    padded.fill(0);
  }
}

/**
 * Decrypt a stored copy of `owner`'s.
 * @param {{key: CryptoKey, owner: string, envelope: {kv: number, iv: string, ct: string}, subtle?: SubtleCrypto}} f
 * @returns {Promise<object>} the plaintext object (v 2, this owner)
 * @throws cause.code 'undecryptable' (wrong key, another account's copy, tampered) | 'unreadable'
 */
export async function open({ key, owner, envelope, subtle = globalThis.crypto.subtle }) {
  if (!envelope || envelope.kv !== KEY_VERSION) throw fail('the saved copy uses a key version this page does not know', 'unreadable');
  let plainBytes;
  try {
    plainBytes = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv), additionalData: aadFor(owner) }, key, fromB64(envelope.ct))
    );
  } catch {
    throw fail('the saved copy could not be decrypted with this key', 'undecryptable');
  }
  let plain;
  try {
    plain = JSON.parse(new TextDecoder().decode(plainBytes));
  } catch {
    plain = null;
  } finally {
    plainBytes.fill(0);
  }
  if (!plain || typeof plain !== 'object' || plain.v !== 2 || plain.owner !== String(owner).toLowerCase() || !Array.isArray(plain.wallets)) {
    throw fail('the saved copy is unreadable', 'unreadable');
  }
  return plain;
}
