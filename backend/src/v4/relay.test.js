'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const relay = require('./relay');

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const DEPOSIT = '0x3333333333333333333333333333333333333333';

// Relay's quote carries its own fee ceiling on the deposit tx. It must never
// reach a signature: the base fee can move between quote and broadcast, and
// every live-transfer test below asserts the chain's fee (not this one) was
// signed. If a wrong implementation ever preferred Relay's tx-level fee
// fields, this stale value — distinct from every getFeesFn stub in this file
// — is what would leak into `signed`.
const STALE_FEE = '999000000000';

function quote({ from = FROM, chainId, value = '1100000000000000' } = {}) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: `0x${'ab'.repeat(32)}`,
        depositAddress: DEPOSIT,
        items: [
          {
            kind: 'transaction',
            check: { endpoint: '/x' },
            data: {
              from,
              to: DEPOSIT,
              value,
              gas: '50000',
              chainId: chainId ?? require('../config').chainId,
              maxFeePerGas: STALE_FEE,
              maxPriorityFeePerGas: STALE_FEE,
            },
          },
        ],
      },
    ],
    fees: {},
    details: {},
  };
}

test('the order is same-chain and exact-output', () => {
  const body = relay.quoteBody({ from: FROM, recipient: TO, amountWei: parseEther('0.004') });
  const { chainId } = require('../config');
  assert.equal(body.originChainId, Number(chainId));
  assert.equal(body.destinationChainId, Number(chainId));
  assert.equal(body.tradeType, 'EXACT_OUTPUT');
  assert.equal(body.strict, true);
  // A refund must land where the payer will look for it, not with whoever asked.
  assert.equal(body.refundTo.toLowerCase(), FROM.toLowerCase());
});

test('depositStep refuses a quote from the wrong wallet', () => {
  assert.throws(
    () => relay.depositStep(quote({ from: TO }), { expectedFrom: FROM }),
    /expected/
  );
});

test('depositStep refuses another chain', () => {
  assert.throws(() => relay.depositStep(quote({ chainId: 999999 }), {}), /chain/);
});

test('depositStep refuses a zero deposit', () => {
  assert.throws(() => relay.depositStep(quote({ value: '0' }), {}), /positive/);
});

test('transfer refuses when the payer cannot cover deposit plus gas', async () => {
  await assert.rejects(
    relay.transfer(
      { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
      {
        keystore: {},
        dryRun: false,
        relayQuote: async () => quote(),
        getFeesFn: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
        rpc: { getBalance: async () => 1n, getTransactionCount: async () => 0 },
      }
    ),
    /needs/
  );
});

test('a dry run quotes and signs nothing', async () => {
  const out = await relay.transfer(
    { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
    {
      dryRun: true,
      relayQuote: async () => quote(),
      getFeesFn: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      rpc: { getBalance: async () => parseEther('10'), getTransactionCount: async () => 0 },
    }
  );
  assert.equal(out.simulated, true);
  assert.equal(out.hash, null);
  assert.equal(out.depositAddress.toLowerCase(), DEPOSIT.toLowerCase());
});

test('a live transfer signs with the pending nonce and returns the hash', async () => {
  let signed = null;
  const out = await relay.transfer(
    { fromWallet: { id: 'm1', address: FROM }, toAddress: TO, amountWei: parseEther('0.004') },
    {
      dryRun: false,
      keystore: {
        signer: () => ({
          sendTransaction: async (tx) => {
            signed = tx;
            return { hash: `0x${'cd'.repeat(32)}` };
          },
        }),
      },
      relayQuote: async () => quote(),
      getFeesFn: async () => ({ maxFeePerGas: 7n, maxPriorityFeePerGas: 2n }),
      rpc: { getBalance: async () => parseEther('10'), getTransactionCount: async () => 41 },
    }
  );
  assert.equal(signed.nonce, 41);
  // Relay's own fee fields are dropped and re-read from the chain: the quote
  // fixture's deposit tx carries STALE_FEE as both fee fields, and the signed
  // tx must carry the chain's numbers instead.
  assert.equal(signed.maxFeePerGas, 7n);
  assert.equal(signed.maxPriorityFeePerGas, 2n);
  assert.notEqual(signed.maxFeePerGas, BigInt(STALE_FEE));
  assert.match(out.hash, /^0x[0-9a-f]{64}$/);
});
