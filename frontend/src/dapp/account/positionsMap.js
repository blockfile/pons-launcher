/**
 * The account copy's `positions`: each wallet's starting size per token, the
 * 100 % of the %-left bars (spec Addendum C). The book that keeps and draws them
 * is ui/positions.js (Task 34). It talks to the account sync over the page hub
 * (vaultSync.js), and this module is the account side's view of the same map:
 *
 *   {[lowerToken]: {[lowerWallet]: record}}
 *   record  {hwm: 'decimal string', seenAt: ms, startedAt?: ms, empty?: true}
 *
 * Records pass through UNCHANGED: the book owns their meaning. A record is only
 * checked (hwm a decimal string, seenAt a number, startedAt a number when
 * present); its fields are kept when they are plain values (at most 8, strings of
 * at most 100 characters), and its keys are sorted so equal maps compare equal.
 *
 * Two maps merge record by record with the book's own rule (ui/positions.js
 * mergePositions): the later position (startedAt, which defaults to seenAt), then
 * the higher mark, then the later sighting. The MAX_POSITION_TOKENS tokens seen
 * most recently are kept. No key is ever here.
 */
export const MAX_POSITION_TOKENS = 20;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const DECIMAL_RE = /^[0-9]{1,78}$/;
const MAX_FIELDS = 8;
const MAX_TEXT = 100;
const KNOWN = ['empty', 'hwm', 'seenAt', 'startedAt'];

const lower = (a) => String(a).toLowerCase();
const isMap = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const startOf = (r) => (r.startedAt === undefined ? r.seenAt : r.startedAt);

function plainValue(v) {
  if (typeof v === 'string') return v.length <= MAX_TEXT;
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'boolean';
}

/** A record kept as it is (the book's fields first, then other plain fields; keys sorted), or null. */
function cleanRecord(r) {
  if (!isMap(r)) return null;
  if (typeof r.hwm !== 'string' || !DECIMAL_RE.test(r.hwm)) return null;
  if (typeof r.seenAt !== 'number' || !Number.isFinite(r.seenAt)) return null;
  if (r.startedAt !== undefined && (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt))) return null;
  const names = [...KNOWN, ...Object.keys(r).filter((k) => !KNOWN.includes(k) && k !== '__proto__').sort()];
  const kept = names.filter((k) => r[k] !== undefined && plainValue(r[k])).slice(0, MAX_FIELDS).sort();
  const out = {};
  for (const k of kept) out[k] = r[k];
  return out;
}

/** The book's rule for two records of one (token, wallet); `a` wins a full tie. */
function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  const sa = startOf(a);
  const sb = startOf(b);
  if (sa !== sb) return sa > sb ? a : b;
  const ha = BigInt(a.hwm);
  const hb = BigInt(b.hwm);
  if (ha !== hb) return ha > hb ? a : b;
  return a.seenAt >= b.seenAt ? a : b;
}

function lastSeen(group) {
  let t = -Infinity;
  for (const r of group.values()) if (r.seenAt > t) t = r.seenAt;
  return t;
}

function gather(all, src) {
  if (!isMap(src)) return;
  for (const [t, group] of Object.entries(src)) {
    const token = lower(t);
    if (!ADDRESS_RE.test(token) || !isMap(group)) continue;
    for (const [w, raw] of Object.entries(group)) {
      const wallet = lower(w);
      const rec = ADDRESS_RE.test(wallet) ? cleanRecord(raw) : null;
      if (!rec) continue;
      let g = all.get(token);
      if (!g) {
        g = new Map();
        all.set(token, g);
      }
      g.set(wallet, pick(g.get(wallet) || null, rec));
    }
  }
}

function emit(all, maxTokens) {
  const kept = [...all.entries()]
    .sort((x, y) => lastSeen(y[1]) - lastSeen(x[1]) || (x[0] < y[0] ? -1 : 1))
    .slice(0, maxTokens)
    .sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const out = {};
  for (const [token, g] of kept) {
    const group = {};
    for (const wallet of [...g.keys()].sort()) group[wallet] = { ...g.get(wallet) };
    out[token] = group;
  }
  return out;
}

/**
 * Two positions maps merged record by record (`a` wins a full tie), junk
 * dropped, the maxTokens tokens seen most recently kept, keys sorted.
 * @returns {Record<string, Record<string, object>>}
 */
export function mergePositionMaps(a, b, maxTokens = MAX_POSITION_TOKENS) {
  const all = new Map();
  gather(all, a);
  gather(all, b);
  return emit(all, maxTokens);
}

/** One map in its saved form (the same as merging it with nothing). */
export function normalizePositionMap(obj, maxTokens = MAX_POSITION_TOKENS) {
  return mergePositionMaps(obj, null, maxTokens);
}

/** A saved-form map without its least recently seen token (for a copy that must shrink to fit). */
export function withoutOldestToken(map) {
  const all = new Map();
  gather(all, map);
  if (!all.size) return {};
  return emit(all, all.size - 1);
}
