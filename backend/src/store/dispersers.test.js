'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-dispersers-'));
process.env.HISTORY_PATH = path.join(dir, 'launches.json');
process.env.DISPERSER_ADDRESSES = '0x1111111111111111111111111111111111111111';

const { dispersersFor, _reset } = require('./dispersers');

const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';

test.beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  _reset();
});

test('an empty list falls back to DISPERSER_ADDRESSES', () => {
  const store = dispersersFor('alice');
  assert.deepEqual(store.addresses(), ['0x1111111111111111111111111111111111111111']);
  assert.equal(store.usingFallback(), true);
});

test('recorded contracts win over the env fallback outright', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A }]);

  // Not merged with the env value: a stale entry there could otherwise never
  // be removed from the console.
  assert.deepEqual(store.addresses(), [A]);
  assert.equal(store.usingFallback(), false);
});

test('the same contract cannot be listed twice', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A }]);
  store.add([{ address: A.toLowerCase() }]);

  // A duplicate would take two chunks of a split and defeat the point of
  // having several contracts.
  assert.deepEqual(store.addresses(), [A]);
});

test('users do not see each other\'s contracts', () => {
  dispersersFor('alice').add([{ address: A }]);
  dispersersFor('bob').add([{ address: B }]);

  assert.deepEqual(dispersersFor('alice').addresses(), [A]);
  assert.deepEqual(dispersersFor('bob').addresses(), [B]);
});

test('removing one leaves the rest funding', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A }, { address: B }]);
  store.remove(A);
  assert.deepEqual(store.addresses(), [B]);
});

test('removing something absent is an error, not a silent no-op', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A }]);
  assert.throws(() => store.remove(B), /is not in the list/);
});

test('a record keeps the transaction that created it', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A, txHash: '0xdead', deployer: B }]);
  const [rec] = store.records();

  assert.equal(rec.address, A);
  assert.equal(rec.txHash, '0xdead');
  assert.equal(rec.deployer, B);
  assert.ok(Date.parse(rec.deployedAt), 'deployedAt must be a real timestamp');
});

test('a corrupt file falls back rather than failing a funding run', () => {
  const store = dispersersFor('alice');
  store.add([{ address: A }]);
  fs.writeFileSync(store._path(), 'not json');
  _reset();

  assert.deepEqual(dispersersFor('alice').addresses(), ['0x1111111111111111111111111111111111111111']);
});

test('the list survives a reload', () => {
  dispersersFor('alice').add([{ address: A }]);
  _reset();
  assert.deepEqual(dispersersFor('alice').addresses(), [A]);
});
