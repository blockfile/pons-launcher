'use strict';

// The take-profit dApp's ACCOUNT: Sign-In-With-Ethereum (EIP-4361) login and a
// session cookie, so a visitor's encrypted wallet list can follow them between
// devices (spec: docs/superpowers/specs/2026-09-19-tp-dapp-design.md, Addendum v2 A).
//
// WHAT THIS FILE EVER HOLDS: a login signature it verifies and forgets, and a session
// token it signed itself. No private key, no plaintext wallet list, and never the
// SECOND signature — the one the browser turns into its AES key. Login accepts only a
// signature over text THIS SERVER built and still holds for that nonce; the body is
// {nonce, signature} and nothing else, so a signature over any other text (the unlock
// message included) cannot log in: it recovers to a different address.
//
// THE MESSAGE is built here and the browser rebuilds it byte for byte before it
// signs (frontend/src/dapp/account, its own golden-tested copy). ASCII only, lines
// joined with LF (never CRLF), EIP-55 address, Chain ID 4663 — personal_sign is not
// chain-bound, so no wallet is ever asked to switch network. Its Expiration Time is
// the NONCE's life (5 min); the 24 h is the cookie's.
//
// THE COOKIE: __Host-tp_session; Path=/; Secure; HttpOnly; SameSite=Strict; 24 h.
// DEVIATION FROM THE SPEC, which said Path=/api/tp/account: a '__Host-' cookie MUST
// have Path=/ and no Domain, and that prefix is what stops rhbond.xyz and
// api.rhbond.xyz (same SITE as the dApp, so SameSite does not separate them) from
// tossing a Domain=rhbond.xyz cookie at this host. A cookie path is not a security
// boundary anyway. Needs Ivan's OK; COOKIE_NAME / COOKIE_OPTIONS are the one place
// to change it.
//
// THE TOKEN is stateless: 'v1.<addr40hex>.<iatMs>.<expMs>.<base64url HMAC-SHA256>',
// under a 32-byte secret in <TP_ACCOUNTS_DIR>/session.key (0600, made once), so a pm2
// restart signs nobody out.
//
// CSRF: SameSite=Strict does not separate same-site hosts, so every account request
// is also checked here: a Sec-Fetch-Site other than same-origin is refused, and a
// non-GET must be application/json (no HTML form can send that) from Origin ==
// TP_SIWE_ORIGIN. That also covers login CSRF.
//
// THE VAULT (tp/vaultStore.js): GET/PUT/DELETE /vault read and write the signed-in
// address's ciphertext blob, never another's — the address comes from the session,
// never from the body. Writes pay a per-IP and a per-ADDRESS bucket; a write that
// CREATES a vault also pays TP_ACCOUNT_CREATES_PER_HOUR per IP (identities are free
// to make, disk is not). A write under another keyId is refused with no override;
// starting over is a DELETE, which keeps the deleted copy for the operator
// (TP_VAULT_KEEP_DELETED_DAYS) and revokes every session of the address, this one
// included. Each write names its session (issuedAt) so the store's .prev keeps the
// copy from before that session began writing. The store never touches the disk
// synchronously (this process also answers /api/tp/broadcast), so the vault routes
// and requireSession are async.
//
// NOTHING AT REQUIRE TIME TOUCHES THE DISK OR THROWS. This router is mounted by
// routes/tp.js inside the console's own process: a bad TP_SIWE_ORIGIN or an
// unwritable TP_ACCOUNTS_DIR turns into 503 'unavailable' on the account routes
// (logged once), never into a server that will not boot.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { getAddress, hashMessage, recoverAddress } = require('ethers');
const { TpError, sendError } = require('./errors');
const { rateLimit, clientIp, tokenBuckets } = require('./limits');
const { CHAIN_ID } = require('./constants');
const { DEFAULT_DAPP_HOST } = require('./hostGate');
const { createVaultStore, validatePut } = require('./vaultStore');

// Express 4 does not catch a rejected promise from an async handler (routes/tp.js has
// the same one-liner): route every rejection to this router's error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

const LF = String.fromCharCode(10);
const STATEMENT =
  'Sign in to rhbond take-profit to sync your encrypted wallet list. ' +
  'Keeps this browser signed in for 24 hours. This is not a transaction and costs nothing.';

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 24 * 3600_000;
// A token issued further than this in the future (clock steps) is not honoured.
const CLOCK_SKEW_MS = 60_000;

const COOKIE_NAME = '__Host-tp_session';
const COOKIE_OPTIONS = Object.freeze({ httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
const COOKIE_VALUE_RE = /^[A-Za-z0-9._-]{1,256}$/;
const MAX_COOKIE_HEADER = 8192;

const DEFAULT_ACCOUNTS_DIR = path.resolve(__dirname, '..', '..', 'data', 'tp-accounts');

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const TOKEN_RE = /^v1\.([0-9a-f]{40})\.([0-9]{1,15})\.([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/;

// secp256k1 group order, and half of it: a signature with s above half is the
// "high-s" twin of a valid one. ethers 6 refuses it outright; wallets differ.
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const HALF_N = SECP256K1_N >> 1n;

const posNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Per-IP unless named otherwise. Env-tunable (backend/.env.example).
const ACCOUNT_LIMITS = Object.freeze({
  noncesPerMin: posNum(process.env.TP_ACCOUNT_NONCES_PER_MIN, 10),
  loginsPerMin: posNum(process.env.TP_ACCOUNT_LOGINS_PER_MIN, 10),
  readsPerMin: posNum(process.env.TP_ACCOUNT_READS_PER_MIN, 60),
  writesPerMinPerIp: posNum(process.env.TP_ACCOUNT_WRITES_PER_MIN_IP, 60),
  // per signed-in ADDRESS, and new vaults per IP per hour (tp/vaultStore.js routes)
  writesPerMinPerAccount: posNum(process.env.TP_ACCOUNT_WRITES_PER_MIN, 30),
  createsPerHour: posNum(process.env.TP_ACCOUNT_CREATES_PER_HOUR, 5),
});

/** The EIP-4361 login text. Every argument is already validated; no field may hold a LF. */
function buildLoginMessage({ domain, origin, address, nonce, issuedAt, expirationTime }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    STATEMENT,
    '',
    `URI: ${origin}`,
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join(LF);
}

/**
 * TP_SIWE_ORIGIN as {origin, domain}: a bare http(s) origin (scheme://host[:port], no
 * path, no credentials). `domain` keeps a non-default port — the SIWE domain of a
 * dev or smoke page on http://127.0.0.1:3199 is '127.0.0.1:3199'.
 */
function parseOrigin(value) {
  const raw = String(value == null ? '' : value);
  let u = null;
  try {
    u = new URL(raw);
  } catch (_err) {
    u = null;
  }
  const bare = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.origin !== bare) {
    throw new Error(`TP_SIWE_ORIGIN must be a bare origin such as https://dapp.rhbond.xyz, got "${raw}"`);
  }
  return { origin: u.origin, domain: u.host };
}

/**
 * A 65-byte personal_sign signature as {r, s, yParity} with LOW s, or null. v may be
 * 27/28 or 0/1 (a Ledger behind MetaMask answers 0/1); a high-s signature is folded
 * to its low-s twin (s := n - s, parity flipped), which recovers the same address.
 * Anything else — 64 bytes, an ERC-6492 wrapper, v outside {0,1,27,28}, r or s out of
 * range — is null.
 */
function canonicalSignature(signature) {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return null;
  const hex = signature.slice(2).toLowerCase();
  const r = BigInt(`0x${hex.slice(0, 64)}`);
  let s = BigInt(`0x${hex.slice(64, 128)}`);
  let v = parseInt(hex.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) return null;
  if (s > HALF_N) {
    s = SECP256K1_N - s;
    v ^= 1;
  }
  const hex32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;
  return { r: hex32(r), s: hex32(s), yParity: v };
}

/** The lower-case address that signed `message` (EIP-191), or null. */
function recoverSigner(message, sig) {
  try {
    return recoverAddress(hashMessage(message), { r: sig.r, s: sig.s, v: 27 + sig.yParity }).toLowerCase();
  } catch (_err) {
    return null;
  }
}

/**
 * Outstanding login challenges, in memory: 5-minute life, single use, at most `perIp`
 * per CLIENT AND ADDRESS (the oldest goes) and `max` in total (the oldest goes).
 *
 * Per IP alone would not do: clientIp() keys a shared IPv4 exactly, so every visitor
 * behind one carrier NAT or office egress shares one bucket, and each holds its slot
 * for the full 5 minutes while its owner is in their wallet's approval dialog. The
 * sixth neighbour to tap Connect silently evicted the first, whose signature then
 * answered 401 unknown_nonce. Keying by (ip, address) separates them; `perIp` is over
 * the 5 min x TP_ACCOUNT_NONCES_PER_MIN an IP could issue anyway, so a visitor's own
 * retries never evict their own, and `max` stays the memory bound.
 */
function createChallenges({ now = Date.now, perIp = 20, max = 10_000 } = {}) {
  const byNonce = new Map(); // nonce -> {address, message, expiresAt, ip}; insertion = issue order
  const byClient = new Map(); // 'ip|address' -> Set(nonce), oldest first

  const clientKey = (record) => `${record.ip}|${String(record.address).toLowerCase()}`;

  function drop(nonce) {
    const c = byNonce.get(nonce);
    if (!c) return null;
    byNonce.delete(nonce);
    const k = clientKey(c);
    const mine = byClient.get(k);
    if (mine) {
      mine.delete(nonce);
      if (mine.size === 0) byClient.delete(k);
    }
    return c;
  }

  function add(nonce, record) {
    const t = now();
    // Every challenge lives the same 5 minutes, so the expired ones are at the front.
    for (const [n, c] of byNonce) {
      if (c.expiresAt > t) break;
      drop(n);
    }
    const k = clientKey(record);
    for (let mine = byClient.get(k); mine && mine.size >= perIp; mine = byClient.get(k)) {
      drop(mine.values().next().value);
    }
    while (byNonce.size >= max) drop(byNonce.keys().next().value);
    byNonce.set(nonce, record);
    const mine = byClient.get(k) || new Set();
    mine.add(nonce);
    byClient.set(k, mine);
  }

  /** The challenge for `nonce`, removed — single use, whatever the login's outcome. */
  function take(nonce) {
    return drop(nonce);
  }

  return { add, take, size: () => byNonce.size };
}

/** Stateless session tokens under a 32-byte secret. verify() -> {address, issuedAt, expiresAt} | null. */
function createSessions({ secret, now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('createSessions: secret must be 32 bytes');
  const mac = (addr, iat, exp) =>
    crypto.createHmac('sha256', secret).update(`tp-session|v1|${addr}|${iat}|${exp}`).digest('base64url');

  function issue(address) {
    const addr = String(address).toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(addr)) throw new TypeError('createSessions.issue: not an address');
    const iat = now();
    const exp = iat + ttlMs;
    return { token: `v1.${addr}.${iat}.${exp}.${mac(addr, iat, exp)}`, address: `0x${addr}`, issuedAt: iat, expiresAt: exp };
  }

  function verify(token) {
    const m = TOKEN_RE.exec(typeof token === 'string' ? token : '');
    if (!m) return null;
    const [, addr, iatText, expText, got] = m;
    const want = Buffer.from(mac(addr, iatText, expText));
    const given = Buffer.from(got);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    const iat = Number(iatText);
    const exp = Number(expText);
    const t = now();
    if (!(exp > t) || !(exp > iat) || exp - iat > ttlMs || iat > t + CLOCK_SKEW_MS) return null;
    return { address: `0x${addr}`, issuedAt: iat, expiresAt: exp };
  }

  return { issue, verify };
}

/**
 * The value of the one __Host-tp_session cookie, or null: no Cookie header, a header
 * over 8 KiB, the name twice (a tossed duplicate), or a value outside the token alphabet.
 */
function readSessionCookie(req) {
  const header = req && req.headers ? req.headers.cookie : undefined;
  if (typeof header !== 'string' || header.length === 0 || header.length > MAX_COOKIE_HEADER) return null;
  let value = null;
  let count = 0;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    count += 1;
    value = part.slice(eq + 1).trim();
  }
  return count === 1 && COOKIE_VALUE_RE.test(value) ? value : null;
}

/**
 * The session secret: 32 random bytes in <dir>/session.key, made once with mode 0600
 * (O_EXCL) and read back ever after. An EMPTY file (a crash between create and write)
 * is replaced; any other length is refused — deleting the file rotates the secret and
 * signs every visitor out.
 */
function loadSessionSecret(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'session.key');
  let existing = null;
  try {
    existing = fs.readFileSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing && existing.length === 32) return existing;
  if (existing && existing.length !== 0) {
    throw new Error(`${file} holds ${existing.length} bytes, not 32 — delete it to make a new one (signs everyone out)`);
  }
  if (existing) fs.unlinkSync(file);
  const secret = crypto.randomBytes(32);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    let off = 0;
    while (off < secret.length) off += fs.writeSync(fd, secret, off, secret.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return secret;
}

/** The refusal for a request that is not a same-origin JSON call from the dApp page, or null. */
function csrfRefusal(req, origin) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    return new TpError('forbidden', 'the account API answers the dApp page only', 403);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) return new TpError('bad_request', 'send the request as JSON', 415);
  if (req.headers.origin !== origin) return new TpError('forbidden', 'the account API answers the dApp page only', 403);
  return null;
}

/** A plain-object JSON body whose keys are all in `allowed`; anything else is bad_request. */
function objectBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TpError('bad_request', `expected a JSON body {${allowed.join(', ')}}`);
  }
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new TpError('bad_request', `unexpected field "${k.slice(0, 32)}"`);
  }
  return body;
}

function parseAddress(value) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) throw new TpError('bad_address', 'address is not an address');
  try {
    return getAddress(value);
  } catch (_err) {
    throw new TpError('bad_address', 'address has a bad checksum');
  }
}

const noSession = () => new TpError('no_session', 'not signed in — connect your wallet and sign in', 401);

/**
 * The /api/tp/account router. Every option has a production default; tests inject
 * their own dir, origin, clock and limits.
 */
function createAccountRouter({
  dir = process.env.TP_ACCOUNTS_DIR || DEFAULT_ACCOUNTS_DIR,
  origin = process.env.TP_SIWE_ORIGIN || `https://${process.env.DAPP_HOST || DEFAULT_DAPP_HOST}`,
  now = Date.now,
  limits = {},
  vaultLimits = {},
} = {}) {
  const lim = { ...ACCOUNT_LIMITS, ...limits };
  const router = express.Router();

  let cfg = null;
  let cfgLogged = false;
  function config() {
    if (cfg) return cfg;
    try {
      cfg = { ...parseOrigin(origin), dir: path.resolve(dir) };
      return cfg;
    } catch (err) {
      if (!cfgLogged) console.error(`[tp] account API disabled: ${err.message}`);
      cfgLogged = true;
      throw new TpError('unavailable', 'saved wallets are not available on this server', 503);
    }
  }

  // The disk half, made on first need (a request with no cookie never gets here).
  let ctx = null;
  function context() {
    if (ctx) return ctx;
    const { dir: root } = config();
    try {
      ctx = {
        sessions: createSessions({ secret: loadSessionSecret(root), now }),
        store: createVaultStore({ dir: root, limits: vaultLimits, now }),
      };
      return ctx;
    } catch (err) {
      console.error(`[tp] account store unavailable: ${err.message}`);
      throw new TpError('unavailable', 'saved wallets are unavailable right now — try again later', 503);
    }
  }

  const challenges = createChallenges({ now });
  const nonceLimit = rateLimit({ windowMs: 60_000, max: lim.noncesPerMin, now });
  const loginLimit = rateLimit({ windowMs: 60_000, max: lim.loginsPerMin, now });
  const readLimit = rateLimit({ windowMs: 60_000, max: lim.readsPerMin, now });
  const writeIpLimit = rateLimit({ windowMs: 60_000, max: lim.writesPerMinPerIp, now });
  // After requireSession: keyed by the signed-in address, whatever IP it writes from.
  const writeAccountLimit = rateLimit({
    windowMs: 60_000,
    max: lim.writesPerMinPerAccount,
    now,
    key: (req) => `account:${req.tpSession.address}`,
  });
  // New vaults per IP per hour: charged only when a PUT actually creates one.
  const creates = tokenBuckets({ windowMs: 3600_000, max: lim.createsPerHour, now });

  // Async: the revocations live in the vault store, which reads the disk only
  // asynchronously (it opens on first use).
  const requireSession = wrap(async (req, res, next) => {
    const token = readSessionCookie(req);
    if (!token) return next(noSession());
    const { sessions, store } = context();
    const session = sessions.verify(token);
    // A vault DELETE revokes every session of its address issued up to that moment.
    // This reads the revocations as they stand NOW; a DELETE still queued in the
    // store's write lane has not set one yet, so the store checks again inside the
    // lane (it is given this session's issuedAt) and answers 401 there. Only this
    // check clears the cookie — the next request from that session reaches here.
    if (!session || session.issuedAt <= (await store.notBefore(session.address))) {
      res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      return next(noSession());
    }
    req.tpSession = session;
    return next();
  });

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next(csrfRefusal(req, config().origin) || undefined);
  });

  // {address} -> {nonce, message, issuedAt, expirationTime} (both ISO strings, as printed in the message)
  router.post('/nonce', nonceLimit, (req, res) => {
    const body = objectBody(req.body, ['address']);
    const address = parseAddress(body.address);
    const { origin: uri, domain } = config();
    const t = now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const issuedAt = new Date(t).toISOString();
    const expirationTime = new Date(t + CHALLENGE_TTL_MS).toISOString();
    const message = buildLoginMessage({ domain, origin: uri, address, nonce, issuedAt, expirationTime });
    challenges.add(nonce, { address, message, expiresAt: t + CHALLENGE_TTL_MS, ip: clientIp(req) });
    res.json({ nonce, message, issuedAt, expirationTime });
  });

  // {nonce, signature} -> {address, expiresAt} + the session cookie
  router.post('/login', loginLimit, (req, res) => {
    const body = objectBody(req.body, ['nonce', 'signature']);
    const challenge = typeof body.nonce === 'string' && NONCE_RE.test(body.nonce) ? challenges.take(body.nonce) : null;
    if (!challenge) {
      throw new TpError('unknown_nonce', 'that sign-in request is unknown or already used — start again', 401);
    }
    if (now() > challenge.expiresAt) {
      throw new TpError('challenge_expired', 'that sign-in request expired — start again', 401);
    }
    const sig = canonicalSignature(body.signature);
    if (!sig || recoverSigner(challenge.message, sig) !== challenge.address.toLowerCase()) {
      throw new TpError('bad_signature', 'the signature does not match this sign-in request', 401);
    }
    const session = context().sessions.issue(challenge.address);
    res.cookie(COOKIE_NAME, session.token, { ...COOKIE_OPTIONS, maxAge: SESSION_TTL_MS });
    res.json({ address: challenge.address, expiresAt: session.expiresAt });
  });

  router.post('/logout', writeIpLimit, (req, res) => {
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
    res.status(204).end();
  });

  // -> {address, expiresAt, vault: {rev, updatedAt, keyId, bytes} | null}
  router.get(
    '/me',
    readLimit,
    requireSession,
    wrap(async (req, res) => {
      const vault = await context().store.meta(req.tpSession.address);
      res.json({ address: getAddress(req.tpSession.address), expiresAt: req.tpSession.expiresAt, vault });
    })
  );

  // -> {vault: null | {v, kv, keyId, iv, ct, rev, updatedAt}}
  router.get(
    '/vault',
    readLimit,
    requireSession,
    wrap(async (req, res) => {
      res.json({ vault: await context().store.get(req.tpSession.address) });
    })
  );

  // {baseRev, kv, keyId, iv, ct} -> {rev, updatedAt}
  router.put(
    '/vault',
    writeIpLimit,
    requireSession,
    writeAccountLimit,
    wrap(async (req, res) => {
      const { store } = context();
      const input = validatePut(req.body, { maxBytes: store.limits.maxBytes });
      const ip = clientIp(req);
      const out = await store.put(req.tpSession.address, input, {
        writer: req.tpSession.issuedAt,
        // Called inside the store's write lane, only when this write is about to
        // CREATE a vault (every other check passed): an update, or a baseRev 0 that
        // meets an existing vault (409 conflict), pays nothing. The slot is taken
        // here, so two racing creates from one IP cannot both slip under the cap; a
        // create that then fails on the disk (503) has still spent its slot.
        beforeCreate: () => {
          const slot = creates.take(ip);
          if (!slot.ok) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))));
            throw new TpError('rate_limited', 'too many new saved-wallet lists from this address — try again later', 429);
          }
        },
      });
      res.json({ rev: out.rev, updatedAt: out.updatedAt });
    })
  );

  // {baseRev} -> {deleted}. Keeps the deleted copy for a hand restore, and ends every
  // session of this address, this one included (also when nothing was stored).
  router.delete(
    '/vault',
    writeIpLimit,
    requireSession,
    writeAccountLimit,
    wrap(async (req, res) => {
      const body = objectBody(req.body, ['baseRev']);
      if (!Number.isSafeInteger(body.baseRev) || body.baseRev < 0) {
        throw new TpError('bad_request', 'baseRev must be the rev you read');
      }
      const out = await context().store.remove(req.tpSession.address, body.baseRev, { writer: req.tpSession.issuedAt });
      res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      res.json(out);
    })
  );

  router.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => sendError(res, err));

  router.limiters = { nonceLimit, loginLimit, readLimit, writeIpLimit, writeAccountLimit };
  return router;
}

module.exports = {
  createAccountRouter,
  buildLoginMessage,
  parseOrigin,
  canonicalSignature,
  recoverSigner,
  createChallenges,
  createSessions,
  readSessionCookie,
  loadSessionSecret,
  csrfRefusal,
  ACCOUNT_LIMITS,
  COOKIE_NAME,
  COOKIE_OPTIONS,
  CHALLENGE_TTL_MS,
  SESSION_TTL_MS,
  DEFAULT_ACCOUNTS_DIR,
  STATEMENT,
};
