import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { looksLikeKey } from './keyGuard.js';

test('a private key, with or without 0x and around whitespace, looks like a key; an address does not', () => {
  const key = Wallet.createRandom().privateKey; // generated here, never stored
  assert.equal(looksLikeKey(key), true);
  assert.equal(looksLikeKey(key.slice(2)), true);
  assert.equal(looksLikeKey(`  ${key}  `), true);
  assert.equal(looksLikeKey('0x' + 'a'.repeat(40)), false);
  assert.equal(looksLikeKey('0x' + 'a'.repeat(63)), false);
  assert.equal(looksLikeKey(''), false);
  assert.equal(looksLikeKey(undefined), false);
});
