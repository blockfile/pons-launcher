import test from 'node:test';
import assert from 'node:assert/strict';

// The name a V5 key export is saved under. It is read from what the file HOLDS —
// the count and, when every wallet in it shares one, the role — because a backup
// is found months later by its name, and a name built from the request alone has
// already lied once (a V4 "nofunders" export that held a funding wallet).
import { v5ExportName } from './exportName.js';
import { ROLES } from './roles.js';

const DAY = new Date('2026-09-11T12:00:00Z');
const w = (role, n) => Array.from({ length: n }, () => ({ role }));

test('a single-role file is named by that role, counted', () => {
  assert.equal(v5ExportName({ wallets: w('v5bundle', 30), date: DAY }), '30pcs-V5-bundle-wallets-2026-09-11.json');
});

test('a qualifier leads; the contents still decide the kind', () => {
  assert.equal(
    v5ExportName({ wallets: w('v5bundle', 3), qualifier: 'selected', date: DAY }),
    '3pcs-V5-selected-bundle-wallets-2026-09-11.json'
  );
  // A selection that ticked the launcher as well holds two roles: it is no longer
  // a "bundle" file, whatever panel the export was started from.
  assert.equal(
    v5ExportName({ wallets: [...w('v5dev', 1), ...w('v5bundle', 2)], qualifier: 'selected', date: DAY }),
    '3pcs-V5-selected-wallets-2026-09-11.json'
  );
});

test('a mixed file with no narrowing is all-wallets', () => {
  assert.equal(
    v5ExportName({ wallets: [...w('v5dev', 1), ...w('v5bundle', 30)], date: DAY }),
    '31pcs-V5-all-wallets-2026-09-11.json'
  );
});

test('one wallet is singular', () => {
  assert.equal(v5ExportName({ wallets: w('v5dev', 1), date: DAY }), '1pcs-V5-dev-wallet-2026-09-11.json');
  assert.equal(
    v5ExportName({ wallets: w('v5bundle', 1), qualifier: 'selected', date: DAY }),
    '1pcs-V5-selected-bundle-wallet-2026-09-11.json'
  );
});

test('a role this tab does not own never becomes a word', () => {
  // v1's bare "dev"/"bundle" and other tabs' roles — none of them is V5's to name.
  for (const role of ['dev', 'bundle', 'v6bundle', 'v4seed']) {
    assert.equal(v5ExportName({ wallets: w(role, 2), date: DAY }), '2pcs-V5-all-wallets-2026-09-11.json');
  }
});

test('every role V5 owns has a word — the literals match roles.js', () => {
  // exportName.js spells the role strings out so it stays a leaf module; this is
  // what notices if roles.js is ever renamed underneath it.
  for (const role of Object.values(ROLES)) {
    assert.doesNotMatch(v5ExportName({ wallets: w(role, 2), date: DAY }), /-all-wallets-/, role);
  }
});
