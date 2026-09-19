import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { CHAIN_ID, LOGIN_STATEMENT, checkChallenge, loginMessage, unlockMessage } from './messages.js';

// No escape sequences in this file on purpose (memory: write-tool-escapes).
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
// The EIP-55 test vector: a public address, not anyone's key.
const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const NONCE = '0123456789abcdef0123456789abcdef';
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const asciiOnly = (text) => [...text].every((ch) => ch === LF || (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126));

test('the unlock message is frozen: its bytes hash to the pinned SHA-256', () => {
  const m = unlockMessage(ADDR.toLowerCase());
  // CHANGING THIS HASH CHANGES EVERY USER'S KEY AND LOCKS THEM OUT OF THEIR SAVED WALLETS.
  assert.equal(sha256(m), '2cd970a7db4e45e6e57b87fdd3ac142a34112bbd484c1a7ccac52da9f684a10f');
  assert.equal(
    m,
    [
      'dapp.rhbond.xyz wants you to sign in with your Ethereum account:',
      ADDR,
      '',
      'Unlock the wallets you saved on rhbond take-profit. This signature never leaves your browser: it is the key to your saved wallets. Only sign it on https://dapp.rhbond.xyz.',
      '',
      'URI: https://dapp.rhbond.xyz/vault',
      'Version: 1',
      'Chain ID: 4663',
      'Nonce: vaultkeyv1',
      'Issued At: 2026-09-19T00:00:00Z',
    ].join(LF)
  );
  assert.ok(asciiOnly(m), 'ASCII and LF only');
  assert.ok(!m.includes(CR), 'no CR');
  assert.ok(!m.endsWith(LF), 'no trailing LF');
});

test('the login message matches the EIP-4361 template byte for byte', () => {
  const m = loginMessage({
    domain: 'dapp.rhbond.xyz',
    address: ADDR.toLowerCase(),
    uri: 'https://dapp.rhbond.xyz',
    nonce: NONCE,
    issuedAt: '2026-09-19T12:00:00.000Z',
    expirationTime: '2026-09-19T12:05:00.000Z',
  });
  assert.equal(sha256(m), '4f406bc06cc0ef2ec7748874387dff3dd67e3bdea8d55b54ee5785f914950943');
  assert.deepEqual(m.split(LF), [
    'dapp.rhbond.xyz wants you to sign in with your Ethereum account:',
    ADDR,
    '',
    LOGIN_STATEMENT,
    '',
    'URI: https://dapp.rhbond.xyz',
    'Version: 1',
    'Chain ID: 4663',
    `Nonce: ${NONCE}`,
    'Issued At: 2026-09-19T12:00:00.000Z',
    'Expiration Time: 2026-09-19T12:05:00.000Z',
  ]);
  assert.equal(CHAIN_ID, 4663);
  assert.ok(asciiOnly(m));
});

test('the unlock message can never be a login message: its nonce is not 32 hex', () => {
  const m = unlockMessage(ADDR);
  const nonceLine = m.split(LF).find((l) => l.startsWith('Nonce: '));
  assert.equal(nonceLine, 'Nonce: vaultkeyv1');
  assert.doesNotMatch(nonceLine.slice(7), /^[0-9a-f]{32}$/);
  assert.ok(!m.includes('Expiration Time'), 'the unlock message has no expiry: it is the same forever');
});

function serverChallenge({ origin = 'http://127.0.0.1:3199', address = ADDR, issued = Date.UTC(2026, 8, 19, 12), lifeMs = 300000 } = {}) {
  const url = new URL(origin);
  const issuedAt = new Date(issued).toISOString();
  const expirationTime = new Date(issued + lifeMs).toISOString();
  const message = loginMessage({ domain: url.host, address, uri: url.origin, nonce: NONCE, issuedAt, expirationTime });
  // exactly the answer of POST /api/tp/account/nonce (backend/src/tp/accountContract.json)
  return { nonce: NONCE, message, issuedAt, expirationTime };
}

test('checkChallenge returns the server message when it is exactly the one the page would build, port included', () => {
  const ch = serverChallenge();
  assert.equal(checkChallenge(ch, { address: ADDR, origin: 'http://127.0.0.1:3199' }), ch.message);
  assert.ok(ch.message.startsWith('127.0.0.1:3199 wants you to sign in'));
  // epoch-ms times are accepted and read as ISO with milliseconds
  const ms = { ...ch, issuedAt: Date.parse(ch.issuedAt), expirationTime: Date.parse(ch.expirationTime) };
  assert.equal(checkChallenge(ms, { address: ADDR, origin: 'http://127.0.0.1:3199' }), ch.message);
});

test('checkChallenge refuses any difference: another domain, account, nonce, statement, CRLF or lifetime', () => {
  const origin = 'http://127.0.0.1:3199';
  const ch = serverChallenge();
  const other = Wallet.createRandom().address;
  const cases = [
    { ...ch, message: ch.message.replace('127.0.0.1:3199', 'evil.example') },
    serverChallenge({ origin: 'https://dapp.rhbond.xyz' }),
    serverChallenge({ address: other }),
    { ...ch, nonce: 'f'.repeat(32) },
    { ...ch, message: ch.message.replace('costs nothing', 'costs nothing. Also approve') },
    { ...ch, message: ch.message.split(LF).join(CR + LF) },
    { ...ch, message: `${ch.message}${LF}` },
    serverChallenge({ lifeMs: 24 * 3600 * 1000 }),
    { ...ch, expirationTime: ch.issuedAt },
    { ...ch, issuedAt: 'yesterday' },
    // the expiry under any other name than the server's is no expiry at all
    { nonce: ch.nonce, message: ch.message, issuedAt: ch.issuedAt, expiresAt: ch.expirationTime },
    null,
  ];
  for (const bad of cases) {
    assert.throws(
      () => checkChallenge(bad, { address: ADDR, origin }),
      (e) => e.cause && e.cause.code === 'bad_challenge'
    );
  }
});
