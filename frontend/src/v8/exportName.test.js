import test from 'node:test';
import assert from 'node:assert/strict';

// The name a V8 key export is saved under. It is read from what the file HOLDS —
// the count and, when every wallet in it shares one, the role — because a backup
// is found months later by its name, and a name built from the request alone has
// already lied once (a V4 "nofunders" export that held a funding wallet).
import { v8ExportName } from './exportName.js';
import { ROLES } from './roles.js';

const DAY = new Date('2026-09-11T12:00:00Z');
const w = (role, n) => Array.from({ length: n }, () => ({ role }));

test('a single-role file is named by that role, counted', () => {
  assert.equal(v8ExportName({ wallets: w('v8bundle', 5), date: DAY }), '5pcs-V8-destination-wallets-2026-09-11.json');
});

test('a qualifier leads; the contents still decide the kind', () => {
  assert.equal(
    v8ExportName({ wallets: w('v8bundle', 3), qualifier: 'selected', date: DAY }),
    '3pcs-V8-selected-destination-wallets-2026-09-11.json'
  );
  // A selection that ticked the source as well holds two roles: it is no longer a
  // "destination" file, whatever panel the export was started from.
  assert.equal(
    v8ExportName({ wallets: [...w('v8main', 1), ...w('v8bundle', 2)], qualifier: 'selected', date: DAY }),
    '3pcs-V8-selected-wallets-2026-09-11.json'
  );
});

test('a mixed file with no narrowing is all-wallets', () => {
  assert.equal(
    v8ExportName({ wallets: [...w('v8main', 1), ...w('v8bundle', 5)], date: DAY }),
    '6pcs-V8-all-wallets-2026-09-11.json'
  );
});

test('one wallet is singular', () => {
  assert.equal(v8ExportName({ wallets: w('v8main', 1), date: DAY }), '1pcs-V8-source-wallet-2026-09-11.json');
});

test('a role this tab does not own never becomes a word', () => {
  // V6 and V7 have a main and a bundle too, under their own role strings; v1 has a
  // bare "bundle". None of them is V8's to name.
  for (const role of ['v7main', 'v6bundle', 'v7bundle', 'bundle', 'v4seed']) {
    assert.equal(v8ExportName({ wallets: w(role, 2), date: DAY }), '2pcs-V8-all-wallets-2026-09-11.json');
  }
});

test('the bare-keys file carries the keys suffix after the kind, and its own extension', () => {
  assert.equal(
    v8ExportName({ wallets: w('v8bundle', 5), suffix: 'keys', ext: 'txt', date: DAY }),
    '5pcs-V8-destination-wallets-keys-2026-09-11.txt'
  );
  assert.equal(
    v8ExportName({ wallets: w('v8bundle', 3), qualifier: 'selected', suffix: 'keys', ext: 'txt', date: DAY }),
    '3pcs-V8-selected-destination-wallets-keys-2026-09-11.txt'
  );
});

test('every role V8 owns has a word — the literals match roles.js', () => {
  // exportName.js spells the role strings out so it stays a leaf module; this is
  // what notices if roles.js is ever renamed underneath it.
  for (const role of Object.values(ROLES)) {
    assert.doesNotMatch(v8ExportName({ wallets: w(role, 2), date: DAY }), /-all-wallets-/, role);
  }
});
