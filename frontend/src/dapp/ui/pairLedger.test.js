import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { createPairLedger } from './pairLedger.js';

const PAIR = '0x' + '9'.repeat(40);
const PAIR2 = '0x' + '8'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function memoryStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test('remembers an amount per (pair token, wallet) with its nonce and expected balance, and forgets it at 0', () => {
  const storage = memoryStorage();
  const ledger = createPairLedger({ storage, hash: id });
  assert.equal(ledger.get(PAIR, A), null);
  ledger.set(PAIR, A, 1234n, { nonce: 7, bal: 2234n });
  ledger.set(PAIR, B, 5n, { nonce: 1, bal: 5n });
  assert.deepEqual(ledger.get(PAIR, A.toUpperCase().replace('0X', '0x')), { owed: 1234n, nonce: 7, bal: 2234n }, 'any case');
  assert.deepEqual(ledger.get(PAIR, B), { owed: 5n, nonce: 1, bal: 5n });
  ledger.set(PAIR, A, 0n);
  assert.equal(ledger.get(PAIR, A), null);
  ledger.set(PAIR, B, 0n);
  assert.equal(storage.m.size, 0, 'an empty ledger leaves nothing behind');
});

test('an entry without a nonce or balance reads them as null (the session then cannot vouch for it)', () => {
  const ledger = createPairLedger({ storage: memoryStorage(), hash: id });
  ledger.set(PAIR, A, 9n);
  assert.deepEqual(ledger.get(PAIR, A), { owed: 9n, nonce: null, bal: null });
});

test("touch moves the nonce of every entry of that wallet, whatever the pair token, and no one else's", () => {
  const ledger = createPairLedger({ storage: memoryStorage(), hash: id });
  ledger.set(PAIR, A, 10n, { nonce: 3, bal: 10n });
  ledger.set(PAIR2, A, 20n, { nonce: 3, bal: 20n });
  ledger.set(PAIR, B, 30n, { nonce: 3, bal: 30n });
  ledger.touch([{ address: A, nonce: 9 }]);
  assert.equal(ledger.get(PAIR, A).nonce, 9);
  assert.equal(ledger.get(PAIR2, A).nonce, 9);
  assert.equal(ledger.get(PAIR, B).nonce, 3);
  ledger.touch([{ address: B, nonce: 2 }]);
  assert.equal(ledger.get(PAIR, B).nonce, 2, 'a resync may move it down');
});

test('stores no address in the clear — only hashes, amounts and times', () => {
  const storage = memoryStorage();
  createPairLedger({ storage, hash: id }).set(PAIR, A, 7n, { nonce: 1, bal: 7n });
  const text = [...storage.m.values()].join('');
  assert.ok(!text.toLowerCase().includes('a'.repeat(40)), 'no wallet address');
  assert.ok(!text.toLowerCase().includes('9'.repeat(40)), 'no pair address');
});

test('without Remember the ledger lives in memory only, and removes a copy an earlier visit left', () => {
  const storage = memoryStorage();
  let remember = true;
  const earlier = createPairLedger({ storage, hash: id, persist: () => remember });
  earlier.set(PAIR, B, 3n, { nonce: 0, bal: 3n });
  assert.equal(storage.m.size, 1, 'Remember on: kept on the device');

  remember = false;
  const ledger = createPairLedger({ storage, hash: id, persist: () => remember });
  assert.equal(ledger.get(PAIR, B), null, 'a stored copy is not read without Remember');
  ledger.set(PAIR, A, 11n, { nonce: 2, bal: 11n });
  assert.deepEqual(ledger.get(PAIR, A), { owed: 11n, nonce: 2, bal: 11n }, 'this page still remembers it');
  assert.equal(storage.m.size, 0, 'nothing readable stays on the device');

  remember = true; // the visitor saves the wallets: the memory entries go to the device on the next write
  ledger.set(PAIR, B, 4n, { nonce: 0, bal: 4n });
  const again = createPairLedger({ storage, hash: id, persist: () => true });
  assert.equal(again.get(PAIR, A).owed, 11n);
  assert.equal(again.get(PAIR, B).owed, 4n);
});

test('clear forgets everything, in memory and on the device', () => {
  const storage = memoryStorage();
  const ledger = createPairLedger({ storage, hash: id });
  ledger.set(PAIR, A, 1n, { nonce: 0, bal: 1n });
  ledger.clear();
  assert.equal(ledger.get(PAIR, A), null);
  assert.equal(storage.m.size, 0);
  assert.equal(createPairLedger({ storage, hash: id }).get(PAIR, A), null);
});

test('entries expire after 7 days', () => {
  const storage = memoryStorage();
  let t = 1_000_000;
  const ledger = createPairLedger({ storage, hash: id, now: () => t });
  ledger.set(PAIR, A, 9n, { nonce: 0, bal: 9n });
  t += 7 * 24 * 3600 * 1000 + 1;
  assert.equal(ledger.get(PAIR, A), null);
});

test('storage that throws or holds junk reads as nothing and never throws', () => {
  const broken = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  };
  const ledger = createPairLedger({ storage: broken, hash: id });
  assert.doesNotThrow(() => ledger.set(PAIR, A, 1n, { nonce: 0, bal: 1n }));
  assert.doesNotThrow(() => ledger.touch([{ address: A, nonce: 1 }]));
  assert.doesNotThrow(() => ledger.clear());
  const junk = memoryStorage();
  junk.setItem('tp.pairOwed.v1', '{"x": {"owed": "-5", "at": 1}}');
  assert.equal(createPairLedger({ storage: junk, hash: id }).get(PAIR, A), null);
  junk.setItem('tp.pairOwed.v1', 'not json');
  assert.equal(createPairLedger({ storage: junk, hash: id }).get(PAIR, A), null);
  assert.equal(createPairLedger({ storage: null, hash: id }).get(PAIR, A), null);
  const throwing = createPairLedger({
    storage: memoryStorage(),
    hash: id,
    persist: () => {
      throw new Error('no vault check');
    },
  });
  throwing.set(PAIR, A, 2n, { nonce: 0, bal: 2n });
  assert.equal(throwing.get(PAIR, A).owed, 2n, 'a persist check that throws keeps it in memory');
});
