'use strict';

// The take-profit dApp's one error type.
//
// Every refusal the public /api/tp surface makes is a TpError: a stable machine
// `code` the browser branches on, a human `message` it shows as text, and the HTTP
// `status` the router answers with. The code list is CLOSED — a code outside it is a
// programming error and throws at construction, so a typo cannot reach the wire as a
// code the frontend has never heard of.
//
// Nothing here ever carries a private key: the server never receives one.

const CODES = Object.freeze([
  'bad_address', // not a 0x-prefixed 20-byte address
  'not_contract', // no code at the address
  'not_pons', // not in either pons factory's registry
  'migrating', // a pons v2 phase that is neither curve (0) nor graduated (2)
  'bad_request', // malformed body / query
  'bad_tx', // a raw transaction the broadcast validator refused
  'rate_limited', // limits.js said no
  'too_many', // more items than one request may carry
  'unavailable', // the chain / a dependency did not answer, or not implemented yet
  // ── the account (tp/account.js, tp/vaultStore.js) ──
  'forbidden', // a cross-site or cross-origin request to the account API
  'no_session', // no session cookie, or an expired / tampered / revoked one
  'unknown_nonce', // a login naming a nonce this server never issued, or already used
  'challenge_expired', // a login after its 5-minute challenge ran out
  'bad_signature', // a login signature that does not recover to the challenge's address
  'conflict', // a vault write whose baseRev is not the stored rev (answer carries `rev`)
  'key_mismatch', // a vault write under a different keyId (no override: DELETE starts over)
  'too_large', // a vault ciphertext over TP_VAULT_MAX_BYTES
  'store_full', // the account store's global caps are reached
]);
const CODE_SET = new Set(CODES);

class TpError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message shown to the visitor verbatim — never put a key or a raw body in it
   * @param {number} [status=400] HTTP status, 400-599
   * @param {Object<string, number>} [extra] numeric fields the answer carries beside
   *   {error, code} — e.g. a vault conflict's current `rev`. Numbers only, so no text
   *   (and no key) can ride along; `error` and `code` cannot be overridden.
   */
  constructor(code, message, status = 400, extra) {
    if (!CODE_SET.has(code)) throw new TypeError(`TpError: unknown code "${code}"`);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError(`TpError: status must be an integer 400-599, got ${status}`);
    }
    if (extra !== undefined) {
      const ok =
        extra !== null &&
        typeof extra === 'object' &&
        !Array.isArray(extra) &&
        Object.entries(extra).every(([k, v]) => k !== 'error' && k !== 'code' && Number.isFinite(v));
      if (!ok) throw new TypeError('TpError: extra must be {name: finite number}, never error/code');
    }
    super(message || code);
    this.name = 'TpError';
    this.code = code;
    this.status = status;
    if (extra !== undefined) this.extra = Object.freeze({ ...extra });
  }
}

function isTpError(err) {
  return err instanceof TpError;
}

/**
 * Answer an error as JSON `{error, code}`. A TpError answers with its own status and
 * message. Anything else (an RPC failure, a bug) answers 502 'unavailable' with a
 * generic message: the raw error text of an arbitrary exception is not the visitor's
 * business, and is logged server-side instead.
 */
function sendError(res, err) {
  if (isTpError(err)) {
    return res.status(err.status).json({ ...(err.extra || {}), error: err.message, code: err.code });
  }
  console.error('[tp] request error:', err && err.message ? err.message : String(err));
  return res
    .status(502)
    .json({ error: 'the chain did not answer in time — try again', code: 'unavailable' });
}

module.exports = { TpError, CODES, isTpError, sendError };
