import test from 'node:test';
import assert from 'node:assert/strict';
import { v4ExportName } from './exportName.js';

const DAY = new Date('2026-09-11T12:00:00Z');
const w = (role, n) => Array.from({ length: n }, () => ({ role }));

test('a single-role file is named by that role, counted', () => {
  assert.equal(v4ExportName({ wallets: w('v4master', 100), date: DAY }), '100pcs-V4-funding-wallets-2026-09-11.json');
  assert.equal(v4ExportName({ wallets: w('v4seed', 495), date: DAY }), '495pcs-V4-seed-wallets-2026-09-11.json');
});

test('a qualifier leads; the contents still decide the kind', () => {
  assert.equal(
    v4ExportName({ wallets: w('v4seed', 495), qualifier: 'selected', date: DAY }),
    '495pcs-V4-selected-seed-wallets-2026-09-11.json'
  );
  assert.equal(
    v4ExportName({ wallets: w('v4seed', 200), qualifier: 'seasoned-1d', date: DAY }),
    '200pcs-V4-seasoned-1d-seed-wallets-2026-09-11.json'
  );
  // The 2026-09-11 case: a narrowed export that also held a funding wallet. The name
  // must not claim "seed" for a file that carries a funder's key.
  assert.equal(
    v4ExportName({ wallets: [...w('v4seed', 2), ...w('v4master', 1)], qualifier: 'selected', date: DAY }),
    '3pcs-V4-selected-wallets-2026-09-11.json'
  );
  assert.equal(
    v4ExportName({ wallets: [...w('v4seed', 200), ...w('v4master', 100)], qualifier: 'seasoned-7d', date: DAY }),
    '300pcs-V4-seasoned-7d-wallets-2026-09-11.json'
  );
});

test('a mixed file with no narrowing is all-wallets', () => {
  const full = [...w('v4master', 100), ...w('v4seed', 495)];
  assert.equal(v4ExportName({ wallets: full, date: DAY }), '595pcs-V4-all-wallets-2026-09-11.json');
});

test('one wallet is singular', () => {
  assert.equal(v4ExportName({ wallets: w('v4master', 1), date: DAY }), '1pcs-V4-funding-wallet-2026-09-11.json');
  assert.equal(
    v4ExportName({ wallets: w('v4seed', 1), qualifier: 'seasoned-3d', date: DAY }),
    '1pcs-V4-seasoned-3d-seed-wallet-2026-09-11.json'
  );
});

test('a role this tab does not own never becomes a word', () => {
  assert.equal(v4ExportName({ wallets: w('v3bundle', 2), date: DAY }), '2pcs-V4-all-wallets-2026-09-11.json');
  assert.equal(v4ExportName({ wallets: w(undefined, 2), date: DAY }), '2pcs-V4-all-wallets-2026-09-11.json');
});
