'use strict';

// The v2 roles have to survive add(), which is the one place every wallet is
// created — generate() and importKeys() both funnel through it. An earlier
// version hardcoded `role === 'dev' ? 'dev' : 'bundle'`, so every v2 wallet
// was silently created as a v1 bundle wallet: the V2 tab appeared to work,
// the wallets appeared on the V1 tab, and nothing errored.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshKeystore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-roles-'));
  process.env.KEYSTORE_PATH = path.join(dir, 'wallets.json');
  process.env.KEYSTORE_PASSPHRASE = 'test-passphrase-for-roles';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('./keystore')];
  const { keystoreFor, _reset } = require('./keystore');
  _reset?.();
  return keystoreFor('default');
}

test('every declared role survives generate', () => {
  const ks = freshKeystore();
  for (const role of ['bundle', 'v2dev', 'v2funding', 'v2bundle']) {
    const [made] = ks.generate(1, { role });
    assert.equal(made.role, role, `generate({role: '${role}'}) must keep the role`);
  }
});

test('v2 wallets do not appear among v1 bundle wallets', () => {
  const ks = freshKeystore();
  ks.generate(2, { role: 'bundle' });
  ks.generate(3, { role: 'v2bundle' });
  assert.equal(ks.bundleWallets().length, 2, 'v1 sees only its own');
  assert.equal(ks.walletsWithRole('v2bundle').length, 3, 'v2 sees only its own');
});

test('an unknown role still falls back to bundle rather than being stored raw', () => {
  const ks = freshKeystore();
  const [made] = ks.generate(1, { role: 'nonsense' });
  assert.equal(made.role, 'bundle');
});

test('the v2 singletons are singular', () => {
  const ks = freshKeystore();
  ks.generate(1, { role: 'v2dev' });
  assert.throws(() => ks.generate(1, { role: 'v2dev' }), /already exists/);
});
