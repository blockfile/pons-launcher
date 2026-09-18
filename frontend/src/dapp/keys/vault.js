/**
 * "Remember on this device": the wallets in walletStore, encrypted with a
 * passphrase, in this browser's localStorage. Optional; off unless the visitor
 * ticks it (spec: Decisions 3).
 *
 *   key derivation  PBKDF2-SHA256, 600 000 iterations, random 16-byte salt
 *   cipher          AES-GCM 256, random 12-byte IV, AAD = the storage key name
 *   stored as       localStorage['tp.vault.v1'] = JSON {v: 1, salt, iv, ct}, base64
 *
 * A fresh salt and IV on every save. The passphrase is never stored. A wrong
 * passphrase fails AES-GCM authentication and is reported as 'wrong passphrase'
 * (a tampered record reads the same — GCM cannot tell them apart).
 *
 * Every localStorage access is in try/catch: storage throws in private windows and
 * with blocked site data. Reading then behaves as "no vault"; saving reports that
 * the browser refused.
 */
import { _exportForVault, _importFromVault } from './walletStore.js';

export const VAULT_KEY = 'tp.vault.v1';
export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSPHRASE = 8;

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode(VAULT_KEY);
const UNREADABLE = 'the saved wallets on this device are unreadable';

function webCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('this browser has no WebCrypto (the page must be served over HTTPS)');
  return c;
}

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt) {
  const { subtle } = webCrypto();
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function readRecord() {
  try {
    return localStorage.getItem(VAULT_KEY);
  } catch {
    return null;
  }
}

/** @returns {boolean} whether an encrypted vault is stored on this device */
export function hasVault() {
  return readRecord() !== null;
}

/**
 * Encrypt every wallet currently in walletStore and store it, replacing any
 * earlier vault.
 * @returns {Promise<number>} wallets saved
 */
export async function saveVault(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const list = _exportForVault();
  if (!list.length) throw new Error('there are no wallets to remember');
  const c = webCrypto();
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const plain = enc.encode(JSON.stringify(list));
  let ct;
  try {
    ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
  } finally {
    plain.fill(0);
  }
  const record = JSON.stringify({ v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
  try {
    localStorage.setItem(VAULT_KEY, record);
  } catch {
    throw new Error('this browser refused to store the wallets (private window or blocked site data)');
  }
  return list.length;
}

/**
 * Decrypt the vault and load its wallets into walletStore.
 * @returns {Promise<number>} wallets restored (the number in the vault)
 * @throws Error('wrong passphrase') | Error('no wallets are saved on this device') | Error(unreadable)
 */
export async function unlockVault(passphrase) {
  const raw = readRecord();
  if (raw === null) throw new Error('no wallets are saved on this device');
  let salt;
  let iv;
  let ct;
  try {
    const rec = JSON.parse(raw);
    if (!rec || rec.v !== 1) throw new Error(UNREADABLE);
    salt = fromB64(rec.salt);
    iv = fromB64(rec.iv);
    ct = fromB64(rec.ct);
  } catch {
    throw new Error(UNREADABLE);
  }
  if (salt.length !== 16 || iv.length !== 12 || ct.length < 17) throw new Error(UNREADABLE);

  const key = await deriveKey(String(passphrase ?? ''), salt);
  let plain;
  try {
    plain = new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, ct));
  } catch {
    throw new Error('wrong passphrase');
  }
  let list;
  try {
    list = JSON.parse(dec.decode(plain));
  } catch {
    list = null;
  } finally {
    plain.fill(0);
  }
  if (!Array.isArray(list)) throw new Error(UNREADABLE);
  _importFromVault(list);
  return list.length;
}

/** Delete the stored vault. Never throws. The in-memory wallets are untouched. */
export function wipeVault() {
  try {
    localStorage.removeItem(VAULT_KEY);
  } catch {
    // storage unavailable: there is nothing this page can remove
  }
}
