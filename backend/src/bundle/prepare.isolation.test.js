'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-prepare-iso-'));
process.env.KEYSTORE_PATH = path.join(dir, 'wallets.keystore.json');
process.env.KEYSTORE_PASSPHRASE = 'isolation test passphrase';

const keystore = require('../wallets/keystore');
const { prepare } = require('./prepare');

test('a launch cannot sign with another user wallet', async () => {
  const alice = keystore.keystoreFor('alice');
  const bob = keystore.keystoreFor('bob');
  alice.generate(1, { role: 'dev' });
  const [bobBundle] = bob.generate(1, { role: 'bundle' });

  // Alice launches, naming one of Bob's wallet ids. It must be rejected as
  // unknown — never silently signed with.
  await assert.rejects(
    () =>
      prepare(
        {
          params: { name: 'X', symbol: 'X', logo: 'ipfs://x' },
          launchConfigId: 0,
          dexId: 0,
          wallets: [{ walletId: bobBundle.id, mode: 'fixed', amountEth: '0.01' }],
        },
        { keystore: alice }
      ),
    /no wallet/
  );
});

test('a launch with no dev wallet of its own is refused', async () => {
  const carol = keystore.keystoreFor('carol-empty');
  await assert.rejects(
    () =>
      prepare(
        { params: { name: 'X', symbol: 'X', logo: 'ipfs://x' }, launchConfigId: 0, dexId: 0, wallets: [] },
        { keystore: carol }
      ),
    /no dev wallet/
  );
});
