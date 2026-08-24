'use strict';

// The pons swap-zap client. Fund-critical: this is what tells a bundle wallet
// holding only ETH exactly which transaction to send to buy a non-ETH-paired
// token. The whole point is that the taker is the wallet itself (its exemption
// keeps the buy untaxed), so the body it POSTs is asserted field by field.
//
// Nothing here touches the network — fetch is injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');
const { getZapBuyTx, getZapPrice, waitForZapRoute } = require('./zeroexSwap');

const TOKEN = getAddress('0x' + 'dd'.repeat(20));
const TAKER = getAddress('0x' + '22'.repeat(20));
const SETTLER = getAddress('0x0000000000001fF3684f28c67538d4D072C22734');

// A fetch stand-in that captures the request and returns a canned response.
function fakeFetch(response, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return response;
      },
    };
  };
  return { impl, calls };
}

const OK_QUOTE = {
  quote: {
    buyAmount: '123456',
    needsAllowance: false,
    allowanceTarget: null,
    transaction: { to: SETTLER, data: '0xdeadbeef', value: '1000000000000000000' },
  },
};

test('getZapBuyTx POSTs sellToken:null, the taker, the wei amount and intent quote', async () => {
  const { impl, calls } = fakeFetch(OK_QUOTE);
  const tx = await getZapBuyTx(
    { buyToken: TOKEN, sellAmountWei: 10n ** 18n, taker: TAKER, slippageBps: 250 },
    { fetch: impl }
  );

  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.equal(body.sellToken, null, 'native ETH in is sellToken:null');
  assert.equal(getAddress(body.buyToken), TOKEN);
  assert.equal(body.sellAmountWei, '1000000000000000000', 'wei as a decimal string');
  assert.equal(getAddress(body.taker), TAKER, 'the taker is the wallet itself');
  assert.equal(body.slippageBps, 250);
  assert.equal(body.intent, 'quote', 'intent:quote asks for the sendable transaction');
  assert.equal(calls[0].opts.method, 'POST');
});

test('getZapBuyTx returns exactly {to,data,value} from quote.transaction', async () => {
  const { impl } = fakeFetch(OK_QUOTE);
  const tx = await getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 10n ** 18n, taker: TAKER }, { fetch: impl });
  assert.deepEqual(tx, { to: SETTLER, data: '0xdeadbeef', value: '1000000000000000000' });
});

test('getZapBuyTx surfaces a .error (no route) as a thrown message, not a silent skip', async () => {
  const { impl } = fakeFetch({ error: 'No route right now.' });
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: TAKER }, { fetch: impl }),
    /No route right now/
  );
});

test('getZapBuyTx throws when .quote is present but carries no transaction', async () => {
  const { impl } = fakeFetch({ quote: { buyAmount: '1' } });
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: TAKER }, { fetch: impl }),
    /no sendable transaction/
  );
});

test('getZapBuyTx throws a readable error on a non-2xx status', async () => {
  const { impl } = fakeFetch({ error: 'bad request' }, { status: 400 });
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: TAKER }, { fetch: impl }),
    /pons zap quote failed: bad request/
  );
});

test('getZapBuyTx refuses a missing taker — an un-declared recipient would be taxed', async () => {
  const { impl, calls } = fakeFetch(OK_QUOTE);
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: undefined }, { fetch: impl }),
    /taker is required/
  );
  assert.equal(calls.length, 0, 'nothing is requested when the input is invalid');
});

test('getZapPrice omits the taker and the intent — it is only a preview', async () => {
  const { impl, calls } = fakeFetch(OK_QUOTE);
  const price = await getZapPrice({ buyToken: TOKEN, sellAmountWei: 10n ** 18n, slippageBps: 100 }, { fetch: impl });
  const body = calls[0].body;
  assert.equal(body.sellToken, null);
  assert.equal('taker' in body, false, 'a price preview has no taker');
  assert.equal('intent' in body, false, 'a price preview omits intent');
  assert.equal(price.buyAmount, '123456');
});

test('getZapPrice reads buyAmount from a .price-shaped preview (the real preview shape)', async () => {
  // The live endpoint answers a taker-less preview under `.price`, not `.quote`.
  const { impl } = fakeFetch({ price: { buyAmount: '999', needsAllowance: false } });
  const price = await getZapPrice({ buyToken: TOKEN, sellAmountWei: 1n }, { fetch: impl });
  assert.equal(price.buyAmount, '999');
});

test('getZapPrice surfaces a no-route preview (.error, no .price) as a throw', async () => {
  const { impl } = fakeFetch({ error: 'No route for that pair.' });
  await assert.rejects(
    () => getZapPrice({ buyToken: TOKEN, sellAmountWei: 1n }, { fetch: impl }),
    /No route for that pair/
  );
});

// A fetch that returns a different canned response on each call, so the poll can
// see "no route" a few times and then a route appearing.
function sequencedFetch(responses) {
  let i = 0;
  const calls = [];
  const impl = async (url, opts) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({ body: JSON.parse(opts.body) });
    return { ok: true, status: 200, async json() { return r; } };
  };
  return { impl, calls, count: () => i };
}

// Deterministic clock: sleep advances it, now reads it — no wall time in the test.
function fakeClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms) => { clock += ms; } };
}

test('waitForZapRoute resolves as soon as the route appears, reporting the wait', async () => {
  const seq = sequencedFetch([
    { error: 'No route for that pair.' },
    { error: 'No route for that pair.' },
    { price: { buyAmount: '5' } },
  ]);
  const { now, sleep } = fakeClock();
  const r = await waitForZapRoute(
    { buyToken: TOKEN },
    { fetch: seq.impl, timeoutMs: 45_000, intervalMs: 1_500, now, sleep }
  );
  assert.equal(seq.count(), 3, 'polled until the route appeared');
  assert.equal(r.waitedMs, 3_000, 'reports the elapsed wait (two 1.5s intervals)');
});

test('waitForZapRoute is a routability probe — no taker, no intent in its body', async () => {
  const seq = sequencedFetch([{ price: { buyAmount: '5' } }]);
  const { now, sleep } = fakeClock();
  await waitForZapRoute({ buyToken: TOKEN }, { fetch: seq.impl, now, sleep });
  const body = seq.calls[0].body;
  assert.equal('taker' in body, false, 'the probe never bakes a taker');
  assert.equal('intent' in body, false, 'the probe never asks for a firm quote');
});

test('waitForZapRoute throws when the route never appears within the budget', async () => {
  const seq = sequencedFetch([{ error: 'No route for that pair.' }]);
  const { now, sleep } = fakeClock();
  await assert.rejects(
    () =>
      waitForZapRoute(
        { buyToken: TOKEN },
        { fetch: seq.impl, timeoutMs: 5_000, intervalMs: 1_500, now, sleep }
      ),
    /no route for the launched token after 5000ms/
  );
});

test('getZapBuyTx names a transport failure rather than leaking a raw fetch error', async () => {
  const impl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: TAKER }, { fetch: impl }),
    /pons zap endpoint unreachable: ECONNREFUSED/
  );
});
