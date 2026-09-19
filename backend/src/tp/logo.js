'use strict';

// Token logos for the dApp's header (spec Addendum v2 D): fetched BY THE SERVER and
// served by GET /api/tp/logo/:ca from the page's own origin, so the page's CSP stays
// img-src 'self' data:. Two sources:
//
//   - an IPFS logo (ipfs://<cid>, a gateway URL, a bare CID: ~78% of pons logos):
//     getLogo(cid) fetches <gateway prefix><cid> from a fixed https list
//     (TP_LOGO_GATEWAYS, default below). The CID has passed cid.parseCid, whose
//     character set has no '/', '?', '#', '@', ':' or '.', so the token's own logo
//     text contributes nothing but that CID and the host it names is never contacted.
//     Redirects are not followed (redirect: 'manual': any 3xx is a failed gateway);
//   - a logo on an ordinary https host (~21%; spec section E decision 19):
//     getHttpsLogo(url) fetches it through safeFetch.js, the SSRF-safe GET (https on
//     443 only, no userinfo, every DNS answer public, the connection pinned to the
//     vetted address, at most 2 redirects each vetted again, 5 s in all).
//
// What is served: at most TP_LOGO_MAX_BYTES (default 3 MiB, at most 5 MiB: the largest
// sampled pons logos are 3 MB), and only PNG, JPEG, GIF or WebP by their MAGIC BYTES —
// never SVG, and never whatever Content-Type a gateway or host claimed.
// A raw-codec CIDv1 (bafkrei..., ~half of all pons logos) IS the sha2-256 of the file,
// so those bytes are verified and a lying gateway cannot swap the image. dag-pb CIDs
// (Qm..., bafybei...) wrap the file in a UnixFS node and are not verified: their bytes
// are only a gateway's word, so they are trusted for UNVERIFIED_TTL_MS (a day) and no
// longer. The server then drops them and asks the gateways again, and GET /logo tells
// browsers max-age=86400 (CACHE_HIT_UNVERIFIED). Only verified bytes stay held until
// evicted and are served immutable (CACHE_HIT). A logo from an https host can never be
// verified (its host may change it at any time): it is held and served like dag-pb
// bytes, for a day.
//
// Gateways (server-side, measured 2026-09-19): ponsfamily's own worker — where
// ponsfamily uploads logos (config.ipfsUploadUrl) — answers in 0.3-1.5 s, Filebase in
// 0.6-2.5 s, Pinata (config.ipfsGatewayUrl) in 5-8 s. ipfs.io and dweb.link answer 429
// ("service worker gateway only") and cloudflare-ipfs is gone. Tried in order, one at
// a time, each with its own timeout.
//
// A 451 (Unavailable For Legal Reasons — the pons worker's answer for moderated
// content) is FINAL: the logo is not shown and no other gateway is asked for it.
//
// Caches, per CID: the bytes in an LRU bounded by TP_LOGO_CACHE_BYTES (default 64 MiB),
// where a verified hit never goes stale and an unverified one expires after
// UNVERIFIED_TTL_MS; a failed CID is not retried for TP_LOGO_RETRY_MS (default 10 min),
// a 451 never. One fetch per CID at a time and at most TP_LOGO_CONCURRENCY (default 3)
// gateway requests in flight process-wide.
//
// NOBODY WAITS FOR EVER, AND NOBODY OWNS THE LANE. Those 3 slots are process-wide and
// a dead CID holds one for the full 4 s + 4 s + 10 s of gateway attempts, so one
// visitor spending their whole read budget on distinct dead CIDs (120/min) used to
// outrun the lane (~0.17 CIDs/s) and every other visitor's logo queued behind it with
// no deadline at all — every timer in this file started only once a slot was granted.
// Now:
//   - a request carries a WAIT BUDGET (TP_LOGO_WAIT_MS, 15 s) measured from ARRIVAL and
//     spanning every gateway hop, since fetchCid takes a fresh slot per gateway;
//   - at most TP_LOGO_PER_CALLER (2) fetches per caller key (the route passes the
//     client IP) may be in flight, so one visitor cannot hold all 3 slots. A caller
//     that JOINS a fetch already in flight pays nothing: it is not more work;
//   - at most MAX_WAITING callers queue for a slot; past that the next is shed at once.
// A shed request answers {ok: false, permanent: false, shed: true} and is NEVER
// remembered as a miss — otherwise queue pressure would park a perfectly good logo for
// TP_LOGO_RETRY_MS, which is worse than the wait it avoids. GET /logo answers it 404
// with no-store, exactly as it answers a gateway failure, and the page draws its
// identicon until the next try.
//
// Node's global fetch (undici): no new dependency. Requiring this module starts nothing.

const crypto = require('node:crypto');
const { parseCid } = require('./cid');
const safeFetch = require('./safeFetch'); // module object: tests stand in for safeGet

const DEFAULT_GATEWAYS = Object.freeze([
  'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/|4000',
  'https://ipfs.filebase.io/ipfs/|4000',
  'https://gateway.pinata.cloud/ipfs/|10000',
]);
const MIB = 1024 * 1024;
// Each overridable by its TP_LOGO_* variable (backend/.env.example).
const DEFAULTS = Object.freeze({
  maxBytes: 3 * MIB,
  cacheBytes: 64 * MIB,
  retryMs: 10 * 60_000,
  concurrency: 3,
  // Under nginx's 60 s proxy_read_timeout, and over the 18 s a full round of gateway
  // attempts takes, so a request that is being SERVED is never cut short (and its
  // failure is still remembered for retryMs); only real queueing runs it out.
  waitBudgetMs: 25_000,
  perCaller: 2,
});
// Callers queued for a slot before the next is shed at once.
const MAX_WAITING = 64;
// What a shed request answers: not a verdict on the logo, so it is never cached.
const SHED = Object.freeze({ ok: false, permanent: false, reason: 'busy', shed: true });
const MAX_BYTES_CEILING = 5 * MIB; // pons' own uploader cap: no reason to ever allow more
const MAX_MISSES = 10_000;
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_TIMEOUT_MS = 30_000;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

// Headers on every GET /api/tp/logo answer (routes/tp.js): the bytes are an image and
// nothing else, only this origin may embed them, and opened directly they run nothing.
const LOGO_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
});
// How long bytes that could NOT be checked against their CID (dag-pb) are trusted: the
// server holds them this long, and browsers cache them this long, so a wrong answer
// from a gateway is gone within two days.
const UNVERIFIED_TTL_MS = 86_400_000;
const CACHE_HIT = 'public, max-age=31536000, immutable'; // bytes that hash to their CID never change
const CACHE_HIT_UNVERIFIED = `public, max-age=${UNVERIFIED_TTL_MS / 1000}`; // a gateway's word: a day
const CACHE_NONE_FINAL = 'public, max-age=86400'; // no logo, and there never will be
const CACHE_NONE_RETRY = 'no-store'; // no logo right now: the gateways failed

const posInt = (v, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : d;
};

/**
 * 'prefix|timeoutMs,...' -> [{prefix, timeoutMs}]. A prefix must be an https URL ending
 * in '/', with no credentials, port, query or fragment; anything else is dropped.
 */
function parseGateways(text) {
  const out = [];
  for (const entry of String(text || '').split(',')) {
    const [rawPrefix, rawMs] = entry.trim().split('|');
    if (!rawPrefix) continue;
    let url;
    try {
      url = new URL(rawPrefix);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) continue;
    if (!url.pathname.endsWith('/') || url.href !== rawPrefix) continue;
    out.push({ prefix: url.href, timeoutMs: Math.min(posInt(rawMs, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS) });
  }
  return out;
}

const startsWith = (buf, at, bytes) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);

/** The image type by magic bytes: PNG, JPEG, GIF or WebP; anything else (SVG, HTML) is null. */
function sniffImage(buf) {
  if (!buf || !buf.length) return null;
  if (startsWith(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, 0, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'image/gif'; // GIF87a / GIF89a
  }
  if (startsWith(buf, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'; // RIFF....WEBP
  }
  return null;
}

/**
 * At most `max` calls of fn in flight; the rest wait in arrival order, each no longer
 * than its own `deadline` (a wall-clock ms, from the caller's ARRIVAL). A caller that
 * gives up, or that meets a full queue, gets SHED back instead of running `fn`.
 */
function createLimiter(max, { maxWaiting = MAX_WAITING, now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  let active = 0;
  const queue = []; // {done, resolve}: a waiter that gave up stays until it is skipped

  function release() {
    while (queue.length) {
      const w = queue.shift();
      if (w.done) continue; // gave up: the slot it would have taken is still free
      w.done = true;
      w.resolve(true); // the slot passes straight to it, so `active` does not move
      return;
    }
    active -= 1;
  }

  function take(deadline) {
    if (active < max) {
      active += 1;
      return Promise.resolve(true);
    }
    if (queue.length >= maxWaiting) return Promise.resolve(false);
    const ms = deadline == null ? Infinity : deadline - now();
    if (!(ms > 0)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = { done: false, resolve: null };
      const timer = Number.isFinite(ms)
        ? st(() => {
            if (w.done) return;
            w.done = true;
            resolve(false);
          }, ms)
        : null;
      w.resolve = (v) => {
        if (timer) ct(timer);
        resolve(v);
      };
      queue.push(w);
    });
  }

  return async function run(fn, { deadline = null } = {}) {
    if (!(await take(deadline))) return SHED;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function discard(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
  } catch {
    // nothing to free
  }
}

/** The body, or null past `max` bytes (the download is aborted there, not finished). */
async function readCapped(res, max, controller) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) {
      controller.abort();
      return null;
    }
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks, total);
}

function createLogoStore(overrides = {}) {
  const env = process.env;
  const deps = {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    gateways: null,
    safeGet: (url, options) => safeFetch.safeGet(url, options),
    maxBytes: Math.min(posInt(env.TP_LOGO_MAX_BYTES, DEFAULTS.maxBytes), MAX_BYTES_CEILING),
    cacheBytes: posInt(env.TP_LOGO_CACHE_BYTES, DEFAULTS.cacheBytes),
    retryMs: posInt(env.TP_LOGO_RETRY_MS, DEFAULTS.retryMs),
    concurrency: posInt(env.TP_LOGO_CONCURRENCY, DEFAULTS.concurrency),
    waitBudgetMs: posInt(env.TP_LOGO_WAIT_MS, DEFAULTS.waitBudgetMs),
    perCaller: posInt(env.TP_LOGO_PER_CALLER, DEFAULTS.perCaller),
    ...overrides,
  };
  const fromEnv = parseGateways(env.TP_LOGO_GATEWAYS);
  const gateways = deps.gateways || (fromEnv.length ? fromEnv : parseGateways(DEFAULT_GATEWAYS.join(',')));
  const limit = createLimiter(deps.concurrency, { now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });

  // Keyed by the CID, or by 'https:' + the URL for a logo on an https host.
  const hits = new Map(); // key -> {bytes, type, verified, expires}, oldest first
  let held = 0;
  const misses = new Map(); // key -> {until, permanent, reason}
  const inflight = new Map(); // key -> Promise
  const busyPerCaller = new Map(); // caller key -> fetches of its own in flight

  function remember(cid, entry) {
    if (entry.bytes.length > deps.cacheBytes) return;
    while (held + entry.bytes.length > deps.cacheBytes && hits.size) {
      const [oldest, e] = hits.entries().next().value;
      hits.delete(oldest);
      held -= e.bytes.length;
    }
    hits.set(cid, entry);
    held += entry.bytes.length;
  }

  function rememberMiss(cid, r) {
    if (misses.size >= MAX_MISSES) misses.delete(misses.keys().next().value);
    misses.set(cid, { until: r.permanent ? Infinity : deps.now() + deps.retryMs, permanent: r.permanent, reason: r.reason });
  }

  /** One gateway, one attempt: {ok, bytes, type, verified} or {reason, final?}. Never throws. */
  async function fromGateway(gw, parsed) {
    const controller = new AbortController();
    const timer = deps.setTimeout(() => controller.abort(), gw.timeoutMs);
    try {
      const res = await deps.fetch(gw.prefix + parsed.cid, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: ACCEPT },
      });
      if (res.status === 451) {
        discard(res);
        return { reason: 'blocked', final: true };
      }
      if (res.status !== 200) {
        discard(res);
        return { reason: `http_${res.status}` };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > deps.maxBytes) {
        discard(res);
        return { reason: 'too_large' };
      }
      const bytes = await readCapped(res, deps.maxBytes, controller);
      if (!bytes) return { reason: 'too_large' };
      const type = sniffImage(bytes);
      if (!type) return { reason: 'not_image' };
      const verified = parsed.codec === 'raw'; // the only CIDs that are the file's own hash
      if (verified) {
        const digest = crypto.createHash('sha256').update(bytes).digest();
        if (!digest.equals(parsed.digest)) return { reason: 'hash_mismatch' };
      }
      return { ok: true, bytes, type, verified };
    } catch (_err) {
      return { reason: controller.signal.aborted ? 'timeout' : 'fetch_failed' };
    } finally {
      deps.clearTimeout(timer);
    }
  }

  /** Every gateway in turn, inside ONE wait budget: a slot per gateway, but not a queue each. */
  async function fetchCid(parsed, deadline) {
    let reason = 'no_gateway';
    for (const gw of gateways) {
      if (deps.now() >= deadline) return SHED;
      const r = await limit(() => fromGateway(gw, parsed), { deadline });
      if (r === SHED) return SHED;
      if (r.ok) return r;
      reason = r.reason;
      if (r.final) return { ok: false, permanent: true, reason };
    }
    return { ok: false, permanent: false, reason };
  }

  /**
   * `key`'s image from the caches, or from `load()` once (single-flight), remembered:
   * a verified answer for good, an unverified one for UNVERIFIED_TTL_MS, a failure for
   * retryMs (a permanent one for good).
   */
  function cached(key, load, by) {
    const hit = hits.get(key);
    if (hit) {
      hits.delete(key);
      if (hit.expires > deps.now()) {
        hits.set(key, hit); // most recently used goes last
        return Promise.resolve({ ok: true, bytes: hit.bytes, type: hit.type, verified: hit.verified });
      }
      held -= hit.bytes.length; // unverified bytes had their day: ask the gateways again
    }
    const miss = misses.get(key);
    if (miss && miss.until > deps.now()) {
      return Promise.resolve({ ok: false, permanent: miss.permanent, reason: miss.reason });
    }
    // Joining a fetch already in flight is free: it is not more work for anyone.
    if (inflight.has(key)) return inflight.get(key);
    const mine = by == null ? 0 : busyPerCaller.get(by) || 0;
    if (mine >= deps.perCaller) return Promise.resolve(SHED);
    if (by != null) busyPerCaller.set(by, mine + 1);
    const pending = load()
      .then((r) => {
        // A shed request never answered the question, so nothing is remembered for it:
        // queue pressure must not park a good logo for retryMs.
        if (r === SHED || r.shed) return SHED;
        if (r.ok) {
          misses.delete(key);
          const expires = r.verified ? Infinity : deps.now() + UNVERIFIED_TTL_MS;
          remember(key, { bytes: r.bytes, type: r.type, verified: r.verified, expires });
          return { ok: true, bytes: r.bytes, type: r.type, verified: r.verified };
        }
        rememberMiss(key, r);
        return r;
      })
      .finally(() => {
        inflight.delete(key);
        if (by == null) return;
        const n = (busyPerCaller.get(by) || 1) - 1;
        if (n > 0) busyPerCaller.set(by, n);
        else busyPerCaller.delete(by);
      });
    inflight.set(key, pending);
    return pending;
  }

  /**
   * A CID's image: {ok: true, bytes: Buffer, type, verified} or {ok: false, permanent, reason}.
   * `verified`: the bytes hash to the CID (a raw CID), so they may be cached for good.
   * `permanent`: there will never be an image for this CID (a bad CID, a 451).
   */
  function getLogo(cidText, { by = null } = {}) {
    const parsed = parseCid(cidText);
    if (!parsed) return Promise.resolve({ ok: false, permanent: true, reason: 'bad_cid' });
    const deadline = deps.now() + deps.waitBudgetMs;
    return cached(parsed.cid, () => fetchCid(parsed, deadline), by);
  }

  /** One attempt at an https host's logo through safeFetch: {ok, bytes, type, verified: false} or {reason}. */
  async function fromHttpsHost(url) {
    const r = await deps.safeGet(url, { maxBytes: deps.maxBytes });
    if (!r.ok) return { ok: false, permanent: r.reason === 'bad_url', reason: r.reason };
    const type = sniffImage(r.bytes);
    if (!type) return { ok: false, permanent: false, reason: 'not_image' };
    return { ok: true, bytes: r.bytes, type, verified: false };
  }

  /**
   * The image a logo URL on an ordinary https host names, fetched SSRF-safe
   * (safeFetch.js): {ok: true, bytes, type, verified: false} or {ok: false, permanent, reason}.
   * Never verified: held for UNVERIFIED_TTL_MS and served for a day, like dag-pb bytes.
   */
  function getHttpsLogo(url, { by = null } = {}) {
    const vetted = safeFetch.vetUrl(url);
    if (!vetted) return Promise.resolve({ ok: false, permanent: true, reason: 'bad_url' });
    const deadline = deps.now() + deps.waitBudgetMs;
    return cached(`https:${vetted.href}`, () => limit(() => fromHttpsHost(vetted.href), { deadline }), by);
  }

  return { getLogo, getHttpsLogo, gateways, heldBytes: () => held };
}

let store = null; // built on first use, so requiring this module reads nothing

function getLogo(cid, options) {
  if (!store) store = createLogoStore();
  return store.getLogo(cid, options);
}

function getHttpsLogo(url, options) {
  if (!store) store = createLogoStore();
  return store.getHttpsLogo(url, options);
}

module.exports = {
  getLogo,
  getHttpsLogo,
  createLogoStore,
  parseGateways,
  sniffImage,
  DEFAULT_GATEWAYS,
  DEFAULTS,
  MAX_WAITING,
  SHED,
  LOGO_HEADERS,
  CACHE_HIT,
  CACHE_HIT_UNVERIFIED,
  CACHE_NONE_FINAL,
  CACHE_NONE_RETRY,
  UNVERIFIED_TTL_MS,
};
