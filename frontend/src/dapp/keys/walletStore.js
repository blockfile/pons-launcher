/**
 * The in-memory key store. The ONE place in the dApp that holds private keys.
 *
 * The Map below is module-private: nothing outside this file can reach it, and no
 * export returns a Wallet or a key — the UI gets addresses, and signing happens
 * here (spec: "UI reads addresses only; signing goes through sign(address, tx)").
 * The two underscore exports exist for vault.js (encrypted "Remember on this
 * device") and account/vaultSync.js (the account's encrypted copy) alone;
 * nothing else may import them (keys/privateExports.test.js enforces it).
 *
 * subscribe(fn) reports every change as {type: 'add' | 'duplicate' | 'remove' |
 * 'clear', addresses} — checksummed addresses only, never a key — so the account
 * copy can follow imports and removals without the UI remembering to tell it.
 * 'duplicate' is an import of wallets already here: nothing changes in the tab,
 * but the account copy counts it as a new import (account/vaultSync.js).
 *
 * Keys are never logged and never put in an error message. Library errors from a
 * bad key are replaced with fixed text, because some secp256k1 libraries print the
 * offending scalar in their range errors.
 */
import { SigningKey, Transaction, computeAddress, getAddress } from 'ethers';

/** lower-case address -> {address, key: SigningKey}. Insertion order = import order. */
const store = new Map();

/** Change listeners: fn({type, addresses}). */
const listeners = new Set();

function notify(type, list) {
  if (!list.length) return;
  const event = { type, addresses: list };
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch {
      // A listener's bug must not undo or block a key change.
    }
  }
}

/**
 * Follow changes to the store. fn({type: 'add' | 'duplicate' | 'remove' | 'clear',
 * addresses}) runs synchronously after the change, only when something was
 * imported, removed or cleared.
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// A SigningKey and a Transaction, not an ethers Wallet: a Wallet drags the JSON
// keystore (scrypt, AES), the HD wallet and the mnemonic wordlist into the page's
// first load, and none of that is used here.
function toWallet(item, index) {
  let wallet;
  try {
    const raw = String(item.privateKey);
    const key = new SigningKey(raw.startsWith('0x') || raw.startsWith('0X') ? `0x${raw.slice(2)}` : `0x${raw}`);
    wallet = { address: computeAddress(key.publicKey), key };
  } catch {
    throw new Error(`wallet ${index + 1}: not a valid private key`);
  }
  if (item.address != null) {
    let named;
    try {
      named = getAddress(String(item.address));
    } catch {
      throw new Error(`wallet ${index + 1}: not a valid address`);
    }
    if (named !== wallet.address) throw new Error(`wallet ${index + 1}: key does not match ${named}`);
  }
  return wallet;
}

/**
 * Add wallets. All-or-nothing: every entry is validated before any is stored, so
 * a bad entry cannot leave half an import behind.
 * @param {{address?: string, privateKey: string}[]} list
 * @returns {{added: number, duplicates: number}} duplicates = already held (or repeated in list)
 */
export function addWallets(list) {
  if (!Array.isArray(list)) throw new Error('addWallets expects a list');
  const wallets = list.map(toWallet);
  const fresh = [];
  const again = [];
  for (const wallet of wallets) {
    const k = wallet.address.toLowerCase();
    if (store.has(k)) {
      again.push(store.get(k).address);
      continue;
    }
    store.set(k, wallet);
    fresh.push(wallet.address);
  }
  notify('add', fresh);
  notify('duplicate', again);
  return { added: fresh.length, duplicates: again.length };
}

/** @returns {string[]} checksummed addresses, in import order */
export function addresses() {
  return [...store.values()].map((w) => w.address);
}

/** @returns {boolean} whether a wallet was removed */
export function removeWallet(address) {
  const k = String(address).toLowerCase();
  const wallet = store.get(k);
  if (!wallet) return false;
  store.delete(k);
  notify('remove', [wallet.address]);
  return true;
}

export function clearWallets() {
  const list = addresses();
  store.clear();
  notify('clear', list);
}

/**
 * Sign a transaction with the named wallet's key.
 * @param {string} address
 * @param {object} txRequest {to, data, value, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, chainId, type}
 *   — fully populated: there is no provider here, nothing is filled in.
 * @returns {Promise<string>} the signed raw transaction (0x hex)
 */
export async function signTx(address, txRequest) {
  const wallet = store.get(String(address).toLowerCase());
  if (!wallet) throw new Error(`no key loaded for ${address}`);
  if (txRequest && txRequest.from != null && getAddress(String(txRequest.from)) !== wallet.address) {
    throw new Error(`transaction from ${txRequest.from} cannot be signed by ${wallet.address}`);
  }
  const { from: _from, ...fields } = txRequest || {};
  const tx = Transaction.from(fields);
  tx.signature = wallet.key.sign(tx.unsignedHash);
  return tx.serialized;
}

/** vault.js and account/vaultSync.js ONLY. @returns {{address: string, privateKey: string}[]} */
export function _exportForVault() {
  return [...store.values()].map((w) => ({ address: w.address, privateKey: w.key.privateKey }));
}

/** vault.js and account/vaultSync.js ONLY. */
export function _importFromVault(list) {
  return addWallets(list);
}
