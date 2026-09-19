'use strict';

// A pons token's info for the dApp's token header (spec Addendum v2 D): what the token
// says about itself, what the factory registry says about its launch, and the figures
// the header derives from the live mark (curve progress, pool liquidity) and from the
// indexer (5 m / 1 h / 24 h change and volume).
//
// readTokenInfo: ONE Multicall3 request per token, then CACHED FOREVER — nothing read
// here can change. The token has no setter for its metadata (its dispatcher holds only
// ERC-20, burn and the metadata getters — measured 2026-09-19), and the registry's
// launch record and the curve's launch constants are fixed at launch:
//   token.getTokenInfo()      deployer, logo, description, socials      v1 and v2
//   factory.getLaunchedToken  deployer = the creator, creatorFeeRecipient (v2),
//                             graduationThreshold (v2)
//   curve.launchedAt()        unix seconds == the launch block's timestamp (v2)
//   curve.phantomQuote()      the curve's virtual quote reserve (v2)
//   curve.launchSupply()      tokens on the curve at launch (v2)
// A graduated token's curve is its venue.formerCurve. A slot that fails (a revert) is
// a null field and IS cached (deterministic); a request that fails is not cached.
//
// v1 has no launch-time getter (token.launchBlock() is an L1 block number) and v1 is
// dead: its last launch was at 1786563753 (block 34,788,618, 2026-08-12). A v1 token
// answers launchedAt: null, launchedBefore: V1_LAST_LAUNCH_TS. No whole-chain getLogs
// for it: the public RPC rate-limits that after ~7 calls and QuickNode refuses the span.
//
// The CREATOR is the REGISTRY's deployer, never the token's own word. It can be a
// third-party launcher contract (GMGNPAD's is); creatorFeeRecipient is then the
// account behind it.
//
// Every string is attacker-chosen. Control and bidi-override characters are stripped
// by code point (no escape sequences in this source — memory: write-tool-escapes),
// lengths are capped, socials are kept only when they become an https URL on the
// platform's own host (website: any https host), and the logo text is reduced to an
// IPFS CID (cid.js) or, failing that, to an https URL on a named host on port 443
// (safeFetch.vetUrl), which GET /api/tp/logo/:ca serves (logo.js). The URL rides on the
// info object as a NON-enumerable property, so JSON (GET /token) never carries it: the
// raw logo text never reaches the browser.
//
// figures(): curve progress is ponsfamily's own formula (ponsV2GraduationProgress in
// their bundle): real quote / graduationThreshold, real = quoteReserve - phantomQuote
// (getReserves includes the phantom — state.js readMark). A graduated pool is ONE
// locked full-range position (the graduation logs PositionLocked), so its reserves are
// L * 2^96 / sqrtP of currency0 and L * sqrtP / 2^96 of currency1. A v1 pool's
// positions are concentrated: its reserves are the pool's balances (poolBalances).

const { Interface, formatUnits, getAddress } = require('ethers');
const C = require('./constants');
const { TpError } = require('./errors');
// Called through the module object, never destructured, so a test can swap the provider.
const providers = require('./providers');
const { aggregate3, decodeSlot, one } = require('./multicall');
const { cidFromLogoUri } = require('./cid');
const { vetUrl } = require('./safeFetch');

const lc = (a) => String(a).toLowerCase();
const ZERO = lc(C.NATIVE);

const V1_LAST_LAUNCH_TS = 1786563753;
// Genuine pons tokens only (the venue gate runs first), like venue.js's cache.
const MAX_CACHE = 5000;
const MAX_DESCRIPTION = 1000;
const MAX_SOCIAL = 200;
const MAX_LINK = 300;
const POOL_TTL_MS = 15_000;
const LF = 10;
const LOGO_PATH = '/api/tp/logo/';

const tokenIface = new Interface(C.ABI.PONS_TOKEN);
const v2FactoryIface = new Interface(C.ABI.V2_FACTORY);
const v1FactoryIface = new Interface(C.ABI.V1_FACTORY);
const curveIface = new Interface(C.ABI.CURVE);
const erc20Iface = new Interface(C.ABI.ERC20);

const cache = new Map(); // token (lower-case) -> TokenInfo (frozen)
const inflight = new Map(); // token -> Promise<TokenInfo>
const pools = new Map(); // v1 token -> { at, value, pending, failedAt }

function providerOf(deps) {
  return deps.provider || providers.tpReadProvider();
}

// ── strings ──────────────────────────────────────────────────────────────────

/** Is this code point kept? C0/C1 controls, DEL and bidi overrides are not; LF only if asked. */
function keepCode(c, keepLf) {
  if (c === LF) return keepLf;
  if (c < 32 || c === 127 || (c >= 128 && c <= 159)) return false;
  if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return false;
  return true;
}

function cleanString(value, max, keepLf = false) {
  if (typeof value !== 'string') return '';
  const kept = Array.from(value).filter((ch) => keepCode(ch.codePointAt(0), keepLf));
  return kept.slice(0, max).join('').trim();
}

/** The description: plain text, line breaks kept, at most 1000 characters. */
function cleanDescription(value) {
  return cleanString(value, MAX_DESCRIPTION, true);
}

const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const TELEGRAM_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);
const DISCORD_HOSTS = new Set(['discord.gg', 'www.discord.gg', 'discord.com', 'www.discord.com', 'discordapp.com', 'www.discordapp.com']);
const FARCASTER_HOSTS = new Set(['warpcast.com', 'www.warpcast.com', 'farcaster.xyz', 'www.farcaster.xyz']);
// A profile / post / invite path: '/name', '/name/status/123', '/+invite', '/i/status/1'.
const SAFE_PATH = /^[/][A-Za-z0-9_.+/-]{1,150}$/;
const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;
const TELEGRAM_HANDLE = /^@?([A-Za-z0-9_]{5,32})$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A social field's text, or '' when absent or over the cap (never truncated into another URL). */
function socialText(value) {
  const s = cleanString(value, MAX_SOCIAL + 1);
  return s.length > MAX_SOCIAL ? '' : s;
}

/** http(s) text (a bare host gets https://) -> an https URL object, or null. */
function httpsUrl(value) {
  const s = socialText(value);
  if (!s || s.includes(' ')) return null;
  let url;
  try {
    url = new URL(HAS_SCHEME.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  url.protocol = 'https:';
  return url;
}

/** A link on one platform: its own host, a safe path, no query; www. dropped. */
function platformLink(value, hosts, canonicalHost) {
  const url = httpsUrl(value);
  if (!url || !hosts.has(url.hostname) || !SAFE_PATH.test(url.pathname)) return null;
  return 'https://' + (canonicalHost || url.hostname.replace(/^www[.]/, '')) + url.pathname;
}

function xLink(value) {
  const handle = X_HANDLE.exec(socialText(value));
  if (handle) return 'https://x.com/' + handle[1];
  return platformLink(value, X_HOSTS, 'x.com');
}

function telegramLink(value) {
  const handle = TELEGRAM_HANDLE.exec(socialText(value));
  if (handle) return 'https://t.me/' + handle[1];
  return platformLink(value, TELEGRAM_HOSTS, 't.me');
}

function websiteLink(value) {
  const url = httpsUrl(value);
  if (!url || !url.hostname.includes('.') || url.hostname.endsWith('.')) return null;
  return url.href.length <= MAX_LINK ? url.href : null;
}

/**
 * The token's socials as https links, each null when absent or unusable. A link on the
 * wrong platform (a tweet in the telegram field) is dropped, not moved.
 */
function normaliseSocials(socials) {
  const s = socials || {};
  return Object.freeze({
    x: xLink(s.twitter),
    telegram: telegramLink(s.telegram),
    discord: platformLink(s.discord, DISCORD_HOSTS, null),
    website: websiteLink(s.website),
    farcaster: platformLink(s.farcaster, FARCASTER_HOSTS, null),
  });
}

/**
 * The logo text -> {cid, path} for an IPFS logo, {path} with a non-enumerable `url` for
 * one on an ordinary https host, or null (path: this token's GET /api/tp/logo/:ca).
 */
function logoOf(token, text) {
  const cid = cidFromLogoUri(text);
  if (cid) return Object.freeze({ cid, path: LOGO_PATH + token });
  const url = vetUrl(text);
  if (!url) return null;
  const logo = { path: LOGO_PATH + token };
  Object.defineProperty(logo, 'url', { value: url.href, enumerable: false });
  return Object.freeze(logo);
}

const addressOrNull = (a) => (a == null || lc(a) === ZERO ? null : getAddress(lc(a)));
const uintOrNull = (v) => (v == null ? null : BigInt(v).toString());

// ── the static info ──────────────────────────────────────────────────────────

async function readFresh(venue, deps) {
  const token = lc(venue.token);
  const v2 = venue.kind === 'curve' || venue.kind === 'graduated';
  const curve = v2 ? lc(venue.curve || venue.formerCurve || ZERO) : ZERO;
  const calls = [
    { target: token, callData: tokenIface.encodeFunctionData('getTokenInfo') },
    v2
      ? { target: lc(C.PONS_V2_FACTORY), callData: v2FactoryIface.encodeFunctionData('getLaunchedToken', [token]) }
      : { target: lc(C.PONS_V1_FACTORY), callData: v1FactoryIface.encodeFunctionData('getLaunchedToken', [token]) },
  ];
  const withCurve = v2 && curve !== ZERO;
  if (withCurve) {
    calls.push({ target: curve, callData: curveIface.encodeFunctionData('launchedAt') });
    calls.push({ target: curve, callData: curveIface.encodeFunctionData('phantomQuote') });
    calls.push({ target: curve, callData: curveIface.encodeFunctionData('launchSupply') });
  }
  const slots = await aggregate3(providerOf(deps), calls);

  const meta = decodeSlot(tokenIface, 'getTokenInfo', slots[0]);
  const found = one(v2 ? v2FactoryIface : v1FactoryIface, 'getLaunchedToken', slots[1]);
  const rec = found && found.exists ? found : null;
  const at = withCurve ? one(curveIface, 'launchedAt', slots[2]) : null;
  const launchedAt = at != null && BigInt(at) > 0n ? Number(at) : null;

  return Object.freeze({
    token,
    version: v2 ? 'v2' : 'v1',
    name: venue.name,
    symbol: venue.symbol,
    description: cleanDescription(meta ? meta.description : ''),
    socials: normaliseSocials(meta ? meta.socials : null),
    logo: logoOf(token, meta ? meta.logo : null),
    creator: rec ? addressOrNull(rec.deployer) : null,
    creatorFeeRecipient: rec && v2 ? addressOrNull(rec.creatorFeeRecipient) : null,
    launchedAt,
    launchedBefore: v2 || launchedAt != null ? null : V1_LAST_LAUNCH_TS,
    graduationThreshold: rec && v2 ? uintOrNull(rec.graduationThreshold) : null,
    phantomQuote: withCurve ? uintOrNull(one(curveIface, 'phantomQuote', slots[3])) : null,
    launchSupply: withCurve ? uintOrNull(one(curveIface, 'launchSupply', slots[4])) : null,
  });
}

/**
 * TokenInfo for a RESOLVED venue (venue.js), read once and cached forever. Rejects when
 * the chain does not answer (nothing is cached then). `deps.provider` replaces the
 * shared read provider (tests).
 */
function readTokenInfo(venue, deps = {}) {
  if (!venue || !venue.token || !venue.kind) {
    return Promise.reject(new TpError('bad_request', 'a resolved venue is required'));
  }
  const key = lc(venue.token);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const pending = readFresh(venue, deps)
    .then((info) => {
      if (!cache.has(key) && cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, info);
      return info;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/** The cached TokenInfo, or null — never a read. */
function cachedInfo(token) {
  return cache.get(lc(token)) || null;
}

// ── the live figures ─────────────────────────────────────────────────────────

async function readPoolBalances(venue, deps) {
  const pool = lc(venue.pool);
  const slots = await aggregate3(providerOf(deps), [
    { target: lc(C.WETH), callData: erc20Iface.encodeFunctionData('balanceOf', [pool]) },
    { target: lc(venue.token), callData: erc20Iface.encodeFunctionData('balanceOf', [pool]) },
  ]);
  const quote = one(erc20Iface, 'balanceOf', slots[0]);
  const tokens = one(erc20Iface, 'balanceOf', slots[1]);
  if (quote == null || tokens == null) {
    throw new TpError('unavailable', `could not read the pool balances of ${venue.token}`, 503);
  }
  return Object.freeze({ quote: BigInt(quote).toString(), token: BigInt(tokens).toString() });
}

/**
 * A v1 pool's reserves {quote, token} (WETH and token balances of the pool, base units),
 * memoised POOL_TTL_MS per token with one read in flight; null for any other venue.
 * A failed read is not retried for POOL_TTL_MS.
 */
function poolBalances(venue, deps = {}) {
  if (!venue || venue.kind !== 'v1' || !venue.pool) return Promise.resolve(null);
  const key = lc(venue.token);
  const now = (deps.now || Date.now)();
  const memo = pools.get(key) || { at: -Infinity, value: null, pending: null, failedAt: -Infinity };
  if (memo.value && now - memo.at < POOL_TTL_MS) return Promise.resolve(memo.value);
  if (memo.pending) return memo.pending;
  if (now - memo.failedAt < POOL_TTL_MS) {
    return memo.value ? Promise.resolve(memo.value) : Promise.reject(new TpError('unavailable', 'pool balances unavailable', 503));
  }
  const pending = readPoolBalances(venue, deps).then(
    (value) => {
      pools.set(key, { at: (deps.now || Date.now)(), value, pending: null, failedAt: -Infinity });
      return value;
    },
    (err) => {
      pools.set(key, { ...memo, pending: null, failedAt: (deps.now || Date.now)() });
      throw err;
    }
  );
  if (!pools.has(key) && pools.size >= MAX_CACHE) pools.delete(pools.keys().next().value);
  pools.set(key, { ...memo, pending });
  return pending;
}

/** The last known v1 pool reserves (or null) at once; refreshes them in the background when stale. */
function peekPoolBalances(venue, deps = {}) {
  if (!venue || venue.kind !== 'v1') return null;
  poolBalances(venue, deps).catch(() => {});
  const memo = pools.get(lc(venue.token));
  return memo ? memo.value : null;
}

/**
 * The header's live figures from a Mark (state.js readMark) and the TokenInfo:
 *   progress   0..1 of the way to graduation (curve), 1 (graduated), null (v1 / unknown)
 *   raised     the curve's REAL quote reserve, pair base units (curve only)
 *   liquidity  {quote, token} pool reserves in base units (graduated, v1), else null
 * A figure that cannot be computed is null — never a guess.
 */
function figures(venue, mark, info, pool = null) {
  const out = { progress: null, raised: null, liquidity: null };
  if (!venue) return out;
  if (venue.kind === 'curve') {
    if (!mark || mark.quoteReserve == null || !info || info.phantomQuote == null || info.graduationThreshold == null) {
      return out;
    }
    const q = BigInt(mark.quoteReserve);
    const phantom = BigInt(info.phantomQuote);
    const target = BigInt(info.graduationThreshold);
    const real = q > phantom ? q - phantom : 0n;
    out.raised = real.toString();
    if (target > 0n) out.progress = real >= target ? 1 : Number((real * 1_000_000n) / target) / 1_000_000;
    return out;
  }
  if (venue.kind === 'graduated') {
    out.progress = 1;
    if (!mark || mark.sqrtPriceX96 == null || mark.liquidity == null || !venue.poolKey) return out;
    const sqrtP = BigInt(mark.sqrtPriceX96);
    const L = BigInt(mark.liquidity);
    if (sqrtP <= 0n) return out;
    const amount0 = (L << 96n) / sqrtP;
    const amount1 = (L * sqrtP) >> 96n;
    const tokenIs0 = lc(venue.poolKey.currency0) === lc(venue.token);
    out.liquidity = {
      quote: (tokenIs0 ? amount1 : amount0).toString(),
      token: (tokenIs0 ? amount0 : amount1).toString(),
    };
    return out;
  }
  if (venue.kind === 'v1' && pool && pool.quote != null && pool.token != null) {
    out.liquidity = { quote: String(pool.quote), token: String(pool.token) };
  }
  return out;
}

/**
 * A v2 curve's launch as the reference price for a window it falls inside:
 * {ts, price} with price = phantomQuote / launchSupply in human units (pair per token,
 * the unit of every Trade.price), or null.
 */
function launchRef(venue, info) {
  if (!venue || !info || info.launchedAt == null || info.phantomQuote == null || info.launchSupply == null) return null;
  const quote = Number(formatUnits(BigInt(info.phantomQuote), venue.pairDecimals));
  const supply = Number(formatUnits(BigInt(info.launchSupply), venue.decimals));
  if (!(quote > 0) || !(supply > 0)) return null;
  return { ts: Number(info.launchedAt), price: quote / supply };
}

/**
 * The stream's 'stats' payload for one indexer: its CandleRing stats (change and volume
 * per window) plus the figures from its current mark. null for an indexer that cannot
 * report stats. Never reads the chain on the caller's path: the TokenInfo comes from the
 * cache (a miss starts the read for the next call) and a v1 pool from its memo.
 */
function streamStats(indexer, deps = {}) {
  if (!indexer || typeof indexer.stats !== 'function' || !indexer.venue) return null;
  const venue = indexer.venue;
  const info = cachedInfo(venue.token);
  if (!info) readTokenInfo(venue, deps).catch(() => {});
  const s = indexer.stats(launchRef(venue, info));
  if (!s) return null;
  const pool = venue.kind === 'v1' ? peekPoolBalances(venue, deps) : null;
  return { ...s, figures: figures(venue, indexer.mark, info, pool) };
}

/** Tests only: forget every cached info and pool memo. */
function _clearCache() {
  cache.clear();
  inflight.clear();
  pools.clear();
}

module.exports = {
  readTokenInfo,
  cachedInfo,
  figures,
  launchRef,
  poolBalances,
  peekPoolBalances,
  streamStats,
  normaliseSocials,
  cleanDescription,
  V1_LAST_LAUNCH_TS,
  POOL_TTL_MS,
  _clearCache,
};
