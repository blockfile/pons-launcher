import test from 'node:test';
import assert from 'node:assert/strict';

import { V4_XLSX_HEADER, v4XlsxRows } from './backupRows.js';

const funder = {
  address: '0xF0000000000000000000000000000000000000F1',
  privateKey: '0xkey-funder',
  role: 'v4master',
  fundedAt: null,
  daysSinceFunded: null,
};
const agedSeed = {
  address: '0x5EED00000000000000000000000000000000AA01',
  privateKey: '0xkey-seed',
  role: 'v4seed',
  fundedAt: '2026-09-10T08:30:00.000Z',
  daysSinceFunded: 7,
};
const freshSeed = {
  address: '0x5EED00000000000000000000000000000000AA02',
  privateKey: '0xkey-fresh',
  role: 'v4seed',
  fundedAt: null,
  daysSinceFunded: null,
};

test('the sheet leads with the public address and private key, like the V2 export', () => {
  assert.deepEqual(V4_XLSX_HEADER, ['Public address', 'Private key', 'Type', 'Funded at', 'Days since funded']);
  assert.deepEqual(v4XlsxRows([])[0], V4_XLSX_HEADER);
});

test('each wallet is one row: address, key, type, funding date, age — in that order', () => {
  const [, f, s] = v4XlsxRows([funder, agedSeed]);
  assert.deepEqual(f, ['0xF0000000000000000000000000000000000000F1', '0xkey-funder', 'funding', '', '']);
  assert.deepEqual(s, ['0x5EED00000000000000000000000000000000AA01', '0xkey-seed', 'seed', '2026-09-10T08:30:00.000Z', '7']);
});

test('an unfunded seed has blank funding columns, never "null" or 0', () => {
  const [, row] = v4XlsxRows([freshSeed]);
  assert.deepEqual(row.slice(2), ['seed', '', '']);
});

test('every cell is a string, so the XLSX writer stores it as text', () => {
  for (const row of v4XlsxRows([funder, agedSeed, freshSeed])) {
    for (const cell of row) assert.equal(typeof cell, 'string');
  }
});
