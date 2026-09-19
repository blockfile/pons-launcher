/**
 * The account copy's encryption key, derived IN THE BROWSER from the wallet's
 * signature over the frozen unlock message (messages.js):
 *
 *   ikm    r || s of the canonical signature (64 bytes; v left out: Ledger
 *          answers 0/1 where others answer 27/28)
 *   base   an HKDF key imported from ikm (WebCrypto, not extractable)
 *   key    HKDF-SHA256(salt 'rhbond-tp/vault/salt/v1',
 *                      info 'rhbond-tp/vault/aes-gcm-256/v1/' + owner) -> AES-GCM-256,
 *          NOT extractable, usages encrypt/decrypt
 *   keyId  HKDF-SHA256(same salt, info 'rhbond-tp/vault/key-id/v1/' + owner),
 *          128 bits as 0x + 32 hex. PUBLIC: the server stores it beside the
 *          ciphertext and compares it on every write, so a different key is
 *          caught before anything is overwritten, and the server still cannot
 *          decrypt anything.
 *   owner  the account's lower-case 0x address
 *
 * The signature is never sent, logged or stored: it lives in deriveVaultKey's
 * frame, and the ikm bytes are zeroed once the base key is imported. The salt
 * and info strings are FROZEN FOREVER like the message (unlockKey.test.js pins a
 * golden keyId).
 */
import { getAddress, hexlify, toUtf8Bytes } from 'ethers';
import { canonicalSignature, signerOf } from './signature.js';
import { unlockMessage } from './messages.js';

export const HKDF_SALT = 'rhbond-tp/vault/salt/v1';
export const AES_INFO = 'rhbond-tp/vault/aes-gcm-256/v1/';
export const KEY_ID_INFO = 'rhbond-tp/vault/key-id/v1/';

function webSubtle(subtle) {
  const s = subtle || (globalThis.crypto && globalThis.crypto.subtle);
  if (!s) throw new Error('this browser has no WebCrypto (the page must be served over HTTPS)');
  return s;
}

/**
 * The key and keyId for 64 bytes of r || s. Exported for the golden test.
 * @param {Uint8Array} rs
 * @param {string} address
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<{key: CryptoKey, keyId: string}>}
 */
export async function keyFromRs(rs, address, subtle) {
  if (!(rs instanceof Uint8Array) || rs.length !== 64) throw new Error('the key material must be 64 bytes');
  const sub = webSubtle(subtle);
  const owner = getAddress(String(address)).toLowerCase();
  const base = await sub.importKey('raw', rs, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = toUtf8Bytes(HKDF_SALT);
  const key = await sub.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: toUtf8Bytes(AES_INFO + owner) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const bits = await sub.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: toUtf8Bytes(KEY_ID_INFO + owner) }, base, 128);
  return { key, keyId: hexlify(new Uint8Array(bits)) };
}

/**
 * Derive from the wallet's signature over unlockMessage(address). The signature
 * must recover to `address`, or nothing is derived.
 * @param {{signature: string, address: string, subtle?: SubtleCrypto}} f
 * @returns {Promise<{key: CryptoKey, keyId: string}>}
 * @throws cause.code 'bad_signature' | 'smart_wallet' | 'wrong_signer'
 */
export async function deriveVaultKey({ signature, address, subtle }) {
  const owner = getAddress(String(address));
  const sig = canonicalSignature(signature);
  try {
    let signer;
    try {
      signer = signerOf(unlockMessage(owner), sig);
    } catch {
      signer = null;
    }
    if (signer !== owner) {
      throw new Error(`the unlock signature is not from ${owner}`, { cause: { code: 'wrong_signer' } });
    }
    return await keyFromRs(sig.rs, owner, subtle);
  } finally {
    sig.rs.fill(0);
  }
}
