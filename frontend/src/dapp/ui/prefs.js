/**
 * Per-viewer preferences in localStorage: the five preset chips and the
 * slippage %. Conveniences only — storage can be missing, full, blocked or
 * throwing (private window, blocked site data), so every read and write is
 * wrapped and the page works on the defaults without it.
 */

export const PRESETS_KEY = 'tp.presets.v1';
export const SLIPPAGE_KEY = 'tp.slippage.v1';
export const DEFAULT_PRESETS = Object.freeze([25, 30, 50, 75, 100]);
export const DEFAULT_SLIPPAGE = 15;

function storageOr(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** A whole percent 1..100, or null. Fractions are refused so the plan's bigint maths stays exact. */
export function parsePct(v) {
  const s = String(v ?? '').trim();
  if (!/^[0-9]{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 100 ? n : null;
}

/** A slippage percent 0.1..50 with at most one decimal, or null. */
export function parseSlippage(v) {
  const s = String(v ?? '').trim();
  if (!/^[0-9]{1,2}(\.[0-9])?$/.test(s)) return null;
  const n = Number(s);
  return n >= 0.1 && n <= 50 ? n : null;
}

export function slippageToBps(pct) {
  return Math.round(Number(pct) * 100);
}

export function loadPresets(storage) {
  try {
    const raw = storageOr(storage)?.getItem(PRESETS_KEY);
    if (!raw) return [...DEFAULT_PRESETS];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== DEFAULT_PRESETS.length) return [...DEFAULT_PRESETS];
    const clean = arr.map(parsePct);
    return clean.every((x) => x !== null) ? clean : [...DEFAULT_PRESETS];
  } catch {
    return [...DEFAULT_PRESETS];
  }
}

/** Validates, then persists. Returns the clean list, or null when any entry is invalid. */
export function savePresets(list, storage) {
  if (!Array.isArray(list) || list.length !== DEFAULT_PRESETS.length) return null;
  const clean = list.map(parsePct);
  if (clean.some((x) => x === null)) return null;
  try {
    storageOr(storage)?.setItem(PRESETS_KEY, JSON.stringify(clean));
  } catch {
    // Storage refused: the presets still apply for this visit.
  }
  return clean;
}

export function loadSlippage(storage) {
  try {
    const raw = storageOr(storage)?.getItem(SLIPPAGE_KEY);
    const n = raw === null || raw === undefined ? null : parseSlippage(raw);
    return n === null ? DEFAULT_SLIPPAGE : n;
  } catch {
    return DEFAULT_SLIPPAGE;
  }
}

export function saveSlippage(value, storage) {
  const n = parseSlippage(value);
  if (n === null) return null;
  try {
    storageOr(storage)?.setItem(SLIPPAGE_KEY, String(n));
  } catch {
    // Storage refused: the value still applies for this visit.
  }
  return n;
}
