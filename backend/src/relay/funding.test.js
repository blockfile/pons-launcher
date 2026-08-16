'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const { quoteBody, depositStep, fundV2Bundle } = require('./funding');

const DEV = '0x1111111111111111111111111111111111111111';
const V2_BUNDLE = '0x2222222222222222222222222222222222222222';
const V1_BUNDLE = '0x3333333333333333333333333333333333333333';
const DEPOSIT = '0x4444444444444444444444444444444444444444';
const REQUEST = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;
const REFRESHED_FEES = { type: 2, maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n };

function fakeKeystore(sent = []) {
  const wallets = [
    { id: 'dev', role: 'v2dev', address: DEV },
    { id: 'v2b', role: 'v2bundle', address: V2_BUNDLE },
    { id: 'v1b', role: 'bundle', address: V1_BUNDLE },
  ];
  return {
    list: () => wallets,
    walletWithRole: (role) => wallets.find((w) => w.role === role) || null,
    walletsWithRole: (role) => wallets.filter((w) => w.role === role),
    signer: () => ({
      sendTransaction: async (tx) => {
        sent.push(tx);
        return { hash: HASH };
      },
    }),
  };
}

function fakeRpc() {
  return {
    getBalance: async () => parseEther('1'),
    getTransactionCount: async () => 7,
  };
}

function relayQuote({ from, recipient, amountWei }) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: REQUEST,
        depositAddress: DEPOSIT,
        items: [
          {
            kind: 'transaction',
            data: {
              from,
              to: DEPOSIT,
              data: '0x',
              value: (amountWei + parseEther('0.00001')).toString(),
              chainId: 4663,
              gas: '28087',
              maxFeePerGas: '22514800',
              maxPriorityFeePerGas: '0',
            },
            check: { endpoint: `/intents/status/v3?requestId=${REQUEST}`, method: 'GET' },
          },
        ],
      },
    ],
    fees: {
      relayer: { amount: '100', amountFormatted: '0.0000000000000001', amountUsd: '0', currency: { symbol: 'ETH', chainId: 4663 } },
    },
    details: {
      operation: 'swap',
      recipient,
      currencyIn: { amount: '1', amountFormatted: '0.1', amountUsd: '0', currency: { chainId: 4663 } },
      currencyOut: { amount: amountWei.toString(), amountFormatted: '0.1', amountUsd: '0', currency: { chainId: 4663 } },
    },
    protocol: { v2: { orderId: `0x${'c'.repeat(64)}`, orderData: { solver: `0x${'d'.repeat(40)}` } } },
  };
}

test('Relay quote body is strict exact-output into Robinhood native ETH', () => {
  const body = quoteBody({ from: DEV, recipient: V2_BUNDLE, amountWei: parseEther('0.01'), chainId: 4663 });
  assert.equal(body.user, DEV);
  assert.equal(body.recipient, V2_BUNDLE);
  assert.equal(body.originChainId, 4663);
  assert.equal(body.destinationChainId, 4663);
  assert.equal(body.tradeType, 'EXACT_OUTPUT');
  assert.equal(body.useDepositAddress, true);
  assert.equal(body.strict, true);
  assert.equal(body.amount, parseEther('0.01').toString());
});

test('depositStep refuses a plain Relay send quote', () => {
  assert.throws(
    () =>
      depositStep({
        steps: [
          {
            id: 'send',
            items: [{ data: { from: DEV, to: V2_BUNDLE, value: '1', chainId: 4663 } }],
          },
        ],
      }),
    /deposit transaction/
  );
});

test('fundV2Bundle sends the Relay deposit transaction, not a direct bundle transfer', async () => {
  const sent = [];
  const out = await fundV2Bundle([{ walletId: 'v2b', amountEth: '0.01' }], {
    keystore: fakeKeystore(sent),
    relayQuote,
    rpc: fakeRpc(),
    getFeesFn: async () => REFRESHED_FEES,
    dryRun: false,
  });

  assert.equal(out.mode, 'relay-solver');
  assert.equal(out.from, DEV);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].address, V2_BUNDLE);
  assert.equal(out.results[0].depositAddress, DEPOSIT);
  assert.equal(out.results[0].requestId, REQUEST);
  assert.equal(out.results[0].hash, HASH);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, DEPOSIT);
  assert.equal(sent[0].value, parseEther('0.01001'));
  assert.equal(sent[0].nonce, 7);
  assert.equal(sent[0].chainId, 4663);
  assert.equal(sent[0].maxFeePerGas, REFRESHED_FEES.maxFeePerGas);
  assert.equal(sent[0].maxPriorityFeePerGas, REFRESHED_FEES.maxPriorityFeePerGas);
});

test('fundV2Bundle rejects non-v2 bundle wallets before quoting Relay', async () => {
  let quoted = false;
  await assert.rejects(
    () =>
      fundV2Bundle([{ walletId: 'v1b', amountEth: '0.01' }], {
        keystore: fakeKeystore(),
        relayQuote: async () => {
          quoted = true;
          return relayQuote({ from: DEV, recipient: V1_BUNDLE, amountWei: parseEther('0.01') });
        },
        rpc: fakeRpc(),
        getFeesFn: async () => REFRESHED_FEES,
      }),
    /not a v2 bundle wallet/
  );
  assert.equal(quoted, false);
});

test('dry run quotes Relay but does not broadcast deposits', async () => {
  const sent = [];
  const out = await fundV2Bundle([{ walletId: 'v2b', amountEth: '0.01' }], {
    keystore: fakeKeystore(sent),
    relayQuote,
    rpc: fakeRpc(),
    getFeesFn: async () => REFRESHED_FEES,
    dryRun: true,
  });

  assert.equal(out.simulated, true);
  assert.equal(out.results[0].simulated, true);
  assert.equal(out.results[0].hash, null);
  assert.equal(sent.length, 0);
});
