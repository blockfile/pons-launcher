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
