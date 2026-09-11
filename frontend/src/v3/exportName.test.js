import test from 'node:test';
import assert from 'node:assert/strict';
import { v3ExportName } from './exportName.js';

const DAY = new Date('2026-09-11T12:00:00Z');
const w = (role, n) => Array.from({ length: n }, () => ({ role }));

test('a single-role file is named by that role, counted', () => {
  assert.equal(v3ExportName({ wallets: w('v3bundle', 30), date: DAY }), '30pcs-V3-bundle-wallets-2026-09-11.json');
  assert.equal(v3ExportName({ wallets: w('v3main', 2), date: DAY }), '2pcs-V3-main-wallets-2026-09-11.json');
  assert.equal(v3ExportName({ wallets: w('v3dev', 2), date: DAY }), '2pcs-V3-treasury-wallets-2026-09-11.json');
});

test('a qualifier leads; the contents still decide the kind', () => {
  assert.equal(
    v3ExportName({ wallets: w('v3bundle', 3), qualifier: 'selected', date: DAY }),
    '3pcs-V3-selected-bundle-wallets-2026-09-11.json'
  );
  // A selection that spans roles says "selected" and no role — never "all".
  assert.equal(
    v3ExportName({ wallets: [...w('v3main', 1), ...w('v3bundle', 2)], qualifier: 'selected', date: DAY }),
    '3pcs-V3-selected-wallets-2026-09-11.json'
  );
});

test('a mixed file with no narrowing is all-wallets', () => {
  const full = [...w('v3dev', 1), ...w('v3main', 1), ...w('v3bundle', 30)];
  assert.equal(v3ExportName({ wallets: full, date: DAY }), '32pcs-V3-all-wallets-2026-09-11.json');
});

test('one wallet is singular', () => {
  assert.equal(v3ExportName({ wallets: w('v3dev', 1), date: DAY }), '1pcs-V3-treasury-wallet-2026-09-11.json');
  assert.equal(
    v3ExportName({ wallets: w('v3bundle', 1), qualifier: 'selected', date: DAY }),
    '1pcs-V3-selected-bundle-wallet-2026-09-11.json'
  );
});

test('a role this tab does not own never becomes a word', () => {
  assert.equal(v3ExportName({ wallets: w('v4seed', 2), date: DAY }), '2pcs-V3-all-wallets-2026-09-11.json');
  assert.equal(v3ExportName({ wallets: w(undefined, 2), date: DAY }), '2pcs-V3-all-wallets-2026-09-11.json');
});
