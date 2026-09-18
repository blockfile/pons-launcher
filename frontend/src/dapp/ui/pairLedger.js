/**
 * Pair-token proceeds the page still has to turn into ETH, remembered across a
 * reload or a token switch — so the next visit's baseline ("what the wallet
 * held before") does not swallow them and leave them unconverted for good.
 *
 * Stored in localStorage['tp.pairOwed.v1'] as {id: {owed, at}}: an AMOUNT and a
 * time, keyed by a HASH of (pair token, wallet address) — never an address in
 * the clear, so the device does not keep a readable list of the visitor's
 * wallets. No key, nothing signed. Entries older than 7 days are dropped.
 *
 * Every storage access is in try/catch (private windows, blocked site data):
 * reading then answers 0 — the pre-ledger behaviour — and writing does nothing.
 */
const KEY = 'tp.pairOwed.v1';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DECIMAL = /^[0-9]+$/;

/**
 * @param {{storage: {getItem, setItem, removeItem}|null, hash: (text: string) => string, now?: () => number}} deps
 * @returns {{get(pairToken, address): bigint, set(pairToken, address, amount: bigint): void}}
 */
export function createPairLedger({ storage, hash, now = () => Date.now() }) {
  const idOf = (pairToken, address) => hash(`${String(pairToken).toLowerCase()}:${String(address).toLowerCase()}`);

  function read() {
    try {
      const raw = storage ? storage.getItem(KEY) : null;
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      return {};
    }
  }

  function write(obj) {
    try {
      if (!storage) return;
      if (Object.keys(obj).length) storage.setItem(KEY, JSON.stringify(obj));
      else storage.removeItem(KEY);
    } catch {
      // storage refused: this visit still converts; a reload may not
    }
  }

  const live = (e, t) => !!e && typeof e.owed === 'string' && DECIMAL.test(e.owed) && Number.isFinite(e.at) && t - e.at <= MAX_AGE_MS;

  return {
    get(pairToken, address) {
      const e = read()[idOf(pairToken, address)];
      return live(e, now()) ? BigInt(e.owed) : 0n;
    },
    set(pairToken, address, amount) {
      const t = now();
      const obj = read();
      for (const [k, e] of Object.entries(obj)) if (!live(e, t)) delete obj[k];
      const id = idOf(pairToken, address);
      if (typeof amount === 'bigint' && amount > 0n) obj[id] = { owed: amount.toString(), at: t };
      else delete obj[id];
      write(obj);
    },
  };
}
