'use strict';

// THE DAPP HOST GATE. Express serves the console SPA and every /api route to ANY Host
// header (server.js), so a wholesale proxy of dapp.rhbond.xyz would expose the console's
// key-export routes on a public, password-less hostname. This middleware runs before
// express.static and before every router, and for the dApp's hostname allows exactly:
//
//   /api/tp, /api/tp/*        → next()  (the public, key-less tp router)
//   any other /api/*          → 404 {error:'not found'}
//   GET|HEAD /dapp/assets/*   → the dApp's OWN bundle (dist/dapp/assets, 404 JSON if missing)
//   /assets, /assets/*        → 404 JSON: that is the CONSOLE page's bundle (dist/assets)
//   GET|HEAD anything else    → dist/dapp/index.html, no-cache (404 JSON when not built)
//   anything else             → 404 JSON
//
// The two pages build separately (frontend/vite.config.js): the console's files land in
// dist/assets/, the dApp's in dist/dapp/assets/ (vite.dapp.config.js assetsDir). So the
// dApp host serves the dApp's files and nothing of the console: the console's code sits
// behind basic auth on its own host, and this host has no password.
//
// EVERY OTHER HOST (the console) is unchanged except for two paths, which answer 404
// JSON whatever the method: /dapp and /dapp/*, and the account API /api/tp/account and
// /api/tp/account/*. Without that, express.static would serve the
// key-holding dApp page at https://rhbond.xyz/dapp/ — on the CONSOLE's origin, with no
// CSP, where the browser attaches the console's cached basic-auth credentials (and an
// nginx-injected x-api-key, if that map is on) to every /api request. An XSS in the
// dApp there could call the console's key-export routes. The page may only ever run on
// DAPP_HOST, where every console route is a 404. The account API (tp/account.js) sets
// and reads the dApp's session cookie and holds its visitors' encrypted wallet lists:
// it answers on the dApp's origin only, where the CSP and the __Host- cookie apply.
// (Local dev through the Vite proxy therefore runs the backend with DAPP_HOST set to
// the proxy's target host, e.g. 127.0.0.1 — backend/.env.example.)
//
// nginx enforces the same allowlist; this is the copy that survives a mis-edited nginx
// file.
//
// The host is read from the Host header itself, NOT req.hostname: with `trust proxy`
// ever switched on, req.hostname would honour a client-supplied X-Forwarded-Host and a
// visitor could walk around this gate.

const fs = require('fs');
const path = require('path');
const express = require('express');

const DEFAULT_DAPP_HOST = 'dapp.rhbond.xyz';
// Where the dApp build puts its JS, CSS and fonts (frontend/vite.dapp.config.js).
const DAPP_ASSETS = '/dapp/assets/';

// The key-holding page's Content-Security-Policy — the same string as the server-level
// add_header in deploy/nginx-rhbond.conf (deploy.test.js checks they agree). nginx drops
// its whole server-level header set for any location that declares an add_header of
// its own, so the gate sends these too: the copy that survives a mis-edited nginx file.
// A duplicated identical CSP is harmless (browsers enforce the intersection).
const DAPP_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function setPageHeaders(res) {
  res.set('Content-Security-Policy', DAPP_CSP);
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
}

/**
 * True when a request on a NON-dApp host would reach dist/dapp/**. Judged on the path
 * the way express.static will see it: percent-decoded, backslashes as slashes, dot
 * segments and doubled slashes collapsed, case-folded (Windows dev boxes have
 * case-insensitive disks), and the first segment cut at its first character outside
 * [a-z0-9_-] (Windows also resolves "dapp.", "dapp " and "dapp::$INDEX_ALLOCATION" to
 * the dapp directory). "/dappled" or "/dapp-notes" are NOT the dApp.
 */
function isDappPath(reqPath) {
  let p = String(reqPath || '');
  try {
    p = decodeURIComponent(p);
  } catch (_err) {
    // Undecodable: express.static cannot decode it either (it answers 400), so the
    // raw form is what matters.
  }
  p = path.posix.normalize(p.split(String.fromCharCode(92)).join('/')).toLowerCase();
  const first = p.split('/').filter(Boolean)[0] || '';
  return first.replace(/[^a-z0-9_-].*$/, '') === 'dapp';
}

/**
 * True when a request path would reach the account API: /api/tp/account or anything
 * under it, judged as isDappPath judges /dapp (decoded, backslashes as slashes, dot
 * segments and doubled slashes collapsed, case-folded, the segment cut at its first
 * character outside [a-z0-9_-]). "/api/tp/accounts" is not the account API.
 */
function isAccountPath(reqPath) {
  let p = String(reqPath || '');
  try {
    p = decodeURIComponent(p);
  } catch (_err) {
    // undecodable: judged raw
  }
  p = path.posix.normalize(p.split(String.fromCharCode(92)).join('/')).toLowerCase();
  const seg = p.split('/').filter(Boolean);
  return seg[0] === 'api' && seg[1] === 'tp' && (seg[2] || '').replace(/[^a-z0-9_-].*$/, '') === 'account';
}

function normaliseHost(value) {
  let h = String(value || '').trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end > 0 ? h.slice(0, end + 1) : h; // [ipv6]:port -> [ipv6]
  } else {
    const colon = h.indexOf(':');
    if (colon >= 0) h = h.slice(0, colon); // host:port -> host
  }
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

function hostOf(req) {
  return normaliseHost(req.headers && req.headers.host);
}

// '..' segments, backslashes and percent-encoded dots/slashes have no business in any
// dApp URL (API paths carry hex addresses only).
const SUSPICIOUS_PATH = /(^|\/)\.\.?(\/|$)|\\|%2e|%2f|%5c/i;

function dappHostGate({ host = process.env.DAPP_HOST || DEFAULT_DAPP_HOST, dist } = {}) {
  if (!dist) throw new TypeError('dappHostGate: `dist` (the frontend build directory) is required');
  const want = normaliseHost(host);
  const index = path.join(dist, 'dapp', 'index.html');
  const serveStatic = express.static(dist, { index: false, redirect: false, fallthrough: true });
  const notFound = (res) => res.status(404).json({ error: 'not found' });

  return function dappGate(req, res, next) {
    if (hostOf(req) !== want) {
      // The console host: untouched, except that the dApp page never runs on its origin
      // and the dApp's account API never answers there.
      if (isDappPath(req.path)) return notFound(res);
      if (isAccountPath(req.path)) return notFound(res);
      return next();
    }

    const rawPath = String(req.originalUrl || req.url || '').split('?')[0];
    if (SUSPICIOUS_PATH.test(rawPath)) return notFound(res);

    const p = req.path;
    if (p === '/api/tp' || p.startsWith('/api/tp/')) return next();
    if (p.toLowerCase() === '/api' || p.toLowerCase().startsWith('/api/')) return notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    setPageHeaders(res);
    if (p.startsWith(DAPP_ASSETS)) return serveStatic(req, res, () => notFound(res));
    // The console page's bundle: never on this host, in any letter case.
    const lower = p.toLowerCase();
    if (lower === '/assets' || lower.startsWith('/assets/')) return notFound(res);
    if (!fs.existsSync(index)) {
      return res.status(404).json({ error: 'no dApp build — run `npm run build` in frontend/' });
    }
    // Always revalidate the page itself: a stale index.html points at hashed assets the
    // last build deleted. The hashed /dapp/assets/* files are immutable and cache normally.
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(index);
  };
}

module.exports = {
  dappHostGate,
  hostOf,
  normaliseHost,
  isDappPath,
  isAccountPath,
  DEFAULT_DAPP_HOST,
  DAPP_CSP,
  DAPP_ASSETS,
};
