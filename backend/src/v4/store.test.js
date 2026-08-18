'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-'));
  process.env.HISTORY_PATH = path.join(dir, 'launches.json');
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./store')];
  const store = require('./store');
  store._reset();
  return { store, dir };
}

function campaign(over = {}) {
  return {
    id: 'c1',
    name: 'august',
    status: 'running',
    seed: 'abc',
    masterWalletId: 'm1',
    params: { days: 2 },
    transfers: [
      { id: '1-1', walletId: 's1', address: '0x1', amountEth: '0.004000', dueAt: 1, status: 'pending', attempts: [] },
      { id: '2-1', walletId: 's2', address: '0x2', amountEth: '0.005000', dueAt: 2, status: 'pending', attempts: [] },
    ],
    consecutiveFailures: 0,
    ...over,
  };
}

test('a campaign survives a round trip through disk', () => {
  const { store } = freshStore();
  store.storeFor('u').create(campaign());
  store._reset();
  const back = store.storeFor('u').get('c1');
  assert.equal(back.name, 'august');
  assert.equal(back.transfers.length, 2);
});

test('several campaigns live in one file', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'c1', masterWalletId: 'm1' }));
  s.create(campaign({ id: 'c2', masterWalletId: 'm2' }));
  assert.equal(s.campaigns().length, 2);
  assert.equal(s.running().length, 2);
});

// The guarantee: after a write, no partially-written file is ever visible at
// the campaign store's path. A "no stray .tmp file" check alone cannot fail
// against a plain, non-atomic fs.writeFileSync(file, ...) implementation —
// that never creates a `.tmp` file at all, so the assertion passes trivially
// whether or not the write is actually atomic. So this test spies on
// fs.writeFileSync/fs.renameSync to assert the MECHANISM directly: persist()
// must never write straight onto the live path, and must rename a `.tmp`
// sibling onto it. That is what genuinely distinguishes the two
// implementations. See backend/src/wallets/keystore.atomic.test.js for the
// same pattern applied to the keystore.
test('the write leaves no temp file behind', (t) => {
  const { store, dir } = freshStore();
  const file = store.pathFor('u');

  // Default mock implementation calls through to the real fs method, so
  // behaviour is unchanged — this only records what persist() actually calls.
  const writeSpy = t.mock.method(fs, 'writeFileSync');
  const renameSpy = t.mock.method(fs, 'renameSync');

  store.storeFor('u').create(campaign());

  const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(stray, []);

  const wroteDirectlyToFile = writeSpy.mock.calls.some((c) => c.arguments[0] === file);
  assert.equal(wroteDirectlyToFile, false, 'persist() must never write straight onto the live campaign store path');

  const renamedTmpOntoFile = renameSpy.mock.calls.some(
    (c) => c.arguments[0] === `${file}.tmp` && c.arguments[1] === file
  );
  assert.equal(renamedTmpOntoFile, true, 'persist() must rename a .tmp sibling onto the live campaign store path');
});

test('updateTransfer changes one transfer and nothing else', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign());
  s.updateTransfer('c1', '1-1', { status: 'sent', hash: '0xdead' });
  const back = s.get('c1');
  assert.equal(back.transfers[0].status, 'sent');
  assert.equal(back.transfers[0].hash, '0xdead');
  assert.equal(back.transfers[1].status, 'pending');
  assert.equal(back.transfers[1].hash, undefined);
});

test('running excludes everything that is not running', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'a', status: 'running' }));
  s.create(campaign({ id: 'b', status: 'paused' }));
  s.create(campaign({ id: 'c', status: 'complete' }));
  s.create(campaign({ id: 'd', status: 'halted' }));
  s.create(campaign({ id: 'e', status: 'cancelled' }));
  assert.deepEqual(s.running().map((c) => c.id), ['a']);
});

test('claimed seed ids span every campaign, running or not', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  s.create(campaign({ id: 'a', status: 'complete' }));
  assert.deepEqual([...s.claimedSeedIds()].sort(), ['s1', 's2']);
});

test('backedUp names the wallets with no backup on record', () => {
  const { store } = freshStore();
  const s = store.storeFor('u');
  assert.deepEqual(s.backedUp(['s1', 's2']), ['s1', 's2']);
  s.recordBackup(['s1']);
  assert.deepEqual(s.backedUp(['s1', 's2']), ['s2']);
  s.recordBackup(['s2', 's3']);
  assert.deepEqual(s.backedUp(['s1', 's2']), []);
});

test('two users never see each others campaigns', () => {
  const { store } = freshStore();
  store.storeFor('alice').create(campaign({ id: 'a' }));
  store.storeFor('alice').create(campaign({ id: 'b' }));
  assert.deepEqual(store.storeFor('bob').campaigns(), []);
  assert.equal(store.storeFor('alice').campaigns().length, 2);
  assert.equal(fs.existsSync(store.pathFor('bob')), false);
});
