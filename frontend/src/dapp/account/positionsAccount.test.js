// Addendum C end to end with the REAL pieces: the page's one positions book
// (ui/positions.js), the page hub (ui/hub.js), the account sync
// (account/vaultSync.js) and the page's own api.js against the fake account
// server. Task 29 tests the sync with a stand-in book and Task 34 tests the book
// with a bare hub; these prove the two meet. A starting size reaches the
// ciphertext, comes back on a device with no copy of its own (no Remember, or a
// passphrase vault already moved into the account), survives a 409, and is not
// reset by a tab that saw the wallet before it unlocked.
// Keys are Wallet.createRandom() made here; nothing prints one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SigningKey, Wallet, computeAddress, getAddress, id } from 'ethers';
import * as api from '../api.js';
import { createHub } from '../ui/hub.js';
import { createPositionBook, leftOf } from '../ui/positions.js';
import { createVaultSync } from './vaultSync.js';
import { keyFromRs } from './unlockKey.js';
import { open } from './envelope.js';
import { boundApi, createFakeAccountServer } from './fakeServer.js';

const subtle = webcrypto.subtle;
const T1 = `0x${'a1'.repeat(20)}`;
const T2 = `0x${'b2'.repeat(20)}`;

function fresh(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  });
}

/** One device's wallet list in the shape of the sync's `keys` port. */
function memoryKeys() {
  const m = new Map();
  const subs = new Set();
  const emit = (type, list) => {
    if (list.length) for (const fn of [...subs]) fn({ type, addresses: list });
  };
  return {
    list: () => [...m.values()].map((w) => ({ address: w.address, privateKey: w.privateKey })),
    addresses: () => [...m.values()].map((w) => w.address),
    add(list) {
      const got = [];
      for (const x of list) {
        const address = computeAddress(new SigningKey(x.privateKey).publicKey);
        if (x.address && getAddress(x.address) !== address) throw new Error('key does not match');
        if (m.has(address.toLowerCase())) continue;
        m.set(address.toLowerCase(), { address, privateKey: x.privateKey });
        got.push(address);
      }
      emit('add', got);
      return { added: got.length, duplicates: list.length - got.length };
    },
    remove(a) {
      const w = m.get(String(a).toLowerCase());
      if (!w) return false;
      m.delete(String(a).toLowerCase());
      emit('remove', [w.address]);
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Debounce timers that never fire on their own: the tests flush. */
function heldTimers() {
  let n = 0;
  return { setTimeout: () => (n += 1), clearTimeout: () => {} };
}

/** An account with a server session and its unlock key (random key material: no wallet signs here). */
async function account() {
  const server = createFakeAccountServer();
  const owner = Wallet.createRandom().address;
  server.signInAs(owner);
  const { key, keyId } = await keyFromRs(webcrypto.getRandomValues(new Uint8Array(64)), owner, subtle);
  return { server, owner, key, keyId };
}

/**
 * One browser, wired as App wires it: a page hub, the book connected to it
 * (App's first effect), and the sync on the same hub once a key is here.
 */
function device(acct, { clock = { t: 1000 }, keys = memoryKeys(), book = null } = {}) {
  const hub = createHub();
  const b = book || createPositionBook({ storage: null, hash: id, now: () => clock.t });
  b.connect(hub);
  const timers = heldTimers();
  const start = () =>
    createVaultSync({
      api: boundApi(api, acct.server.fetch),
      owner: acct.owner,
      key: acct.key,
      keyId: acct.keyId,
      keys,
      hub,
      subtle,
      now: () => clock.t,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
  return { hub, book: b, keys, clock, start };
}

/** A row as session.view() lists it: what the book observes. */
const held = (address, tokens) => ({ address, tokens: String(tokens), inflight: '0', balanceKnown: true });

async function serverPlain(acct) {
  return open({ key: acct.key, owner: acct.owner, envelope: acct.server.vaults.get(acct.owner.toLowerCase()), subtle });
}

test('a starting size reaches the ciphertext with every field, and comes back on a device that has no copy of its own', async () => {
  const acct = await account();
  const a = device(acct);
  const [w] = fresh(1);
  const W = w.address.toLowerCase();
  a.keys.add([w]);
  a.book.observe(T1, [held(w.address, 1000)]);
  a.clock.t = 2000;
  a.book.observe(T1, [held(w.address, 0)]); // sold out: that position ended
  a.book.observe(T2, [held(w.address, 400)]);
  const sync = a.start();
  assert.equal((await sync.load()).ok, true);
  const saved = await sync.flush();
  assert.equal(saved.ok, true);
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.positions[T1][W], a.book.forToken(T1)[W], 'the ended position, as the book holds it');
  assert.equal(plain.positions[T1][W].empty, true);
  assert.equal(plain.positions[T1][W].hwm, '1000');
  assert.deepEqual(plain.positions[T2][W], a.book.forToken(T2)[W]);
  assert.equal(plain.positions[T2][W].hwm, '400');
  const sent = acct.server.bodies.join(' ').toLowerCase();
  assert.ok(!sent.includes(W.slice(2)), 'no wallet address in any body: the positions travel encrypted');

  // A second browser without Remember (or after its passphrase vault moved into
  // the account): its book starts empty, and the account is where sizes come from.
  const b = device(acct, { clock: { t: 9000 } });
  await b.start().load();
  assert.deepEqual(b.book.forToken(T2)[W], a.book.forToken(T2)[W]);
  assert.equal(leftOf(held(w.address, 100), b.book.forToken(T2)[W]).left, 0.25, 'the bar reads 25 %, not 100 %');
  assert.equal(b.book.forToken(T1)[W].empty, true);
});

test('a 409 carries both devices\' sizes through the real book: the same position keeps the higher mark, a newer one wins', async () => {
  const acct = await account();
  const a = device(acct);
  const b = device(acct, { clock: a.clock });
  const [x, y] = fresh(2);
  const X = x.address.toLowerCase();
  const Y = y.address.toLowerCase();
  a.keys.add([x, y]);
  a.book.observe(T1, [held(x.address, 1000), held(y.address, 500)]);
  const sa = a.start();
  await sa.load();
  await sa.flush(); // rev 1
  const sb = b.start();
  await sb.load(); // b holds rev 1
  a.clock.t = 2000;
  a.book.observe(T1, [held(x.address, 1500)]); // x bought more, seen on a
  await sa.flush(); // rev 2
  a.clock.t = 3000;
  b.book.observe(T1, [held(y.address, 0)]); // y sold out, seen on b
  a.clock.t = 4000;
  b.book.observe(T1, [held(y.address, 300)]); // and bought again: a new position
  const r = await sb.flush(); // 409 -> re-read -> merge -> save
  assert.equal(r.ok, true);
  const plain = await serverPlain(acct);
  assert.equal(plain.positions[T1][X].hwm, '1500', "a's higher mark survives b's save");
  assert.deepEqual(plain.positions[T1][Y], { hwm: '300', seenAt: 4000, startedAt: 4000 }, "b's newer position wins");
  assert.equal(b.book.forToken(T1)[X].hwm, '1500', 'b draws from the merged mark');
});

test('a wallet imported and seen before the account is unlocked does not reset its starting size', async () => {
  const acct = await account();
  const a = device(acct);
  const [w] = fresh(1);
  const W = w.address.toLowerCase();
  a.keys.add([w]);
  a.book.observe(T1, [held(w.address, 1000)]);
  const sa = a.start();
  await sa.load();
  await sa.flush();
  // Another browser: the visitor imports the same wallet and opens the token BEFORE
  // connecting (the account strip's banner invites exactly that). It sold to 250 since.
  const b = device(acct, { clock: { t: 5000 } });
  b.keys.add([w]);
  b.book.observe(T1, [held(w.address, 250)]);
  assert.equal(leftOf(held(w.address, 250), b.book.forToken(T1)[W]).left, 1, 'alone, this tab can only say 100 %');
  const sb = b.start();
  await sb.load();
  assert.equal(b.book.forToken(T1)[W].hwm, '1000', "the account's starting size wins over a first sighting");
  assert.equal(leftOf(held(w.address, 250), b.book.forToken(T1)[W]).left, 0.25);
  await sb.flush();
  assert.equal((await serverPlain(acct)).positions[T1][W].hwm, '1000', 'and the account keeps it');
});

test('Lock: the stopped sync tells the book to stop saving, the book is cleared, and the account keeps the sizes', async () => {
  const acct = await account();
  const a = device(acct);
  const [w] = fresh(1);
  a.keys.add([w]);
  a.book.observe(T1, [held(w.address, 10)]);
  const sa = a.start();
  await sa.load();
  await sa.flush();
  const heard = [];
  a.hub.on('positions:save', () => heard.push('save'));
  sa.stop(); // App's leaveAccount: flush, stop, then the tab's wallets and book go
  a.book.clear();
  a.book.observe(T1, [held(w.address, 99)]);
  assert.deepEqual(heard, [], 'a locked tab saves nothing to the account');
  assert.equal((await serverPlain(acct)).positions[T1][w.address.toLowerCase()].hwm, '10');
});
