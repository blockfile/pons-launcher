/**
 * TEST HELPER — nothing in the page imports it, so it never reaches the bundle.
 *
 * An in-memory stand-in for /api/tp/account/* with the semantics the backend
 * serves (backend/src/tp/account.js), spoken through a fetch function so tests
 * exercise the REAL api.js. One visitor, one cookie jar. Its routes and answer
 * fields are pinned to backend/src/tp/accountContract.json by contract.test.js,
 * and the backend's own tests walk that same file.
 *
 *   POST /nonce {address}          -> {nonce, message, issuedAt, expirationTime}; 5 min, single use
 *   POST /login {nonce, signature} -> {address, expiresAt} | 401 unknown_nonce |
 *                                     challenge_expired | bad_signature
 *   GET  /me                       -> {address, expiresAt, vault: meta|null} | 401 no_session
 *   POST /logout                   -> 204
 *   GET  /vault                    -> {vault: null|{v:2, kv, keyId, iv, ct, rev, updatedAt}}
 *   PUT  /vault {baseRev, kv, keyId, iv, ct} -> {rev, updatedAt} | 409 conflict |
 *                                     409 key_mismatch | 413 too_large
 *   DELETE /vault {baseRev}        -> {deleted: true|false} and the session ENDS (the
 *                                     backend revokes every session of the address and
 *                                     clears the cookie, copy or no copy) | 409 conflict
 *
 * Test hooks: bodies (every request body text), log ([{method, path}]),
 * vaults (Map lower address -> stored record), expireSession(),
 * writeAs(address, record) (another device saved), and
 * failNext(method, route, status|'network', {code?, retryAfter?, proxy?}):
 *   the next matching request fails the way the real server fails. The JSON
 *   {error, code} carries the code the backend's tp routes send for that status
 *   (REAL_CODES; another status needs an explicit code). A 429 carries
 *   Retry-After (whole seconds, default 1; retryAfter: null leaves it out), as
 *   limits.js does. proxy: true answers with no JSON body and no Retry-After,
 *   the way nginx's limit_req (429) or a stopped backend (502/504) does.
 */
import { getAddress } from 'ethers';
import { loginMessage } from './messages.js';
import { canonicalSignature, signerOf } from './signature.js';

const BASE = '/api/tp/account';

/** The code backend/src/tp answers with, by status, on the account routes. */
export const REAL_CODES = Object.freeze({
  400: 'bad_request',
  401: 'no_session',
  403: 'forbidden',
  409: 'conflict',
  413: 'too_large',
  415: 'bad_request',
  429: 'rate_limited',
  502: 'unavailable',
  503: 'unavailable',
  507: 'store_full',
});

export function createFakeAccountServer({ origin = 'http://127.0.0.1:3199', now = () => Date.now() } = {}) {
  const page = new URL(origin);
  const challenges = new Map();
  const vaults = new Map();
  const bodies = [];
  const log = [];
  const failures = [];
  let session = null;

  const answer = (status, body, head = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    body: null,
    headers: { get: (name) => (Object.hasOwn(head, String(name).toLowerCase()) ? head[String(name).toLowerCase()] : null) },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  });
  const refuse = (status, code) => answer(status, { error: code.replace(/_/g, ' '), code });

  function randomHex(bytes) {
    const b = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function meta(rec) {
    return rec ? { rev: rec.rev, keyId: rec.keyId, updatedAt: rec.updatedAt, bytes: Math.floor((rec.ct.length * 3) / 4) } : null;
  }

  async function fetch(url, init = {}) {
    const method = init.method || 'GET';
    const path = String(url);
    log.push({ method, path });
    if (init.body !== undefined) bodies.push(String(init.body));
    const i = failures.findIndex((f) => f.method === method && f.path === path);
    if (i >= 0) {
      const [f] = failures.splice(i, 1);
      if (f.status === 'network') throw new TypeError('fetch failed');
      if (f.proxy) return answer(f.status, undefined);
      const head = f.status === 429 && f.retryAfter !== null ? { 'retry-after': String(f.retryAfter ?? 1) } : {};
      return answer(f.status, { error: f.code.replace(/_/g, ' '), code: f.code }, head);
    }
    const body = init.body !== undefined ? JSON.parse(init.body) : null;
    const route = `${method} ${path.startsWith(BASE) ? path.slice(BASE.length) : path}`;

    if (route === 'POST /nonce') {
      const address = getAddress(body.address);
      const nonce = randomHex(16);
      const t = now();
      const issuedAt = new Date(t).toISOString();
      const expirationTime = new Date(t + 5 * 60 * 1000).toISOString();
      const message = loginMessage({ domain: page.host, address, uri: page.origin, nonce, issuedAt, expirationTime });
      challenges.set(nonce, { address, message, expiresAt: t + 5 * 60 * 1000 });
      return answer(200, { nonce, message, issuedAt, expirationTime });
    }
    if (route === 'POST /login') {
      const ch = challenges.get(body.nonce);
      challenges.delete(body.nonce);
      if (!ch) return refuse(401, 'unknown_nonce');
      if (now() > ch.expiresAt) return refuse(401, 'challenge_expired');
      let who = null;
      try {
        who = signerOf(ch.message, canonicalSignature(body.signature));
      } catch {
        who = null;
      }
      if (who !== ch.address) return refuse(401, 'bad_signature');
      session = { address: ch.address, expiresAt: now() + 24 * 3600 * 1000 };
      return answer(200, { address: session.address, expiresAt: session.expiresAt });
    }
    if (route === 'POST /logout') {
      session = null;
      return answer(204, undefined);
    }
    if (!session) return refuse(401, 'no_session');
    const key = session.address.toLowerCase();
    const rec = vaults.get(key) || null;
    if (route === 'GET /me') return answer(200, { address: session.address, expiresAt: session.expiresAt, vault: meta(rec) });
    if (route === 'GET /vault') return answer(200, { vault: rec ? { ...rec } : null });
    if (route === 'PUT /vault') {
      const cur = rec ? rec.rev : 0;
      if (body.baseRev !== cur) return answer(409, { error: 'conflict', code: 'conflict', rev: cur });
      if (rec && rec.keyId !== body.keyId) return refuse(409, 'key_mismatch');
      if (Math.floor((body.ct.length * 3) / 4) > 262144) return refuse(413, 'too_large');
      const next = { v: 2, kv: body.kv, keyId: body.keyId, iv: body.iv, ct: body.ct, rev: cur + 1, updatedAt: now() };
      vaults.set(key, next);
      return answer(200, { rev: next.rev, updatedAt: next.updatedAt });
    }
    if (route === 'DELETE /vault') {
      const cur = rec ? rec.rev : 0;
      if (body.baseRev !== cur) return answer(409, { error: 'conflict', code: 'conflict', rev: cur });
      vaults.delete(key);
      session = null; // one cookie jar: revoking every session of the address ends this one
      return answer(200, { deleted: Boolean(rec) });
    }
    return refuse(404, 'not_found');
  }

  return {
    fetch,
    bodies,
    log,
    vaults,
    failNext(method, route, status, { code, retryAfter, proxy = false } = {}) {
      const real = code || REAL_CODES[status];
      if (status !== 'network' && !proxy && !real) throw new Error(`failNext: no backend code for HTTP ${status}; pass {code}`);
      failures.push({ method, path: `${BASE}${route}`, status, code: real, retryAfter, proxy });
    },
    expireSession() {
      session = null;
    },
    signInAs(address) {
      session = { address: getAddress(address), expiresAt: now() + 24 * 3600 * 1000 };
    },
    writeAs(address, record) {
      vaults.set(String(address).toLowerCase(), record);
    },
    get session() {
      return session;
    },
  };
}

/** The account api (api.js) bound to a fake fetch, in the shape account.js and vaultSync.js take. */
export function boundApi(api, fetch) {
  const o = { fetch };
  return {
    postChallenge: (a) => api.postChallenge(a, o),
    postLogin: (x) => api.postLogin(x, o),
    getAccountSession: () => api.getAccountSession(o),
    postLogout: () => api.postLogout(o),
    getVault: () => api.getVault(o),
    putVault: (x) => api.putVault(x, o),
    deleteVault: (rev) => api.deleteVault(rev, o),
  };
}
