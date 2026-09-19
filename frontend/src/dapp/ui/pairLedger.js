/**
 * Pair-token proceeds the page still has to turn into ETH, remembered across a
 * token switch (and, for a visitor who chose Remember, a reload) — so the next
 * session's baseline ("what the wallet held before") does not swallow them for
 * good. A later session never converts them on its own: it lists them with a
 * Convert action and swaps them only on the visitor's click (session.js).
 *
 * An entry is {owed, nonce, bal, at, w}:
 *   owed   the proceeds still owed, in pair-token base units
 *   nonce  the wallet's next nonce as this page knew it when it last wrote or
 *          sent. A wallet whose nonce has moved past it has sent a transaction
 *          this page did not: the visitor may have moved or re-bought pair
 *          tokens, so the entry is dropped (session.js carriedFrom)
 *   bal    the pair balance the page expected the wallet to hold (its own pair
 *          tokens + owed). A lower balance on the next read clamps owed
 *   at     when it was written; entries older than 7 days are dropped
 *   w      a hash of the wallet alone, so touch() can move the nonce of every
 *          entry of one wallet whatever the pair token
 *
 * PRIVACY. Ids are unsalted keccak256 hashes over a small, enumerable set (the
 * holders of a pair token), and owed/bal are exact on-chain amounts that can be
 * matched against the token's Transfer logs: whoever can read this storage can
 * link it to the visitor's wallets. So the ledger lives in MEMORY unless
 * `persist()` says the visitor chose to remember wallets on this device (the
 * encrypted vault exists); Clear and Forget wipe it (clear()). No key is ever
 * stored, and nothing here is signed.
 *
 * Every storage access is in try/catch (private windows, blocked site data):
 * reading then answers from memory, writing keeps the memory copy only.
 */
const KEY = 'tp.pairOwed.v1';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const DECIMAL = /^[0-9]+$/;

const lower = (a) => String(a).toLowerCase();

/**
 * @param {{storage?: {getItem, setItem, removeItem}|null, hash: (text: string) => string,
 *   now?: () => number, persist?: () => boolean}} deps
 *   persist: whether the ledger may be written to `storage` (default: whenever storage exists)
 * @returns {{
 *   get(pairToken, address): {owed: bigint, nonce: number|null, bal: bigint|null}|null,
 *   set(pairToken, address, owed: bigint, meta?: {nonce?: number, bal?: bigint}): void,
 *   touch(list: Array<{address: string, nonce: number}>): void,
 *   clear(): void,
 * }}
 */
export function createPairLedger({ storage = null, hash, now = () => Date.now(), persist = () => true }) {
  const idOf = (pairToken, address) => hash(`${lower(pairToken)}:${lower(address)}`);
  const walletOf = (address) => hash(`wallet:${lower(address)}`);
  let mem = {};

  const durable = () => {
    try {
      return !!storage && persist() === true;
    } catch {
      return false;
    }
  };

  function stored() {
    try {
      const raw = storage.getItem(KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      return {};
    }
  }

  /** The entries: the stored copy when the ledger may persist (it wins over memory), else memory. */
  function read() {
    return durable() ? { ...mem, ...stored() } : { ...mem };
  }

  function write(obj) {
    mem = obj;
    try {
      if (!storage) return;
      // Not persisting (no Remember): make sure no older copy stays readable either.
      if (!durable() || !Object.keys(obj).length) storage.removeItem(KEY);
      else storage.setItem(KEY, JSON.stringify(obj));
    } catch {
      // storage refused: the memory copy still serves this page
    }
  }

  const live = (e, t) => !!e && typeof e.owed === 'string' && DECIMAL.test(e.owed) && Number.isFinite(e.at) && t - e.at <= MAX_AGE_MS;

  function prune(obj, t) {
    for (const [k, e] of Object.entries(obj)) if (!live(e, t)) delete obj[k];
    return obj;
  }

  return {
    get(pairToken, address) {
      const e = read()[idOf(pairToken, address)];
      if (!live(e, now())) return null;
      return {
        owed: BigInt(e.owed),
        nonce: Number.isSafeInteger(e.nonce) && e.nonce >= 0 ? e.nonce : null,
        bal: typeof e.bal === 'string' && DECIMAL.test(e.bal) ? BigInt(e.bal) : null,
      };
    },
    set(pairToken, address, owed, meta = {}) {
      const t = now();
      const obj = prune(read(), t);
      const id = idOf(pairToken, address);
      if (typeof owed === 'bigint' && owed > 0n) {
        const e = { owed: owed.toString(), at: t, w: walletOf(address) };
        if (Number.isSafeInteger(meta.nonce) && meta.nonce >= 0) e.nonce = meta.nonce;
        if (typeof meta.bal === 'bigint' && meta.bal >= 0n) e.bal = meta.bal.toString();
        obj[id] = e;
      } else {
        delete obj[id];
      }
      write(obj);
    },
    /** This page sent from (or resynced) these wallets: each entry of theirs now expects this next nonce. */
    touch(list) {
      const byWallet = new Map();
      for (const x of Array.isArray(list) ? list : []) {
        if (x && Number.isSafeInteger(x.nonce) && x.nonce >= 0) byWallet.set(walletOf(x.address), x.nonce);
      }
      if (!byWallet.size) return;
      const obj = read();
      let changed = false;
      for (const e of Object.values(obj)) {
        if (e && byWallet.has(e.w) && e.nonce !== byWallet.get(e.w)) {
          e.nonce = byWallet.get(e.w);
          changed = true;
        }
      }
      if (changed) write(obj);
    },
    /** Forget every entry, in memory and on the device (Clear, Forget). */
    clear() {
      mem = {};
      try {
        if (storage) storage.removeItem(KEY);
      } catch {
        // nothing more to do
      }
    },
  };
}
