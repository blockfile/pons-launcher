'use strict';

// The forced-disperser path of disperse(): one disperser transaction for the
// given recipients regardless of the batching threshold, only ever through a
// contract the user has configured, and never falling back to plain transfers.
// Fully offline: fake keystore, fake provider, fake fee quote.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same isolation the disperse.js tests use: a temp history dir so a real
// dispersers.json cannot decide what these assertions see, and a fixed
// DISPERSER_ADDRESSES fallback list. DRY_RUN must be off or disperse() returns
// simulated rows before it reaches the code under test.
process.env.HISTORY_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pons-fund-')), 'launches.json');
process.env.DRY_RUN = 'false';
const D1 = '0x1111111111111111111111111111111111111111';
const D2 = '0x2222222222222222222222222222222222222222';
process.env.DISPERSER_ADDRESSES = [D1, D2].join(',');

const { getAddress, parseEther } = require('ethers');
const { disperse } = require('./funding');

const DEV = getAddress('0x' + 'aa'.repeat(20));
const B1 = getAddress('0x' + 'b1'.repeat(20));
const B2 = getAddress('0x' + 'b2'.repeat(20));

function fakeKs() {
  const ks = { sent: [], failNext: null };
  const wallets = [
    { id: 'dev', role: 'dev', address: DEV },
    { id: 'w1', role: 'bundle', address: B1 },
    { id: 'w2', role: 'bundle', address: B2 },
  ];
  ks.list = () => wallets;
  ks.devWallet = () => wallets[0];
  ks.signer = () => ({
    sendTransaction: async (tx) => {
      if (ks.failNext) {
        const err = ks.failNext;
        ks.failNext = null;
        throw err;
      }
      ks.sent.push(tx);
      return { hash: `0xhash${ks.sent.length}` };
    },
  });
  return ks;
}

function fakeProvider() {
  return {
    getBalance: async () => parseEther('10'),
    getTransactionCount: async () => 3,
    estimateGas: async () => 21195n,
  };
}

function deps(over = {}) {
  return {
    provider: fakeProvider(),
    getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    ...over,
  };
}

const ONE = [{ walletId: 'w1', amountEth: '0.05' }];

test('viaDisperser sends one recipient through the disperser even below the batching threshold', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true }, deps());

  assert.equal(ks.sent.length, 1, 'exactly one transaction');
  const tx = ks.sent[0];
  assert.equal(getAddress(tx.to), D1, 'the transaction goes TO the disperser contract, not the wallet');
  assert.equal(tx.value, parseEther('0.05'));
  assert.ok(tx.data && tx.data.length > 10, 'it is a contract call');
  assert.equal(tx.nonce, 3);
  assert.deepEqual(out, [
    { walletId: 'w1', address: B1, amountEth: '0.05', hash: '0xhash1', batched: true, disperser: D1 },
  ]);
});

test('viaDisperser honours a configured disperser address, in any case', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true, disperser: D2.toLowerCase() }, deps());
  assert.equal(getAddress(ks.sent[0].to), D2);
  assert.equal(out[0].disperser, D2);
});

test('viaDisperser refuses a disperser that is not configured and sends nothing', async () => {
  const ks = fakeKs();
  const foreign = '0x9999999999999999999999999999999999999999';
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true, disperser: foreign }, deps()),
    /not one of your configured dispersers/
  );
  assert.equal(ks.sent.length, 0);
});

test('viaDisperser refuses when no disperser is configured', async () => {
  const ks = fakeKs();
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true }, deps({ disperserAddresses: () => [] })),
    /no disperser deployed/
  );
  assert.equal(ks.sent.length, 0);
});

test('viaDisperser does NOT fall back to a plain transfer when the disperser send fails', async () => {
  const ks = fakeKs();
  ks.failNext = new Error('execution reverted: nope');
  const out = await disperse(ONE, { keystore: ks, viaDisperser: true }, deps());

  assert.equal(ks.sent.length, 0, 'no second attempt of any kind');
  assert.equal(out.length, 1);
  assert.equal(out[0].walletId, 'w1');
  assert.equal(out[0].address, B1);
  assert.equal(out[0].amountEth, '0.05');
  assert.equal(out[0].disperser, D1);
  assert.match(out[0].error, /nope/);
  assert.equal(out[0].hash, undefined);
});

test('viaDisperser still runs the balance check before sending', async () => {
  const ks = fakeKs();
  const poor = deps();
  poor.provider.getBalance = async () => parseEther('0.01');
  await assert.rejects(
    () => disperse(ONE, { keystore: ks, viaDisperser: true }, poor),
    /dev wallet has 0\.01 ETH but needs/
  );
  assert.equal(ks.sent.length, 0);
});

test('without viaDisperser one recipient still takes the plain-transfer path (unchanged behaviour)', async () => {
  const ks = fakeKs();
  const out = await disperse(ONE, { keystore: ks, disperser: D2 }, deps());
  assert.equal(ks.sent.length, 1);
  assert.equal(getAddress(ks.sent[0].to), B1, 'straight to the wallet');
  assert.equal(ks.sent[0].data, undefined);
  assert.deepEqual(out, [{ walletId: 'w1', address: B1, amountEth: '0.05', hash: '0xhash1' }]);
});
