'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const roles = require('./roles');

/** The three methods roles.js actually uses, over a fixed wallet list. */
function ks(wallets = []) {
  return {
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
}

const V3 = [
  { id: 't', role: 'v3dev', address: '0x0000000000000000000000000000000000000001' },
  { id: 'm', role: 'v3main', address: '0x0000000000000000000000000000000000000002' },
  { id: 'b1', role: 'v3bundle', address: '0x0000000000000000000000000000000000000003' },
  { id: 'b2', role: 'v3bundle', address: '0x0000000000000000000000000000000000000004' },
];

// Every role v1, v2 and the distributor own. If a V3 lookup ever returns one of
// these, two strategies are spending one wallet — the bug the roles exist to
// prevent.
const OTHERS = [
  { id: 'a', role: 'dev', address: '0x00000000000000000000000000000000000000a1' },
  { id: 'b', role: 'bundle', address: '0x00000000000000000000000000000000000000a2' },
  { id: 'c', role: 'v2dev', address: '0x00000000000000000000000000000000000000a3' },
  { id: 'd', role: 'v2bundle', address: '0x00000000000000000000000000000000000000a4' },
  { id: 'e', role: 'distdev', address: '0x00000000000000000000000000000000000000a5' },
  { id: 'f', role: 'distfunding', address: '0x00000000000000000000000000000000000000a6' },
  { id: 'g', role: 'distbundle', address: '0x00000000000000000000000000000000000000a7' },
  { id: 'h', role: 'v2funding', address: '0x00000000000000000000000000000000000000a8' },
];

test('the role names are v3s own', () => {
  assert.deepEqual(roles.ROLES, { treasury: 'v3dev', main: 'v3main', bundle: 'v3bundle' });
});

test('treasury throws naming the role it is missing', () => {
  assert.throws(() => roles.treasury(ks()), /v3dev/);
});

test('main throws naming the role it is missing', () => {
  assert.throws(() => roles.main(ks()), /v3main/);
});

test('bundle with no wallets is empty, not an error', () => {
  assert.deepEqual(roles.bundle(ks()), []);
});

test('the lookups never resolve another strategys wallet', () => {
  const store = ks(OTHERS);
  assert.throws(() => roles.treasury(store), /v3dev/);
  assert.throws(() => roles.main(store), /v3main/);
  assert.deepEqual(roles.bundle(store), []);
});

test('the lookups find v3s own wallets among everyone elses', () => {
  const store = ks([...OTHERS, ...V3]);
  assert.equal(roles.treasury(store).id, 't');
  assert.equal(roles.main(store).id, 'm');
  assert.deepEqual(
    roles.bundle(store).map((w) => w.id),
    ['b1', 'b2']
  );
});

test('all returns the three groups together', () => {
  const out = roles.all(ks([...OTHERS, ...V3]));
  assert.equal(out.treasury.id, 't');
  assert.equal(out.main.id, 'm');
  assert.equal(out.bundle.length, 2);
});

test('all tolerates missing singletons rather than throwing', () => {
  // GET /v3/wallets reads this before anything has been created, so it has to
  // answer "none yet" instead of refusing to draw the page.
  const out = roles.all(ks());
  assert.equal(out.treasury, null);
  assert.equal(out.main, null);
  assert.deepEqual(out.bundle, []);
});

test('isV3Role recognises exactly the three, and nothing else', () => {
  assert.ok(roles.isV3Role('v3dev'));
  assert.ok(roles.isV3Role('v3main'));
  assert.ok(roles.isV3Role('v3bundle'));
  for (const w of OTHERS) assert.equal(roles.isV3Role(w.role), false, `${w.role} is not v3's`);
  assert.equal(roles.isV3Role(undefined), false);
});
