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
const { getZapBuyTx, getZapPrice } = require('./zeroexSwap');

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

test('getZapBuyTx names a transport failure rather than leaking a raw fetch error', async () => {
  const impl = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () => getZapBuyTx({ buyToken: TOKEN, sellAmountWei: 1n, taker: TAKER }, { fetch: impl }),
    /pons zap endpoint unreachable: ECONNREFUSED/
  );
});
