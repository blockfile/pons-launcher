import test from 'node:test';
import assert from 'node:assert/strict';

// The name a V7 key export is saved under. It is read from what the file HOLDS —
// the count and, when every wallet in it shares one, the role — because a backup
// is found months later by its name, and a name built from the request alone has
// already lied once (a V4 "nofunders" export that held a funding wallet).
import { v7ExportName } from './exportName.js';
import { ROLES } from './roles.js';

const DAY = new Date('2026-09-11T12:00:00Z');
const w = (role, n) => Array.from({ length: n }, () => ({ role }));

test('a single-role file is named by that role, counted', () => {
  assert.equal(v7ExportName({ wallets: w('v7bundle', 30), date: DAY }), '30pcs-V7-bundle-wallets-2026-09-11.json');
  assert.equal(v7ExportName({ wallets: w('v7main', 2), date: DAY }), '2pcs-V7-main-wallets-2026-09-11.json');
});

test('a qualifier leads; the contents still decide the kind', () => {
  assert.equal(
    v7ExportName({ wallets: w('v7bundle', 3), qualifier: 'selected', date: DAY }),
    '3pcs-V7-selected-bundle-wallets-2026-09-11.json'
  );
  // A selection that ticked the treasury as well holds two roles: it is no longer
  // a "bundle" file, whatever panel the export was started from.
  assert.equal(
    v7ExportName({ wallets: [...w('v7dev', 1), ...w('v7bundle', 2)], qualifier: 'selected', date: DAY }),
    '3pcs-V7-selected-wallets-2026-09-11.json'
  );
});

test('a mixed file with no narrowing is all-wallets', () => {
  assert.equal(
    v7ExportName({ wallets: [...w('v7dev', 1), ...w('v7main', 1), ...w('v7bundle', 30)], date: DAY }),
    '32pcs-V7-all-wallets-2026-09-11.json'
  );
});

test('one wallet is singular', () => {
  // v7dev is written as the treasury — the word ROLES and the V7 panels use for it.
  assert.equal(v7ExportName({ wallets: w('v7dev', 1), date: DAY }), '1pcs-V7-treasury-wallet-2026-09-11.json');
});

test('a role this tab does not own never becomes a word', () => {
  // V6 has a treasury, a main and a bundle too, under its own role strings; v1 has
  // a bare "dev". None of them is V7's to name.
  for (const role of ['v6dev', 'v6main', 'v6bundle', 'v3dev', 'dev', 'bundle']) {
    assert.equal(v7ExportName({ wallets: w(role, 2), date: DAY }), '2pcs-V7-all-wallets-2026-09-11.json');
  }
});

test('every role V7 owns has a word — the literals match roles.js', () => {
  // exportName.js spells the role strings out so it stays a leaf module; this is
  // what notices if roles.js is ever renamed underneath it.
  for (const role of Object.values(ROLES)) {
    assert.doesNotMatch(v7ExportName({ wallets: w(role, 2), date: DAY }), /-all-wallets-/, role);
  }
});
