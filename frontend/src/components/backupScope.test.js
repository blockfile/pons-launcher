import test from 'node:test';
import assert from 'node:assert/strict';

// What the v1/v2 key-export dialog says is in the file. The backend decides what
// the file HOLDS (backend/src/routes/wallets.js), but a dialog that names the
// wrong count on a key export is its own hazard — the operator's only check is
// the number they read before typing EXPORT.
//
// The bug these pin: BackupControls used to be handed the console's whole wallet
// list and count it, so the dialog beside the v1 bundle said "all 23 wallets"
// while exporting V3 through V8 as well.
import { resolveBackupScope, tabWallets, tierWord } from './backupScope.js';

// The list as GET /wallets returns it: ONE keystore holding every tab.
const ALL = [
  { id: '1', role: 'dev' },
  { id: '2', role: 'bundle' },
  { id: '3', role: 'bundle' },
  { id: '4', role: 'bundle' },
  { id: '5', role: 'v2dev' },
  { id: '6', role: 'v2bundle' },
  { id: '7', role: 'v3bundle' },
  { id: '8', role: 'v4seed' },
  { id: '9', role: 'v5bundle' },
  { id: '10', role: 'v6bundle' },
  { id: '11', role: 'v7bundle' },
  { id: '12', role: 'v8bundle' },
];

const ids = (list) => list.map((w) => w.id).sort();

test('a v1 backup covers v1 only — not v2, not v3–v8', () => {
  const { kind, wallets, tabCount } = resolveBackupScope(ALL, { variant: 'v1' });
  assert.equal(kind, 'all');
  assert.deepEqual(ids(wallets), ['1', '2', '3', '4'].sort());
  assert.equal(tabCount, 4);
});

test('a v2 backup covers v2 only — not v1', () => {
  const { wallets } = resolveBackupScope(ALL, { variant: 'v2' });
  assert.deepEqual(ids(wallets), ['5', '6'].sort());
});

test('a role scope is one tier — the bundle without the dev wallet, and vice versa', () => {
  const bundleOnly = resolveBackupScope(ALL, { variant: 'v1', role: 'bundle' });
  assert.equal(bundleOnly.kind, 'role');
  assert.deepEqual(ids(bundleOnly.wallets), ['2', '3', '4'].sort());

  const devOnly = resolveBackupScope(ALL, { variant: 'v1', role: 'dev' });
  assert.deepEqual(ids(devOnly.wallets), ['1']);

  // The tab's total rides along either way, so a filtered dialog can say "N of M".
  assert.equal(bundleOnly.tabCount, 4);
  assert.equal(devOnly.tabCount, 4);
});

test('a role the tab does not own resolves to nothing, never to another tab', () => {
  for (const role of ['v2bundle', 'v4seed', 'v8bundle']) {
    assert.deepEqual(resolveBackupScope(ALL, { variant: 'v1', role }).wallets, []);
  }
});

test('a selection is exactly the ids ticked', () => {
  const { kind, wallets } = resolveBackupScope(ALL, { variant: 'v1', walletIds: ['2', '4'] });
  assert.equal(kind, 'selected');
  assert.deepEqual(ids(wallets), ['2', '4']);
});

test('a selection can never widen past the tab, even when a foreign id is named', () => {
  const { wallets } = resolveBackupScope(ALL, {
    variant: 'v1',
    walletIds: ['2', '5', '6', '7', '8', '9', '10', '11', '12'],
  });
  assert.deepEqual(ids(wallets), ['2'], 'the tab filter runs first');
});

test('an empty selection is empty, not everything', () => {
  // The failure mode worth naming: treating [] as "no filter" is how "export the
  // 0 wallets I ticked" becomes "export the whole tab".
  assert.deepEqual(resolveBackupScope(ALL, { variant: 'v1', walletIds: [] }).wallets, []);
});

test('walletIds wins over role, so the two narrowings can never compound wrongly', () => {
  const { kind, wallets } = resolveBackupScope(ALL, {
    variant: 'v1',
    role: 'dev',
    walletIds: ['3'],
  });
  assert.equal(kind, 'selected');
  assert.deepEqual(ids(wallets), ['3']);
});

test('tabWallets and tierWord speak the tab that was asked for', () => {
  assert.equal(tabWallets(ALL, 'v2').length, 2);
  assert.equal(tabWallets([], 'v1').length, 0);
  assert.equal(tierWord('bundle', 'v1'), 'bundle');
  assert.equal(tierWord('dev', 'v1'), 'dev');
  // v2's roles are different strings for the same two tiers — the dialog must
  // still read "bundle", not "v2bundle".
  assert.equal(tierWord('v2bundle', 'v2'), 'bundle');
  assert.equal(tierWord('v2dev', 'v2'), 'dev');
});
