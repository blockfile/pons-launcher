'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const seasoned = require('./seasoned');

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-21T12:00:00Z');

// A fake keystore holding seeds + one non-seed, and a fake store of campaigns.
function fakeKs(wallets) {
  return { walletsWithRole: (role) => wallets.filter((w) => w.role === role) };
}
function fakeStore(transfers) {
  return { campaigns: () => [{ id: 'c1', kind: 'season', transfers }] };
}

test('available includes a funded seed aged past the gate, excludes a young one', () => {
  const ks = fakeKs([
    { id: 's1', role: 'v4seed', address: '0x1', label: 'seed-1' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'seed-2' },
    { id: 'm1', role: 'v4master', address: '0x9', label: 'master' },
  ]);
  const store = fakeStore([
    { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
    { walletId: 's2', status: 'sent', sentAt: new Date(NOW - 10 * HOUR).toISOString() },
  ]);
  const out = seasoned.available(ks, store, NOW, { minHours: 24 });
  assert.deepEqual(out.map((w) => w.id), ['s1'], 'only the 30h-old seed qualifies');
  assert.equal(out[0].hoursSinceFunded, 30);
});

test('available excludes a seed the operator has withdrawn from the pool', () => {
  const ks = fakeKs([
    { id: 's1', role: 'v4seed', address: '0x1', label: 'a' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'b' },
  ]);
  // Both are aged past the gate, but s1 has been withdrawn (key exported).
  const store = {
    campaigns: () => [
      {
        id: 'c1',
        kind: 'season',
        transfers: [
          { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
          { walletId: 's2', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
        ],
      },
    ],
    withdrawnSeedIds: () => new Set(['s1']),
  };
  const out = seasoned.available(ks, store, NOW, { minHours: 24 });
  assert.deepEqual(out.map((w) => w.id), ['s2'], 'the withdrawn seed is not offered; the other still is');
});

test('available excludes never-funded seeds and non-seed roles, and sorts most-aged first', () => {
  const ks = fakeKs([
    { id: 's1', role: 'v4seed', address: '0x1', label: 'a' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'b' },
    { id: 's3', role: 'v4seed', address: '0x3', label: 'c' },
  ]);
  const store = fakeStore([
    { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 30 * HOUR).toISOString() },
    { walletId: 's3', status: 'sent', sentAt: new Date(NOW - 50 * HOUR).toISOString() },
    // s2 has no sent transfer → never funded
    { walletId: 's2', status: 'pending', sentAt: null },
  ]);
  const out = seasoned.available(ks, store, NOW, { minHours: 24 });
  assert.deepEqual(out.map((w) => w.id), ['s3', 's1'], 'most-aged first, s2 absent');
});

function claimKs(wallets, roleLog) {
  return {
    walletsWithRole: (role) => wallets.filter((w) => w.role === role),
    setRole: (id, role) => {
      const w = wallets.find((x) => x.id === id);
      w.role = role;
      roleLog.push({ id, role });
    },
  };
}

test('claim re-roles available seeds and records them graduated, all-or-nothing', () => {
  const wallets = [
    { id: 's1', role: 'v4seed', address: '0x1', label: 'a' },
    { id: 's2', role: 'v4seed', address: '0x2', label: 'b' },
  ];
  const log = [];
  const ks = claimKs(wallets, log);
  const graduated = [];
  const store = {
    campaigns: () => [{ id: 'c', kind: 'season', transfers: [
      { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
      { walletId: 's2', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
    ]}],
    recordGraduated: (e) => graduated.push(...e),
  };
  const out = seasoned.claim(ks, store, ['s1', 's2'], { toRole: 'v3bundle', toTab: 'v3', now: NOW, minHours: 24 });
  assert.equal(out.claimed.length, 2);
  assert.deepEqual(log.map((x) => x.role), ['v3bundle', 'v3bundle']);
  assert.equal(graduated.length, 2);
  assert.equal(graduated[0].toTab, 'v3');
});

test('claim refuses an id that is not currently claimable and re-roles nothing', () => {
  const wallets = [{ id: 's1', role: 'v4seed', address: '0x1', label: 'a' }];
  const log = [];
  const ks = claimKs(wallets, log);
  const store = {
    campaigns: () => [{ id: 'c', kind: 'season', transfers: [
      { walletId: 's1', status: 'sent', sentAt: new Date(NOW - 40 * HOUR).toISOString() },
    ]}],
    recordGraduated: () => {},
  };
  assert.throws(
    () => seasoned.claim(ks, store, ['s1', 'ghost'], { toRole: 'v3bundle', toTab: 'v3', now: NOW, minHours: 24 }),
    /ghost/
  );
  assert.equal(log.length, 0, 'nothing re-roled when one id is bad');
});
