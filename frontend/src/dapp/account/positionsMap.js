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
// ui/positions.js keeps its own copy of this: two starts this close are one position
// seen twice by two devices, not two positions.
const SAME_START_MS = 60_000;

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
/*
 * `startedAt` is when a tab first SAW the wallet
 * holding — a detection time, not an identity — so two devices polling on their own
 * clocks date one empty -> holding transition differently. Inside SAME_START_MS they
 * are the same position: keep the later start (the copy's start, spec decision 12)
 * but never the smaller of the two marks, or a %-left bar reads 100% for a wallet
 * that has already sold part of the position, and that wrong mark is then saved back
 * to the blob for every device (observe() only ever raises a mark on MORE tokens,
 * which never happens once a wallet is selling down). Further apart it is a new
 * position and does reset the mark, and a record marked `empty` — a recorded END —
 * never lends its mark forward.
 */
function pick(a, b) {
  if (!a) return b;
  if (!b) return a;
  const sa = startOf(a);
  const sb = startOf(b);
  const ha = BigInt(a.hwm);
  const hb = BigInt(b.hwm);
  // Both must KNOW when their position started: a first sighting stands in seenAt (or
  // 0) for a start it never saw, and those must keep losing to a dated one outright.
  const sameStart = sa > 0 && sb > 0 && a.startedAt !== undefined && b.startedAt !== undefined && Math.abs(sa - sb) <= SAME_START_MS;
  let win = a;
  if (sa !== sb) win = sa > sb ? a : b;
  else if (ha !== hb) win = ha > hb ? a : b;
  else return a.seenAt >= b.seenAt ? a : b;
  const lose = win === a ? b : a;
  if (!sameStart || win.empty || lose.empty) return win;
  return BigInt(lose.hwm) > BigInt(win.hwm) ? { ...win, hwm: lose.hwm } : win;
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
