import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import { NonceBook } from './nonces.js';

test('next hands out consecutive nonces from the seed', () => {
  const book = new NonceBook();
  const a = Wallet.createRandom().address;
  book.seed(a, 7);
  assert.equal(book.next(a), 7);
  assert.equal(book.next(a), 8);
  assert.equal(book.peek(a), 9);
});

test('addresses are case-insensitive', () => {
  const book = new NonceBook();
  const a = Wallet.createRandom().address;
  book.seed(a.toLowerCase(), 3);
  assert.equal(book.next(a.toUpperCase().replace('0X', '0x')), 3);
  assert.equal(book.next(a), 4);
});

test('a stale seed never moves the counter backwards', () => {
  const book = new NonceBook();
  const a = Wallet.createRandom().address;
  book.seed(a, 5);
  book.next(a);
  book.next(a); // local counter now 7; the chain may still report 5 pending
  book.seed(a, 5);
  assert.equal(book.next(a), 7);
  book.seed(a, 12); // a higher chain value wins (another tab or device sent)
  assert.equal(book.next(a), 12);
});

test('resync overwrites, including downwards, after a failed send', () => {
  const book = new NonceBook();
  const a = Wallet.createRandom().address;
  book.seed(a, 10);
  book.next(a);
  book.next(a);
  book.resync(a, 10);
  assert.equal(book.next(a), 10);
});

test('an unknown wallet and a bad nonce are refused', () => {
  const book = new NonceBook();
  const a = Wallet.createRandom().address;
  assert.throws(() => book.next(a), /no nonce known/);
  assert.throws(() => book.seed(a, -1), /non-negative/);
  assert.throws(() => book.seed(a, 1.5), /non-negative/);
  assert.equal(book.peek(a), undefined);
  book.seed(a, '4'); // the wire may carry a decimal string
  assert.equal(book.next(a), 4);
});
