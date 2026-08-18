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

const V4 = [
  { id: 'm1', role: 'v4master', address: '0x0000000000000000000000000000000000000001' },
  { id: 'm2', role: 'v4master', address: '0x0000000000000000000000000000000000000002' },
  { id: 's1', role: 'v4seed', address: '0x0000000000000000000000000000000000000003' },
];

// Every role owned by another strategy. If a V4 lookup returns one of these,
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
];

test('the role names are v4s own', () => {
  assert.deepEqual(roles.ROLES, { master: 'v4master', seed: 'v4seed' });
});

test('isV4Role accepts only v4s two', () => {
  assert.equal(roles.isV4Role('v4master'), true);
  assert.equal(roles.isV4Role('v4seed'), true);
  for (const other of OTHERS) assert.equal(roles.isV4Role(other.role), false);
});

test('the lookups never resolve another strategys wallet', () => {
  const store = ks(OTHERS);
  assert.deepEqual(roles.masters(store), []);
  assert.deepEqual(roles.seeds(store), []);
});

test('the lookups find v4s own among everyone elses', () => {
  const store = ks([...OTHERS, ...V4]);
  assert.deepEqual(roles.masters(store).map((w) => w.id), ['m1', 'm2']);
  assert.deepEqual(roles.seeds(store).map((w) => w.id), ['s1']);
});

test('master is plural — parallel campaigns need more than one', () => {
  const store = ks(V4);
  assert.equal(roles.masters(store).length, 2);
});

test('empty is not an error — it is the state the tab starts in', () => {
  assert.deepEqual(roles.all(ks()), { masters: [], seeds: [] });
});
