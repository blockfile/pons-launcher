'use strict';

// Token logos for the dApp's header (spec Addendum v2 D): fetched BY THE SERVER from
// IPFS gateways and served by GET /api/tp/logo/:ca from the page's own origin, so the
// page's CSP stays img-src 'self' data:.
//
// SSRF. The only URLs this module ever fetches are <gateway prefix><cid>: the prefixes
// are a fixed https list (TP_LOGO_GATEWAYS, default below) and the CID has passed
// cid.parseCid, whose character set has no '/', '?', '#', '@', ':' or '.'. The token's
// own logo text contributes nothing but that CID; the host it names is never
// contacted. Redirects are not followed (redirect: 'manual' — any 3xx is a failed
// gateway), so a gateway cannot bounce the fetch anywhere else either.
//
// What is served: at most TP_LOGO_MAX_BYTES (default 1 MiB, the spec's cap; ~15% of
// sampled pons logos are 1-3 MB and become identicons), and only PNG, JPEG, GIF or WebP
// by their MAGIC BYTES — never SVG, and never whatever Content-Type a gateway claimed.
// A raw-codec CIDv1 (bafkrei..., ~half of all pons logos) IS the sha2-256 of the file,
// so those bytes are verified and a lying gateway cannot swap the image. dag-pb CIDs
// (Qm..., bafybei...) wrap the file in a UnixFS node and are not verified: their bytes
// are only a gateway's word, so they are trusted for UNVERIFIED_TTL_MS (a day) and no
// longer. The server then drops them and asks the gateways again, and GET /logo tells
// browsers max-age=86400 (CACHE_HIT_UNVERIFIED). Only verified bytes stay held until
// evicted and are served immutable (CACHE_HIT).
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
// Node's global fetch (undici): no new dependency. Requiring this module starts nothing.

const crypto = require('node:crypto');
const { parseCid } = require('./cid');

const DEFAULT_GATEWAYS = Object.freeze([
  'https://pons-vercel-data-gateway.ozzy-6de.workers.dev/public/ipfs/|4000',
  'https://ipfs.filebase.io/ipfs/|4000',
  'https://gateway.pinata.cloud/ipfs/|10000',
]);
const MIB = 1024 * 1024;
// Each overridable by its TP_LOGO_* variable (backend/.env.example).
const DEFAULTS = Object.freeze({ maxBytes: MIB, cacheBytes: 64 * MIB, retryMs: 10 * 60_000, concurrency: 3 });
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

/** At most `max` calls of fn in flight; the rest wait in arrival order. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active >= max) await new Promise((resolve) => queue.push(resolve));
    else active += 1;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
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
    maxBytes: Math.min(posInt(env.TP_LOGO_MAX_BYTES, DEFAULTS.maxBytes), MAX_BYTES_CEILING),
    cacheBytes: posInt(env.TP_LOGO_CACHE_BYTES, DEFAULTS.cacheBytes),
    retryMs: posInt(env.TP_LOGO_RETRY_MS, DEFAULTS.retryMs),
    concurrency: posInt(env.TP_LOGO_CONCURRENCY, DEFAULTS.concurrency),
    ...overrides,
  };
  const fromEnv = parseGateways(env.TP_LOGO_GATEWAYS);
  const gateways = deps.gateways || (fromEnv.length ? fromEnv : parseGateways(DEFAULT_GATEWAYS.join(',')));
  const limit = createLimiter(deps.concurrency);

  const hits = new Map(); // cid -> {bytes, type, verified, expires}, oldest first
  let held = 0;
  const misses = new Map(); // cid -> {until, permanent, reason}
  const inflight = new Map(); // cid -> Promise

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

  async function fetchCid(parsed) {
    let reason = 'no_gateway';
    for (const gw of gateways) {
      const r = await limit(() => fromGateway(gw, parsed));
      if (r.ok) return r;
      reason = r.reason;
      if (r.final) return { ok: false, permanent: true, reason };
    }
    return { ok: false, permanent: false, reason };
  }

  /**
   * A CID's image: {ok: true, bytes: Buffer, type, verified} or {ok: false, permanent, reason}.
   * `verified`: the bytes hash to the CID (a raw CID), so they may be cached for good.
   * `permanent`: there will never be an image for this CID (a bad CID, a 451).
   */
  function getLogo(cidText) {
    const parsed = parseCid(cidText);
    if (!parsed) return Promise.resolve({ ok: false, permanent: true, reason: 'bad_cid' });
    const key = parsed.cid;
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
    if (inflight.has(key)) return inflight.get(key);
    const pending = fetchCid(parsed)
      .then((r) => {
        if (r.ok) {
          misses.delete(key);
          const expires = r.verified ? Infinity : deps.now() + UNVERIFIED_TTL_MS;
          remember(key, { bytes: r.bytes, type: r.type, verified: r.verified, expires });
          return { ok: true, bytes: r.bytes, type: r.type, verified: r.verified };
        }
        rememberMiss(key, r);
        return r;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  return { getLogo, gateways, heldBytes: () => held };
}

let store = null; // built on first use, so requiring this module reads nothing

function getLogo(cid) {
  if (!store) store = createLogoStore();
  return store.getLogo(cid);
}

module.exports = {
  getLogo,
  createLogoStore,
  parseGateways,
  sniffImage,
  DEFAULT_GATEWAYS,
  DEFAULTS,
  LOGO_HEADERS,
  CACHE_HIT,
  CACHE_HIT_UNVERIFIED,
  CACHE_NONE_FINAL,
  CACHE_NONE_RETRY,
  UNVERIFIED_TTL_MS,
};
