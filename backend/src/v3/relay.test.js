'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const relay = require('./relay');
const config = require('../config');

const FROM = '0x1111111111111111111111111111111111111111';
const TO = '0x2222222222222222222222222222222222222222';
const DEPOSIT = '0x3333333333333333333333333333333333333333';
const REQUEST = `0x${'a'.repeat(64)}`;
const HASH = `0x${'b'.repeat(64)}`;

// The quote says 1 gwei. The chain, by the time we broadcast, wants 30. Every
// test that sends asserts we used the second number — see the fee test below.
const STALE_FEE = 1_000_000_000n;
const REFRESHED = { type: 2, maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1n };

const FROM_WALLET = { id: 'main', role: 'v3main', address: FROM };

function quote({ from = FROM, chainId = config.chainId, value = parseEther('0.11') } = {}) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: REQUEST,
        depositAddress: DEPOSIT,
        items: [
          {
            kind: 'transaction',
            check: { endpoint: '/intents/status/v3', method: 'GET' },
            data: {
              from,
              to: DEPOSIT,
              value: value.toString(),
              data: '0x',
              gas: '21000',
              chainId,
              maxFeePerGas: STALE_FEE.toString(),
              maxPriorityFeePerGas: STALE_FEE.toString(),
            },
          },
        ],
      },
    ],
    fees: { relayer: { amount: '10000000000000000', amountFormatted: '0.01', currency: { symbol: 'ETH' } } },
    details: { operation: 'send', timeEstimate: 4, currencyIn: {}, currencyOut: {} },
  };
}

function harness({ quoteOut = quote(), balance = parseEther('10') } = {}) {
  const sent = [];
  const asked = [];
  return {
    sent,
    asked,
    deps: {
      relayQuote: async (body) => {
        asked.push(body);
        return quoteOut;
      },
      keystore: {
        signer: () => ({
          sendTransaction: async (tx) => {
            sent.push(tx);
            return { hash: HASH };
          },
        }),
      },
      rpc: {
        getBalance: async () => balance,
        getTransactionCount: async () => 7,
      },
      getFeesFn: async () => REFRESHED,
      dryRun: false,
    },
  };
}

const transfer = (h, over = {}) =>
  relay.transfer({ fromWallet: FROM_WALLET, toAddress: TO, amountWei: parseEther('0.1'), ...over }, h.deps);

test('the quote is EXACT_OUTPUT, same chain, strict, and refunds to the sender', async () => {
  const h = harness();
  await transfer(h);
  const [body] = h.asked;
  assert.equal(body.tradeType, 'EXACT_OUTPUT');
  assert.equal(body.originChainId, config.chainId);
  assert.equal(body.destinationChainId, config.chainId);
  assert.equal(body.strict, true);
  assert.equal(body.useDepositAddress, true);
  assert.equal(body.amount, parseEther('0.1').toString());
  assert.equal(body.recipient.toLowerCase(), TO);
  assert.equal(body.refundTo.toLowerCase(), FROM);
});

test('it refuses a quote carrying no deposit transaction', async () => {
  const h = harness({ quoteOut: { steps: [] } });
  await assert.rejects(() => transfer(h), /deposit transaction/);
});

test('it refuses a deposit on a chain this server cannot sign for', async () => {
  const h = harness({ quoteOut: quote({ chainId: config.chainId + 1 }) });
  await assert.rejects(() => transfer(h), /chain/);
});

test('it refuses a deposit from a wallet we did not name', async () => {
  const h = harness({ quoteOut: quote({ from: TO }) });
  await assert.rejects(() => transfer(h), /expected/);
});

test('it refuses a deposit worth nothing', async () => {
  const h = harness({ quoteOut: quote({ value: 0n }) });
  await assert.rejects(() => transfer(h), /positive/);
});

test('it refuses when the sender cannot cover the deposit and its gas', async () => {
  const h = harness({ balance: parseEther('0.01') });
  await assert.rejects(() => transfer(h), /has 0\.01 ETH/);
});

test('it sends the REFRESHED fee ceiling, never the quoted one', async () => {
  // This is the whole reason the helper refreshes fees at send time. Relay
  // quotes a concrete maxFeePerGas; the base fee ticks between quote and
  // broadcast; a stale ceiling is rejected before it reaches the mempool.
  const h = harness();
  await transfer(h);
  const [tx] = h.sent;
  assert.equal(tx.maxFeePerGas, REFRESHED.maxFeePerGas);
  assert.notEqual(tx.maxFeePerGas, STALE_FEE);
});

test('it keeps Relays recipient, value and data untouched', async () => {
  const h = harness();
  await transfer(h);
  const [tx] = h.sent;
  assert.equal(tx.to.toLowerCase(), DEPOSIT);
  assert.equal(tx.value, parseEther('0.11'));
  assert.equal(tx.data, '0x');
  assert.equal(tx.nonce, 7);
});

test('it reports the requestId and deposit address so a stall can be looked up', async () => {
  const h = harness();
  const out = await transfer(h);
  assert.equal(out.requestId, REQUEST);
  assert.equal(out.depositAddress.toLowerCase(), DEPOSIT);
  assert.equal(out.hash, HASH);
  assert.equal(out.amountWei, parseEther('0.1'));
});

test('a dry run quotes and validates but signs nothing', async () => {
  const h = harness();
  h.deps.dryRun = true;
  const out = await transfer(h);
  assert.equal(out.simulated, true);
  assert.equal(out.hash, null);
  assert.equal(h.sent.length, 0);
  assert.equal(h.asked.length, 1, 'still quoted, so a dry run proves the route exists');
});

test('status refuses anything that is not a 32-byte request id', async () => {
  await assert.rejects(() => relay.status('nope'), /32-byte/);
});

// ── confirmFill: a broadcast deposit is not a delivered one ──────────────────

test('confirmFill reports filled once Relay says success', async () => {
  let calls = 0;
  const statusFn = async () => {
    calls += 1;
    return { status: calls >= 2 ? 'success' : 'pending' };
  };
  const out = await relay.confirmFill(REQUEST, { statusFn, gapMs: 0 });
  assert.deepEqual(out, { filled: true, status: 'success' });
  assert.equal(calls, 2, 'kept polling until it filled');
});

test('confirmFill reports NOT filled on a refund or failure, without waiting out every try', async () => {
  const refunded = await relay.confirmFill(REQUEST, { statusFn: async () => ({ status: 'refund' }), gapMs: 0 });
  assert.deepEqual(refunded, { filled: false, status: 'refund' });

  const failed = await relay.confirmFill(REQUEST, {
    statusFn: async () => ({ status: 'failure' }),
    gapMs: 0,
  });
  assert.deepEqual(failed, { filled: false, status: 'failure' });
});

test('confirmFill gives up as pending after its tries, and treats a status error as "not yet"', async () => {
  let calls = 0;
  const out = await relay.confirmFill(REQUEST, {
    tries: 3,
    gapMs: 0,
    statusFn: async () => {
      calls += 1;
      throw new Error('status endpoint down');
    },
  });
  assert.deepEqual(out, { filled: false, status: 'pending' });
  assert.equal(calls, 3, 'a status read that throws is retried, never fatal');
});

test('confirmFill returns filled:null for a missing or malformed request id', async () => {
  assert.deepEqual(await relay.confirmFill(null, { gapMs: 0 }), { filled: null, status: 'unknown' });
  assert.deepEqual(await relay.confirmFill('nope', { gapMs: 0 }), { filled: null, status: 'unknown' });
});
