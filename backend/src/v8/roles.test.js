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

const A = (n) => '0x' + String(n).padStart(40, '0');

const V8 = [
  { id: 'm1', role: 'v8main', address: A(1) },
  { id: 'b1', role: 'v8bundle', address: A(2) },
  { id: 'b2', role: 'v8bundle', address: A(3) },
];

// Every role owned by another strategy. If a v8 lookup ever returns one of these, two
// tabs are spending one wallet.
const OTHERS = [
  { id: 'a', role: 'dev', address: A(11) },
  { id: 'b', role: 'bundle', address: A(12) },
  { id: 'c', role: 'v2dev', address: A(13) },
  { id: 'd', role: 'v2bundle', address: A(14) },
  { id: 'e', role: 'distdev', address: A(15) },
  { id: 'f', role: 'distfunding', address: A(16) },
  { id: 'g', role: 'distbundle', address: A(17) },
  { id: 'h', role: 'v2funding', address: A(18) },
  { id: 'i', role: 'v3dev', address: A(19) },
  { id: 'j', role: 'v3main', address: A(20) },
  { id: 'k', role: 'v3bundle', address: A(21) },
  { id: 'l', role: 'v4master', address: A(22) },
  { id: 'm', role: 'v4seed', address: A(23) },
  { id: 'n', role: 'v5dev', address: A(24) },
  { id: 'o', role: 'v5bundle', address: A(25) },
  { id: 'p', role: 'v6dev', address: A(26) },
  { id: 'q', role: 'v6main', address: A(27) },
  { id: 'r', role: 'v6bundle', address: A(28) },
  { id: 's', role: 'v7dev', address: A(29) },
  { id: 't', role: 'v7main', address: A(30) },
  { id: 'u', role: 'v7bundle', address: A(31) },
];

test('the role names are v8s own', () => {
  assert.deepEqual(roles.ROLES, { main: 'v8main', bundle: 'v8bundle' });
});

test('isV8Role accepts only v8s two', () => {
  assert.equal(roles.isV8Role('v8main'), true);
  assert.equal(roles.isV8Role('v8bundle'), true);
  for (const other of OTHERS) assert.equal(roles.isV8Role(other.role), false);
  assert.equal(roles.isV8Role(undefined), false);
  assert.equal(roles.isV8Role('v8'), false);
});

test('the lookups never resolve another strategys wallet', () => {
  const store = ks(OTHERS);
  assert.throws(() => roles.main(store), /no v8main wallet/);
  assert.deepEqual(roles.bundle(store), []);
  assert.deepEqual(roles.all(store), { main: null, bundle: [] });
});

test('the lookups find v8s own among everyone elses', () => {
  const store = ks([...OTHERS, ...V8]);
  assert.equal(roles.main(store).id, 'm1');
  assert.deepEqual(
    roles.bundle(store).map((w) => w.id),
    ['b1', 'b2']
  );
});

test('main throws by name when it is missing, so a null never reaches a signer', () => {
  assert.throws(() => roles.main(ks()), /no v8main wallet — create the V8 main wallet first/);
});

test('empty is not an error — it is the state the tab starts in', () => {
  assert.deepEqual(roles.all(ks()), { main: null, bundle: [] });
});

// The property this whole tab depends on: no cap. The 31 that binds v1/v2 is the pons
// factory's snipe-tax exemption list; v8 never launches, so there is nothing to overflow.
test('bundle() has NO CAP — 250 bundle wallets all come back', () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `b${i}`, role: 'v8bundle', address: A(i + 100) }));
  const store = ks([...V8, ...many]);
  assert.equal(roles.bundle(store).length, 252);
  assert.equal(roles.all(store).bundle.length, 252);
});
