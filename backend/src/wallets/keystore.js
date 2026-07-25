'use strict';

// The only module that ever touches plaintext private keys.
//
// Wallets are stored AES-256-GCM encrypted, under a key derived from
// KEYSTORE_PASSPHRASE with scrypt. The GCM auth tag means a wrong passphrase
// fails closed (decryption throws) rather than returning garbage that would
// later be signed with.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Wallet, HDNodeWallet, getAddress } = require('ethers');
const config = require('../config');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const VERSION = 1;

let cache = null; // { version, kdf, wallets: [...] }
let derivedKey = null; // Buffer, memoised per (passphrase, salt)

function passphrase() {
  if (!config.keystorePassphrase) {
    throw new Error('KEYSTORE_PASSPHRASE is not set — cannot read or write the keystore');
  }
  return config.keystorePassphrase;
}

function deriveKey(saltHex) {
  if (derivedKey) return derivedKey;
  derivedKey = crypto.scryptSync(passphrase(), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return derivedKey;
}

function emptyStore() {
  return { version: VERSION, kdf: { salt: crypto.randomBytes(32).toString('hex'), ...SCRYPT }, wallets: [] };
}

function load() {
  if (cache) return cache;
  if (!fs.existsSync(config.keystorePath)) {
    cache = emptyStore();
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(config.keystorePath, 'utf8'));
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(config.keystorePath), { recursive: true });
  // 0600 — the keystore is only ever readable by the account running the app.
  fs.writeFileSync(config.keystorePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function encrypt(plaintext) {
  const store = load();
  const key = deriveKey(store.kdf.salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ct.toString('hex'),
  };
}

function decrypt(record) {
  const store = load();
  const key = deriveKey(store.kdf.salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch (_err) {
    // GCM tag mismatch — wrong passphrase, or the file was tampered with.
    throw new Error('could not decrypt wallet — wrong KEYSTORE_PASSPHRASE?');
  }
}

function publicView(w) {
  return { id: w.id, address: w.address, label: w.label, role: w.role, createdAt: w.createdAt };
}

/** Every wallet, without keys. Never returns key material. */
function list() {
  return load().wallets.map(publicView);
}

function get(id) {
  const w = load().wallets.find((x) => x.id === id);
  if (!w) throw new Error(`no wallet ${id}`);
  return w;
}

function add(privateKey, { label, role }) {
  const wallet = new Wallet(privateKey);
  const store = load();
  if (store.wallets.some((w) => w.address.toLowerCase() === wallet.address.toLowerCase())) {
    throw new Error(`wallet ${wallet.address} is already in the keystore`);
  }
  // Only one dev wallet: it is the launch signer and the funding source, and
  // two of them would silently make "the dev wallet" ambiguous.
  if (role === 'dev' && store.wallets.some((w) => w.role === 'dev')) {
    throw new Error('a dev wallet already exists — delete it first');
  }
  const record = {
    id: crypto.randomUUID(),
    address: getAddress(wallet.address),
    label: label || (role === 'dev' ? 'dev' : 'bundle'),
    role: role === 'dev' ? 'dev' : 'bundle',
    createdAt: new Date().toISOString(),
    ...encrypt(wallet.privateKey),
  };
  store.wallets.push(record);
  persist();
  return publicView(record);
}

/** Generate `count` fresh wallets. Robinhood Chain is EVM — plain secp256k1. */
function generate(count, { label, role } = {}) {
  const made = [];
  for (let i = 0; i < count; i++) {
    const w = HDNodeWallet.createRandom();
    made.push(add(w.privateKey, { label: label ? `${label}-${i + 1}` : undefined, role }));
  }
  return made;
}

/** Import existing keys (0x-prefixed or bare hex). */
function importKeys(privateKeys, { label, role } = {}) {
  return privateKeys
    .map((k) => String(k).trim())
    .filter(Boolean)
    .map((k, i) => {
      const key = k.startsWith('0x') ? k : `0x${k}`;
      return add(key, { label: label ? `${label}-${i + 1}` : undefined, role });
    });
}

function remove(id) {
  const store = load();
  const before = store.wallets.length;
  store.wallets = store.wallets.filter((w) => w.id !== id);
  if (store.wallets.length === before) throw new Error(`no wallet ${id}`);
  persist();
  return { removed: id };
}

/** A signer for `id`. Plaintext keys exist only inside this call's stack. */
function signer(id, provider) {
  const record = get(id);
  const wallet = new Wallet(decrypt(record));
  return provider ? wallet.connect(provider) : wallet;
}

/** Deliberate key export. Callers must gate this behind explicit confirmation. */
function exportKey(id) {
  return { address: get(id).address, privateKey: decrypt(get(id)) };
}

/**
 * Every wallet with its plaintext key, for the operator to back up offline.
 *
 * There are no mnemonics to return: generate() derives each wallet from its own
 * random HD node but stores only the private key, so the phrase is gone the
 * moment the wallet is created. A private key restores a wallet in any EVM
 * client, which is what a backup needs to do.
 *
 * The most dangerous call in the app — the caller must demand explicit
 * confirmation and log it.
 */
function exportAll() {
  return load().wallets.map((w) => ({
    ...publicView(w),
    privateKey: decrypt(w),
  }));
}

function devWallet() {
  const dev = load().wallets.find((w) => w.role === 'dev');
  if (!dev) throw new Error('no dev wallet in the keystore — generate or import one first');
  return publicView(dev);
}

function bundleWallets() {
  return load().wallets.filter((w) => w.role === 'bundle').map(publicView);
}

/** Test seam — drops the in-memory cache and derived key. */
function _reset() {
  cache = null;
  derivedKey = null;
}

module.exports = {
  list,
  generate,
  importKeys,
  remove,
  signer,
  exportKey,
  exportAll,
  devWallet,
  bundleWallets,
  _reset,
};
