/**
 * Each wallet's starting size in a token — the 100 % of the %-left bar (spec
 * addendum C) — kept as a HIGH-WATER MARK: the largest balance the page has
 * seen the wallet hold in its current position. A later buy raises it, a sell
 * never lowers it, and a wallet seen empty and then holding again starts a new
 * position. "Held" is the row's tokens PLUS its in-flight sells (session.js
 * view: tokens = the chain balance less what is in flight), so a sell being
 * sent never looks like a smaller position.
 *
 * A record: {hwm, seenAt, startedAt, empty?}
 *   hwm        base units, a decimal string
 *   seenAt     ms, the last time the page saw the wallet (orders the prune)
 *   startedAt  ms, when this position started (a merge keeps the later one)
 *   empty      true when the last balance seen was 0: the next non-zero
 *              balance starts a new position
 *
 * WHERE IT LIVES
 *   memory   always, for this tab
 *   device   localStorage POSITIONS_KEY, only while persist() says the visitor
 *            chose to remember wallets on this device — pairLedger.js's rule,
 *            for pairLedger's reason: ids are unsalted keccak hashes over an
 *            enumerable set and hwm is an exact on-chain amount, so whoever
 *            reads the storage can link it to the visitor's wallets
 *   account  the encrypted account blob's `positions` (Task 29), over the hub:
 *              'account:positions' {positions}  the unlocked account's copy (on
 *                                               unlock, and after a sync merged
 *                                               another device's): merged here,
 *                                               and saving to the account starts
 *              'account:locked'                 lock / disconnect: saving stops
 *              'positions:save'   {positions}   emitted HERE on every change
 *                                               while an account is attached;
 *                                               Task 29 debounces, encrypts, PUTs
 *            The account copy is keyed by plain lower-case addresses: it is
 *            encrypted in the browser before it leaves.
 *
 * At most MAX_POSITION_TOKENS tokens are kept (the most recently seen). No key
 * is ever here, nothing here is signed, and every storage access is in
 * try/catch (a private window, blocked site data): the book then lives in memory.
 */
import { toNumber } from './format.js';

export const POSITIONS_KEY = 'tp.positions.v1';
export const MAX_POSITION_TOKENS = 20;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^[0-9]{1,78}$/;
// A record seen again after this long is re-dated (and saved), so a token in use
// is never pruned for one merely opened later.
const SEEN_REFRESH_MS = 3_600_000;

const lower = (a) => String(a || '').toLowerCase();

/** A non-negative base-unit amount; anything unreadable is 0. */
function big(v) {
  if (typeof v === 'bigint') return v > 0n ? v : 0n;
  const s = String(v ?? '');
  return DECIMAL.test(s) ? BigInt(s) : 0n;
}

const ratio = (a, b) => Number((a * 1_000_000n) / b) / 1_000_000;

/**
 * A record from storage or the account, normalised — or null when malformed. A
 * record without startedAt (the plain {hwm, seenAt} shape) started when it was
 * last seen.
 */
function cleanRec(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.hwm !== 'string' || !DECIMAL.test(r.hwm)) return null;
  if (!Number.isFinite(r.seenAt)) return null;
  const startedAt = r.startedAt === undefined ? r.seenAt : r.startedAt;
  if (!Number.isFinite(startedAt)) return null;
  const out = { hwm: BigInt(r.hwm).toString(), seenAt: r.seenAt, startedAt };
  if (r.empty === true) out.empty = true;
  return out;
}

const sameRec = (a, b) => !!a && !!b && a.hwm === b.hwm && a.seenAt === b.seenAt && a.startedAt === b.startedAt && !!a.empty === !!b.empty;

/** Two copies of one (token, wallet): the later position; the same position keeps the higher mark, then the later sighting. */
function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt ? a : b;
  const ha = BigInt(a.hwm);
  const hb = BigInt(b.hwm);
  if (ha !== hb) return ha > hb ? a : b;
  return a.seenAt >= b.seenAt ? a : b;
}

/** The latest seenAt among a token's records (the prune's order). */
function lastSeen(records) {
  let t = -Infinity;
  for (const r of records) if (r && Number.isFinite(r.seenAt) && r.seenAt > t) t = r.seenAt;
  return t;
}

/**
 * Two positions maps (the account blob's `positions` shape) merged record by
 * record with the book's own rule — the later position wins, the same position
 * keeps the higher mark, then the later sighting. Malformed entries are
 * dropped; at most MAX_POSITION_TOKENS tokens are kept, the most recently seen.
 * For Task 29's merge after a 409 (another tab or device saved first).
 */
export function mergePositions(a, b) {
  const all = new Map(); // lower token -> Map(lower wallet -> record)
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [token, group] of Object.entries(src)) {
      const tk = lower(token);
      if (!ADDRESS.test(tk) || !group || typeof group !== 'object' || Array.isArray(group)) continue;
      for (const [wallet, raw] of Object.entries(group)) {
        const w = lower(wallet);
        const rec = ADDRESS.test(w) ? cleanRec(raw) : null;
        if (!rec) continue;
        let g = all.get(tk);
        if (!g) {
          g = new Map();
          all.set(tk, g);
        }
        g.set(w, pick(g.get(w) || null, rec));
      }
    }
  }
  const out = {};
  const kept = [...all.entries()].sort((x, y) => lastSeen(y[1].values()) - lastSeen(x[1].values())).slice(0, MAX_POSITION_TOKENS);
  for (const [tk, g] of kept) {
    out[tk] = {};
    for (const [w, rec] of g) out[tk][w] = { ...rec };
  }
  return out;
}

/**
 * The bar of one row: fractions (0..1) of the position still held and in flight.
 * With no record, or a row holding more than its record, the row's own held +
 * in-flight tokens are the 100 %; a record marked empty is a position that has
 * ended (the row, holding again, starts a new one).
 * @returns {{left: number, flight: number, hwm: string}}
 */
export function leftOf(row, rec) {
  const held = big(row && row.tokens);
  const flight = big(row && row.inflight);
  const total = held + flight;
  let hwm = rec && !rec.empty && typeof rec.hwm === 'string' && DECIMAL.test(rec.hwm) ? BigInt(rec.hwm) : 0n;
  if (total > hwm) hwm = total;
  if (hwm === 0n) return { left: 0, flight: 0, hwm: '0' };
  return { left: ratio(held, hwm), flight: ratio(flight, hwm), hwm: hwm.toString() };
}

/**
 * A row's value: tokens x price is in the QUOTE asset (memory
 * launcher-eth-pair-unit-bugs), then ETH and USD from their per-quote rates.
 * A missing input is null — never a guess.
 */
export function rowValue({ tokens, decimals, price, ethPerQuote, usdPerQuote }) {
  const amount = toNumber(tokens, decimals);
  const quote = Number.isFinite(price) && Number.isFinite(amount) ? amount * price : null;
  return {
    quote,
    eth: quote !== null && Number.isFinite(ethPerQuote) ? quote * ethPerQuote : null,
    usd: quote !== null && Number.isFinite(usdPerQuote) ? quote * usdPerQuote : null,
  };
}

/** ETH per ONE quote unit: 1 when ETH-quoted; a token pair through its USD price (App's quoteUsd); else null. */
export function ethPerQuoteOf(venue, quoteUsd, ethUsd) {
  if (!venue) return null;
  if (venue.nativeQuote) return 1;
  const usd = Number(quoteUsd && quoteUsd.usd);
  const e = Number(ethUsd);
  return Number.isFinite(usd) && usd > 0 && Number.isFinite(e) && e > 0 ? usd / e : null;
}

/**
 * @param {{storage?: {getItem, setItem, removeItem}|null, hash: (text: string) => string,
 *   now?: () => number, persist?: () => boolean}} deps
 *   persist: whether the book may be written to `storage` (pairLedger's rule: the
 *   visitor chose Remember on this device)
 */
export function createPositionBook({ storage = null, hash, now = () => Date.now(), persist = () => true }) {
  const mem = new Map(); // lower token -> Map(lower wallet -> record)
  const listeners = new Set();
  let bus = null;
  let attached = false;

  const tokenId = (token) => hash(`tp.pos.token:${token}`);
  const walletId = (token, wallet) => hash(`tp.pos.wallet:${token}:${wallet}`);

  const durable = () => {
    try {
      return !!storage && persist() === true;
    } catch {
      return false;
    }
  };

  function stored() {
    if (!durable()) return {};
    try {
      const raw = storage.getItem(POSITIONS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    } catch {
      return {};
    }
  }

  function memGet(token, wallet) {
    const g = mem.get(token);
    return g ? g.get(wallet) || null : null;
  }

  function memPut(token, wallet, rec) {
    let g = mem.get(token);
    if (!g) {
      g = new Map();
      mem.set(token, g);
    }
    g.set(wallet, rec);
  }

  function prune() {
    if (mem.size <= MAX_POSITION_TOKENS) return;
    const order = [...mem.entries()].sort((x, y) => lastSeen(y[1].values()) - lastSeen(x[1].values()));
    for (const [token] of order.slice(MAX_POSITION_TOKENS)) mem.delete(token);
  }

  /** The device copy: ours overwrite, a token only the device knows (hashed) stays; pruned the same way. */
  function writeDevice() {
    try {
      if (!storage) return;
      if (!durable()) {
        storage.removeItem(POSITIONS_KEY); // no Remember: no older copy stays readable either
        return;
      }
      const obj = stored();
      for (const [token, g] of mem) {
        const tid = tokenId(token);
        const group = obj[tid] && typeof obj[tid] === 'object' && !Array.isArray(obj[tid]) ? obj[tid] : {};
        for (const [wallet, rec] of g) group[walletId(token, wallet)] = rec;
        obj[tid] = group;
      }
      const keep = Object.entries(obj)
        .sort((x, y) => lastSeen(Object.values(y[1] || {})) - lastSeen(Object.values(x[1] || {})))
        .slice(0, MAX_POSITION_TOKENS);
      if (keep.length) storage.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(keep)));
      else storage.removeItem(POSITIONS_KEY);
    } catch {
      // storage refused: the memory copy still serves this tab
    }
  }

  function snapshot() {
    const out = {};
    for (const [token, g] of mem) {
      const group = {};
      for (const [wallet, rec] of g) group[wallet] = { ...rec };
      out[token] = group;
    }
    return out;
  }

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // a UI listener's bug must not stop the book
      }
    }
  }

  function saveAccount() {
    if (attached && bus) bus.emit('positions:save', { positions: snapshot() });
  }

  function changed() {
    prune();
    writeDevice();
    saveAccount();
    notify();
  }

  /**
   * The rows of one token as session.view() lists them. A row whose balance the
   * server could not read (balanceKnown false) is skipped: an unread balance is
   * not an empty wallet.
   */
  function observe(token, rows) {
    const tk = lower(token);
    if (!ADDRESS.test(tk) || !Array.isArray(rows)) return;
    const t = now();
    let dirty = false;
    let loaded = false;
    let dev = null;
    const device = () => {
      if (dev === null) dev = stored();
      return dev;
    };
    for (const r of rows) {
      if (!r || r.balanceKnown === false) continue;
      const w = lower(r.address);
      if (!ADDRESS.test(w)) continue;
      const held = big(r.tokens) + big(r.inflight);
      let rec = memGet(tk, w);
      if (!rec) {
        const group = device()[tokenId(tk)];
        rec = group && typeof group === 'object' ? cleanRec(group[walletId(tk, w)]) : null;
        if (rec) {
          memPut(tk, w, rec);
          loaded = true;
        }
      }
      if (!rec) {
        if (held > 0n) {
          memPut(tk, w, { hwm: held.toString(), seenAt: t, startedAt: t });
          dirty = true;
        }
      } else if (held === 0n) {
        if (!rec.empty) {
          rec.empty = true;
          rec.seenAt = t;
          dirty = true;
        }
      } else if (rec.empty) {
        memPut(tk, w, { hwm: held.toString(), seenAt: t, startedAt: t }); // a new position
        dirty = true;
      } else if (held > BigInt(rec.hwm)) {
        rec.hwm = held.toString();
        rec.seenAt = t;
        dirty = true;
      } else if (t - rec.seenAt >= SEEN_REFRESH_MS) {
        rec.seenAt = t;
        dirty = true;
      }
    }
    if (dirty) changed();
    else if (loaded) notify();
  }

  /** The unlocked account's copy: merged record by record (pick), then whatever this tab knew that it lacks is saved back. */
  function mergeAccount(positions) {
    attached = true;
    const incoming = new Map();
    if (positions && typeof positions === 'object' && !Array.isArray(positions)) {
      for (const [token, group] of Object.entries(positions)) {
        const tk = lower(token);
        if (!ADDRESS.test(tk) || !group || typeof group !== 'object' || Array.isArray(group)) continue;
        for (const [wallet, raw] of Object.entries(group)) {
          const w = lower(wallet);
          const rec = ADDRESS.test(w) ? cleanRec(raw) : null;
          if (rec) incoming.set(`${tk}|${w}`, { tk, w, rec });
        }
      }
    }
    let moved = false;
    for (const { tk, w, rec } of incoming.values()) {
      const mine = memGet(tk, w);
      const win = pick(mine, rec);
      if (win !== mine) {
        memPut(tk, w, { ...win });
        moved = true;
      }
    }
    if (moved) prune();
    let differs = false;
    for (const [token, g] of mem) {
      for (const [wallet, rec] of g) {
        const theirs = incoming.get(`${token}|${wallet}`);
        if (!theirs || !sameRec(theirs.rec, rec)) differs = true;
      }
    }
    if (moved) {
      writeDevice();
      notify();
    }
    if (differs) saveAccount();
  }

  return {
    observe,
    /** A token's records by lower-case wallet (copies): what the %-left bars draw from. */
    forToken(token) {
      const g = mem.get(lower(token));
      const out = {};
      if (g) for (const [wallet, rec] of g) out[wallet] = { ...rec };
      return out;
    },
    /** Every record this tab knows, as the account blob's `positions` (plain lower-case keys). */
    snapshot,
    /** Called on every change (a new or raised mark, a new position, a merge, a device load, clear). Returns unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Listen for Task 29's account events on `hub` and save to it through 'positions:save'. Returns disconnect. */
    connect(hub) {
      bus = hub;
      const offs = [hub.on('account:positions', (d) => mergeAccount(d && d.positions)), hub.on('account:locked', () => (attached = false))];
      return () => {
        offs.forEach((off) => off());
        if (bus === hub) {
          bus = null;
          attached = false;
        }
      };
    },
    /**
     * Forget every record, in memory and on the device (Clear, Forget). The
     * account copy is left as it is, and saving to it waits for the next
     * 'account:positions' — a cleared tab must not overwrite it with nothing.
     */
    clear() {
      mem.clear();
      attached = false;
      try {
        if (storage) storage.removeItem(POSITIONS_KEY);
      } catch {
        // nothing more to do
      }
      notify();
    },
  };
}
