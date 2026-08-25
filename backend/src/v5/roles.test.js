'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const roles = require('./roles');

function ks(wallets = []) {
  return {
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
}

const V5 = [
  { id: 'd1', role: 'v5dev', address: '0x0000000000000000000000000000000000000001' },
  { id: 'b1', role: 'v5bundle', address: '0x0000000000000000000000000000000000000002' },
  { id: 'b2', role: 'v5bundle', address: '0x0000000000000000000000000000000000000003' },
];

// Every role owned by another strategy. If a v5 lookup returns one of these,
// two strategies are spending one wallet.
const OTHERS = [
  { id: 'a', role: 'dev', address: '0x00000000000000000000000000000000000000a1' },
  { id: 'b', role: 'bundle', address: '0x00000000000000000000000000000000000000a2' },
  { id: 'c', role: 'v2dev', address: '0x00000000000000000000000000000000000000a3' },
  { id: 'd', role: 'v2bundle', address: '0x00000000000000000000000000000000000000a4' },
  { id: 'e', role: 'distdev', address: '0x00000000000000000000000000000000000000a5' },
  { id: 'f', role: 'distfunding', address: '0x00000000000000000000000000000000000000a6' },
  { id: 'g', role: 'distbundle', address: '0x00000000000000000000000000000000000000a7' },
  { id: 'h', role: 'v2funding', address: '0x00000000000000000000000000000000000000a8' },
  { id: 'i', role: 'v3dev', address: '0x00000000000000000000000000000000000000a9' },
  { id: 'j', role: 'v3main', address: '0x00000000000000000000000000000000000000aa' },
  { id: 'k', role: 'v3bundle', address: '0x00000000000000000000000000000000000000ab' },
  { id: 'l', role: 'v4master', address: '0x00000000000000000000000000000000000000ac' },
  { id: 'm', role: 'v4seed', address: '0x00000000000000000000000000000000000000ad' },
];

test('the role names are v5s own', () => {
  assert.deepEqual(roles.ROLES, { dev: 'v5dev', bundle: 'v5bundle' });
});

test('isV5Role accepts only v5s two', () => {
  assert.equal(roles.isV5Role('v5dev'), true);
  assert.equal(roles.isV5Role('v5bundle'), true);
  for (const other of OTHERS) assert.equal(roles.isV5Role(other.role), false);
});

test('the lookups never resolve another strategys wallet', () => {
  const store = ks(OTHERS);
  assert.equal(roles.dev(store), null);
  assert.deepEqual(roles.bundle(store), []);
});

test('the lookups find v5s own among everyone elses', () => {
  const store = ks([...OTHERS, ...V5]);
  assert.equal(roles.dev(store).id, 'd1');
  assert.deepEqual(roles.bundle(store).map((w) => w.id), ['b1', 'b2']);
});

test('dev is a singleton lookup (one or null), bundle is plural', () => {
  assert.equal(roles.dev(ks(V5)).id, 'd1');
  assert.equal(roles.bundle(ks(V5)).length, 2);
});

test('empty is not an error — it is the state the tab starts in', () => {
  assert.deepEqual(roles.all(ks()), { dev: null, bundle: [] });
});
