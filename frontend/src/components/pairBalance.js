// THE PAIR COLUMN'S ARITHMETIC — and it is arithmetic on ONE currency at a time.
//
// On a paired launch the wallet table carries two balances per row: ETH, which
// pays gas, and the launch's quote asset (NVDA / SPCX / AMD …), which is what the
// bundle buys WITH. The Buy column is denominated in that quote asset because it
// is the number prepareV2 parses and then demands the wallet hold, so "is this
// wallet short?" is a comparison between two figures in the SAME asset — the pair
// balance and the Buy amount. Nothing in this file touches ETH, and nothing in it
// adds an amount in one unit to an amount in another. That was the bug (commit
// 26c2117: `fund: (buy + reserve)` added NVDA to ETH), and the fix survives only
// if every new seam refuses to repeat it.
//
// Compared as scaled integers rather than as floats. `0.029125` typed against a
// balance formatted from wei is exactly the case where a float comparison decides
// "short" by one part in 10^17 — and "short" is the state that makes preflight
// drop the wallet, so it must not be a rounding artefact.
//
// Pure, and unit-tested beside this file. Moves no money; it renders a column.

// Enough places for any quote asset on this chain (18 is the ceiling) with room
// for a longer string to be truncated rather than misread.
const PLACES = 18;

// A plain decimal. Deliberately NOT permissive: an exponent form, a sign, a
// thousands separator or anything else returns null, which every caller reads as
// "unknown" and renders as a dash. A figure that cannot be parsed must never be
// silently treated as zero — zero is a claim, and the claim would be that a
// funded wallet is empty.
const DECIMAL = /^(\d+)(?:\.(\d*))?$/;

/**
 * A decimal string as a scaled BigInt, or null when it is not one.
 * @param {string|number|null|undefined} value
 * @returns {bigint|null}
 */
export function toUnits(value, places = PLACES) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const frac = (m[2] || '').slice(0, places).padEnd(places, '0');
  return BigInt(m[1] + frac);
}

/** The inverse, for showing a difference the operator has to act on. */
export function fromUnits(raw, places = PLACES) {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scale = 10n ** BigInt(places);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * What this row's pair balance says about this row's Buy amount.
 *
 *   'unknown'   — the balance was not read (a native listing, a failed slot, a
 *                 pair the factory would not confirm). Renders as a dash. It is
 *                 NOT "empty" and must never be drawn as short.
 *   'no-target' — nothing is being asked of this wallet yet: no Buy amount, a
 *                 zero one, or a row on "all − gas" whose amount is resolved
 *                 server-side and so names no requirement here.
 *   'ok'        — it already holds at least what its buy will demand. Past tense.
 *   'short'     — it holds less. This is the state preflight skips the wallet for,
 *                 and the whole reason the column was asked for.
 */
export function pairStatus(held, need) {
  const h = toUnits(held);
  if (h === null) return 'unknown';
  const n = toUnits(need);
  if (n === null || n === 0n) return 'no-target';
  return h >= n ? 'ok' : 'short';
}

/**
 * How much more of the pair token this wallet needs, as a decimal string, or null
 * when it needs none (or when the question does not apply). Same asset both
 * sides — this is a subtraction, never a conversion.
 */
export function pairShortfall(held, need) {
  const h = toUnits(held);
  const n = toUnits(need);
  if (h === null || n === null || n === 0n || h >= n) return null;
  return fromUnits(n - h);
}

/**
 * Turn the read-only "use available ETH" plan into row patches.
 *
 * ONLY a row the backend marked `ok` gets an amount, and it gets the backend's
 * OWN `buyPair` string verbatim — the conservative figure, floored to the pair's
 * decimals, that the plan promises the wallet can actually satisfy. Nothing here
 * re-derives it, rounds it or scales it: a Buy amount a hair above what a wallet
 * holds is the "holds 0.0X, needs 0.0Y — skipped" state the whole feature exists
 * to prevent, and the only way to guarantee that is to write back exactly what
 * was quoted and shown.
 *
 * Every other row is returned in `skipped`, NAMED, so the console can say which
 * wallets were left alone and why. None of them is given a zero — a zero reads as
 * a decision, and no decision was made about them.
 */
export function balanceFill(plan) {
  const patches = {};
  const skipped = [];
  for (const r of plan?.results || []) {
    if (r.status === 'ok' && r.buyPair) {
      patches[r.walletId] = { mode: 'fixed', buy: String(r.buyPair) };
    } else {
      skipped.push({
        walletId: r.walletId,
        address: r.address,
        status: r.status,
        reason: r.reason,
      });
    }
  }
  return { patches, filled: Object.keys(patches).length, skipped };
}
