import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { createPairLedger } from './pairLedger.js';

const PAIR = '0x' + '9'.repeat(40);
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

test('remembers an amount per (pair token, wallet), and forgets it at 0', () => {
  const storage = memoryStorage();
  const ledger = createPairLedger({ storage, hash: id });
  assert.equal(ledger.get(PAIR, A), 0n);
  ledger.set(PAIR, A, 1234n);
  ledger.set(PAIR, B, 5n);
  assert.equal(ledger.get(PAIR, A.toUpperCase().replace('0X', '0x')), 1234n, 'any case');
  assert.equal(ledger.get(PAIR, B), 5n);
  ledger.set(PAIR, A, 0n);
  assert.equal(ledger.get(PAIR, A), 0n);
  ledger.set(PAIR, B, 0n);
  assert.equal(storage.m.size, 0, 'an empty ledger leaves nothing behind');
});

test('stores no address in the clear — only hashes, amounts and times', () => {
  const storage = memoryStorage();
  createPairLedger({ storage, hash: id }).set(PAIR, A, 7n);
  const text = [...storage.m.values()].join('');
  assert.ok(!text.toLowerCase().includes('a'.repeat(40)), 'no wallet address');
  assert.ok(!text.toLowerCase().includes('9'.repeat(40)), 'no pair address');
});

test('entries expire after 7 days', () => {
  const storage = memoryStorage();
  let t = 1_000_000;
  const ledger = createPairLedger({ storage, hash: id, now: () => t });
  ledger.set(PAIR, A, 9n);
  t += 7 * 24 * 3600 * 1000 + 1;
  assert.equal(ledger.get(PAIR, A), 0n);
});

test('storage that throws or holds junk reads as 0 and never throws', () => {
  const broken = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceeded');
    },
    removeItem: () => {},
  };
  const ledger = createPairLedger({ storage: broken, hash: id });
  assert.doesNotThrow(() => ledger.set(PAIR, A, 1n));
  assert.equal(ledger.get(PAIR, A), 0n);
  const junk = memoryStorage();
  junk.setItem('tp.pairOwed.v1', '{"x": {"owed": "-5", "at": 1}}');
  assert.equal(createPairLedger({ storage: junk, hash: id }).get(PAIR, A), 0n);
  junk.setItem('tp.pairOwed.v1', 'not json');
  assert.equal(createPairLedger({ storage: junk, hash: id }).get(PAIR, A), 0n);
  assert.equal(createPairLedger({ storage: null, hash: id }).get(PAIR, A), 0n);
});
