'use strict';

// Pure helpers for scripts/tp-account-browser.js: what a REAL browser put on the
// wire to the REAL account API, judged offline (scripts/lib/tpWireAudit.test.js).
// No network, no fs, no keys of its own.
//
// The entries the harness records hold request bodies (sign-in signatures,
// ciphertext) and session-cookie values. They live in the harness's memory only,
// and nothing here returns a value taken from them: only counts, routes, status
// codes and fixed problem texts.
//
// No escape sequences (memory: write-tool-escapes): control characters are built
// with String.fromCharCode.

const LF = String.fromCharCode(10);
const SESSION_COOKIE = '__Host-tp_session';
const ACCOUNT_PREFIX = '/api/tp/account/';
const COOKIE_VALUE_RE = /^[A-Za-z0-9._-]{1,256}$/;
const LOGIN_SIG_RE = /^0x[0-9a-f]{130}$/;
const PUT_FIELDS = ['baseRev', 'ct', 'iv', 'keyId', 'kv'];
// The routes are the server's, pinned for both sides by
// backend/src/tp/accountContract.json: the sign-in challenge is POST /nonce and the
// session is GET /me. Any other name is not one of them.
const CHALLENGE_ROUTES = new Set(['nonce']);
const SESSION_ROUTES = new Set(['me']);

const routeOf = (entry) => String(entry.path).split('?')[0];
const isAccount = (entry) => routeOf(entry).startsWith(ACCOUNT_PREFIX);

/**
 * One Set-Cookie line: its name, value and attributes (attribute names folded to
 * lower case; SameSite's value too).
 * @returns {{name: string, value: string, attrs: {secure: boolean, httponly: boolean,
 *   samesite: string|null, path: string|null, domain: string|null, maxAge: number|null, expires: string|null}}}
 */
function parseSetCookie(line) {
  const parts = String(line).split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  const name = (eq < 0 ? first : first.slice(0, eq)).trim();
  const value = eq < 0 ? '' : first.slice(eq + 1).trim();
  const attrs = { secure: false, httponly: false, samesite: null, path: null, domain: null, maxAge: null, expires: null };
  for (const raw of parts) {
    const i = raw.indexOf('=');
    const key = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : raw.slice(i + 1).trim();
    if (key === 'secure') attrs.secure = true;
    else if (key === 'httponly') attrs.httponly = true;
    else if (key === 'samesite') attrs.samesite = val.toLowerCase();
    else if (key === 'path') attrs.path = val;
    else if (key === 'domain') attrs.domain = val;
    else if (key === 'max-age') attrs.maxAge = Number(val);
    else if (key === 'expires') attrs.expires = val;
  }
  return { name, value, attrs };
}

/** Every value of cookie `name` in a Cookie request header (a browser sends each name once). */
function cookieValues(header, name) {
  if (typeof header !== 'string' || header === '') return [];
  const out = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

const sessionLines = (setCookies) => (setCookies || []).map(parseSetCookie).filter((c) => c.name === SESSION_COOKIE);

/**
 * What is wrong with a sign-in answer's session cookie (spec Addendum A and Part 01:
 * `__Host-tp_session`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, a life
 * of at most 24 h). Empty = right.
 */
function sessionCookieProblems(setCookies) {
  const lines = sessionLines(setCookies);
  if (lines.length !== 1) return [`the answer set ${lines.length} ${SESSION_COOKIE} cookies, not 1`];
  const { value, attrs } = lines[0];
  const out = [];
  if (!COOKIE_VALUE_RE.test(value)) out.push('the session value is empty or not token-shaped');
  if (!attrs.secure) out.push('no Secure');
  if (!attrs.httponly) out.push('no HttpOnly');
  if (attrs.samesite !== 'strict') out.push(`SameSite is ${attrs.samesite === null ? 'missing' : attrs.samesite}, not strict`);
  if (attrs.path !== '/') out.push(`Path is ${attrs.path === null ? 'missing' : attrs.path}, not /`);
  if (attrs.domain !== null) out.push('it names a Domain (a __Host- cookie must not)');
  if (!(attrs.maxAge > 0 && attrs.maxAge <= 86400)) out.push('Max-Age is not in 1..86400 seconds');
  return out;
}

/** True when the answer clears the session cookie: an empty value that expires now. */
function clearsSession(setCookies, nowMs = Date.now()) {
  return sessionLines(setCookies).some((c) => {
    if (c.value !== '') return false;
    if (c.attrs.maxAge !== null && c.attrs.maxAge <= 0) return true;
    const t = c.attrs.expires === null ? NaN : Date.parse(c.attrs.expires);
    return Number.isFinite(t) && t <= nowMs;
  });
}

function jsonKeys(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : null;
  } catch (_err) {
    return null;
  }
}

function jsonField(text, key) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v[key] : undefined;
  } catch (_err) {
    return undefined;
  }
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judge every /api/tp/account request a browser made, in the order it made them.
 *
 * entries: [{seq, method, path, headers: {origin?, 'sec-fetch-site'?, referer?,
 *   'content-type'?, cookie?}, body: string, status: number, setCookies: string[],
 *   responseBody: string}] — headers exactly as the browser sent them (lower-case
 * names); status, Set-Cookie lines and body exactly as the server answered.
 *
 * Rules (Part 01's contract, as a browser must meet it):
 * - every request: Sec-Fetch-Site same-origin, and no Referer (the page's
 *   Referrer-Policy is no-referrer);
 * - every write (not GET): Origin equal to `origin`, Content-Type application/json;
 * - a sign-in answered 200 sets the session cookie right (sessionCookieProblems);
 *   every session value a request carries was set by an earlier sign-in, each
 *   sign-in's value comes back on a later request, and a request carries it once;
 * - every request other than challenge and login carries the cookie, except a
 *   GET /me answered 401: a browser with no session asking whether it has one
 *   (POST /nonce is the challenge and GET /me the session);
 * - bodies: challenge {address}; login {nonce, signature} with a 0x+130-hex
 *   signature; PUT /vault exactly {baseRev, kv, keyId, iv, ct} (never rekey);
 * - statuses: 2xx, that 401, and 409 conflict (a save that raced another device,
 *   re-read and merged by the page); anything else is a problem;
 * - logout answers 204 and clears the cookie.
 *
 * @returns {{problems: string[], stats: {account: number, logins: number, logouts: number,
 *   puts: number, conflicts: number, withCookie: number, probes: number, byRoute: object}}}
 */
function auditAccountWire(entries, { origin, nowMs = Date.now() }) {
  const problems = [];
  const stats = { account: 0, logins: 0, logouts: 0, puts: 0, conflicts: 0, withCookie: 0, probes: 0, byRoute: {} };
  const issued = new Set();
  const used = new Set();
  for (const e of entries) {
    if (!isAccount(e)) continue;
    stats.account += 1;
    const route = routeOf(e);
    const name = `${e.method} ${route}`;
    const say = (what) => problems.push(`${name} (#${e.seq}): ${what}`);
    const h = e.headers || {};
    const key = `${name} ${e.status}`;
    stats.byRoute[key] = (stats.byRoute[key] || 0) + 1;

    if (h['sec-fetch-site'] !== 'same-origin') {
      say(`Sec-Fetch-Site is ${h['sec-fetch-site'] === undefined ? 'missing' : JSON.stringify(h['sec-fetch-site'])}, not same-origin`);
    }
    if (h.referer !== undefined) say('carried a Referer (the page sets Referrer-Policy: no-referrer)');
    if (e.method !== 'GET') {
      if (h.origin !== origin) say(`Origin is ${h.origin === undefined ? 'missing' : JSON.stringify(h.origin)}, not ${origin}`);
      if (!/^application[/]json/i.test(String(h['content-type'] || ''))) say('Content-Type is not application/json');
    }

    const values = cookieValues(h.cookie, SESSION_COOKIE);
    if (values.length > 1) say('carried the session cookie more than once');
    const sent = values.length ? values[0] : null;
    if (sent !== null) {
      stats.withCookie += 1;
      if (issued.has(sent)) used.add(sent);
      else say('carried a session cookie that no sign-in of this run set');
    }

    const tail = route.slice(ACCOUNT_PREFIX.length);
    const isChallenge = e.method === 'POST' && CHALLENGE_ROUTES.has(tail);
    const isLogin = e.method === 'POST' && tail === 'login';
    const isSession = e.method === 'GET' && SESSION_ROUTES.has(tail);
    const isProbe = isSession && e.status === 401 && sent === null;
    if (isProbe) stats.probes += 1;
    if (sent === null && !isChallenge && !isLogin && !isProbe) say('was sent without the session cookie');

    const ok = e.status >= 200 && e.status < 300;
    const conflict = e.status === 409 && jsonField(e.responseBody, 'code') === 'conflict';
    if (!ok && !isProbe && !conflict) say(`answered ${e.status}${jsonField(e.responseBody, 'code') ? ' ' + jsonField(e.responseBody, 'code') : ''}`);
    if (conflict) stats.conflicts += 1;

    if (isChallenge && !sameList(jsonKeys(e.body), ['address'])) say('the body is not exactly {address}');
    if (isLogin) {
      if (!sameList(jsonKeys(e.body), ['nonce', 'signature'])) say('the body is not exactly {nonce, signature}');
      else if (!LOGIN_SIG_RE.test(String(jsonField(e.body, 'signature')))) say('the signature is not 0x + 130 lower-case hex');
      if (ok) {
        stats.logins += 1;
        const wrong = sessionCookieProblems(e.setCookies);
        for (const w of wrong) say(`session cookie: ${w}`);
        if (wrong.length === 0) issued.add(sessionLines(e.setCookies)[0].value);
      }
    }
    if (e.method === 'POST' && tail === 'logout') {
      stats.logouts += 1;
      if (e.status !== 204) say(`logout answered ${e.status}, not 204`);
      if (!clearsSession(e.setCookies, nowMs)) say('logout did not clear the session cookie');
    }
    if (e.method === 'PUT' && tail === 'vault') {
      if (!sameList(jsonKeys(e.body), PUT_FIELDS)) say('the body is not exactly {baseRev, kv, keyId, iv, ct}');
      if (ok) stats.puts += 1;
    }
  }
  if (stats.logins === 0) problems.push('no sign-in was answered 200');
  if ([...issued].some((v) => !used.has(v))) problems.push("a sign-in's session cookie never came back on a later request");
  return { problems, stats };
}

/**
 * The spellings of a secret a scan looks for: lower-case bare hex, and base64 /
 * base64url of its bytes; for a 65-byte signature also r, s and r || s (the unlock
 * key material) on their own. Hex matches ignore case; base64 matches exactly.
 * No spelling appears twice.
 * @returns {Array<{text: string, fold: boolean}>}
 */
function secretNeedles(hex) {
  const bare = String(hex).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(bare) || bare.length < 64 || bare.length % 2 !== 0) {
    throw new Error('a secret to scan for is at least 32 bytes of hex');
  }
  const bytes = Buffer.from(bare, 'hex');
  const out = [{ text: bare, fold: true }];
  const addB64 = (buf) => {
    out.push({ text: buf.toString('base64').replace(/=+$/, ''), fold: false });
    out.push({ text: buf.toString('base64url'), fold: false });
  };
  addB64(bytes);
  if (bytes.length === 65) {
    out.push({ text: bare.slice(0, 64), fold: true }, { text: bare.slice(64, 128), fold: true });
    addB64(bytes.subarray(0, 64));
  }
  // base64 and base64url agree when the bytes encode without + or /: one needle each.
  return out.filter((n, i) => out.findIndex((m) => m.text === n.text) === i);
}

/** A bare 20-byte address as a case-folded needle. */
function addressNeedle(address) {
  const bare = String(address).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(bare)) throw new Error('not an address');
  return { text: bare, fold: true };
}

/** How many (text, needle) pairs match. */
function countNeedles(texts, needles) {
  let hits = 0;
  for (const text of texts) {
    const raw = String(text);
    const folded = raw.toLowerCase();
    for (const n of needles) if ((n.fold ? folded : raw).includes(n.text)) hits += 1;
  }
  return hits;
}

/** Every 0x-prefixed run of exactly `len` hex characters in a text. */
function hexRuns(text, len) {
  const out = [];
  const re = /0x([0-9a-fA-F]+)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) if (m[1].length === len) out.push(`0x${m[1]}`);
  return out;
}

/**
 * Which of the dApp's two messages a wallet was asked to sign, by its Nonce line:
 * the unlock message's fixed 'vaultkeyv1', or a server nonce (32 lower-case hex).
 * @returns {'unlock'|'login'|'other'}
 */
function classifyMessage(text) {
  const line = String(text)
    .split(LF)
    .find((l) => l.startsWith('Nonce: '));
  if (!line) return 'other';
  const nonce = line.slice('Nonce: '.length);
  if (nonce === 'vaultkeyv1') return 'unlock';
  if (/^[0-9a-f]{32}$/.test(nonce)) return 'login';
  return 'other';
}

/** True when a sign-in message names this page: its domain line and its URI line. */
function loginNamesOrigin(text, origin) {
  const lines = String(text).split(LF);
  const host = new URL(origin).host;
  return lines[0] === `${host} wants you to sign in with your Ethereum account:` && lines.includes(`URI: ${origin}`);
}

module.exports = {
  SESSION_COOKIE,
  ACCOUNT_PREFIX,
  isAccount,
  parseSetCookie,
  cookieValues,
  sessionCookieProblems,
  clearsSession,
  auditAccountWire,
  secretNeedles,
  addressNeedle,
  countNeedles,
  hexRuns,
  classifyMessage,
  loginNamesOrigin,
};
