import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SigningKey, Wallet, computeAddress, getAddress } from 'ethers';
import * as api from '../api.js';
import { addWallets, addresses, clearWallets, removeWallet } from '../keys/walletStore.js';
import { createHub } from '../ui/hub.js';
import { createVaultSync, DEBOUNCE_MS, MAX_HOLD_MS, MAX_WAIT_MS, MIN_SAVE_GAP_MS } from './vaultSync.js';
import { keyFromRs } from './unlockKey.js';
import { MAX_CT_BYTES, fromB64, open } from './envelope.js';
import { boundApi, createFakeAccountServer } from './fakeServer.js';

const subtle = webcrypto.subtle;
const T1 = `0x${'a1'.repeat(20)}`;
const T2 = `0x${'b2'.repeat(20)}`;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const low = (w) => w.address.toLowerCase();

function fresh(n) {
  return Array.from({ length: n }, () => {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  });
}

/** One device's walletStore stand-in (two devices cannot share the real module). Same events as walletStore. */
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
      const ws = list.map((x) => {
        const address = computeAddress(new SigningKey(x.privateKey).publicKey);
        if (x.address && getAddress(x.address) !== address) throw new Error('key does not match');
        return { address, privateKey: x.privateKey };
      });
      const got = [];
      const again = [];
      for (const w of ws) {
        if (m.has(w.address.toLowerCase())) {
          again.push(w.address);
          continue;
        }
        m.set(w.address.toLowerCase(), w);
        got.push(w.address);
      }
      emit('add', got);
      emit('duplicate', again);
      return { added: got.length, duplicates: again.length };
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

/**
 * A stand-in for Task 34's positions book (ui/positions.js): the hub protocol
 * only. It saves its records while attached, answers 'account:positions' with
 * what it holds, and records what it heard.
 */
function standInBook(hub) {
  const b = { held: {}, got: [], heard: [], attached: false };
  hub.on('account:positions', (d) => {
    b.heard.push('positions');
    b.got.push(d.positions);
    b.attached = true;
    if (Object.keys(b.held).length) hub.emit('positions:save', { positions: b.held });
  });
  hub.on('account:locked', () => {
    b.heard.push('locked');
    b.attached = false;
  });
  b.save = (positions) => {
    b.held = positions;
    if (b.attached) hub.emit('positions:save', { positions });
  };
  return b;
}

function fakeTimers() {
  const q = [];
  let id = 0;
  return {
    q,
    setTimeout: (fn, ms) => {
      id += 1;
      q.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (x) => {
      const i = q.findIndex((t) => t.id === x);
      if (i >= 0) q.splice(i, 1);
    },
    /** Fire every queued timer (and any they queue), in order. */
    runAll() {
      let n = 0;
      while (q.length && n < 50) {
        q.shift().fn();
        n += 1;
      }
    },
  };
}

/** Timers on a virtual clock: until(to) moves time forward, firing what falls due in order. */
function fakeClock(start = 1000) {
  const q = [];
  let t = start;
  let id = 0;
  return {
    q,
    now: () => t,
    setTimeout: (fn, ms) => {
      id += 1;
      q.push({ id, fn, ms, at: t + ms });
      return id;
    },
    clearTimeout: (x) => {
      const i = q.findIndex((e) => e.id === x);
      if (i >= 0) q.splice(i, 1);
    },
    async until(to, settle) {
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!q.length || q[0].at > to) break;
        const next = q.shift();
        t = Math.max(t, next.at);
        next.fn();
        await settle();
      }
      t = Math.max(t, to);
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
// At least `max` turns of the event loop AND at least 5 s: WebCrypto answers on the
// thread pool, which a busy machine (the whole suite in parallel) can hold up.
async function until(pred, max = 400) {
  const deadline = Date.now() + 5000;
  for (let i = 0; i < max || Date.now() < deadline; i += 1) {
    if (pred()) return;
    await tick();
  }
  throw new Error('condition never became true');
}

/** An account with a server session and its unlock key (random key material: no wallet signs here). */
async function account(server = createFakeAccountServer()) {
  const owner = Wallet.createRandom().address;
  server.signInAs(owner);
  const { key, keyId } = await keyFromRs(webcrypto.getRandomValues(new Uint8Array(64)), owner, subtle);
  return { server, owner, key, keyId };
}

function device(acct, { keys = memoryKeys(), hub = createHub(), now = () => 1000, fetch, timers = fakeTimers(), doc } = {}) {
  const statuses = [];
  const applied = [];
  const book = hub ? standInBook(hub) : null;
  const sync = createVaultSync({
    api: boundApi(api, fetch || acct.server.fetch),
    owner: acct.owner,
    key: acct.key,
    keyId: acct.keyId,
    keys,
    hub,
    subtle,
    now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    document: doc,
    onStatus: (s) => statuses.push(s),
    onApplied: (r) => applied.push(r),
  });
  return { sync, keys, hub, book, timers, statuses, applied, last: () => statuses[statuses.length - 1] };
}

const puts = (server) => server.log.filter((l) => l.method === 'PUT').length;
const holds = (d, w) => d.keys.addresses().includes(w.address);

async function serverPlain(acct) {
  return open({ key: acct.key, owner: acct.owner, envelope: acct.server.vaults.get(acct.owner.toLowerCase()), subtle });
}

test('no copy yet: load creates it at once (baseRev 0) with the tab wallets and positions, encrypted', async () => {
  const acct = await account();
  const d = device(acct);
  const list = fresh(2);
  d.keys.add(list);
  const P = { [T1]: { [low(list[0])]: { hwm: '5', seenAt: 1000, startedAt: 1000 } } };
  d.book.held = P; // the book knew this before the unlock
  const r = await d.sync.load();
  assert.equal(r.ok, true);
  assert.deepEqual(d.book.heard, ['positions'], 'the book was told to save to the account');
  assert.equal(d.timers.q.length, 1);
  assert.equal(d.timers.q[0].ms, 0, 'the creating save is not debounced');
  d.timers.runAll();
  await until(() => d.last().state === 'saved' && d.last().rev === 1);
  const rec = acct.server.vaults.get(acct.owner.toLowerCase());
  assert.equal(rec.rev, 1);
  assert.equal(rec.keyId, acct.keyId);
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.wallets.map((w) => w.address).sort(), list.map((w) => w.address).sort());
  for (const w of plain.wallets) assert.match(w.tags.join(' '), /^[0-9a-f]{16}$/, 'one import tag each');
  assert.deepEqual(plain.removed, {});
  assert.deepEqual(plain.positions, P);
  const sent = acct.server.bodies.join(' ').toLowerCase();
  for (const w of list) {
    assert.ok(!sent.includes(w.privateKey.slice(2).toLowerCase()), 'no key in any body');
    assert.ok(!sent.includes(w.address.slice(2).toLowerCase()), 'no wallet address in any body');
  }
  assert.ok(!sent.includes(Buffer.from(JSON.stringify(plain)).toString('base64').slice(0, 40).toLowerCase()), 'no plaintext base64');
});

test('another device loads the copy: the wallets and positions arrive, and nothing is saved back when nothing differs', async () => {
  const acct = await account();
  const a = device(acct);
  const list = fresh(3);
  a.keys.add(list);
  const P = { [T1]: { [low(list[1])]: { hwm: '9', seenAt: 1000, startedAt: 1000 } } };
  a.book.held = P;
  await a.sync.load();
  a.timers.runAll();
  await until(() => a.last().rev === 1);
  const b = device(acct);
  const r = await b.sync.load();
  assert.equal(r.ok, true);
  assert.deepEqual(b.keys.addresses().sort(), list.map((w) => w.address).sort());
  assert.deepEqual(b.book.got, [P], "the account's positions reach this device's book");
  assert.deepEqual(b.applied, [{ added: 3, removed: 0, unreadable: 0 }]);
  assert.equal(b.timers.q.length, 0, 'nothing to save: no save is even scheduled');
  assert.equal(b.last().state, 'saved');
  const before = puts(acct.server);
  await b.sync.flush();
  assert.equal(puts(acct.server), before, 'no PUT: the tab holds exactly the copy');
});

test('a tab that holds wallets the copy lacks saves them after the load, debounced; one the copy has keeps its import', async () => {
  const acct = await account();
  const a = device(acct);
  const [shared, extra] = fresh(2);
  a.keys.add([shared]);
  await a.sync.load();
  await a.sync.flush();
  const tagBefore = (await serverPlain(acct)).wallets[0].tags;
  const early = memoryKeys();
  early.add([shared, extra]); // imported before the account was unlocked
  const b = device(acct, { keys: early });
  await b.sync.load();
  assert.deepEqual(b.timers.q.map((t) => t.ms), [DEBOUNCE_MS]);
  b.timers.runAll();
  await until(() => b.last().rev === 2);
  const plain = await serverPlain(acct);
  assert.equal(plain.wallets.length, 2);
  assert.deepEqual(plain.wallets.find((w) => w.address === shared.address).tags, tagBefore, 'the copy had it already: the same import');
  assert.equal(b.keys.addresses().length, 2);
});

test('changes within the debounce make ONE save; flush saves at once and returns the new revision', async () => {
  const acct = await account();
  let t = 1000;
  const d = device(acct, { now: () => t });
  await d.sync.load();
  d.timers.runAll();
  await until(() => d.last().rev === 1);
  t += MIN_SAVE_GAP_MS; // the pacing gap after the creating save is over: the debounce alone
  for (const w of fresh(3)) d.keys.add([w]);
  assert.equal(d.timers.q.length, 1, 'one pending save');
  assert.equal(d.timers.q[0].ms, DEBOUNCE_MS);
  assert.equal(d.last().state, 'pending');
  const before = puts(acct.server);
  const r = await d.sync.flush();
  assert.deepEqual(r, { ok: true, rev: 2, code: '', error: '' });
  assert.equal(puts(acct.server) - before, 1);
  assert.equal(d.timers.q.length, 0, 'the debounced save was replaced by the flush');
  assert.equal((await serverPlain(acct)).wallets.length, 3);
});

test('a removal travels as a tombstone naming the import it saw; importing the wallet again brings it back', async () => {
  const acct = await account();
  let t = 1000;
  const now = () => t;
  const a = device(acct, { now });
  const b = device(acct, { now });
  const [w1, w2] = fresh(2);
  a.keys.add([w1, w2]);
  await a.sync.load();
  await a.sync.flush();
  await b.sync.load();
  assert.equal(b.keys.addresses().length, 2);
  const first = (await serverPlain(acct)).wallets.find((x) => x.address === w1.address).tags;
  t = 2000;
  a.keys.remove(w1.address);
  await a.sync.flush();
  const afterRemove = await serverPlain(acct);
  assert.deepEqual(afterRemove.removed, { [low(w1)]: { at: 2000, tags: first } });
  assert.deepEqual(afterRemove.wallets.map((x) => x.address), [w2.address]);
  // b still holds rev 1. Its next save conflicts, re-reads, and drops w1: the removal had seen b's import of it.
  t = 3000;
  const [w3] = fresh(1);
  b.keys.add([w3]);
  const r = await b.sync.flush();
  assert.equal(r.ok, true);
  assert.deepEqual(b.keys.addresses().map((x) => x.toLowerCase()).sort(), [low(w2), low(w3)].sort());
  assert.deepEqual(b.applied[b.applied.length - 1], { added: 0, removed: 1, unreadable: 0 });
  // Importing it again is a new import: the tombstone does not name it.
  t = 4000;
  a.keys.add([w1]);
  await a.sync.flush();
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.wallets.map((x) => low(x)).sort(), [w1, w2, w3].map(low).sort());
  const again = plain.wallets.find((x) => x.address === w1.address).tags;
  assert.equal(again.length, 1);
  assert.notDeepEqual(again, first);
  assert.deepEqual(Object.keys(plain.removed), [low(w1)], 'the tombstone stays, naming the old import only');
  b.keys.add(fresh(1));
  await b.sync.flush();
  assert.ok(holds(b, w1), 'b takes it back on its next read');
});

test('no clock decides: a removal stamped by a clock 10 h ahead cannot drop a later import on another device', async () => {
  const acct = await account();
  const HOUR = 3600000;
  let real = 1000;
  const a = device(acct, { now: () => real + 10 * HOUR }); // this device's clock runs 10 h ahead
  const b = device(acct, { now: () => real });
  const [w, x, y, z] = fresh(4);
  a.keys.add([w]);
  await a.sync.load();
  await a.sync.flush();
  await b.sync.load();
  real = 2000;
  a.keys.remove(w.address); // a tombstone dated 10 h in the future
  await a.sync.flush();
  real = 3000;
  b.keys.add([x]);
  await b.sync.flush(); // b reads the removal and lets w go
  assert.ok(!holds(b, w));
  real = 4000;
  b.keys.add([w]); // later, b imports w again
  await b.sync.flush();
  real = 5000;
  a.keys.add([y]);
  await a.sync.flush(); // a reads b's import
  real = 6000;
  b.keys.add([z]);
  await b.sync.flush(); // and b reads a's copy again
  assert.ok(holds(b, w), 'b keeps the key it imported');
  assert.ok(holds(a, w), 'a takes it back');
  assert.ok((await serverPlain(acct)).wallets.some((v) => v.address === w.address), 'the copy holds it');
});

test('an import made without having seen a removal survives it: a re-import, and a wallet held before unlocking', async () => {
  const acct = await account();
  const a = device(acct);
  const b = device(acct);
  const [w, v] = fresh(2);
  a.keys.add([w, v]);
  await a.sync.load();
  await a.sync.flush();
  await b.sync.load(); // b holds w and v: the copy's imports of them
  a.keys.remove(w.address);
  a.keys.remove(v.address);
  await a.sync.flush();
  b.keys.add([w]); // not having read that, b imports w again: already listed, still a new import
  const r = await b.sync.flush(); // 409: b reads both removals
  assert.equal(r.ok, true);
  assert.ok(holds(b, w), 'imported again: kept');
  assert.ok(!holds(b, v), 'not imported again: removed, as a asked');
  const early = memoryKeys();
  early.add([v]); // imported before this tab unlocked the account: in the store when the sync starts
  const c = device(acct, { keys: early });
  await c.sync.load();
  assert.ok(holds(c, v), 'held before the first read: kept');
  await c.sync.flush();
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.wallets.map(low).sort(), [low(w), low(v)].sort());
});

test('a conflict merges both sides instead of overwriting either', async () => {
  const acct = await account();
  const a = device(acct);
  const b = device(acct);
  await a.sync.load();
  await a.sync.flush();
  await b.sync.load();
  const [x, y] = fresh(2);
  a.keys.add([x]);
  b.keys.add([y]);
  await a.sync.flush();
  await b.sync.flush(); // 409, re-read, merge, save
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.wallets.map((w) => w.address).sort(), [x.address, y.address].sort());
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 3);
});

test("positions: a 409 merges the books record by record with the book's rule, records unchanged", async () => {
  const acct = await account();
  const a = device(acct);
  const b = device(acct);
  await a.sync.load();
  await a.sync.flush();
  await b.sync.load();
  const WA = addr(0xaa);
  const WB = addr(0xbb);
  a.book.save({ [T1]: { [WA]: { hwm: '100', seenAt: 10, startedAt: 10 }, [WB]: { hwm: '900', seenAt: 5, startedAt: 5 } } });
  b.book.save({ [T1]: { [WB]: { hwm: '20', seenAt: 30, startedAt: 30, empty: true } }, [T2]: { [WA]: { hwm: '7', seenAt: 40, note: 'kept' } } });
  await a.sync.flush();
  await b.sync.flush(); // 409, re-read, merge, save
  const merged = {
    [T1]: { [WA]: { hwm: '100', seenAt: 10, startedAt: 10 }, [WB]: { empty: true, hwm: '20', seenAt: 30, startedAt: 30 } },
    [T2]: { [WA]: { hwm: '7', note: 'kept', seenAt: 40 } },
  };
  assert.deepEqual((await serverPlain(acct)).positions, merged, 'the later position wins; unknown fields travel');
  assert.deepEqual(b.book.got[b.book.got.length - 1], merged, "b's book hears a's records after the re-read");
});

test('without a hub the copy keeps the positions it has', async () => {
  const acct = await account();
  const a = device(acct);
  const P = { [T1]: { [addr(0xaa)]: { hwm: '3', seenAt: 1, startedAt: 1 } } };
  a.book.held = P;
  await a.sync.load();
  a.timers.runAll();
  await until(() => a.last().rev === 1);
  const b = device(acct, { hub: null });
  await b.sync.load();
  b.keys.add(fresh(1));
  await b.sync.flush();
  const plain = await serverPlain(acct);
  assert.equal(plain.wallets.length, 1);
  assert.deepEqual(plain.positions, P);
});

test('a copy that would pass the size cap leaves out the least recently seen tokens, never a wallet', async () => {
  const acct = await account();
  const d = device(acct);
  const list = fresh(3);
  d.keys.add(list);
  const big = {};
  for (let i = 0; i < 20; i += 1) {
    const group = {};
    for (let j = 0; j < 150; j += 1) group[addr(0x100000 + i * 1000 + j)] = { hwm: '1000000000000000000000', seenAt: 1000 + i, startedAt: 1000 + i };
    big[addr(0x9000 + i)] = group;
  }
  d.book.held = big; // about 320 KB of positions: more than the copy can hold
  await d.sync.load();
  d.timers.runAll();
  await until(() => d.last().rev === 1);
  const plain = await serverPlain(acct);
  assert.equal(plain.wallets.length, 3, 'every wallet is in the copy');
  const kept = Object.keys(plain.positions);
  assert.ok(kept.length > 10 && kept.length < 20, `${kept.length} tokens kept`);
  assert.ok(!kept.includes(addr(0x9000)), 'the least recently seen token went first');
  assert.ok(kept.includes(addr(0x9000 + 19)), 'the most recent stayed');
  assert.ok(fromB64(acct.server.vaults.get(acct.owner.toLowerCase()).ct).length <= MAX_CT_BYTES);
  const before = puts(acct.server);
  await d.sync.flush();
  assert.equal(puts(acct.server), before, 'the trimmed copy is what this tab would save: no PUT again');
});

test('a copy under another keyId, or one that does not decrypt, blocks saving: it is never overwritten', async () => {
  for (const damage of ['keyId', 'ct']) {
    const acct = await account();
    const a = device(acct);
    a.keys.add(fresh(1));
    await a.sync.load();
    await a.sync.flush();
    const rec = acct.server.vaults.get(acct.owner.toLowerCase());
    if (damage === 'keyId') rec.keyId = `0x${'ee'.repeat(16)}`;
    else rec.ct = Buffer.from(Buffer.from(rec.ct, 'base64').map((byte, i) => (i === 5 ? byte ^ 1 : byte))).toString('base64');
    const snapshot = JSON.stringify(rec);
    const b = device(acct);
    b.keys.add(fresh(1));
    const r = await b.sync.load();
    assert.equal(r.ok, false);
    assert.equal(b.last().state, 'blocked');
    assert.equal(b.last().code, damage === 'keyId' ? 'key_mismatch' : 'undecryptable');
    assert.deepEqual(b.book.heard, ['locked'], 'the book is told not to save here');
    b.keys.add(fresh(1));
    b.hub.emit('positions:save', { positions: { [T1]: { [addr(0xaa)]: { hwm: '1', seenAt: 1 } } } });
    assert.equal(b.timers.q.length, 0, 'a blocked sync schedules nothing');
    assert.equal((await b.sync.flush()).ok, false);
    assert.equal(JSON.stringify(acct.server.vaults.get(acct.owner.toLowerCase())), snapshot, 'the copy is untouched');
  }
});

test('a network failure retries with backoff; a 401 waits for retry() after a new sign-in', async () => {
  const acct = await account();
  const d = device(acct);
  await d.sync.load();
  await d.sync.flush();
  acct.server.failNext('PUT', '/vault', 'network');
  d.keys.add(fresh(1));
  const r = await d.sync.flush();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'network');
  assert.equal(d.last().state, 'error');
  assert.deepEqual(d.timers.q.map((t) => t.ms), [5000]);
  d.timers.runAll();
  await until(() => d.last().state === 'saved');
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 2);
  acct.server.expireSession();
  d.keys.add(fresh(1));
  const r2 = await d.sync.flush();
  assert.equal(r2.code, 'no_session');
  assert.match(r2.error, /Sign in again/);
  assert.equal(d.timers.q.length, 0, 'no automatic retry without a session');
  acct.server.signInAs(acct.owner);
  assert.equal((await d.sync.retry()).ok, true);
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 3);
});

test('saves are paced: at most one scheduled save per MIN_SAVE_GAP_MS, and a steady stream of changes still saves by MAX_WAIT_MS', async () => {
  const acct = await account();
  const clock = fakeClock(1000);
  const putsAt = [];
  const fetch = (url, init) => {
    if (init && init.method === 'PUT') putsAt.push(clock.now());
    return acct.server.fetch(url, init);
  };
  const d = device(acct, { now: clock.now, timers: clock, fetch });
  const settle = () => until(() => !['pending', 'saving', 'loading'].includes(d.last().state));
  await d.sync.load();
  await clock.until(1000, settle);
  assert.deepEqual(putsAt, [1000], 'the creating save goes at once');
  // a change 1 s after a save waits out the gap, not just the 5 s debounce
  await clock.until(2000, settle);
  d.keys.add(fresh(1));
  assert.deepEqual(clock.q.map((e) => e.at), [1000 + MIN_SAVE_GAP_MS]);
  await clock.until(1000 + MIN_SAVE_GAP_MS, settle);
  assert.deepEqual(putsAt, [1000, 1000 + MIN_SAVE_GAP_MS]);
  // a change every 6 s for a minute: saves never closer than the gap, at most 6 in the minute
  const start = clock.now();
  for (let i = 1; i <= 10; i += 1) {
    await clock.until(start + i * 6000, settle);
    d.keys.add(fresh(1));
  }
  await clock.until(start + 60000 + MAX_WAIT_MS, settle);
  for (let i = 1; i < putsAt.length; i += 1) assert.ok(putsAt[i] - putsAt[i - 1] >= MIN_SAVE_GAP_MS, `PUTs at ${putsAt.join(', ')}`);
  assert.ok(putsAt.filter((x) => x > start && x <= start + 60000).length <= 6, `PUTs at ${putsAt.join(', ')}`);
  // a change every second for a minute (faster than the debounce): saved every MAX_WAIT_MS, not starved
  const before = putsAt.length;
  const s0 = clock.now();
  for (let i = 1; i <= 60; i += 1) {
    d.keys.add(fresh(1));
    await clock.until(s0 + i * 1000, settle);
  }
  assert.deepEqual(putsAt.slice(before).map((x) => x - s0), [MAX_WAIT_MS, 2 * MAX_WAIT_MS]);
  assert.equal((await serverPlain(acct)).wallets.length, 1 + 10 + 60, 'every change reached the copy');
  d.sync.stop();
});

test('a 429 waits out its Retry-After; unavailable and the bodiless 429 / 502 of a proxy are retried too', async () => {
  const acct = await account();
  let t = 1000;
  const d = device(acct, { now: () => t });
  await d.sync.load();
  await d.sync.flush();
  acct.server.failNext('PUT', '/vault', 429, { retryAfter: 42 });
  d.keys.add(fresh(1));
  const r = await d.sync.flush();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rate_limited');
  assert.match(r.error, /tries again by itself/);
  assert.equal(d.last().state, 'error');
  assert.deepEqual(d.timers.q.map((e) => e.ms), [42000], 'the Retry-After, not the 5 s backoff');
  t += 20000;
  d.keys.add(fresh(1)); // a change inside the hold
  assert.deepEqual(d.timers.q.map((e) => e.ms), [42000, 22000], 'the debounced save waits for the hold too');
  d.timers.runAll();
  await until(() => d.last().state === 'saved');
  await d.sync.flush();
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 2);
  t += 60000; // the hold is over
  const cases = [
    [503, {}, 'unavailable'],
    [429, { proxy: true }, 'rate_limited'], // nginx limit_req: no JSON, no Retry-After
    [502, { proxy: true }, 'unavailable'], // the backend is restarting
  ];
  for (const [status, opts, code] of cases) {
    acct.server.failNext('PUT', '/vault', status, opts);
    d.keys.add(fresh(1));
    const bad = await d.sync.flush();
    assert.equal(bad.code, code, `${status} ${JSON.stringify(opts)}`);
    assert.deepEqual(d.timers.q.map((e) => e.ms), [5000], `${status} is retried after the backoff`);
    d.timers.runAll();
    await until(() => d.last().state === 'saved');
    await d.sync.flush();
  }
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 5);
  assert.equal((await serverPlain(acct)).wallets.length, 5);
});

test("the visitor's Retry goes at once, Retry-After or not; a huge Retry-After is capped", async () => {
  const acct = await account();
  const d = device(acct);
  await d.sync.load();
  await d.sync.flush();
  acct.server.failNext('PUT', '/vault', 429, { retryAfter: 999999 });
  d.keys.add(fresh(1));
  assert.equal((await d.sync.flush()).code, 'rate_limited');
  assert.deepEqual(d.timers.q.map((e) => e.ms), [MAX_HOLD_MS]);
  const r = await d.sync.retry();
  assert.equal(r.ok, true);
  assert.equal(d.timers.q.length, 0, 'the retry timer is gone');
  assert.equal(acct.server.vaults.get(acct.owner.toLowerCase()).rev, 2);
});

test('a page going hidden saves its pending change at once, unless the server asked to wait; stop() stops listening', async () => {
  const acct = await account();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const d = device(acct, { doc });
  await d.sync.load();
  await d.sync.flush();
  d.keys.add(fresh(1));
  assert.equal(d.timers.q.length, 1, 'a paced save is pending');
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(d.timers.q.length, 1, 'still visible: nothing changes');
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(d.timers.q.length, 0, 'the timer gave way to a save now');
  await until(() => d.last().state === 'saved' && d.last().rev === 2);
  doc.visibilityState = 'visible';
  acct.server.failNext('PUT', '/vault', 429, { retryAfter: 30 });
  d.keys.add(fresh(1));
  await d.sync.flush();
  d.keys.add(fresh(1));
  const queued = d.timers.q.length;
  doc.visibilityState = 'hidden';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(d.timers.q.length, queued, 'inside a Retry-After the page waits, hidden or not');
  d.sync.stop();
  const before = puts(acct.server);
  doc.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(puts(acct.server), before, 'a stopped sync does not listen');
});

test('stop() stops listening and tells the book to stop saving here: later changes schedule nothing', async () => {
  const acct = await account();
  const d = device(acct);
  await d.sync.load();
  await d.sync.flush();
  d.sync.stop();
  assert.deepEqual(d.book.heard, ['positions', 'locked']);
  d.keys.add(fresh(1));
  d.hub.emit('positions:save', { positions: { [T1]: { [addr(0xaa)]: { hwm: '1', seenAt: 1 } } } });
  assert.equal(d.timers.q.length, 0);
  assert.equal((await d.sync.flush()).ok, false);
});

test('with the real walletStore: an import, a re-import, a removal and a Clear reach the account copy', async () => {
  clearWallets();
  const acct = await account();
  const timers = fakeTimers();
  const sync = createVaultSync({
    api: boundApi(api, acct.server.fetch),
    owner: acct.owner,
    key: acct.key,
    keyId: acct.keyId,
    subtle,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await sync.load();
  const list = fresh(2);
  addWallets(list);
  await sync.flush();
  const saved = await serverPlain(acct);
  assert.equal(saved.wallets.length, 2);
  const tagOf = (plain, w) => plain.wallets.find((x) => x.address === w.address).tags;
  const before = tagOf(saved, list[1]);
  assert.deepEqual(addWallets([list[1]]), { added: 0, duplicates: 1 }); // imported again
  await sync.flush();
  const after = tagOf(await serverPlain(acct), list[1]);
  assert.notDeepEqual(after, before, 'a re-import is a new import');
  removeWallet(list[0].address);
  await sync.flush();
  assert.deepEqual((await serverPlain(acct)).wallets.map((w) => w.address), [list[1].address]);
  clearWallets();
  await sync.flush();
  const plain = await serverPlain(acct);
  assert.deepEqual(plain.wallets, []);
  assert.deepEqual(Object.keys(plain.removed).sort(), list.map(low).sort());
  assert.deepEqual(plain.removed[low(list[1])].tags, after, 'the Clear named the import this tab held');
  sync.stop();
  assert.deepEqual(addresses(), []);
});
