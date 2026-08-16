import test from 'node:test';
import assert from 'node:assert/strict';

// The console's role map. Kept in step with backend/src/wallets/variants.js by
// the test at the bottom of this file, which is the only thing stopping the two
// from drifting apart — they are deliberately separate modules.
import { VARIANTS, DEFAULT_VARIANT, rolesFor, isBundle, isDev } from './variant.js';
// The backend copy is CommonJS; an ESM default import gives its module.exports.
import backend from '../../backend/src/wallets/variants.js';

// The wallet list as /wallets returns it: ONE keystore holding both launchers.
// Filtering it is the console's job, and getting that wrong is what put v2's
// wallets in v1's table with a live delete beside each one.
const ALL = [
  { id: '1', role: 'dev', address: '0xV1DEV' },
  { id: '2', role: 'bundle', address: '0xV1B1' },
  { id: '3', role: 'bundle', address: '0xV1B2' },
  { id: '4', role: 'v2dev', address: '0xV2DEV' },
  { id: '5', role: 'v2bundle', address: '0xV2B1' },
  { id: '6', role: 'v2bundle', address: '0xV2B2' },
];

// What WalletsPanel draws: the two roles of the launcher on screen, nothing else.
const visibleTo = (variant) => {
  const roles = rolesFor(variant);
  return ALL.filter((w) => w.role === roles.dev || w.role === roles.bundle);
};

test('the v1 table shows no v2 wallet', () => {
  const shown = visibleTo('v1').map((w) => w.address);
  assert.deepEqual(shown, ['0xV1DEV', '0xV1B1', '0xV1B2']);
  assert.equal(shown.some((a) => a.startsWith('0xV2')), false);
});

test('the v2 table shows no v1 wallet', () => {
  const shown = visibleTo('v2').map((w) => w.address);
  assert.deepEqual(shown, ['0xV2DEV', '0xV2B1', '0xV2B2']);
  assert.equal(shown.some((a) => a.startsWith('0xV1')), false);
});

test('the two tables never share a row', () => {
  const v1 = new Set(visibleTo('v1').map((w) => w.id));
  const v2 = visibleTo('v2').map((w) => w.id);
  assert.equal(v2.some((id) => v1.has(id)), false);
  // And between them they account for every wallet — nothing is orphaned into
  // a table that never draws it.
  assert.equal(visibleTo('v1').length + visibleTo('v2').length, ALL.length);
});

test('isDev and isBundle answer for the right launcher only', () => {
  const v1dev = ALL[0];
  const v2bundle = ALL[5];
  assert.equal(isDev(v1dev, 'v1'), true);
  assert.equal(isDev(v1dev, 'v2'), false);
  assert.equal(isBundle(v2bundle, 'v2'), true);
  assert.equal(isBundle(v2bundle, 'v1'), false);
});

test('the console falls back to v1 on an unknown variant instead of blanking', () => {
  // The backend throws here. The console must not: a bad name should show the
  // wrong list, which is recoverable, rather than render nothing at all. The
  // request it then makes still names the chosen variant, so the backend
  // refuses it loudly rather than spending anything.
  assert.deepEqual(rolesFor('nonsense'), VARIANTS[DEFAULT_VARIANT]);
  assert.equal(DEFAULT_VARIANT, 'v1');
});

test('the console role map matches the backend one exactly', () => {
  // The two files are separate on purpose — see the header of variant.js — so
  // this is the seam where they are checked against each other.
  for (const name of Object.keys(backend.VARIANTS)) {
    assert.ok(VARIANTS[name], `console is missing the ${name} variant`);
    assert.equal(VARIANTS[name].dev, backend.VARIANTS[name].dev, `${name}.dev drifted`);
    assert.equal(VARIANTS[name].bundle, backend.VARIANTS[name].bundle, `${name}.bundle drifted`);
  }
  assert.equal(DEFAULT_VARIANT, backend.DEFAULT_VARIANT);
});
