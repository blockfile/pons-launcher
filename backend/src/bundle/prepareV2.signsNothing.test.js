'use strict';

// The guarantee that matters most, exercised end to end: when the launch would
// revert, prepareV2 throws and NEVER asks the keystore to sign anything. This is
// the invariant that, when it was broken, stranded 1.798 ETH — the buys were
// signed and broadcast at a launch that never created its curve.
//
// It drives the real prepareV2 through its whole pre-sign chain with injected
// dependencies, then makes the launch estimate revert (the forwarder's
// ExemptionListTooLong lands here, not at simulateLaunch, which tests the
// non-forwarder path). The keystore records every signing request; the test
// asserts there were none.

const test = require('node:test');
const assert = require('node:assert');
const prepareV2Module = require('./prepareV2');

const { prepareV2 } = prepareV2Module;

const DEV = '0x' + '11'.repeat(20);
const W1 = '0x' + '22'.repeat(20);
const CURVE = '0x' + 'cc'.repeat(20);
const TOKEN = '0x' + 'dd'.repeat(20);
const FORWARDER = '0x' + 'ff'.repeat(20);

function harness({ estimateReverts }) {
  const signCalls = [];
  const ks = {
    devWallet: () => ({ id: 'dev', address: DEV, role: 'v2dev' }),
    list: () => [
      { id: 'dev', address: DEV, role: 'v2dev' },
      { id: 'b1', address: W1, role: 'v2bundle' },
    ],
    // Any signing attempt is recorded — the test fails if this is ever hit.
    signer: (id) => {
      signCalls.push(id);
      return { signTransaction: async () => '0xsigned' };
    },
  };

  const v2 = {
    MAX_EXEMPTIONS_VIA_FORWARDER: 31,
    MAX_SNIPE_TAX_EXEMPTIONS: 32,
    preflightGate: async () => ({ problems: [], canLaunch: true, enabled: true, approved: true }),
    getConfigs: async () => ({
      launchConfigs: [{ id: 0, enabled: true, supply: 10n ** 27n, graduationThreshold: 42n * 10n ** 17n, curveFeeBps: 100 }],
      maxCreatorTaxBps: 1000,
      launchFee: 10n ** 15n,
      snipeTaxStartBps: 9900,
    }),
    newSalt: () => '0x' + '00'.repeat(32),
    predictAddresses: async () => ({ token: TOKEN, curve: CURVE, wiring: { forwarder: FORWARDER } }),
    // The non-forwarder static call agrees, so we get past the cross-check to the
    // estimate — exactly where a forwarder revert is caught.
    simulateLaunch: async () => ({ token: TOKEN, curve: CURVE }),
    buildLaunchAndBuyTx: async () => ({ to: FORWARDER, data: '0xf85f8e41', value: 10n ** 15n }),
    buildLaunchTx: async () => ({ to: FORWARDER, data: '0x', value: 10n ** 15n }),
    explainRevert: () => 'ExemptionListTooLong',
  };

  const provider = {
    estimateGas: async () => {
      if (estimateReverts) throw { data: '0x021c0d43' }; // ExemptionListTooLong
      return 5_000_000n;
    },
    getBalance: async () => 10n ** 21n,
    getTransactionCount: async () => 0,
  };

  const getFees = async () => ({ maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n });

  return { deps: { keystore: ks, v2, provider, getFees }, signCalls };
}

const input = {
  params: { name: 'Bongo Cat', symbol: 'BONGOCAT', logo: 'ipfs://x' },
  launchConfigId: 0,
  devBuyEth: '0.05', // forces the forwarder path, where the revert lives
  wallets: [{ walletId: 'b1', amountEth: '0.01' }],
};

test('a launch that reverts throws AND signs nothing', async () => {
  const { deps, signCalls } = harness({ estimateReverts: true });
  await assert.rejects(() => prepareV2(input, deps), /nothing was signed|ExemptionListTooLong/);
  assert.equal(signCalls.length, 0, 'the keystore must never be asked to sign when the launch reverts');
});

test('the guarantee is real, not vacuous: the same path DOES sign when the launch is valid', async () => {
  const { deps, signCalls } = harness({ estimateReverts: false });
  const plan = await prepareV2(input, deps);
  assert.equal(plan.protocol, 'v2');
  assert.ok(signCalls.length > 0, 'a valid launch must sign the launch and the buys');
});
