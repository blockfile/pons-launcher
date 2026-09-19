import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Wallet } from 'ethers';
import * as api from '../api.js';
import { createAccount, UNSUPPORTED_TEXT } from './account.js';
import { unlockMessage } from './messages.js';
import { walletError } from './walletRpc.js';
import { fakeEip1193, rpcError } from './fakeEip1193.js';
import { boundApi, createFakeAccountServer } from './fakeServer.js';

const ORIGIN = 'http://127.0.0.1:3199';
const subtle = webcrypto.subtle;

function mapCache() {
  const m = new Map();
  return {
    m,
    get: async (a) => m.get(String(a).toLowerCase()) || null,
    put: async (a, e) => {
      m.set(String(a).toLowerCase(), { key: e.key, keyId: e.keyId, expiresAt: Date.now() + 1000 });
    },
    remove: async (a) => {
      m.delete(String(a).toLowerCase());
    },
  };
}

/** A page: one fake server, one wallet, one key cache — shareable across "reloads". */
function setup({ wallet = Wallet.createRandom(), walletOpts = {}, server = createFakeAccountServer({ origin: ORIGIN }), cache = mapCache(), fetch } = {}) {
  const provider = fakeEip1193(wallet, walletOpts);
  const discovery = { provider: (id) => (id === 'w' ? provider : null) };
  const account = createAccount({ api: boundApi(api, fetch || server.fetch), discovery, keyCache: cache, origin: ORIGIN, subtle });
  const states = [];
  account.subscribe((s) => states.push(s));
  return { wallet, provider, server, cache, account, states };
}

test('first visit: sign in, then the first unlock signs twice; the key is cached, and no signature but the login one is sent', async () => {
  const p = setup();
  await p.account.resume();
  assert.equal(p.account.get().status, 'out');
  assert.equal(await p.account.signIn('w'), true);
  assert.equal(p.account.get().status, 'locked');
  assert.equal(p.account.get().address, p.wallet.address);
  assert.equal(await p.account.unlock('w'), true);
  const s = p.account.get();
  assert.equal(s.status, 'unlocked');
  assert.equal(s.keyEpoch, 1);
  assert.equal(s.error, '');
  assert.equal(p.provider.signCount(), 3, 'login + two unlock signatures');
  assert.ok(p.states.some((x) => x.step === 'confirming'), 'the second unlock signature is announced');
  const k = p.account.keyFor();
  assert.equal(k.address, p.wallet.address);
  assert.equal(k.key.extractable, false);
  assert.match(k.keyId, /^0x[0-9a-f]{32}$/);
  assert.equal(p.cache.m.get(p.wallet.address.toLowerCase()).keyId, k.keyId);
  assert.ok(!('key' in s), 'the key never enters the state');
  const unlockSig = await p.wallet.signMessage(unlockMessage(p.wallet.address)); // deterministic: the same bytes the page got
  for (const body of p.server.bodies) assert.ok(!body.includes(unlockSig.slice(2, 66)), 'the unlock signature never leaves the page');
});

test('a refresh with a cached key unlocks with no wallet at all', async () => {
  const first = setup();
  await first.account.signIn('w');
  await first.account.unlock('w');
  const again = setup({ server: first.server, cache: first.cache, wallet: first.wallet });
  await again.account.resume();
  assert.equal(again.account.get().status, 'unlocked');
  assert.equal(again.account.keyFor().keyId, first.account.keyFor().keyId);
  assert.equal(again.provider.calls.length, 0, 'the wallet was not asked anything');
});

test('resume: a cached key that does not match the copy on the server is dropped, and the account is locked', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  p.server.writeAs(p.wallet.address, { v: 2, kv: 1, keyId: `0x${'00'.repeat(16)}`, iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.alloc(64).toString('base64'), rev: 1, updatedAt: 1 });
  const again = setup({ server: p.server, cache: p.cache, wallet: p.wallet });
  await again.account.resume();
  assert.equal(again.account.get().status, 'locked');
  assert.equal(again.account.keyFor(), null);
  assert.equal(p.cache.m.size, 0);
});

test('with a copy on the server, unlock asks once; a key that does not match changes nothing', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  const keyId = p.account.keyFor().keyId;
  p.server.writeAs(p.wallet.address, { v: 2, kv: 1, keyId, iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.alloc(64).toString('base64'), rev: 1, updatedAt: 1 });
  await p.account.lock();
  const before = p.provider.signCount();
  assert.equal(await p.account.unlock('w'), true);
  assert.equal(p.provider.signCount() - before, 1, 'one signature when the server already holds a copy');
  // the copy was re-created under another key elsewhere
  p.server.writeAs(p.wallet.address, { v: 2, kv: 1, keyId: `0x${'11'.repeat(16)}`, iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.alloc(64).toString('base64'), rev: 2, updatedAt: 2 });
  await p.account.lock();
  assert.equal(await p.account.unlock('w'), false);
  assert.equal(p.account.get().status, 'locked');
  assert.match(p.account.get().error, /different unlock key/);
  assert.equal(p.account.keyFor(), null);
  assert.equal(p.cache.m.size, 0, 'nothing cached');
});

test('a wallet that signs differently every time is refused at the first unlock; nothing is cached', async () => {
  const p = setup({ walletOpts: { hedged: true } });
  await p.account.signIn('w');
  assert.equal(p.account.get().status, 'locked', 'a hedged signature still logs in: the server only checks who signed');
  assert.equal(await p.account.unlock('w'), false);
  assert.equal(p.account.get().status, 'unsupported');
  assert.equal(p.account.get().error, UNSUPPORTED_TEXT);
  assert.equal(p.account.keyFor(), null);
  assert.equal(p.cache.m.size, 0);
  assert.equal(p.server.vaults.size, 0, 'nothing was written');
});

test('a sign-in message that differs from the page template is never signed', async () => {
  const server = createFakeAccountServer({ origin: ORIGIN });
  const tampering = async (url, init) => {
    const res = await server.fetch(url, init);
    if (!String(url).endsWith('/nonce')) return res; // the sign-in challenge (accountContract.json)
    const body = await res.json();
    return { ...res, json: async () => ({ ...body, message: body.message.replace('127.0.0.1:3199', 'evil.example') }) };
  };
  const p = setup({ server, fetch: tampering });
  assert.equal(await p.account.signIn('w'), false);
  assert.equal(p.provider.signCount(), 0);
  assert.equal(p.account.get().status, 'starting', 'nothing changed');
  assert.match(p.account.get().error, /not the one this page expects/);
});

test('a cancelled wallet request reads as text and changes nothing', async () => {
  const p = setup();
  await p.account.resume();
  p.provider.rejectNext('personal_sign', rpcError(4001, 'User rejected the request.'));
  assert.equal(await p.account.signIn('w'), false);
  assert.equal(p.account.get().status, 'out');
  assert.equal(p.account.get().error, 'You cancelled the request in your wallet.');
  assert.equal(p.account.get().step, null);
  assert.equal(walletError(rpcError(-32002, 'pending')).cause.code, 'pending');
  assert.equal(walletError({ code: 4100 }).cause.code, 'unauthorized');
  assert.equal(walletError(new Error('boom')).cause.code, 'wallet_error');
});

test('a wallet that switches accounts never wipes anything; unlock refuses the other account', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  const other = Wallet.createRandom();
  p.provider.switchTo(other);
  const s = p.account.get();
  assert.equal(s.status, 'unlocked', 'still unlocked: a sell may be in flight');
  assert.equal(s.address, p.wallet.address);
  assert.equal(s.walletAddress, other.address);
  assert.ok(p.account.keyFor());
  await p.account.lock();
  const before = p.provider.signCount();
  assert.equal(await p.account.unlock('w'), false);
  assert.equal(p.account.get().error.startsWith('Your wallet is on'), true);
  assert.equal(p.provider.signCount(), before, 'nothing signed for the wrong account');
  p.provider.emit('accountsChanged', []);
  assert.equal(p.account.get().walletLocked, true);
});

test('lock forgets the key here and on this device; disconnect also ends the session and lets go of the wallet', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  await p.account.lock();
  assert.equal(p.account.get().status, 'locked');
  assert.equal(p.account.get().keyEpoch, 2);
  assert.equal(p.account.keyFor(), null);
  assert.equal(p.cache.m.size, 0);
  await p.account.unlock('w');
  assert.equal(p.provider.listenerCount('accountsChanged'), 1);
  await p.account.disconnect();
  const s = p.account.get();
  assert.equal(s.status, 'out');
  assert.equal(s.address, null);
  assert.equal(s.keyEpoch, 4);
  assert.equal(p.cache.m.size, 0);
  assert.equal(p.server.session, null, 'logged out on the server');
  assert.equal(p.provider.listenerCount('accountsChanged'), 0);
});

test('signing in again as the same account keeps the key (a session that expired while unlocked)', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  p.server.expireSession();
  assert.equal(await p.account.signIn('w', { expect: p.wallet.address }), true);
  assert.equal(p.account.get().status, 'unlocked');
  assert.equal(p.account.get().keyEpoch, 1, 'the sync keeps running');
  p.provider.switchTo(Wallet.createRandom());
  assert.equal(await p.account.signIn('w', { expect: p.wallet.address }), false);
  assert.match(p.account.get().error, /Switch it to/);
});

const copyFor = (keyId, rev) => ({ v: 2, kv: 1, keyId, iv: 'AAAAAAAAAAAAAAAA', ct: Buffer.alloc(64).toString('base64'), rev, updatedAt: 1 });
const deletesSent = (p) => p.server.log.filter((x) => x.method === 'DELETE').length;

test('deleteSaved deletes the server copy and signs out, as the server does; the next sign-in unlocks fresh', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  p.server.writeAs(p.wallet.address, copyFor(p.account.keyFor().keyId, 3));
  const epoch = p.account.get().keyEpoch;
  assert.equal(await p.account.deleteSaved(), true);
  assert.equal(p.server.vaults.size, 0);
  assert.equal(p.server.session, null, 'the DELETE ended the session on the server');
  const s = p.account.get();
  assert.equal(s.status, 'out', 'signed out here too: never "Signed in ... locked" over a revoked session');
  assert.equal(s.address, null);
  assert.equal(s.step, null);
  assert.equal(s.error, '');
  assert.equal(s.keyEpoch, epoch + 1, 'the key went: the page drops its sync');
  assert.equal(s.walletId, 'w', 'the wallet stays connected, so Connect needs no picker');
  assert.equal(p.account.keyFor(), null);
  assert.equal(p.cache.m.size, 0, 'the cached key is gone from this device');
  const before = p.provider.signCount();
  assert.equal(await p.account.signIn('w'), true);
  assert.equal(p.account.get().status, 'locked', 'no copy and no cached key');
  assert.equal(await p.account.unlock('w'), true);
  assert.equal(p.provider.signCount() - before, 3, 'sign in, then the double unlock signature: the server holds no copy');
  assert.equal(p.account.get().status, 'unlocked');
});

test('deleteSaved with no copy on the server still sends the DELETE (baseRev 0), so it signs out the same way', async () => {
  const p = setup();
  await p.account.signIn('w');
  assert.equal(await p.account.deleteSaved(), true);
  assert.equal(deletesSent(p), 1);
  assert.equal(p.server.bodies[p.server.bodies.length - 1], JSON.stringify({ baseRev: 0 }));
  assert.equal(p.server.session, null);
  assert.equal(p.account.get().status, 'out');
  assert.equal(p.account.get().address, null);
});

test('deleteSaved re-reads the rev once after a 409 conflict, then deletes and signs out', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  p.server.writeAs(p.wallet.address, copyFor(p.account.keyFor().keyId, 2));
  p.server.failNext('DELETE', '/vault', 409, 'conflict');
  assert.equal(await p.account.deleteSaved(), true);
  assert.equal(deletesSent(p), 2);
  assert.equal(p.server.vaults.size, 0);
  assert.equal(p.server.session, null);
  assert.equal(p.account.get().status, 'out');
});

test('a DELETE that fails changes nothing here: still signed in and unlocked, the key kept, the reason shown', async () => {
  const p = setup();
  await p.account.signIn('w');
  await p.account.unlock('w');
  p.server.writeAs(p.wallet.address, copyFor(p.account.keyFor().keyId, 1));
  const epoch = p.account.get().keyEpoch;
  p.server.failNext('DELETE', '/vault', 'network');
  assert.equal(await p.account.deleteSaved(), false);
  assert.equal(p.server.vaults.size, 1);
  assert.ok(p.server.session, 'the server session is untouched');
  const s = p.account.get();
  assert.equal(s.status, 'unlocked');
  assert.equal(s.address, p.wallet.address);
  assert.equal(s.keyEpoch, epoch, 'the key stays: the page restarts its sync');
  assert.ok(p.account.keyFor());
  assert.equal(p.cache.m.size, 1);
  assert.match(s.error, /server did not answer/);
});
