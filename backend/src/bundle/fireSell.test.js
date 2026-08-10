'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, parseEther } = require('ethers');

const { fireSell } = require('./fireSell');

const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURVE = '0xca11a000000000000000000000000000000000a1';
const A = getAddress('0x1111111111111111111111111111111111111111');
const B = getAddress('0x2222222222222222222222222222222222222222');

// A plan as prepareSell produces it: everything already signed.
const plan = {
  action: 'sell',
  protocol: 'v2',
  route: 'curve',
  token: getAddress(TOKEN),
  symbol: 'AYE',
  decimals: 18,
  curve: getAddress(CURVE),
  isNativeQuote: true,
  minQuoteOut: '0',
  wallets: [
    {
      walletId: 'a',
      address: A,
      tokens: '1000.0',
      tokensRaw: (1000n * 10n ** 18n).toString(),
      estEthOut: '0.002',
      approve: { nonce: 7, raw: 'APPROVE_A' },
      sell: { nonce: 8, raw: 'SELL_A' },
    },
    {
      walletId: 'b',
      address: B,
      tokens: '500.0',
      tokensRaw: (500n * 10n ** 18n).toString(),
      estEthOut: '0.0009',
      approve: { nonce: 42, raw: 'APPROVE_B' },
      sell: { nonce: 43, raw: 'SELL_B' },
    },
  ],
  skipped: [],
  totalTokens: '1500.0',
  totalTokensRaw: (1500n * 10n ** 18n).toString(),
  chainId: '4663',
};

const GAS_SPENT = 21000n * 1_000_000_000n; // per transaction, in the fake receipts

/**
 * A node that records broadcast order, and whose native balances rise by a
 * fixed amount once a wallet's sell has been broadcast — which is what a sell
 * paying out looks like from the outside.
 */
function fakeNode({ order = [], proceeds = {}, sellStatus = {}, fail = () => false } = {}) {
  const sent = new Set();
  return {
    order,
    async broadcastTransaction(raw) {
      if (fail(raw)) throw new Error(`nonce too low for ${raw}`);
      order.push(raw);
      sent.add(raw);
      return { hash: `hash:${raw}` };
    },
    async getTransactionReceipt(hash) {
      const raw = String(hash).replace('hash:', '');
      const status = raw.startsWith('SELL_') ? sellStatus[raw] ?? 1 : 1;
      return {
        status,
        blockNumber: 100,
        gasUsed: 21000n,
        effectiveGasPrice: 1_000_000_000n,
        logs: [],
      };
    },
    async getBalance(addr) {
      const a = getAddress(addr);
      const raw = a === A ? 'SELL_A' : 'SELL_B';
      const base = parseEther('0.05');
      // Before the burst nothing has been sent, so the base is returned; after
      // it, the base plus the proceeds less the gas both transactions burned.
      if (!sent.has(raw)) return base;
      return base + (proceeds[a] ?? 0n) - GAS_SPENT * 2n;
    },
  };
}

const deps = (over = {}) => ({ dryRun: false, warmPool: async () => {}, ...over });

test('every wallet approves then sells, and all wallets go out together', async () => {
  const node = fakeNode();
  const res = await fireSell(plan, { provider: node, ...deps() });

  assert.equal(node.order.length, 4);
  // Within a wallet the order is fixed by the nonces; across wallets it is not.
  assert.ok(node.order.indexOf('APPROVE_A') < node.order.indexOf('SELL_A'));
  assert.ok(node.order.indexOf('APPROVE_B') < node.order.indexOf('SELL_B'));
  assert.equal(res.totals.sold, 2);
  assert.equal(res.totals.failed, 0);
});

test('no receipt is awaited before the whole burst is on the wire', async () => {
  const order = [];
  const node = fakeNode({ order });
  await fireSell(plan, {
    provider: node,
    ...deps({
      waitForReceipt: async (_rpc, hash) => {
        order.push(`RECEIPT:${hash}`);
        return { status: 1, blockNumber: 100, gasUsed: 21000n, effectiveGasPrice: 1_000_000_000n };
      },
    }),
  });

  const firstReceipt = order.findIndex((o) => o.startsWith('RECEIPT:'));
  for (const raw of ['APPROVE_A', 'SELL_A', 'APPROVE_B', 'SELL_B']) {
    assert.ok(order.indexOf(raw) < firstReceipt, `${raw} must precede any receipt`);
  }
});

test("one wallet's broadcast failure does not stop the others", async () => {
  const node = fakeNode({ fail: (raw) => raw === 'SELL_A' });
  const res = await fireSell(plan, { provider: node, ...deps() });

  const a = res.results.find((w) => w.walletId === 'a');
  const b = res.results.find((w) => w.walletId === 'b');
  assert.equal(a.sell.status, 'failed');
  assert.match(a.error, /nonce too low/);
  assert.equal(a.tokensSold, '0.0', 'a wallet whose sell failed keeps its tokens');
  assert.equal(b.sell.status, 'confirmed');
  assert.equal(res.totals.failed, 1);
  assert.equal(res.totals.sold, 1);
});

test('an approval that will not broadcast cancels its own sell rather than stranding it', async () => {
  // The sell sits at nonce n+1. Sending it with nothing at n leaves it queued
  // behind a gap that will never fill.
  const node = fakeNode({ fail: (raw) => raw === 'APPROVE_A' });
  const res = await fireSell(plan, { provider: node, ...deps() });

  assert.equal(node.order.includes('SELL_A'), false, 'the sell must not be sent into a nonce gap');
  const a = res.results.find((w) => w.walletId === 'a');
  assert.equal(a.approve.status, 'failed');
  assert.equal(a.sell.status, 'skipped');
  assert.match(a.error, /nonce too low/);
  assert.equal(node.order.includes('SELL_B'), true);
});

test('a reverted sell is reported as reverted, not as a sale', async () => {
  const node = fakeNode({ sellStatus: { SELL_B: 0 } });
  const res = await fireSell(plan, { provider: node, ...deps() });

  const b = res.results.find((w) => w.walletId === 'b');
  assert.equal(b.sell.status, 'reverted');
  assert.equal(b.tokensSold, '0.0');
  assert.equal(res.totals.sold, 1);
  assert.equal(res.totals.failed, 1);
});

test('proceeds and the best and worst fill are reported, because the tail fills worse', async () => {
  const node = fakeNode({
    proceeds: { [A]: parseEther('0.002'), [B]: parseEther('0.0005') },
  });
  const res = await fireSell(plan, { provider: node, ...deps() });

  const a = res.results.find((w) => w.walletId === 'a');
  const b = res.results.find((w) => w.walletId === 'b');
  assert.equal(a.ethReceived, '0.002');
  assert.equal(b.ethReceived, '0.0005');
  assert.equal(res.totals.ethReceived, '0.0025');
  assert.equal(res.totals.tokensSold, '1500.0');

  // a: 0.002 ETH for 1000 tokens. b: 0.0005 for 500 — half the price.
  assert.equal(res.fill.best.walletId, 'a');
  assert.equal(res.fill.worst.walletId, 'b');
  assert.ok(Number(res.fill.best.priceEth) > Number(res.fill.worst.priceEth));
});

test('the result names the token and symbol so it stands alone once the list refreshes', async () => {
  const node = fakeNode();
  const res = await fireSell(plan, { provider: node, ...deps() });
  assert.equal(res.token, getAddress(TOKEN));
  assert.equal(res.symbol, 'AYE');
  assert.equal(res.curve, getAddress(CURVE));
  assert.equal(res.route, 'curve');
});

test('a dry run broadcasts nothing', async () => {
  const node = fakeNode();
  const res = await fireSell(plan, { provider: node, ...deps({ dryRun: true }) });

  assert.equal(node.order.length, 0);
  assert.equal(res.simulated, true);
  assert.ok(res.results.every((w) => w.sell.status === 'simulated'));
  assert.equal(res.token, getAddress(TOKEN));
});

test('an unsigned plan is refused rather than signed late', async () => {
  const node = fakeNode();
  const half = {
    ...plan,
    wallets: [plan.wallets[0], { ...plan.wallets[1], sell: { nonce: 43, raw: undefined } }],
  };

  await assert.rejects(
    () => fireSell(half, { provider: node, ...deps() }),
    /1 wallet\(s\) are unsigned/
  );
  assert.equal(node.order.length, 0, 'nothing may be broadcast once the plan is known to be bad');
});

// The console reads a sell result straight off the response, so these field
// names ARE the contract. They were mismatched once already — the panel read
// `results` while this returned `wallets`, and the whole table came back empty
// after an irreversible action. Pinned here so it cannot happen again quietly.
test('the result carries exactly the fields the console renders', async () => {
  const node = fakeNode({
    proceeds: { [A]: parseEther('0.002'), [B]: parseEther('0.0005') },
  });
  const res = await fireSell(plan, { provider: node, ...deps() });

  assert.ok(Array.isArray(res.results), 'results[] — not wallets[]');
  assert.equal(res.totalEth, '0.0025');
  assert.equal(res.bestPrice, res.fill.best.priceEth);
  assert.equal(res.worstPrice, res.fill.worst.priceEth);

  for (const r of res.results) {
    assert.ok(r.address && r.walletId);
    assert.equal(typeof r.tokensSold, 'string');
    assert.equal(typeof r.ethReceived, 'string');
    // One rolled-up status to colour on, and both hashes to link.
    assert.equal(r.status, 'confirmed');
    assert.deepEqual(r.hashes, [r.approve.hash, r.sell.hash]);
  }
});

test('a wallet whose approval never broadcast rolls up as failed, with no hashes', async () => {
  const node = fakeNode({ fail: (raw) => raw === 'APPROVE_A' });
  const res = await fireSell(plan, { provider: node, ...deps() });

  const a = res.results.find((w) => w.walletId === 'a');
  assert.equal(a.status, 'failed');
  assert.deepEqual(a.hashes, []);
});

test('the result is JSON — no BigInt reaches the activity log', async () => {
  const node = fakeNode({ proceeds: { [A]: parseEther('0.002') } });
  const res = await fireSell(plan, { provider: node, ...deps() });
  assert.doesNotThrow(() => JSON.stringify(res));
});

// ── the v1 route fires through the same machinery ──────────────────────────
// Nothing in here is protocol-aware: prepareSell already signed both
// transactions, so a v1 plan differs only in what those bytes say. These pin
// that — a v1 exit has to report proceeds and survive a partial failure exactly
// as a v2 one does, because the operator reads the same table either way.

const v1Plan = {
  ...plan,
  protocol: 'v1',
  route: 'swap-router',
  curve: null,
  spender: getAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),
  // The swap's WETH output is unwrapped to the seller in the same transaction,
  // so the wallet's native balance is what moves.
  isNativeQuote: true,
};

test('a v1 sell reports proceeds and fills the same way a curve sell does', async () => {
  const node = fakeNode({
    proceeds: { [A]: parseEther('0.002'), [B]: parseEther('0.0005') },
  });
  const res = await fireSell(v1Plan, { provider: node, ...deps() });

  assert.equal(res.route, 'swap-router');
  assert.equal(res.curve, null);
  assert.equal(res.totals.sold, 2);
  assert.equal(res.totalEth, '0.0025');
  assert.equal(res.fill.best.walletId, 'a');
  assert.equal(res.fill.worst.walletId, 'b');
});

test("one v1 wallet's failure does not stop the other 26", async () => {
  const node = fakeNode({ fail: (raw) => raw === 'SELL_A' });
  const res = await fireSell(v1Plan, { provider: node, ...deps() });

  const a = res.results.find((w) => w.walletId === 'a');
  const b = res.results.find((w) => w.walletId === 'b');
  assert.equal(a.sell.status, 'failed');
  assert.equal(a.tokensSold, '0.0', 'a wallet whose sell failed keeps its tokens');
  assert.equal(b.sell.status, 'confirmed');
  assert.equal(res.totals.sold, 1);
  assert.equal(res.totals.failed, 1);
});

test('proceeds are not invented for a non-native quote asset', async () => {
  // The balance-delta trick only measures native ETH. For an ERC-20 pair the
  // proceeds arrive as that token, and reporting an ETH figure would be a lie.
  const node = fakeNode({ proceeds: { [A]: parseEther('0.002') } });
  const res = await fireSell(
    { ...plan, isNativeQuote: false },
    { provider: node, ...deps() }
  );

  assert.ok(res.results.every((w) => w.ethReceived === null));
  assert.equal(res.totals.ethReceived, null);
  assert.equal(res.fill, null);
});
