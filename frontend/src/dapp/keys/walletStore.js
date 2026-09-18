/**
 * The in-memory key store. The ONE place in the dApp that holds private keys.
 *
 * The Map below is module-private: nothing outside this file can reach it, and no
 * export returns a Wallet or a key — the UI gets addresses, and signing happens
 * here (spec: "UI reads addresses only; signing goes through sign(address, tx)").
 * The two underscore exports exist for vault.js alone (encrypted "Remember on this
 * device"); nothing else may import them.
 *
 * Keys are never logged and never put in an error message. Library errors from a
 * bad key are replaced with fixed text, because some secp256k1 libraries print the
 * offending scalar in their range errors.
 */
import { Wallet, getAddress } from 'ethers';

/** lower-case address -> ethers Wallet (no provider: signing only). Insertion order = import order. */
const store = new Map();

function toWallet(item, index) {
  let wallet;
  try {
    wallet = new Wallet(String(item.privateKey));
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
  let added = 0;
  let duplicates = 0;
  for (const wallet of wallets) {
    const k = wallet.address.toLowerCase();
    if (store.has(k)) {
      duplicates += 1;
      continue;
    }
    store.set(k, wallet);
    added += 1;
  }
  return { added, duplicates };
}

/** @returns {string[]} checksummed addresses, in import order */
export function addresses() {
  return [...store.values()].map((w) => w.address);
}

/** @returns {boolean} whether a wallet was removed */
export function removeWallet(address) {
  return store.delete(String(address).toLowerCase());
}

export function clearWallets() {
  store.clear();
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
  return wallet.signTransaction(txRequest);
}

/** vault.js ONLY. @returns {{address: string, privateKey: string}[]} */
export function _exportForVault() {
  return [...store.values()].map((w) => ({ address: w.address, privateKey: w.privateKey }));
}

/** vault.js ONLY. */
export function _importFromVault(list) {
  return addWallets(list);
}
