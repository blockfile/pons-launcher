import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from './crc32.js';
import { crc32 as consoleCrc32 } from '../../components/xlsx.js';

test('crc32: the standard check value, and the same answers as the console copy it was taken from', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (let n = 1; n < 300; n += 37) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n) & 0xff);
    assert.equal(crc32(bytes), consoleCrc32(bytes));
  }
});
