'use strict';

// One SSRF-safe https GET, for token logos that live on an ordinary https host instead
// of IPFS (spec Addendum v2 D, as changed by section E decision 19). The URL is
// attacker-chosen: whoever launched the token typed it. So nothing here trusts it:
//
//   - https only, port 443 only, no userinfo, and a NAME (an IP literal is refused:
//     a logo lives on a named host, and TLS needs the name for SNI and the cert);
//   - the name is resolved HERE and EVERY address it resolves to must be public:
//     loopback, private (RFC 1918), link-local (with the 169.254.169.254 metadata
//     service), CGNAT (with 100.100.100.200), multicast, unspecified, reserved,
//     documentation and benchmark ranges, IPv4-mapped / IPv4-translated / IPv4-
//     compatible / NAT64 / 6to4 / Teredo IPv6 (each can smuggle an IPv4 address),
//     SRv6 SIDs and ULA (with the AWS fd00:ec2::254 metadata address) are all refused;
//   - the connection goes to the VETTED address: the request's lookup is pinned to it,
//     so there is no second DNS lookup a rebinding name could answer differently. The
//     TLS SNI, the certificate check and the Host header still use the name;
//   - at most MAX_REDIRECTS redirects, each hop vetted again from the top (scheme,
//     port, userinfo, name, DNS); a total deadline (5 s) over every hop and lookup;
//   - the body is capped (the caller's maxBytes, also checked against Content-Length)
//     and read with no decompression; what it is (an image or not) is the caller's
//     magic-byte check (logo.js sniffImage), never the Content-Type a host claims.
//
// No new dependency: node's https, dns and net. Nothing here logs the URL (it is
// attacker text) or keeps a connection (agent: false). Requiring this module starts
// nothing.

const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');

const MAX_URL = 300;
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 5000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const USER_AGENT = 'rhbond-tp-logo/1';
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Ranges no logo fetch may reach. IANA special-purpose registries (RFC 6890 and its
// updates), plus the IPv6 forms that carry an IPv4 address inside them.
const FORBIDDEN_V4 = Object.freeze([
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT (Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast 255.255.255.255
]);
const FORBIDDEN_V6 = Object.freeze([
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible ::a.b.c.d
  ['::ffff:0:0', 96], // IPv4-mapped
  ['::ffff:0:0:0', 96], // IPv4-translated (SIIT, RFC 7915)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking (RFC 5180)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation (RFC 9637)
  ['5f00::', 16], // SRv6 SIDs (RFC 9602)
  ['fc00::', 7], // unique local (AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
]);

// Two lists: one BlockList holding both families would also match an IPv4 address
// against the IPv4-mapped IPv6 rule (::ffff:0:0/96), refusing every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
for (const [a, p] of FORBIDDEN_V4) BLOCKED_V4.addSubnet(a, p, 'ipv4');
const BLOCKED_V6 = new net.BlockList();
for (const [a, p] of FORBIDDEN_V6) BLOCKED_V6.addSubnet(a, p, 'ipv6');

/** True when `address` is not a public unicast address this server may connect to. */
function isForbiddenAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return BLOCKED_V6.check(address, 'ipv6');
  return true; // not an IP at all
}

/**
 * The URL a logo may be fetched from, or null: https, port 443, no userinfo, a DNS
 * name (never an IP literal), at most MAX_URL characters. The fragment is dropped.
 */
function vetUrl(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s || s.length > MAX_URL) return null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port !== '' && url.port !== '443') return null; // the URL parser drops a default :443
  const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
  if (!host || net.isIP(host) || host.startsWith('[')) return null;
  if (!HOST_RE.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null;
  url.hash = '';
  return url;
}

/** Resolve `host`; every answer must be public. -> {address, family} (the first one). */
async function resolveVetted(host, lookup) {
  let answers;
  try {
    answers = await lookup(host);
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
  const list = Array.isArray(answers) ? answers : [];
  if (!list.length) return { ok: false, reason: 'dns_failed' };
  for (const a of list) {
    if (!a || isForbiddenAddress(a.address)) return { ok: false, reason: 'forbidden_address' };
  }
  return { ok: true, address: list[0].address, family: net.isIP(list[0].address) };
}

/** A net lookup that answers the vetted address, whatever it is asked (no second DNS lookup). */
function pinnedLookup(pinned) {
  return function lookup(_host, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
    else cb(null, pinned.address, pinned.family);
  };
}

/** One hop: {ok: true, bytes} | {redirect: location} | {ok: false, reason}. Never rejects. */
function fetchOnce(url, pinned, { request, maxBytes, remainingMs, setTimer, clearTimer }) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimer(timer);
      resolve(r);
    };
    const stop = (r) => {
      finish(r);
      if (req) req.destroy();
    };
    timer = setTimer(() => stop({ ok: false, reason: 'timeout' }), remainingMs);
    try {
      req = request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: 443,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          servername: url.hostname,
          headers: { host: url.host, accept: ACCEPT, 'accept-encoding': 'identity', 'user-agent': USER_AGENT },
          agent: false,
          lookup: pinnedLookup(pinned),
        },
        (res) => {
          const status = res.statusCode;
          // Refused answers are DESTROYED, never drained: finishing clears this hop's
          // deadline, so a drained body would keep trickling from an attacker-chosen
          // host with no cap and no clock (agent: false — no connection worth reusing).
          if (REDIRECT_STATUSES.has(status)) {
            const location = res.headers.location;
            return stop(typeof location === 'string' && location ? { redirect: location } : { ok: false, reason: `http_${status}` });
          }
          if (status !== 200) return stop({ ok: false, reason: `http_${status}` });
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) return stop({ ok: false, reason: 'too_large' });
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            if (done) return;
            total += chunk.length;
            if (total > maxBytes) return stop({ ok: false, reason: 'too_large' });
            chunks.push(chunk);
          });
          res.on('end', () => finish({ ok: true, bytes: Buffer.concat(chunks, total) }));
          res.on('error', () => finish({ ok: false, reason: 'fetch_failed' }));
          res.on('close', () => finish({ ok: false, reason: 'fetch_failed' })); // cut before 'end'
          return undefined;
        }
      );
      req.on('error', () => finish({ ok: false, reason: 'fetch_failed' }));
      req.end();
    } catch {
      finish({ ok: false, reason: 'fetch_failed' });
    }
  });
}

/** `promise`, or {ok: false, reason: 'timeout'} once `ms` has passed. */
function withDeadline(promise, ms, setTimer, clearTimer) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimer(() => resolve({ ok: false, reason: 'timeout' }), Math.max(0, ms));
  });
  return Promise.race([promise, late]).finally(() => clearTimer(timer));
}

const systemLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * GET `urlText` the SSRF-safe way (see the header). Never rejects:
 * -> {ok: true, bytes: Buffer, url: string (the final hop)} | {ok: false, reason}
 * reason: bad_url, bad_redirect, too_many_redirects, dns_failed, forbidden_address,
 * too_large, timeout, fetch_failed, http_<status>.
 */
async function safeGet(urlText, overrides = {}) {
  const o = {
    maxBytes: 3 * 1024 * 1024,
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    lookup: systemLookup,
    request: (options, onResponse) => https.request(options, onResponse),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h),
    ...overrides,
  };
  let url = vetUrl(urlText);
  if (!url) return { ok: false, reason: 'bad_url' };
  const deadline = o.now() + o.timeoutMs;
  for (let hop = 0; ; hop += 1) {
    const pinned = await withDeadline(resolveVetted(url.hostname, o.lookup), deadline - o.now(), o.setTimer, o.clearTimer);
    if (!pinned.ok) return pinned;
    const r = await fetchOnce(url, pinned, { ...o, remainingMs: Math.max(0, deadline - o.now()) });
    if (!r.redirect) return r.ok ? { ok: true, bytes: r.bytes, url: url.href } : r;
    if (hop >= o.maxRedirects) return { ok: false, reason: 'too_many_redirects' };
    let next = null;
    try {
      next = vetUrl(new URL(r.redirect, url).href);
    } catch {
      next = null;
    }
    if (!next) return { ok: false, reason: 'bad_redirect' };
    url = next;
  }
}

module.exports = {
  safeGet,
  vetUrl,
  isForbiddenAddress,
  resolveVetted,
  pinnedLookup,
  FORBIDDEN_V4,
  FORBIDDEN_V6,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  MAX_URL,
};
