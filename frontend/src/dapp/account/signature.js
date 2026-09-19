/**
 * A wallet's 65-byte personal_sign signature, made canonical by hand.
 *
 * ethers' Signature.from and verifyMessage THROW on a high-s signature, and a
 * Ledger behind MetaMask answers v in {0, 1} where software wallets answer
 * {27, 28}. The same signature can therefore arrive in four spellings. This
 * module folds them into one: s <= n/2 (flipping the parity when s is replaced by
 * n - s) and v = 27 + parity. rs (r || s, 64 bytes) is what the unlock key is
 * derived from, so the four spellings give ONE key; v is left out of it.
 *
 * A longer answer (ERC-6492 / ERC-1271 smart-wallet signatures, e.g. Coinbase
 * Smart Wallet) cannot be recovered with ecrecover and cannot give a stable key:
 * it is refused with code 'smart_wallet'.
 *
 * Errors never carry the signature: for the unlock message it is key material.
 */
import { getAddress, getBytes, hashMessage, recoverAddress } from 'ethers';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const HEX_RE = /^0x([0-9a-fA-F]{2})+$/;

function fail(message, code) {
  return new Error(message, { cause: { code } });
}

const hex32 = (n) => n.toString(16).padStart(64, '0');

/**
 * @param {string} signature 0x-hex from personal_sign
 * @returns {{r: string, s: string, yParity: 0|1, rs: Uint8Array, serialized: string}}
 *   serialized = 0x + r + s + v (v = 1b or 1c), lower-case, 132 characters
 * @throws cause.code 'bad_signature' | 'smart_wallet'
 */
export function canonicalSignature(signature) {
  if (typeof signature !== 'string' || !HEX_RE.test(signature)) {
    throw fail('the wallet returned something that is not a signature', 'bad_signature');
  }
  const bytes = getBytes(signature);
  if (bytes.length > 65) throw fail("smart-contract wallets can't hold saved wallets", 'smart_wallet');
  if (bytes.length !== 65) throw fail('the wallet returned something that is not a signature', 'bad_signature');
  let r = 0n;
  let s = 0n;
  for (let i = 0; i < 32; i += 1) r = (r << 8n) | BigInt(bytes[i]);
  for (let i = 32; i < 64; i += 1) s = (s << 8n) | BigInt(bytes[i]);
  let v = bytes[64];
  if (v >= 27) v -= 27;
  bytes.fill(0);
  if ((v !== 0 && v !== 1) || r === 0n || r >= N || s === 0n || s >= N) {
    throw fail('the wallet returned something that is not a signature', 'bad_signature');
  }
  if (s > HALF_N) {
    s = N - s;
    v ^= 1;
  }
  const rHex = hex32(r);
  const sHex = hex32(s);
  return {
    r: `0x${rHex}`,
    s: `0x${sHex}`,
    yParity: v,
    rs: getBytes(`0x${rHex}${sHex}`),
    serialized: `0x${rHex}${sHex}${(27 + v).toString(16)}`,
  };
}

/**
 * The checksummed address that signed `message` (EIP-191 personal message).
 * @param {string} message
 * @param {{r: string, s: string, yParity: 0|1}} sig a canonicalSignature result
 * @returns {string}
 */
export function signerOf(message, sig) {
  return getAddress(recoverAddress(hashMessage(message), { r: sig.r, s: sig.s, yParity: sig.yParity }));
}
