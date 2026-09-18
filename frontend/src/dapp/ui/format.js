/**
 * Display formatting for the take-profit page. Pure render-time transforms:
 * nothing here decides anything, and nothing here ever sees a private key.
 *
 * THE UNIT RULE (memory launcher-eth-pair-unit-bugs): every money figure on
 * this page is in the token's QUOTE asset. That is ETH only when
 * venue.nativeQuote is true; an AMZN-paired curve quotes in AMZN. So every
 * caller labels a figure with quoteSymbol(venue), never with a literal 'ETH'.
 */

// Copied from backend/src/config.js:30 (explorerUrl default).
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

export function txUrl(hash) {
  return `${EXPLORER}/tx/${hash}`;
}

export function addressUrl(address) {
  return `${EXPLORER}/address/${address}`;
}

/** Display-only shortening. Never feed the result back into a lookup or a request. */
export function shortAddr(a, lead = 8, tail = 6) {
  if (!a) return '';
  return a.length <= lead + tail + 1 ? a : `${a.slice(0, lead)}…${a.slice(-tail)}`;
}

export function quoteSymbol(venue) {
  if (!venue) return '';
  return venue.nativeQuote ? 'ETH' : venue.pairSymbol || 'pair';
}

export function quoteDecimals(venue) {
  if (!venue || venue.nativeQuote) return 18;
  const d = Number(venue.pairDecimals);
  return Number.isInteger(d) && d >= 0 ? d : 18;
}

export function venueLabel(venue) {
  if (!venue) return '';
  if (venue.kind === 'curve') return 'pons v2 · bonding curve';
  if (venue.kind === 'graduated') return 'pons v2 · Uniswap v4 pool';
  if (venue.kind === 'v1') return 'pons v1 · Uniswap v3 pool';
  return 'unknown venue';
}

/** Exact decimal string of a base-unit amount ("1500000000000000000", 18) -> "1.5". */
export function unitsString(value, decimals) {
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = v / base;
  const frac = (v % base).toString().padStart(Number(d), '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** A base-unit amount as a float, for display maths only (MC, value, %). */
export function toNumber(value, decimals) {
  try {
    return Number(unitsString(value, decimals));
  } catch {
    return NaN;
  }
}

/**
 * A base-unit amount for a table cell: grouped thousands, at most `maxFrac`
 * fraction digits (truncated, never rounded up), trailing zeros dropped. A
 * non-zero amount too small to show reads "<0.0001" rather than "0".
 */
export function fmtUnits(value, decimals = 18, maxFrac = 4) {
  if (value === null || value === undefined || value === '') return '—';
  let v;
  try {
    v = BigInt(value);
  } catch {
    return '—';
  }
  if (v === 0n) return '0';
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const scale = 10n ** BigInt(maxFrac);
  const fracScaled = ((v % base) * scale) / base;
  const sign = neg ? '-' : '';
  if (whole === 0n && fracScaled === 0n) {
    return maxFrac > 0 ? `${sign}<0.${'0'.repeat(maxFrac - 1)}1` : `${sign}<1`;
  }
  const frac = maxFrac > 0 ? fracScaled.toString().padStart(maxFrac, '0').replace(/0+$/, '') : '';
  return `${sign}${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}

/** Percent of total supply held (a number, e.g. 1.25 for 1.25 %), or null when unknowable. */
export function pctOfSupply(balance, totalSupply) {
  try {
    const t = BigInt(totalSupply);
    if (t <= 0n) return null;
    return Number((BigInt(balance) * 10_000_000n) / t) / 100_000;
  } catch {
    return null;
  }
}

export function fmtPct(p, digits = 2) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p > 0 && p < 10 ** -digits) return `<${(10 ** -digits).toFixed(digits)}%`;
  return `${p.toFixed(digits)}%`;
}

function trimZeros(s) {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function subscript(n) {
  return String(n)
    .split('')
    .map((d) => String.fromCharCode(0x2080 + Number(d)))
    .join('');
}

/**
 * A price for humans. Meme prices sit around 1e-9, where toFixed prints zeros,
 * so four or more leading fraction zeros collapse to the subscript form
 * 0.0₈1234 (0.000000001234). Never scientific notation.
 */
export function fmtPrice(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  if (p === 0) return '0';
  const neg = p < 0;
  const a = Math.abs(p);
  let s;
  if (a >= 1000) s = a.toLocaleString('en-US', { maximumFractionDigits: 2 });
  else if (a >= 1) s = trimZeros(a.toFixed(4));
  else {
    let zeros = Math.floor(-Math.log10(a));
    if (zeros >= 4) {
      let digits = Math.round(a * 10 ** (zeros + 4));
      if (digits >= 10000) {
        zeros -= 1;
        digits = Math.round(a * 10 ** (zeros + 4));
      }
      s = `0.0${subscript(zeros)}${String(digits).replace(/0+$/, '') || '0'}`;
    } else {
      s = trimZeros(a.toPrecision(4));
    }
  }
  return neg ? `-${s}` : s;
}

/** Dollars, compact above a thousand. null / NaN -> an em dash, never a wrong figure. */
export function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(2)}K`;
  if (a > 0 && a < 0.01) return `${sign}<$0.01`;
  return `${sign}$${a.toFixed(2)}`;
}

/** Seconds since a trade -> "4s" / "12m" / "3h" / "2d". */
export function fmtAge(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** An error's message, one line, bounded. Never includes anything but the message. */
export function errText(e, max = 160) {
  const raw = e && typeof e === 'object' && 'message' in e ? e.message : String(e ?? 'failed');
  const line = String(raw).split(String.fromCharCode(10))[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
