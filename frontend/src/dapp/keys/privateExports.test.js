// walletStore's two underscore exports hand out private keys in bulk. Only the two
// encrypted copies may take them: the passphrase vault on this device (vault.js)
// and the account copy (account/vaultSync.js). Any other importer is a leak path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['keys/walletStore.js', 'keys/vault.js', 'account/vaultSync.js']);

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('only vault.js and account/vaultSync.js touch _exportForVault / _importFromVault', () => {
  const offenders = [];
  for (const file of sources(DAPP)) {
    const rel = path.relative(DAPP, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    if (/_exportForVault|_importFromVault/.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});
