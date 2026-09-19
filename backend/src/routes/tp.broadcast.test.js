'use strict';

// POST /api/tp/broadcast, end to end through express on a loopback port, through
// the REAL router (Task 1's broadcastLimit, wrap and sendError) and the REAL
// validator. The send-path venue lookup (venue.cachedVenue), venue.refreshPhase
// and the send provider are fakes on their module objects; every transaction is
// signed by a throwaway Wallet.createRandom().

// The route calls broadcast() without deps, so it would read TP_SEQUENCER_URL:
// blank it BEFORE anything loads config.js (dotenv never overrides a set variable),
// so a developer's .env can never send these test transactions anywhere.
process.env.TP_SEQUENCER_URL = '';
// The send provider below is a fake, so this process runs 'live': a DRY_RUN server
// refuses every broadcast (tp/broadcast.js), which is not what these tests are about.
process.env.DRY_RUN = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { Interface, Transaction, Wallet } = require('ethers');

const C = require('../tp/constants');
const venueMod = require('../tp/venue');
const providersMod = require('../tp/providers');
const { receiptBus } = require('../tp/broadcast');
const tpRoutes = require('./tp');

const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const ZERO = '0x0000000000000000000000000000000000000000';

const erc20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const curveI = new Interface(['function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)']);
const permit2I = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

const curveVenue = { kind: 'curve', token: TOKEN, curve: CURVE, pairToken: ZERO, nativeQuote: true, spenders: { approve: CURVE } };
const gradVenue = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: ZERO,
  nativeQuote: true,
  poolKey: { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
  poolId: '0x' + '11'.repeat(32),
  spenders: { approve: C.PERMIT2, permit2Router: C.UNIVERSAL_ROUTER },
};

/** Sends succeed; every receipt is already mined, status 1. */
const chain = {
  sent: [],
  async send(method, params) {
    assert.equal(method, 'eth_sendRawTransaction');
    this.sent.push(params[0]);
    return Transaction.from(params[0]).hash;
  },
  async getTransactionReceipt(hash) {
    const raw = this.sent.find((r) => Transaction.from(r).hash.toLowerCase() === hash);
    return { from: Transaction.from(raw).from, status: 1, blockNumber: 77, gasUsed: 50000n };
  },
};

const saved = {
  cachedVenue: venueMod.cachedVenue,
  refreshPhase: venueMod.refreshPhase,
  tpSendProvider: providersMod.tpSendProvider,
  tpReadProvider: providersMod.tpReadProvider,
  tpReceiptProvider: providersMod.tpReceiptProvider,
};
let server;
let base;

test.before(async () => {
  providersMod.tpSendProvider = () => chain;
  providersMod.tpReadProvider = () => chain;
  providersMod.tpReceiptProvider = () => chain; // the receipt polls
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/tp', tpRoutes);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/api/tp`;
});

test.after(() => {
  Object.assign(venueMod, { cachedVenue: saved.cachedVenue, refreshPhase: saved.refreshPhase });
  providersMod.tpSendProvider = saved.tpSendProvider;
  providersMod.tpReadProvider = saved.tpReadProvider;
  providersMod.tpReceiptProvider = saved.tpReceiptProvider;
  server.close();
  server.closeAllConnections();
});

test.beforeEach(() => {
  chain.sent.length = 0;
});

const post = async (body) => {
  const r = await fetch(`${base}/broadcast`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const signed = (w, to, data, nonce = 0) =>
  w.signTransaction({ type: 2, chainId: 4663, nonce, to, data, value: 0n, gasLimit: 300000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n });

test('POST /broadcast is wired: broadcastLimit first, no longer the notYet placeholder', () => {
  const layer = tpRoutes.stack.find((l) => l.route && l.route.path === '/broadcast' && l.route.methods.post);
  assert.ok(layer, 'POST /broadcast is registered');
  assert.equal(layer.route.stack[0].handle, tpRoutes.limiters.broadcastLimit, 'broadcastLimit is the first handler');
  const last = layer.route.stack[layer.route.stack.length - 1].handle;
  if (tpRoutes.notYet) assert.notEqual(last, tpRoutes.notYet, 'no longer the placeholder');
});

test('POST /broadcast sends a valid batch, returns hashes, and the receipts reach receiptBus', async () => {
  venueMod.cachedVenue = async () => curveVenue;
  const w = Wallet.createRandom();
  const raw = await signed(w, CURVE, curveI.encodeFunctionData('sell', [10n ** 18n, 1n, w.address]));
  const landed = new Promise((resolve) => {
    const on = (e) => {
      receiptBus.off('receipt', on);
      resolve(e);
    };
    receiptBus.on('receipt', on);
  });
  const r = await post({ token: TOKEN, txs: [raw] });
  assert.equal(r.status, 200);
  const hash = Transaction.from(raw).hash.toLowerCase();
  assert.deepEqual(r.body.results, [{ hash, from: w.address.toLowerCase(), nonce: 0, ok: true, error: null }]);
  assert.deepEqual(chain.sent, [raw]);
  assert.deepEqual(await landed, { token: TOKEN, hash, from: w.address.toLowerCase(), status: 'landed', block: 77, gasUsed: '50000' });
});

test('POST /broadcast refuses a batch with one bad transaction and sends nothing', async () => {
  venueMod.cachedVenue = async () => curveVenue;
  venueMod.refreshPhase = async (v) => v; // phase unchanged
  const w = Wallet.createRandom();
  const good = await signed(w, CURVE, curveI.encodeFunctionData('sell', [1n, 1n, w.address]), 0);
  const evil = await signed(w, TOKEN, erc20.encodeFunctionData('transfer', [ATTACKER, 1n]), 1);
  const r = await post({ token: TOKEN, txs: [good, evil] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'bad_tx');
  assert.match(r.body.error, /^tx 1: /);
  assert.equal(chain.sent.length, 0);
});

test('POST /broadcast re-reads the phase once when the page re-armed for a graduated token', async () => {
  let refreshed = 0;
  venueMod.cachedVenue = async () => curveVenue; // cached before graduation
  venueMod.refreshPhase = async () => {
    refreshed += 1;
    return gradVenue;
  };
  const w = Wallet.createRandom();
  const txs = [
    await signed(w, TOKEN, erc20.encodeFunctionData('approve', [C.PERMIT2, 10n ** 18n]), 0),
    await signed(w, C.PERMIT2, permit2I.encodeFunctionData('approve', [TOKEN, C.UNIVERSAL_ROUTER, 10n ** 18n, 1_900_000_000n]), 1),
  ];
  const r = await post({ token: TOKEN, txs });
  assert.equal(r.status, 200);
  assert.equal(refreshed, 1);
  assert.deepEqual(r.body.results.map((x) => x.ok), [true, true]);
  await new Promise((res) => setTimeout(res, 20)); // let the receipt watcher finish
});

test('POST /broadcast checks the body before touching the venue', async () => {
  venueMod.cachedVenue = async () => {
    throw new Error('must not be called');
  };
  let r = await post({ token: 'x', txs: ['0x00'] });
  assert.equal(r.body.code, 'bad_address');
  r = await post({ token: TOKEN, txs: [] });
  assert.equal(r.body.code, 'bad_request');
  r = await post({ token: TOKEN, txs: new Array(101).fill('0x00') });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'too_many');
  assert.equal(chain.sent.length, 0);
});

test('POST /broadcast answers 502 unavailable for an unexpected failure (the router\'s sendError), and sends nothing', async () => {
  venueMod.cachedVenue = async () => {
    throw new Error('ECONNRESET');
  };
  const w = Wallet.createRandom();
  const raw = await signed(w, CURVE, curveI.encodeFunctionData('sell', [1n, 1n, w.address]));
  const r = await post({ token: TOKEN, txs: [raw] });
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'the chain did not answer in time — try again', code: 'unavailable' });
  assert.equal(chain.sent.length, 0);
});

// ── receipts scoped to the stream that asked for them (plan Task 7) ─────────────
// The route looks the venue up through venue.cachedVenue (Part 02); resolveVenue is set
// too, so these tests do not depend on which of the two the route calls.
const useVenue = (fn) => {
  venueMod.cachedVenue = fn;
  venueMod.resolveVenue = fn;
};

test('POST /broadcast tags the receipts with the sid of the stream that will show them', async () => {
  useVenue(async () => curveVenue);
  const SID = 'ab'.repeat(16);
  const w = Wallet.createRandom();
  const raw = await signed(w, CURVE, curveI.encodeFunctionData('sell', [10n ** 18n, 1n, w.address]));
  const hash = Transaction.from(raw).hash.toLowerCase();
  const landed = new Promise((resolve) => {
    const on = (e) => {
      if (e.hash !== hash) return;
      receiptBus.off('receipt', on);
      resolve(e);
    };
    receiptBus.on('receipt', on);
  });
  const r = await post({ token: TOKEN, txs: [raw], sid: SID });
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].ok, true);
  const e = await landed;
  assert.equal(e.sid, SID);
  assert.equal(e.token, TOKEN);
});

test('POST /broadcast refuses a malformed sid before the venue lookup, and sends nothing', async () => {
  useVenue(async () => {
    throw new Error('must not be called');
  });
  const w = Wallet.createRandom();
  const raw = await signed(w, CURVE, curveI.encodeFunctionData('sell', [1n, 1n, w.address]));
  for (const sid of ['AB'.repeat(16), 'ab'.repeat(15), 'zz'.repeat(16), 42, ['ab'.repeat(16)]]) {
    const r = await post({ token: TOKEN, txs: [raw], sid });
    assert.equal(r.status, 400, JSON.stringify(sid));
    assert.equal(r.body.code, 'bad_request');
  }
  assert.equal(chain.sent.length, 0);
});
