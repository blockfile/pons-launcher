'use strict';

// fireV2 in ETH-zap mode (fireZap).
//
// The flow is: broadcast the launch, WAIT for it to confirm (the curve must
// exist before a zap can be quoted or sent), then fetch one quote per wallet
// with taker = that wallet, sign each at fire time, broadcast, collect receipts.
//
// These assert the properties that keep the money safe:
//   - the launch is confirmed BEFORE any quote is fetched;
//   - exactly one quote per wallet, each with taker = the wallet itself;
//   - each buy is signed with the wallet's own signer and broadcast;
//   - a wallet whose quote fails is SKIPPED with a reason, the rest still fire;
//   - if the launch never confirms, NO buy is attempted (nothing strands).
//
// Nothing here touches a chain or the network — provider, keystore and the zap
// client are all injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');
const { fireZap } = require('./fireV2');

const CURVE = getAddress('0x' + '11'.repeat(20));
const TOKEN = getAddress('0x' + '22'.repeat(20));
const WA = getAddress('0x' + 'aa'.repeat(20));
const WB = getAddress('0x' + 'bb'.repeat(20));
const SETTLER = getAddress('0x0000000000001fF3684f28c67538d4D072C22734');

const plan = {
  protocol: 'v2',
  mode: 'ethZap',
  bundleFunding: 'ethZap',
  token: TOKEN,
  curve: CURVE,
  pairToken: getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  pairSymbol: 'SPCX',
  slippageBps: 100,
  zapBuyGas: '900000',
  launch: { address: '0xdev', raw: 'LAUNCH' },
  buys: [
    { walletId: 'a', address: WA, amountEth: '0.5', amountIn: (5n * 10n ** 17n).toString(), exempt: true, zap: true },
    { walletId: 'b', address: WB, amountEth: '0.5', amountIn: (5n * 10n ** 17n).toString(), exempt: true, zap: true },
  ],
  fees: { type: 2, maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1' },
  chainId: '4663',
};

function fakeKeystore(signed) {
  return {
    signer: (id) => ({
      async signTransaction(tx) {
        signed.push({ id, tx });
        return `SIGNED:${id}:${tx.nonce}`;
      },
    }),
  };
}

function fakeProvider({ order = [], launchStatus = 1, buyStatus = 1, failBroadcast = null } = {}) {
  return {
    order,
    async broadcastTransaction(raw) {
      if (failBroadcast && failBroadcast(raw)) throw new Error('broadcast rejected');
      order.push(raw);
      return { hash: `hash:${raw}` };
    },
    async getTransactionReceipt(hash) {
      const raw = String(hash).replace('hash:', '');
      const status = raw === 'LAUNCH' ? launchStatus : buyStatus;
      return { status, blockNumber: 10, logs: [] };
    },
    async getTransactionCount() {
      return 7;
    },
  };
}

const baseDeps = (over = {}) => ({
  warmPool: async () => {},
  skipRecheck: true,
  parseLaunch: () => ({ token: TOKEN, curve: CURVE, pairToken: plan.pairToken }),
  // The real wait polls the network; default it to an instant no-op so the
  // money-path assertions below don't depend on timing. Tests that care about
  // the wait override it.
  waitForZapRoute: async () => ({ waitedMs: 0 }),
  ...over,
});

test('the launch confirms BEFORE any quote is fetched, and taker is always the wallet', async () => {
  const order = [];
  const signed = [];
  const quoteCalls = [];
  const rpc = fakeProvider({ order });

  const getZapBuyTx = async ({ buyToken, sellAmountWei, taker, slippageBps }) => {
    quoteCalls.push({ buyToken, sellAmountWei, taker, slippageBps });
    // The launch must already be on the wire and its receipt awaited before we
    // ever get here — assert the launch was broadcast first.
    assert.ok(order.includes('LAUNCH'), 'the launch must be broadcast before any quote');
    return { to: SETTLER, data: `0xzap${taker.slice(-4)}`, value: sellAmountWei };
  };

  const res = await fireZap(plan, baseDeps({ provider: rpc, keystore: fakeKeystore(signed), getZapBuyTx }));

  // One quote per wallet, each with taker = the wallet, buyToken = the token.
  assert.equal(quoteCalls.length, 2);
  const takers = quoteCalls.map((q) => getAddress(q.taker)).sort();
  assert.deepEqual(takers, [WA, WB].sort());
  for (const q of quoteCalls) {
    assert.equal(getAddress(q.buyToken), TOKEN);
    assert.equal(q.slippageBps, 100);
  }

  // Each wallet signed its own zap, at the fire-time nonce, and it was broadcast.
  assert.equal(signed.length, 2);
  assert.ok(signed.every((s) => s.tx.nonce === 7 && s.tx.gasLimit === 900000n));
  assert.equal(res.confirmed, 2);
  assert.equal(res.launch.status, 'confirmed');
  assert.equal(res.token, TOKEN);
});

test('a wallet whose quote fails is skipped with a reason; the rest still fire', async () => {
  const signed = [];
  const rpc = fakeProvider();
  const getZapBuyTx = async ({ taker, sellAmountWei }) => {
    if (getAddress(taker) === WA) throw new Error('No route right now.');
    return { to: SETTLER, data: '0xzap', value: sellAmountWei };
  };

  const res = await fireZap(plan, baseDeps({ provider: rpc, keystore: fakeKeystore(signed), getZapBuyTx }));

  const a = res.buys.find((b) => b.walletId === 'a');
  const b = res.buys.find((b) => b.walletId === 'b');
  assert.equal(a.status, 'skipped');
  assert.match(a.reason, /No route right now/);
  assert.equal(b.status, 'confirmed');
  // Only the surviving wallet signed and broadcast.
  assert.equal(signed.length, 1);
  assert.equal(signed[0].id, 'b');
  assert.equal(res.skipped, 1);
  assert.equal(res.confirmed, 1);
});

test('a broadcast failure fails only its own wallet', async () => {
  const signed = [];
  const rpc = fakeProvider({ failBroadcast: (raw) => raw === 'SIGNED:a:7' });
  const getZapBuyTx = async ({ sellAmountWei }) => ({ to: SETTLER, data: '0xzap', value: sellAmountWei });

  const res = await fireZap(plan, baseDeps({ provider: rpc, keystore: fakeKeystore(signed), getZapBuyTx }));
  const a = res.buys.find((b) => b.walletId === 'a');
  const b = res.buys.find((b) => b.walletId === 'b');
  assert.equal(a.status, 'failed');
  assert.match(a.error, /broadcast rejected/);
  assert.equal(b.status, 'confirmed');
});

test('if the launch does NOT confirm, no quote is fetched and no buy is sent', async () => {
  const order = [];
  const signed = [];
  let quotes = 0;
  const rpc = fakeProvider({ order, launchStatus: 0 });
  const getZapBuyTx = async ({ sellAmountWei }) => {
    quotes += 1;
    return { to: SETTLER, data: '0xzap', value: sellAmountWei };
  };

  const res = await fireZap(plan, baseDeps({ provider: rpc, keystore: fakeKeystore(signed), getZapBuyTx }));

  assert.equal(quotes, 0, 'no quote may be fetched when the curve was never created');
  assert.equal(signed.length, 0, 'nothing is signed');
  assert.equal(order.length, 1, 'only the launch was broadcast');
  assert.equal(res.launch.status, 'reverted');
  assert.ok(res.buys.every((b) => b.status === 'skipped'));
  assert.equal(res.confirmed, 0);
});

test('a curve that does not match the prediction aborts the buys', async () => {
  const signed = [];
  let quotes = 0;
  const OTHER = getAddress('0x' + '99'.repeat(20));
  const rpc = fakeProvider();
  const getZapBuyTx = async ({ sellAmountWei }) => {
    quotes += 1;
    return { to: SETTLER, data: '0xzap', value: sellAmountWei };
  };
  const res = await fireZap(
    plan,
    baseDeps({
      provider: rpc,
      keystore: fakeKeystore(signed),
      getZapBuyTx,
      parseLaunch: () => ({ token: TOKEN, curve: OTHER, pairToken: plan.pairToken }),
    })
  );
  assert.equal(quotes, 0, 'no buy may be quoted against the wrong curve');
  assert.match(res.mismatch, /refusing to zap-buy the wrong token/);
  assert.ok(res.buys.every((b) => b.status === 'skipped'));
});

test('fireZap WAITS for the aggregator route before quoting any wallet', async () => {
  // A freshly-launched curve is not indexed for a beat; fireZap must poll for the
  // route FIRST, then quote — never fire a quote that can only answer "No route".
  const events = [];
  const rpc = fakeProvider();
  const waitForZapRoute = async ({ buyToken }) => {
    events.push(`wait:${getAddress(buyToken)}`);
    return { waitedMs: 2500 };
  };
  const getZapBuyTx = async ({ sellAmountWei, taker }) => {
    events.push(`quote:${getAddress(taker)}`);
    return { to: SETTLER, data: '0xzap', value: sellAmountWei };
  };

  const res = await fireZap(
    plan,
    baseDeps({ provider: rpc, keystore: fakeKeystore([]), waitForZapRoute, getZapBuyTx })
  );

  assert.equal(events[0], `wait:${TOKEN}`, 'the route is awaited before the first quote');
  assert.ok(
    events.slice(1).every((e) => e.startsWith('quote:')),
    'every quote comes after the wait'
  );
  assert.equal(res.routeWaitedMs, 2500, 'the wait duration is reported');
  assert.equal(res.confirmed, 2);
});

test('if the route never appears, all buys are skipped and nothing is signed', async () => {
  const signed = [];
  let quotes = 0;
  const rpc = fakeProvider();
  const waitForZapRoute = async () => {
    throw new Error('pons zap: no route for the launched token after 45000ms (No route for that pair.)');
  };
  const getZapBuyTx = async ({ sellAmountWei }) => {
    quotes += 1;
    return { to: SETTLER, data: '0xzap', value: sellAmountWei };
  };

  const res = await fireZap(
    plan,
    baseDeps({ provider: rpc, keystore: fakeKeystore(signed), waitForZapRoute, getZapBuyTx })
  );

  assert.equal(quotes, 0, 'no quote is fetched once the route wait gives up');
  assert.equal(signed.length, 0, 'nothing is signed');
  assert.ok(res.buys.every((b) => b.status === 'skipped'));
  assert.match(res.buys[0].reason, /zap route never appeared/);
  assert.equal(res.confirmed, 0);
  assert.equal(res.skipped, plan.buys.length);
});

test('the keystore is required — fireZap refuses to sign without one', async () => {
  const rpc = fakeProvider();
  await assert.rejects(
    () => fireZap(plan, baseDeps({ provider: rpc, getZapBuyTx: async () => ({}) })),
    /needs a keystore/
  );
});
