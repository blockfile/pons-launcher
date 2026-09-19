// The dApp's only door to the server: /api/tp/*.
//
// Owned by the dApp (tab isolation) and deliberately NOT the console's api.js,
// which carries the console API key. Nothing here holds a credential.
//
// KEYS NEVER LEAVE THE BROWSER. Every request body is built by buildBody() from
// a per-kind ALLOWLIST of fields with typed validators, and the finished body is
// scanned for anything shaped like a private key (64 hex, 0x optional) before it
// is sent — the one exception being the signed raw transactions of a broadcast,
// which are long, type-2 (0x02...) and cannot be a bare key. Error messages name
// the field, never the value, because the value might be the key.
//
// Errors: a refusal becomes Error(message, {cause: {code, status}}) with the
// server's {error, code}; a network failure has code 'network'. The fetch
// wrappers are async, so even a refusal of bad input (before anything is sent)
// arrives as a rejected promise: callers chain .then(ok, fail) and a synchronous
// throw would skip `fail`. openStream alone throws synchronously on bad input.
//
// The stream is SSE read with fetch + ReadableStream (not EventSource), so it can
// be aborted cleanly and reconnected with our own backoff.
//
// RECEIPTS ARE KEYED BY A STREAM ID (sid). The server forwards a broadcast's
// receipts only to the stream whose sid the POST /broadcast body carried
// (backend tp/stream.js), so no other viewer of the token can link this
// visitor's wallets. This tab makes ONE sid per token, up front, from
// crypto.getRandomValues, and every stream of that token (the first, each
// reconnect, a timeframe switch) and every broadcast for it carry it. It is made
// in the browser rather than taken from the first snapshot because the approvals
// the page signs on load can go out before any stream has connected: their
// receipts wait in the server's per-sid replay (150 s) until the stream opens.
// The sid lives in this module's memory only: never the URL bar, storage or a log.
//
// THE ACCOUNT (spec Addendum A) adds /account/*: a sign-in challenge and login,
// the session, logout, and the account's encrypted copy (GET/PUT/DELETE vault).
// Its bodies go through the same allowlist and key-shape scan, with ONE
// exemption: a login's signature (65 bytes, 130 hex) is key-shaped by length,
// so it is exempt from the scan — and postLogin sends it only after checking,
// here, that it recovers to the signing address over the very challenge message
// it answers. The unlock signature (the key material of the encrypted copy) is
// over a different message, so it can never pass that check and ride the
// exemption. The copy's ciphertext travels as canonical base64 and IS scanned:
// a hex key pasted into it is refused, and random ciphertext does not contain 64
// hex characters in a row (odds about 1 in 10^24 for the largest copy).
import { getAddress } from 'ethers';
import { canonicalSignature, signerOf } from './account/signature.js';

const BASE = '/api/tp';
export const INTERVALS = [1, 15, 60, 300, 3600];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SID_RE = /^[0-9a-f]{32}$/;
const DECIMAL_RE = /^[0-9]+$/;
const KEY_SHAPE_RE = /(0x)?[0-9a-fA-F]{64}/;
const RAW_TX_RE = /^0x02[0-9a-fA-F]+$/;
// A signed type-2 transaction is well over 100 bytes; a private key is 32.
const MIN_RAW_TX_CHARS = 2 + 2 * 100;
const MAX_RAW_TX_CHARS = 2 + 2 * 8192;
const MAX_ITEMS = 100;
// Token amounts fit uint128 (a V4 swap's amountIn is uint128). Capping here also
// means a private key smuggled in as a decimal number (a 256-bit value) is refused.
const MAX_AMOUNT = (1n << 128n) - 1n;
const NONCE_RE = /^[0-9a-f]{32}$/;
const LOGIN_SIG_RE = /^0x[0-9a-f]{130}$/;
const KEY_ID_RE = /^0x[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// The account copy's ciphertext: at most 256 KiB decoded (the server refuses more).
export const MAX_VAULT_BYTES = 262144;

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// lower-case token -> the sid this tab's streams and broadcasts of it share.
const streamSids = new Map();

function newSid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** The sid this tab uses for `token`: made on first use, then kept for the tab's life. */
export function sidFor(token) {
  const k = String(token).toLowerCase();
  let s = streamSids.get(k);
  if (!s) {
    s = newSid();
    streamSids.set(k, s);
  }
  return s;
}

function apiError(message, code, status = 0) {
  return new Error(message, { cause: { code, status } });
}

// ── field validators: return the value to send, or throw naming the field ────
function address(value, name) {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw apiError(`${name} is not an address`, 'bad_address');
  }
  return value.toLowerCase();
}

function list(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw apiError(`${name} must be a non-empty list`, 'bad_request');
  if (value.length > MAX_ITEMS) throw apiError(`${name} carries more than ${MAX_ITEMS} items`, 'too_many');
  return value;
}

function amount(value, name) {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && DECIMAL_RE.test(value)) n = BigInt(value);
  else throw apiError(`${name} must be a whole number of base units`, 'bad_request');
  if (n <= 0n || n > MAX_AMOUNT) throw apiError(`${name} is out of range`, 'bad_request');
  return n.toString();
}

/** Optional amount: absent is left out of the body. */
function optionalAmount(value, name) {
  return value === undefined || value === null ? undefined : amount(value, name);
}

function addressList(value, name) {
  return list(value, name).map((a, i) => address(a, `${name}[${i}]`));
}

function sellList(value, name) {
  return list(value, name).map((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw apiError(`${name}[${i}] is not a sell`, 'bad_request');
    for (const k of Object.keys(s)) {
      if (k !== 'address' && k !== 'amount') throw apiError(`${name}[${i}] carries a field that is not allowed`, 'bad_request');
    }
    return { address: address(s.address, `${name}[${i}].address`), amount: amount(s.amount, `${name}[${i}].amount`) };
  });
}

/** Optional: absent is left out of the body; anything but 32 lower-case hex is refused. */
function sid(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !SID_RE.test(value)) throw apiError(`${name} is not a stream id`, 'bad_request');
  return value;
}

function nonce(value, name) {
  if (typeof value !== 'string' || !NONCE_RE.test(value)) throw apiError(`${name} is not a sign-in nonce`, 'bad_request');
  return value;
}

// Only postLogin makes one: a signature it has checked against its own challenge.
// A bare string is refused, so no caller can put a key-shaped value into the one
// field the key-shape scan skips.
class VerifiedLoginSignature {
  constructor(hex) {
    this.hex = hex;
  }
}

function loginSignature(value, name) {
  if (!(value instanceof VerifiedLoginSignature) || !LOGIN_SIG_RE.test(value.hex)) {
    throw apiError(`${name} is not a sign-in signature verified by postLogin`, 'bad_request');
  }
  return value.hex;
}

function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw apiError(`${name} must be a revision number`, 'bad_request');
  return value;
}

function keyVersion(value, name) {
  if (value !== 1) throw apiError(`${name} must be 1`, 'bad_request');
  return value;
}

function keyId(value, name) {
  if (typeof value !== 'string' || !KEY_ID_RE.test(value)) throw apiError(`${name} is not a key id`, 'bad_request');
  return value;
}

/** Canonical base64 (padding included, no whitespace) whose decoded size is in [min, max]. */
function isBase64(value, min, max) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !B64_RE.test(value)) return false;
  let bin;
  try {
    bin = atob(value);
  } catch {
    return false;
  }
  return btoa(bin) === value && bin.length >= min && bin.length <= max;
}

function iv(value, name) {
  if (!isBase64(value, 12, 12)) throw apiError(`${name} is not a 12-byte base64 IV`, 'bad_request');
  return value;
}

function ciphertext(value, name) {
  if (!isBase64(value, 17, MAX_VAULT_BYTES)) throw apiError(`${name} is not base64 ciphertext of at most 256 KiB`, 'bad_request');
  return value;
}

function rawTxList(value, name) {
  return list(value, name).map((raw, i) => {
    const ok =
      typeof raw === 'string' &&
      RAW_TX_RE.test(raw) &&
      raw.length % 2 === 0 &&
      raw.length >= MIN_RAW_TX_CHARS &&
      raw.length <= MAX_RAW_TX_CHARS;
    if (!ok) throw apiError(`${name}[${i}] is not a signed type-2 transaction`, 'bad_tx');
    return raw;
  });
}

const SCHEMAS = {
  wallets: { token: address, addresses: addressList },
  quote: { token: address, sells: sellList, ahead: optionalAmount },
  pairQuote: { pairToken: address, amount },
  broadcast: { token: address, txs: rawTxList, sid },
  challenge: { address },
  login: { nonce, signature: loginSignature },
  logout: {},
  vaultPut: { baseRev: revision, kv: keyVersion, keyId, iv, ct: ciphertext },
  vaultDelete: { baseRev: revision },
};

// A field the key-shape scan skips, because its validator above already pins it
// to something that is not a bare key (signed type-2 txs; a verified login signature).
const SCAN_EXEMPT = { broadcast: 'txs', login: 'signature' };

/** Throw if any string (or object key) in `value` is shaped like a private key. */
function assertNoKey(value, path) {
  if (typeof value === 'string') {
    if (KEY_SHAPE_RE.test(value)) throw apiError(`${path} looks like a private key — refusing to send it`, 'bad_request');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoKey(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (KEY_SHAPE_RE.test(k)) throw apiError(`${path} carries a key-shaped field name — refusing to send it`, 'bad_request');
      assertNoKey(v, `${path}.${k}`);
    }
  }
}

/**
 * The JSON body for a request kind, from its allowlist only.
 *   wallets:   {token, addresses}
 *   quote:     {token, sells: [{address, amount}], ahead?}
 *   pairQuote: {pairToken, amount}
 *   broadcast: {token, txs, sid?}
 *   challenge: {address}
 *   login:     {nonce, signature}     (postLogin only: signature must be its verified wrapper)
 *   logout:    {}
 *   vaultPut:  {baseRev, kv, keyId, iv, ct}
 *   vaultDelete: {baseRev}
 * Throws on an unknown kind, any other field, a bad value, or a key-shaped value.
 */
export function buildBody(kind, fields) {
  const schema = typeof kind === 'string' && has(SCHEMAS, kind) ? SCHEMAS[kind] : null;
  if (!schema) throw apiError('unknown request kind', 'bad_request');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw apiError(`a ${kind} request needs fields`, 'bad_request');
  for (const k of Object.keys(fields)) {
    if (!has(schema, k)) throw apiError(`a ${kind} request carries a field that is not allowed`, 'bad_request');
  }
  const body = {};
  for (const [k, check] of Object.entries(schema)) body[k] = check(fields[k], k);
  for (const [k, v] of Object.entries(body)) {
    if (SCAN_EXEMPT[kind] === k) continue; // validated above: see SCAN_EXEMPT
    assertNoKey(v, k);
  }
  return JSON.stringify(body);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function transport(opts) {
  return (opts && opts.fetch) || ((...args) => globalThis.fetch(...args));
}

// A refusal's Retry-After in ms, or null. The tp routes' limiter (limits.js) sends
// whole seconds with every 429; an HTTP-date or anything else is ignored, and the
// caller falls back to its own backoff.
function retryAfterMs(res) {
  const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return /^[0-9]{1,6}$/.test(text) ? Number(text) * 1000 : null;
}

async function request(method, path, body, opts) {
  const f = transport(opts);
  const headers = { accept: 'application/json' };
  const init = { method, headers, cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = body;
  }
  let res;
  try {
    res = await f(`${BASE}${path}`, init);
  } catch {
    throw apiError('network error — the server did not answer', 'network');
  }
  if (res.ok && res.status === 204) return {}; // logout answers with no body
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json && typeof json.error === 'string' && json.error ? json.error : `request failed (${res.status})`;
    const code = json && typeof json.code === 'string' && json.code ? json.code : `http_${res.status}`;
    const err = apiError(message, code, res.status);
    const wait = retryAfterMs(res);
    if (wait !== null) err.cause.retryAfterMs = wait; // a 429 says when to come back
    throw err;
  }
  if (!json || typeof json !== 'object') throw apiError('the server answered with something that is not JSON', 'bad_response', res.status);
  return json;
}

/** GET /token/:ca -> {venue, mark} */
export async function getToken(ca, opts) {
  const a = address(ca, 'ca');
  return request('GET', `/token/${a}`, undefined, opts);
}

/**
 * The token's logo as THIS origin serves it (GET /api/tp/logo/:ca: the server
 * fetches it from IPFS, sniffs and caches it), for an <img src>; null for
 * anything but an address. Built from the CA, never taken from a response: the
 * page loads no logo from anywhere else (its CSP is img-src 'self' data:).
 */
export function logoPath(ca) {
  return typeof ca === 'string' && ADDRESS_RE.test(ca) ? `${BASE}/logo/${ca.toLowerCase()}` : null;
}

/** POST /wallets {token, addresses} -> {wallets} */
export async function postWallets(token, addresses, opts) {
  return request('POST', '/wallets', buildBody('wallets', { token, addresses }), opts);
}

/** GET /fees -> feeParams */
export async function getFees(opts) {
  return request('GET', '/fees', undefined, opts);
}

/**
 * POST /quote {token, sells, ahead?} -> {quotes}. opts.ahead: the tokens this
 * tab's earlier sells still have in flight — the click is priced behind them,
 * and they are not a row (a full 100-wallet body still fits).
 */
export async function postQuote(token, sells, opts) {
  const ahead = opts && opts.ahead !== undefined ? opts.ahead : undefined;
  return request('POST', '/quote', buildBody('quote', { token, sells, ahead }), opts);
}

/** POST /quote/pair {pairToken, amount} -> {amountOut, path, fees, impactBps, ok, reason} */
export async function postPairQuote(pairToken, amountIn, opts) {
  return request('POST', '/quote/pair', buildBody('pairQuote', { pairToken, amount: amountIn }), opts);
}

/** POST /broadcast {token, txs, sid} -> {results}. The sid is this tab's for the token (sidFor). */
export async function broadcast(token, txs, opts) {
  let s;
  if (opts && opts.sid !== undefined) s = opts.sid;
  else if (typeof token === 'string' && ADDRESS_RE.test(token)) s = sidFor(token);
  return request('POST', '/broadcast', buildBody('broadcast', { token, txs, sid: s }), opts);
}

// ── account (spec Addendum A) ─────────────────────────────────────────────────
function badResponse(what) {
  return apiError(`the server answered with a malformed ${what}`, 'bad_response');
}

function vaultMeta(v) {
  if (v === null || v === undefined) return null;
  if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.rev) || v.rev < 1 || typeof v.keyId !== 'string' || !KEY_ID_RE.test(v.keyId)) {
    throw badResponse('account copy');
  }
  return { rev: v.rev, keyId: v.keyId, updatedAt: Number(v.updatedAt) || 0, bytes: Number(v.bytes) || 0 };
}

/**
 * POST /account/nonce {address} -> {nonce, message, issuedAt, expirationTime}: the
 * sign-in challenge (the backend's route and field names: backend/src/tp/account.js,
 * pinned for both sides by backend/src/tp/accountContract.json). account/messages.js
 * checkChallenge checks it before anything is signed.
 */
export async function postChallenge(addr, opts) {
  const j = await request('POST', '/account/nonce', buildBody('challenge', { address: addr }), opts);
  if (typeof j.nonce !== 'string' || !NONCE_RE.test(j.nonce) || typeof j.message !== 'string' || j.message.length > 2000) {
    throw badResponse('sign-in challenge');
  }
  return { nonce: j.nonce, message: j.message, issuedAt: j.issuedAt, expirationTime: j.expirationTime };
}

/**
 * POST /account/login {nonce, signature} -> {address, expiresAt}.
 * VERIFY BEFORE SEND: the signature must recover to `address` over `message`,
 * and `message` must carry the line 'Nonce: <nonce>'. Otherwise nothing is
 * sent. The signature goes out canonical (low s, v 27/28).
 * @param {{nonce: string, signature: string, message: string, address: string}} login
 */
export async function postLogin({ nonce: n, signature, message, address: who } = {}, opts) {
  nonce(n, 'nonce');
  if (typeof message !== 'string' || !message.split(LF).includes(`Nonce: ${n}`)) {
    throw apiError('the sign-in message does not carry this nonce', 'bad_request');
  }
  let sig;
  try {
    sig = canonicalSignature(signature);
  } catch (e) {
    throw apiError(e.message, (e.cause && e.cause.code) || 'bad_signature');
  }
  let signer = null;
  let expected = null;
  try {
    signer = signerOf(message, sig);
    expected = getAddress(String(who));
  } catch {
    signer = null;
  }
  sig.rs.fill(0);
  if (!signer || signer !== expected) {
    throw apiError('the signature is not from this address over this sign-in message, so it was not sent', 'bad_signature');
  }
  const body = buildBody('login', { nonce: n, signature: new VerifiedLoginSignature(sig.serialized) });
  const j = await request('POST', '/account/login', body, opts);
  if (typeof j.address !== 'string' || !ADDRESS_RE.test(j.address)) throw badResponse('login answer');
  return { address: getAddress(j.address), expiresAt: j.expiresAt };
}

/**
 * GET /account/me -> {address, expiresAt, vault: {rev, keyId, updatedAt, bytes}|null},
 * or null when not signed in (401).
 */
export async function getAccountSession(opts) {
  let j;
  try {
    j = await request('GET', '/account/me', undefined, opts);
  } catch (e) {
    if (e && e.cause && e.cause.status === 401) return null;
    throw e;
  }
  if (typeof j.address !== 'string' || !ADDRESS_RE.test(j.address)) throw badResponse('session');
  return { address: getAddress(j.address), expiresAt: j.expiresAt, vault: vaultMeta(j.vault) };
}

/** POST /account/logout -> {} (the server answers 204). */
export async function postLogout(opts) {
  await request('POST', '/account/logout', buildBody('logout', {}), opts);
  return {};
}

/** GET /account/vault -> {v, kv, keyId, iv, ct, rev, updatedAt} | null */
export async function getVault(opts) {
  const j = await request('GET', '/account/vault', undefined, opts);
  if (!('vault' in j)) throw badResponse('account copy');
  if (j.vault === null) return null;
  const v = j.vault;
  const meta = vaultMeta(v);
  if (v.kv !== 1 || !isBase64(v.iv, 12, 12) || !isBase64(v.ct, 17, MAX_VAULT_BYTES)) throw badResponse('account copy');
  return { v: v.v, kv: 1, keyId: meta.keyId, iv: v.iv, ct: v.ct, rev: meta.rev, updatedAt: meta.updatedAt };
}

/**
 * PUT /account/vault {baseRev, kv, keyId, iv, ct} -> {rev, updatedAt}. baseRev 0 creates.
 * Refusals arrive as errors with cause.code 'conflict' (409: saved elsewhere
 * first), 'key_mismatch' (409), 'too_large' (413), 'store_full' (507), or
 * cause.status 401 (signed out).
 */
export async function putVault({ baseRev, kv, keyId: id, iv: ivText, ct }, opts) {
  const j = await request('PUT', '/account/vault', buildBody('vaultPut', { baseRev, kv, keyId: id, iv: ivText, ct }), opts);
  if (!Number.isSafeInteger(j.rev) || j.rev < 1) throw badResponse('save answer');
  return { rev: j.rev, updatedAt: Number(j.updatedAt) || 0 };
}

/**
 * DELETE /account/vault {baseRev} -> {deleted: true}. The server then ends EVERY
 * session of the address, this one included (backend decision 6): signed out after.
 */
export async function deleteVault(baseRev, opts) {
  const j = await request('DELETE', '/account/vault', buildBody('vaultDelete', { baseRev }), opts);
  return { deleted: j.deleted === true };
}

// ── SSE ──────────────────────────────────────────────────────────────────────
function takeLine(line, state) {
  if (line === '') {
    const data = state.data;
    const name = state.event || 'message';
    state.data = null;
    state.event = '';
    if (data == null) return null;
    try {
      return { event: name, data: JSON.parse(data) };
    } catch {
      state.dropped = (state.dropped || 0) + 1;
      return null;
    }
  }
  if (line[0] === ':') return null; // a comment: the server's keep-alive
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value[0] === ' ') value = value.slice(1);
  if (field === 'event') state.event = value;
  else if (field === 'data') state.data = state.data == null ? value : state.data + LF + value;
  else if (field === 'id') state.lastId = value;
  return null; // 'retry' and unknown fields are ignored
}

/**
 * Feed one decoded chunk of an SSE stream; returns the events it completed as
 * [{event, data}] with data JSON-parsed. `state` ({} to start) carries the
 * partial line and event across chunks. Lines end in LF, CRLF or CR (a CRLF split
 * across two chunks counts once). Comments are skipped; an event whose data is
 * not JSON is dropped and counted in state.dropped.
 */
export function parseSse(chunkText, state) {
  let text = String(chunkText == null ? '' : chunkText);
  if (!text) return [];
  if (state.pendingCR && text[0] === LF) text = text.slice(1);
  state.pendingCR = text.length > 0 && text[text.length - 1] === CR;
  const buf = (state.buf || '') + text;
  const events = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const ch = buf[i];
    if (ch !== LF && ch !== CR) continue;
    const line = buf.slice(start, i);
    if (ch === CR && buf[i + 1] === LF) i += 1;
    start = i + 1;
    const ev = takeLine(line, state);
    if (ev) events.push(ev);
  }
  state.buf = buf.slice(start);
  return events;
}

/**
 * GET /stream?token=&interval=&sid= as SSE, the sid being sidFor(token) on every
 * connect. Calls onEvent(name, data) for every
 * server event (snapshot, trades, bar, mark, receipt, phase, status, ping) plus
 * three of its own:
 *   'stream:open'  {}                     a connection is up (a snapshot follows)
 *   'stream:retry' {attempt, delayMs}     the connection dropped; reconnecting
 *   'stream:error' {message, code, status} refused for good (4xx other than 409 and 429)
 * Reconnects with backoff on a drop, a network error, a 409, a 429 or a 5xx, and when
 * nothing (not even a ping, sent every 15 s) arrives for idleMs. Each reconnect
 * gets a fresh snapshot and, carrying the same sid, the receipts the gap
 * missed. A snapshot naming another well-formed sid (a server that did not keep
 * ours) is adopted for this token's later streams and broadcasts.
 * Returns close().
 *
 * opts (all optional, for tests): fetch, setTimeout, clearTimeout,
 * backoffMs (default [500, 1000, 2000, 5000, 10000, 20000]), idleMs (default
 * 45000; 0 disables the watchdog).
 */
export function openStream(token, interval, onEvent, opts = {}) {
  const tokenAddr = address(token, 'token');
  if (!INTERVALS.includes(Number(interval))) throw apiError('interval must be one of 1, 15, 60, 300, 3600', 'bad_request');
  const f = transport(opts);
  const setT = opts.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((id) => globalThis.clearTimeout(id));
  const backoff = opts.backoffMs || [500, 1000, 2000, 5000, 10000, 20000];
  const idleMs = opts.idleMs == null ? 45000 : opts.idleMs;
  const base = `${BASE}/stream?token=${tokenAddr}&interval=${Number(interval)}`;
  const url = () => `${base}&sid=${sidFor(tokenAddr)}`;

  let closed = false;
  let controller = null;
  let retryTimer = null;
  let idleTimer = null;
  let attempt = 0;

  const emit = (name, data) => {
    if (closed) return;
    try {
      onEvent(name, data);
    } catch {
      // A bug in a UI handler must not take the stream down with it.
    }
  };

  const disarmIdle = () => {
    if (idleTimer != null) {
      clearT(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = (ctl) => {
    if (!idleMs) return;
    disarmIdle();
    idleTimer = setT(() => {
      idleTimer = null;
      ctl.abort(); // a half-open connection: drop it and reconnect
    }, idleMs);
  };

  const retry = () => {
    disarmIdle();
    if (closed) return;
    const delayMs = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    emit('stream:retry', { attempt, delayMs });
    retryTimer = setT(() => {
      retryTimer = null;
      connect();
    }, delayMs);
  };

  async function connect() {
    if (closed) return;
    const ctl = new AbortController();
    controller = ctl;
    let res;
    try {
      res = await f(url(), {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal: ctl.signal,
      });
    } catch {
      retry();
      return;
    }
    if (closed) return;
    if (!res.ok || !res.body) {
      // 409 is the server's 'migrating': a graduation in progress, "try again shortly".
      if (res.ok || res.status === 409 || res.status === 429 || res.status >= 500) {
        retry();
        return;
      }
      let message = `stream refused (${res.status})`;
      let code = `http_${res.status}`;
      try {
        const j = await res.json();
        if (j && typeof j.error === 'string' && j.error) message = j.error;
        if (j && typeof j.code === 'string' && j.code) code = j.code;
      } catch {
        // keep the generic message
      }
      emit('stream:error', { message, code, status: res.status });
      closed = true;
      return;
    }

    emit('stream:open', {});
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state = {};
    armIdle(ctl);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle(ctl);
        for (const ev of parseSse(decoder.decode(value, { stream: true }), state)) {
          attempt = 0; // a delivered event proves this connection works
          if (ev.event === 'snapshot' && ev.data && typeof ev.data.sid === 'string' && SID_RE.test(ev.data.sid)) {
            streamSids.set(tokenAddr, ev.data.sid);
          }
          emit(ev.event, ev.data);
        }
      }
    } catch {
      // aborted (close / watchdog) or dropped — handled below
    }
    if (!closed) retry();
  }

  connect();

  return function close() {
    closed = true;
    disarmIdle();
    if (retryTimer != null) {
      clearT(retryTimer);
      retryTimer = null;
    }
    if (controller) controller.abort();
  };
}
