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

// A keystore holding `n` distinct v2 bundle wallets, for exercising a run large
// enough to span several quote batches.
function fakeKeystoreN(n, sent = []) {
  const wallets = [{ id: 'dev', role: 'v2dev', address: DEV }];
  for (let i = 0; i < n; i += 1) {
    wallets.push({
      id: `v2b${i}`,
      role: 'v2bundle',
      address: `0x${String(i + 1).padStart(40, '0')}`,
    });
  }
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

test('a many-wallet run quotes in batches, never bursting, and keeps order and nonces', async () => {
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const targets = Array.from({ length: 7 }, (_, i) => ({ walletId: `v2b${i}`, amountEth: '0.01' }));

  const out = await fundV2Bundle(targets, {
    keystore: fakeKeystoreN(7, sent),
    // Record peak concurrency so a regression back to Promise.all(all) is caught.
    relayQuote: async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return relayQuote(input);
    },
    rpc: fakeRpc(),
    getFeesFn: async () => REFRESHED_FEES,
    dryRun: false,
    quoteBatchGapMs: 0, // keep the test instant; the batching itself is what matters
  });

  assert.equal(out.results.length, 7);
  assert.ok(maxInFlight <= 3, `expected at most 3 concurrent quotes, saw ${maxInFlight}`);
  // Order preserved end to end: results and the broadcast nonces follow the
  // order the targets were given in.
  assert.deepEqual(
    out.results.map((r) => r.address),
    targets.map((_, i) => `0x${String(i + 1).padStart(40, '0')}`)
  );
  assert.deepEqual(
    sent.map((tx) => tx.nonce),
    [7, 8, 9, 10, 11, 12, 13]
  );
});

test('a transient Relay refusal is retried, not surfaced', async () => {
  let calls = 0;
  const out = await fundV2Bundle([{ walletId: 'v2b', amountEth: '0.01' }], {
    keystore: fakeKeystore([]),
    relayQuote: async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('Could not process request. Please try again later.');
      return relayQuote(input);
    },
    rpc: fakeRpc(),
    getFeesFn: async () => REFRESHED_FEES,
    dryRun: true,
    quoteBatchGapMs: 0,
  });

  assert.equal(calls, 2, 'the first refusal should have been retried once');
  assert.equal(out.results[0].requestId, REQUEST);
});

test('a specific Relay error is surfaced immediately, not retried', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      fundV2Bundle([{ walletId: 'v2b', amountEth: '0.01' }], {
        keystore: fakeKeystore([]),
        relayQuote: async () => {
          calls += 1;
          throw new Error('Invalid recipient address for chain 4663');
        },
        rpc: fakeRpc(),
        getFeesFn: async () => REFRESHED_FEES,
        dryRun: true,
        quoteBatchGapMs: 0,
      }),
    /Invalid recipient address/
  );
  assert.equal(calls, 1, 'a non-transient error must not be retried');
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
