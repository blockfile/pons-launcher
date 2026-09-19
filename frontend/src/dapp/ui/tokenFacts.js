/**
 * The token header's figures (spec addendum D), as pure functions over what the
 * server sends (Part 02): GET /token/:ca's `info` (TokenInfo) and `figures`, and
 * the stream's `stats` — plus what the live mark implies (curve progress,
 * graduated-pool liquidity), which is fresher than any figure the server sent.
 *
 * EVERYTHING HERE IS ATTACKER-CHOSEN. A pons token's description, socials and
 * logo were typed by whoever launched it, and the CA is whatever the visitor
 * pasted. The server already cleans them; this module cleans them AGAIN, because
 * the page must not depend on it: text is stripped of control and bidi-override
 * characters and rendered as React text only; a social link is an https URL on
 * that network's own hosts (any DNS host for a website) or nothing; the logo is
 * never a URL the page loads — only a yes/no that it may ask its own origin's
 * /api/tp/logo/:ca. No escape sequences are typed in this file (memory:
 * write-tool-escapes): characters are compared by code point.
 */
import { id } from 'ethers';

export const SOCIAL_KINDS = Object.freeze(['x', 'telegram', 'discord', 'website', 'farcaster']);

// THE social host table: each network's accepted hosts -> the host its links are
// shown on. The server's copy (backend/src/tp/tokenInfo.js SOCIAL_HOSTS) is the same
// literal (tab isolation: each side owns its copy) and both tests pin it, so change
// both files together. The server sends every link on its canonical host already;
// checking with the same table, the page drops nothing the server sends.
export const SOCIAL_HOSTS = Object.freeze({
  x: Object.freeze({
    'x.com': 'x.com',
    'www.x.com': 'x.com',
    'mobile.x.com': 'x.com',
    'twitter.com': 'x.com',
    'www.twitter.com': 'x.com',
    'mobile.twitter.com': 'x.com',
  }),
  telegram: Object.freeze({
    't.me': 't.me',
    'www.t.me': 't.me',
    'telegram.me': 't.me',
    'www.telegram.me': 't.me',
  }),
  discord: Object.freeze({
    'discord.gg': 'discord.gg',
    'www.discord.gg': 'discord.gg',
    'discord.com': 'discord.com',
    'www.discord.com': 'discord.com',
    'discordapp.com': 'discord.com',
    'www.discordapp.com': 'discord.com',
  }),
  farcaster: Object.freeze({
    'warpcast.com': 'warpcast.com',
    'www.warpcast.com': 'warpcast.com',
    'farcaster.xyz': 'farcaster.xyz',
    'www.farcaster.xyz': 'farcaster.xyz',
  }),
});
// A profile / post / invite path, the server's rule: '/name', '/name/status/123', '/+invite'.
const SAFE_PATH = /^[/][A-Za-z0-9_.+/-]{1,150}$/;
const WINDOWS = Object.freeze(['m5', 'h1', 'h24']);
const MAX_SOCIAL = 200;
const MAX_DESCRIPTION = 1000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]{1,78}$/;
// A DNS name with a letter TLD (or an IDN one): never an IP literal.
const DNS = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;
const TELEGRAM_HANDLE = /^@?[A-Za-z0-9_]{5,32}$/;
const LF = String.fromCharCode(10);
const Q96 = 1n << 96n;

const lower = (a) => String(a || '').toLowerCase();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A decimal base-unit string as a bigint, or null. */
function dec(v) {
  return typeof v === 'string' && DECIMAL.test(v) ? BigInt(v) : null;
}

/** A positive whole number (unix seconds), or null. */
function posInt(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

/** A finite number, or null. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** C0 / C1 controls (LF excepted), line and paragraph separators, bidi embeddings, overrides and isolates. */
function dropped(c) {
  if (c === 10) return false;
  return c < 32 || (c >= 127 && c < 160) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}

/** Display text: controls stripped, lines trimmed, at most one blank line in a row, at most `max` characters. */
export function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) if (!dropped(ch.codePointAt(0))) out += ch;
  const kept = [];
  let blank = 0;
  for (const line of out.split(LF).map((l) => l.trim())) {
    if (!line) {
      blank += 1;
      if (blank > 1) continue;
    } else blank = 0;
    kept.push(line);
  }
  const text = kept.join(LF).trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A social value as a link the page may render, or null: an https URL with no
 * credentials and no port. A network's link needs a host in SOCIAL_HOSTS and a
 * profile / post / invite path, and comes back on the table's canonical host
 * with no query, as the server sends it; a website needs a DNS host (checked
 * whole) and at most 200 characters. A bare X or Telegram handle becomes its
 * x.com / t.me link. Every link the server sends comes back unchanged.
 */
export function safeSocial(kind, value) {
  if (!SOCIAL_KINDS.includes(kind) || typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > MAX_SOCIAL) return null;
  if (kind === 'x' && X_HANDLE.test(v)) return `https://x.com/${v.replace(/^@/, '')}`;
  if (kind === 'telegram' && TELEGRAM_HANDLE.test(v)) return `https://t.me/${v.replace(/^@/, '')}`;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (kind === 'website') return DNS.test(u.hostname) && u.href.length <= MAX_SOCIAL ? u.href : null;
  const hosts = SOCIAL_HOSTS[kind];
  // Own keys only: 'https://constructor/x' must not find Object.prototype's.
  if (!Object.prototype.hasOwnProperty.call(hosts, u.hostname) || !SAFE_PATH.test(u.pathname)) return null;
  return `https://${hosts[u.hostname]}${u.pathname}`;
}

/**
 * GET /token/:ca's `info` (Part 02 TokenInfo), read tolerantly: a missing or
 * malformed field is absent (null / '' / []), never thrown; an `info` of null
 * (the server could not read it) is an all-absent result with hasLogo false.
 * `socials.twitter` is accepted where `socials.x` is missing.
 */
export function normalizeInfo(raw) {
  const o = isObj(raw) ? raw : {};
  const s = isObj(o.socials) ? o.socials : {};
  const socials = [];
  for (const kind of SOCIAL_KINDS) {
    const url = safeSocial(kind, kind === 'x' && s.x == null ? s.twitter : s[kind]);
    if (url) socials.push({ kind, url });
  }
  return {
    creator: typeof o.creator === 'string' && ADDRESS.test(o.creator) ? o.creator : null,
    description: cleanText(o.description, MAX_DESCRIPTION),
    socials,
    // Only whether to ASK this origin's /api/tp/logo/:ca — never a URL to load.
    hasLogo: isObj(o.logo) || o.logo === true,
    launchedAt: posInt(o.launchedAt),
    launchedBefore: posInt(o.launchedBefore),
    graduationThreshold: dec(o.graduationThreshold) === null ? null : o.graduationThreshold,
    phantomQuote: dec(o.phantomQuote) === null ? null : o.phantomQuote,
  };
}

/** Part 02 Figures ({progress, raised, liquidity: {quote, token}}) -> {progress 0..1 | null, liquidityQuote: bigint | null}, or null. */
export function normalizeFigures(raw) {
  if (!isObj(raw)) return null;
  const p = num(raw.progress);
  return {
    progress: p === null ? null : Math.min(1, Math.max(0, p)),
    liquidityQuote: isObj(raw.liquidity) ? dec(raw.liquidity.quote) : null,
  };
}

/**
 * A curve's progress to graduation, 0..1 (ponsfamily's own formula): the real
 * quote reserve — the mark's quoteReserve less the curve's fixed phantom quote —
 * over the graduation threshold; 1 once the threshold is reached (ready to
 * graduate). Unit-free, so an AMZN-quoted curve works the same. null when an
 * input is unknown.
 */
export function curveProgress(mark, info) {
  if (!mark || !info) return null;
  const q = dec(mark.quoteReserve);
  const phantom = dec(info.phantomQuote);
  const threshold = dec(info.graduationThreshold);
  if (q === null || phantom === null || threshold === null || threshold === 0n) return null;
  const real = q > phantom ? q - phantom : 0n;
  if (real >= threshold) return 1;
  return Number((real * 1_000_000n) / threshold) / 1_000_000;
}

/**
 * The quote asset a graduated pool holds, in base units, from the live mark:
 * its one locked full-range position, L x 2^96 / sqrtP when the quote is
 * currency0 (native ETH always is), L x sqrtP / 2^96 when it is currency1.
 * null for anything else (a v1 pool is not full-range: its reserve comes from
 * the server's figures).
 */
export function poolQuoteReserve(venue, mark) {
  if (!venue || !mark || venue.kind !== 'graduated') return null;
  const L = dec(mark.liquidity);
  const sqrtP = dec(mark.sqrtPriceX96);
  if (L === null || sqrtP === null || sqrtP === 0n) return null;
  const quoteIs0 = typeof venue.quoteIsCurrency0 === 'boolean' ? venue.quoteIsCurrency0 : !!venue.poolKey && lower(venue.poolKey.currency0) !== lower(venue.token);
  return quoteIs0 ? (L * Q96) / sqrtP : (L * sqrtP) / Q96;
}

/**
 * The stream's `stats` (Part 02 Stats), or null. Changes arrive as fractions
 * (0.12 = +12 %) and leave as PERCENT; volume stays in human quote units;
 * complete[k] false = the indexed history does not cover that window yet
 * (the header then says since when).
 * @returns {{change: {m5, h1, h24}, volume: {m5, h1, h24}, complete: {m5, h1, h24}, since: number|null, figures: object|null}|null}
 */
export function normalizeStats(raw) {
  if (!isObj(raw)) return null;
  const change = {};
  const volume = {};
  const complete = {};
  for (const k of WINDOWS) {
    const c = isObj(raw.change) ? num(raw.change[k]) : null;
    change[k] = c === null ? null : c * 100;
    const v = isObj(raw.volume) ? num(raw.volume[k]) : null;
    volume[k] = v !== null && v >= 0 ? v : null;
    complete[k] = isObj(raw.complete) && raw.complete[k] === true;
  }
  return { change, volume, complete, since: posInt(raw.since), figures: normalizeFigures(raw.figures) };
}

/** "+3.3%", "−1.0%", "0.0%", "+1235%", or an em dash when unknown (the input is percent). */
export function fmtChange(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
  const a = Math.abs(p);
  const body = a >= 1000 ? a.toFixed(0) : a.toFixed(1);
  if (p > 0) return `+${body}%`;
  if (p < 0) return `−${body}%`;
  return `${body}%`;
}

/** Which way a change points — the chart's own up / down hues, never the money colours. */
export function changeDir(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p === 0) return 'flat';
  return p > 0 ? 'up' : 'down';
}

/**
 * A 5 x 5 mirrored grid (row-major booleans) drawn from keccak(address): the
 * logo when the token has none, or its logo will not load. Grey cells only — a
 * hue could land on a money colour.
 */
export function identicon(address) {
  const hex = id(lower(address)).slice(2);
  const cells = new Array(25).fill(false);
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const on = parseInt(hex[r * 3 + c], 16) >= 8;
      cells[r * 5 + c] = on;
      cells[r * 5 + (4 - c)] = on;
    }
  }
  if (!cells.some(Boolean)) cells[12] = true;
  return cells;
}
