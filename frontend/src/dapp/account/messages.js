/**
 * The two texts a connected wallet signs (spec Addendum A). Both are EIP-4361
 * (Sign-In with Ethereum) shaped, ASCII only, lines joined with LF (no CR, no
 * trailing LF). No escape sequence appears in this file: LF is built from its
 * char code (memory: write-tool-escapes).
 *
 * LOGIN. The SERVER builds the login message and hands it over with its nonce;
 * the page rebuilds the same text from {address, nonce, issuedAt, expirationTime,
 * location.origin} and refuses to sign unless the two are byte-identical
 * (checkChallenge). backend/src/tp owns its own copy of this template (tab
 * isolation); each side golden-tests it, so a drift fails a test, not a login.
 *
 * UNLOCK. A fixed message whose signature is the key material for the account's
 * encrypted copy (unlockKey.js). It is FROZEN FOREVER: one changed byte (a CRLF
 * from an editor, the domain, a word) changes every user's key and locks them
 * out of their saved wallets. messages.test.js pins its SHA-256. Its domain and
 * URI are the production host whatever host serves the page, so the key is the
 * same everywhere. The nonce 'vaultkeyv1' has non-hex letters: it can never be a
 * server nonce (32 lower-case hex), and the login route accepts only messages the
 * server itself produced.
 */
import { getAddress } from 'ethers';

export const CHAIN_ID = 4663;
const LF = String.fromCharCode(10);
const NONCE_RE = /^[0-9a-f]{32}$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
const HOST_RE = /^[a-z0-9.-]+(:[0-9]{1,5})?$/;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const MAX_CHALLENGE_MS = 10 * 60 * 1000;

export const LOGIN_STATEMENT =
  'Sign in to rhbond take-profit to sync your encrypted wallet list. Keeps this browser signed in for 24 hours. This is not a transaction and costs nothing.';

function fail(message, code = 'bad_challenge') {
  return new Error(message, { cause: { code } });
}

/**
 * The login message. domain = host[:port] of the page; uri = its origin.
 * @param {{domain: string, address: string, uri: string, nonce: string, issuedAt: string, expirationTime: string}} f
 * @returns {string}
 */
export function loginMessage({ domain, address, uri, nonce, issuedAt, expirationTime }) {
  if (typeof domain !== 'string' || !HOST_RE.test(domain)) throw fail('the sign-in domain is malformed');
  if (typeof uri !== 'string' || !ORIGIN_RE.test(uri)) throw fail('the sign-in URI is malformed');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw fail('the sign-in nonce is malformed');
  if (typeof issuedAt !== 'string' || !ISO_RE.test(issuedAt)) throw fail('the sign-in time is malformed');
  if (typeof expirationTime !== 'string' || !ISO_RE.test(expirationTime)) throw fail('the sign-in expiry is malformed');
  let who;
  try {
    who = getAddress(String(address));
  } catch {
    throw fail('the sign-in address is malformed');
  }
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    who,
    '',
    LOGIN_STATEMENT,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join(LF);
}

/** A time the server sent: an ISO string used verbatim, or epoch ms turned into ISO with ms. */
function isoOf(value) {
  if (typeof value === 'string' && ISO_RE.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value).toISOString();
  throw fail('the server sent a malformed sign-in time');
}

/**
 * Check the server's challenge before anything is signed.
 * @param {{nonce: string, message: string, issuedAt: string|number, expirationTime: string|number}} challenge
 *   the answer of POST /api/tp/account/nonce (backend/src/tp/accountContract.json)
 * @param {{address: string, origin: string}} page  origin = location.origin
 * @returns {string} the message to sign (byte-identical to the server's)
 * @throws Error with cause.code 'bad_challenge' when anything differs
 */
export function checkChallenge(challenge, { address, origin }) {
  if (!challenge || typeof challenge !== 'object') throw fail('the server sent no sign-in message');
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw fail('this page has no origin to sign in to');
  }
  const issuedAt = isoOf(challenge.issuedAt);
  const expirationTime = isoOf(challenge.expirationTime);
  const life = Date.parse(expirationTime) - Date.parse(issuedAt);
  if (!(life > 0 && life <= MAX_CHALLENGE_MS)) throw fail('the sign-in message has an implausible lifetime');
  const expected = loginMessage({ domain: url.host, address, uri: url.origin, nonce: challenge.nonce, issuedAt, expirationTime });
  if (challenge.message !== expected) {
    throw fail("the server's sign-in message is not the one this page expects, so it was not signed");
  }
  return expected;
}

export const UNLOCK_DOMAIN = 'dapp.rhbond.xyz';
export const UNLOCK_STATEMENT =
  'Unlock the wallets you saved on rhbond take-profit. This signature never leaves your browser: it is the key to your saved wallets. Only sign it on https://dapp.rhbond.xyz.';

/**
 * The unlock message for one account. FROZEN FOREVER (see the header).
 * @param {string} address
 * @returns {string}
 */
export function unlockMessage(address) {
  return [
    'dapp.rhbond.xyz wants you to sign in with your Ethereum account:',
    getAddress(String(address)),
    '',
    UNLOCK_STATEMENT,
    '',
    'URI: https://dapp.rhbond.xyz/vault',
    'Version: 1',
    'Chain ID: 4663',
    'Nonce: vaultkeyv1',
    'Issued At: 2026-09-19T00:00:00Z',
  ].join(LF);
}
