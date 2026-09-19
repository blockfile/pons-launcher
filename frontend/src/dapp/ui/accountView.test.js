import test from 'node:test';
import assert from 'node:assert/strict';
import { accountView } from './accountView.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const base = { status: 'out', step: null, address: null, walletId: null, walletAddress: null, walletLocked: false, keyEpoch: 0, error: '' };
const WALLETS = [{ id: 'eip6963:1', name: 'MetaMask', icon: null }];
const ids = (v) => v.actions.map((a) => a.id);

test('starting: nothing is shown (no flash of the banner before the session answers)', () => {
  assert.equal(accountView({ acct: { ...base, status: 'starting' } }).hidden, true);
});

test('out: the banner offers Connect when a wallet exists, and says so when none does', () => {
  const v = accountView({ acct: base, wallets: WALLETS });
  assert.equal(v.banner, true);
  assert.match(v.text, /gone after a refresh/);
  assert.deepEqual(ids(v), ['connect']);
  assert.equal(v.actions[0].kind, 'go');
  assert.equal(v.actions[0].needsWallet, true);
  const none = accountView({ acct: base, wallets: [] });
  assert.deepEqual(ids(none), []);
  assert.match(none.hint, /No browser wallet found/);
});

test('while the wallet is asked, only the step text shows', () => {
  for (const step of ['connecting', 'signing-in', 'unlocking', 'confirming', 'deleting']) {
    const v = accountView({ acct: { ...base, status: 'locked', address: A, step }, wallets: WALLETS });
    assert.equal(v.busy, true);
    assert.ok(v.text.length > 10, step);
    assert.deepEqual(ids(v), []);
  }
  assert.match(accountView({ acct: { ...base, step: 'confirming' } }).text, /once more/);
});

test('locked: Unlock, Disconnect and Delete; unsupported: Disconnect only, with the reason', () => {
  const v = accountView({ acct: { ...base, status: 'locked', address: A }, wallets: WALLETS });
  assert.deepEqual(ids(v), ['unlock', 'disconnect', 'delete']);
  assert.equal(v.actions[2].kind, 'danger');
  const u = accountView({ acct: { ...base, status: 'unsupported', address: A, error: 'signs differently' }, wallets: WALLETS });
  assert.deepEqual(ids(u), ['disconnect']);
  assert.equal(u.error, 'signs differently');
});

test('unlocked: the sync state reads as words; a lost session asks to sign in again, other errors offer Retry', () => {
  const acct = { ...base, status: 'unlocked', address: A, walletAddress: A };
  assert.equal(accountView({ acct, sync: { state: 'saved' } }).sync, 'saved to your account');
  assert.equal(accountView({ acct, sync: { state: 'pending' } }).sync, 'saving…');
  assert.deepEqual(ids(accountView({ acct, sync: { state: 'saved' } })), ['lock', 'disconnect', 'delete']);
  const lost = accountView({ acct, sync: { state: 'error', code: 'no_session', error: 'Your sign-in expired.' } });
  assert.deepEqual(ids(lost), ['signin-again', 'lock', 'disconnect', 'delete']);
  const net = accountView({ acct, sync: { state: 'error', code: 'network', error: 'Could not reach the server.' } });
  assert.deepEqual(ids(net), ['retry', 'lock', 'disconnect', 'delete']);
  assert.equal(net.sync, 'not saved: Could not reach the server.');
  const blocked = accountView({ acct, sync: { state: 'blocked', code: 'key_mismatch', error: 'stopped' } });
  assert.deepEqual(ids(blocked), ['lock', 'disconnect', 'delete']);
});

test('a switched wallet is reported, never acted on by itself; the page offers to sign in as the new account', () => {
  const v = accountView({ acct: { ...base, status: 'unlocked', address: A, walletAddress: B }, sync: { state: 'saved' }, wallets: WALLETS });
  assert.match(v.switched, /switched to 0x2222…2222/);
  assert.equal(ids(v)[0], 'switch');
  const locked = accountView({ acct: { ...base, status: 'locked', address: A, walletAddress: B }, wallets: WALLETS });
  assert.deepEqual(ids(locked), ['switch', 'disconnect', 'delete'], 'no Unlock for the wrong account');
});

test('a passphrase vault on this device is offered for moving once the account copy is open', () => {
  const acct = { ...base, status: 'unlocked', address: A };
  assert.equal(accountView({ acct, sync: { state: 'saved' }, legacy: 'locked' }).migrate, 'passphrase');
  assert.equal(accountView({ acct, sync: { state: 'saved' }, legacy: 'unlocked' }).migrate, 'move');
  assert.equal(accountView({ acct, sync: { state: 'loading' }, legacy: 'locked' }).migrate, null);
  assert.equal(accountView({ acct, sync: { state: 'blocked' }, legacy: 'locked' }).migrate, null);
  assert.equal(accountView({ acct, sync: { state: 'saved' }, legacy: 'none' }).migrate, null);
  assert.equal(accountView({ acct: { ...acct, status: 'locked' }, legacy: 'locked', wallets: WALLETS }).migrate, null);
});

test('no action is amber: the account strip moves no money', () => {
  const all = [
    accountView({ acct: base, wallets: WALLETS }),
    accountView({ acct: { ...base, status: 'locked', address: A }, wallets: WALLETS }),
    accountView({ acct: { ...base, status: 'unlocked', address: A }, sync: { state: 'error', code: 'network', error: 'x' } }),
  ];
  for (const v of all) for (const a of v.actions) assert.ok(['go', 'quiet', 'danger'].includes(a.kind));
});

test("a leave waiting for the tab's own signing shows its text and only the way back; once final, nothing to press", () => {
  const acct = { ...base, status: 'unlocked', address: A, walletAddress: A };
  const text = 'Locking once this tab has signed what it still owes';
  const v = accountView({ acct, sync: { state: 'saved' }, wallets: WALLETS, legacy: 'unlocked', leaving: { how: 'lock', text, final: false } });
  assert.equal(v.busy, true);
  assert.equal(v.text, text);
  assert.deepEqual(v.actions, [{ id: 'leave-cancel', label: 'Keep unlocked', kind: 'quiet', needsWallet: false }]);
  assert.equal(v.migrate, null, 'no move into the account while it locks');
  assert.equal(accountView({ acct, sync: { state: 'saved' }, leaving: { how: 'disconnect', text, final: false } }).actions[0].label, 'Stay connected');
  assert.deepEqual(accountView({ acct, sync: { state: 'saved' }, leaving: { how: 'switch', text, final: true } }).actions, []);
});

test('without a leave the strip is exactly as before', () => {
  const acct = { ...base, status: 'unlocked', address: A, walletAddress: A };
  assert.deepEqual(accountView({ acct, sync: { state: 'saved' }, leaving: null }), accountView({ acct, sync: { state: 'saved' } }));
  assert.deepEqual(ids(accountView({ acct, sync: { state: 'saved' }, leaving: null })), ['lock', 'disconnect', 'delete']);
});
