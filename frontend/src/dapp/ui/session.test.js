import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface } from 'ethers';
import { createSession } from './session.js';
import { createHub } from './hub.js';
import { planArm as realPlanArm, planSell as realPlanSell } from '../chain/plan.js';
import { NonceBook as RealNonceBook } from '../chain/nonces.js';
import { NATIVE, PERMIT2, UNIVERSAL_ROUTER } from '../chain/constants.js';

// ── fakes: no network, no keys. Addresses are plain hex, never derived from a key. ──
const TOKEN = '0x' + '7'.repeat(40);
const PAIR = '0x' + '9'.repeat(40);
const ROUTER = '0x' + '5'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

class FakeNonces {
  constructor() {
    this.m = new Map();
    this.resyncs = [];
  }
  seed(a, n) {
    this.m.set(a.toLowerCase(), n);
  }
  next(a) {
    const k = a.toLowerCase();
    if (!this.m.has(k)) throw new Error(`unseeded ${a}`);
    const n = this.m.get(k);
    this.m.set(k, n + 1);
    return n;
  }
  resync(a, n) {
    this.resyncs.push([a.toLowerCase(), n]);
    this.m.set(a.toLowerCase(), n);
  }
}

function wallet(address, over = {}) {
  return { address, tokenBalance: '0', ethBalance: '1000000000000000000', nonce: 0, allowance: '0', permit2: null, ...over };
}

function harness({ venue, states, planSellCalls = [], real = false }) {
  const byAddr = new Map(states.map((s) => [s.address.toLowerCase(), s]));
  const log = { wallets: [], broadcast: [], quote: [], pair: [] };
  const api = {
    onBroadcast: null,
    async postWallets(token, addrs) {
      log.wallets.push(addrs.map((a) => a.toLowerCase()));
      return { wallets: addrs.map((a) => byAddr.get(a.toLowerCase())).filter(Boolean).map((s) => ({ ...s })) };
    },
    async broadcast(token, txs) {
      log.broadcast.push(txs);
      if (api.onBroadcast) return { results: api.onBroadcast(txs, log.broadcast.length) };
      return { results: txs.map((raw) => ({ hash: `h:${raw}`, from: raw.split('|')[1], nonce: 0, ok: true, error: null })) };
    },
    async postQuote(token, sells) {
      log.quote.push(sells);
      return { quotes: sells.map((s) => ({ address: s.address, amountOut: (BigInt(s.amount) / 2n).toString(), impactBps: 10, ok: true, reason: null })) };
    },
    async postPairQuote(pairToken, amount) {
      log.pair.push(amount);
      return { amountOut: (BigInt(amount) * 2n).toString(), path: 'route', fees: [], impactBps: 5, ok: true, reason: null };
    },
  };
  const store = {
    async signTx(address, tx) {
      return `raw|${address.toLowerCase()}|${tx.nonce}|${tx.data}`;
    },
    addresses: () => states.map((s) => s.address),
  };
  function planArm({ venue: v, wallets, nonces }) {
    return wallets
      .filter((w) => BigInt(w.allowance) < BigInt(w.tokenBalance))
      .map((w) => ({ address: w.address, txs: [{ to: v.token, data: 'approve', value: 0n, nonce: nonces.next(w.address) }] }));
  }
  function planSell({ venue: v, mark, wallets, pct, slippageBps, quotes, nonces }) {
    planSellCalls.push({ wallets: wallets.map((w) => ({ ...w })), pct, quotes, mark });
    return wallets.map((w) => {
      const bal = BigInt(w.tokenBalance);
      const amount = pct >= 100 ? bal : (bal * BigInt(pct)) / 100n;
      if (amount === 0n) return { address: w.address, amount: 0n, reason: 'no balance' };
      if (BigInt(w.allowance) < amount) return { address: w.address, amount: 0n, reason: 'not armed' };
      const q = (quotes || []).find((x) => x.address.toLowerCase() === w.address.toLowerCase());
      const expectedOut = v.kind === 'curve' ? amount / 1000n : BigInt(q.amountOut);
      const minOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
      return { address: w.address, amount, expectedOut, minOut, tx: { to: 'SELL', data: `sell:${amount}`, value: 0n, nonce: nonces.next(w.address) } };
    });
  }
  let clock = 1_000_000;
  const timers = [];
  const deps = {
    api,
    store,
    // real: Task 10's planner and nonce book, exactly as ui/deps.js wires them.
    planArm: real ? realPlanArm : planArm,
    planSell: real ? realPlanSell : planSell,
    approveTx: (token, spender, amount) => ({ to: token, data: `approve:${token}:${spender}:${amount}`, value: 0n }),
    pairToEthTx: (route, amountIn, minOut, recipient, deadline) => ({ to: ROUTER, data: `swap:${amountIn}:${minOut}:${recipient}:${deadline}`, value: 0n }),
    NonceBook: real ? RealNonceBook : FakeNonces,
    swapRouter: ROUTER,
    hashOf: (raw) => `h:${raw}`,
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    sleep: () => Promise.resolve(),
    isHidden: () => false,
  };
  const views = [];
  const hub = createHub();
  const own = { txs: new Set(), addrs: new Set() };
  const fees = {
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '0',
    gasLimits: { approve: 50000, permit2Approve: 60000, sellCurve: 200000, sellV4: 300000, sellV1: 250000, pairSwap: 300000 },
  };
  const mark = { block: 10, price: 0.000001, quoteReserve: '1000000000', tokenReserve: '1000000000' };
  const s = createSession({ venue, mark, fees, slippageBps: 1500, own, hub, deps, onView: (v) => views.push(v) });
  return {
    s,
    api,
    log,
    own,
    hub,
    byAddr,
    views,
    advance: (ms) => {
      clock += ms;
    },
    runTimers: async () => {
      while (timers.length) timers.shift()();
      await flush();
    },
  };
}

const CURVE = { kind: 'curve', token: TOKEN, decimals: 18, nativeQuote: true, pairSymbol: 'ETH', pairDecimals: 18 };
const POOL = { kind: 'graduated', token: TOKEN, decimals: 18, nativeQuote: true, pairSymbol: 'ETH', pairDecimals: 18 };
const AMZN_CURVE = { kind: 'curve', token: TOKEN, decimals: 18, nativeQuote: false, pairToken: PAIR, pairSymbol: 'AMZN', pairDecimals: 18 };

const hashOfSell = (addr, nonce, amount) => `h:raw|${addr}|${nonce}|sell:${amount}`;

test('load keeps holders only, ticks them, and auto-arms the unapproved in ONE broadcast', async () => {
  const h = harness({
    venue: CURVE,
    states: [
      wallet(A, { tokenBalance: '1000000', nonce: 5 }),
      wallet(B, { tokenBalance: '2000000', allowance: '2000000', nonce: 7 }),
      wallet(C, { tokenBalance: '0', nonce: 1 }),
    ],
  });
  await h.s.loadWallets([A, B, C]);
  await flush();
  const v = h.s.view();
  assert.deepEqual(
    v.rows.map((r) => [r.address, r.ticked, r.status]),
    [
      [A, true, 'arming'],
      [B, true, 'ready'],
    ]
  );
  assert.equal(h.log.broadcast.length, 1);
  assert.deepEqual(h.log.broadcast[0], [`raw|${A}|5|approve`]);
  // the approval lands; the allowance now covers the balance
  h.byAddr.get(A).allowance = '1000000';
  h.s.onReceipt({ hash: `h:raw|${A}|5|approve`, status: 'landed', block: 11, gasUsed: '40000' });
  await flush();
  assert.equal(h.s.view().rows[0].status, 'ready');
  assert.equal(h.s.view().totals.sellable, 2);
});

test('a click sells from every ready wallet in one broadcast; two fast 50 % clicks sell 75 %', async () => {
  const calls = [];
  const h = harness({
    venue: CURVE,
    planSellCalls: calls,
    states: [
      wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 3 }),
      wallet(B, { tokenBalance: '2000000', allowance: '2000000', nonce: 8 }),
    ],
  });
  await h.s.loadWallets([A, B]);
  const r1 = h.s.sell(50);
  const r2 = h.s.sell(50);
  const [o1, o2] = await Promise.all([r1, r2]);
  assert.equal(o1.sent, 2);
  assert.equal(o2.sent, 2);
  assert.equal(h.log.broadcast.length, 2);
  assert.deepEqual(h.log.broadcast[0], [`raw|${A}|3|sell:500000`, `raw|${B}|8|sell:1000000`]);
  assert.deepEqual(h.log.broadcast[1], [`raw|${A}|4|sell:250000`, `raw|${B}|9|sell:500000`]);
  assert.deepEqual(
    h.s.view().rows.map((r) => r.tokens),
    ['250000', '500000']
  );
  assert.ok(h.own.txs.has(hashOfSell(A, 3, 500000)), 'own sells are recorded for the chart');
  // the second click priced against the curve walked forward by the first click's sells
  assert.equal(calls[0].mark.tokenReserve, '1000000000');
  assert.equal(calls[1].mark.tokenReserve, String(1_000_000_000 + 500_000 + 1_000_000));
});

test('a reverted sell gives its tokens back; a landed one stays sold', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500), status: 'reverted', block: 12, gasUsed: '1' });
  await flush();
  let row = h.s.view().rows[0];
  assert.equal(row.status, 'reverted');
  assert.equal(row.tokens, '1000');
  assert.match(row.detail, /15%/);
  await h.s.sell(100);
  h.s.onReceipt({ hash: hashOfSell(A, 1, 1000), status: 'landed', block: 13, gasUsed: '1' });
  await flush();
  row = h.s.view().rows[0];
  assert.equal(row.status, 'landed');
  assert.equal(row.tokens, '0');
});

test('a nonce gap resyncs from /wallets and re-signs ONCE; a second failure marks the row failed', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 4 })] });
  await h.s.loadWallets([A]);
  h.byAddr.get(A).nonce = 2; // the chain says 2
  h.api.onBroadcast = (txs, n) => txs.map((raw) => (n === 1 ? { ok: false, error: 'nonce too high' } : { hash: `h:${raw}`, ok: true }));
  await h.s.sell(50);
  assert.equal(h.log.broadcast.length, 2);
  assert.deepEqual(h.log.broadcast[1], [`raw|${A}|2|sell:500`]);
  assert.equal(h.s.view().rows[0].status, 'sent');

  h.api.onBroadcast = () => [{ ok: false, error: 'nonce too high' }];
  await h.s.sell(10);
  await flush();
  assert.equal(h.log.broadcast.length, 4, 'one retry, no more');
  assert.equal(h.s.view().rows[0].status, 'failed');
  assert.equal(h.s.view().rows[0].tokens, '500', 'the failed sell gave its tokens back');
});

test('a refused broadcast gives the tokens back and resyncs every wallet in ONE read', async () => {
  const h = harness({
    venue: CURVE,
    states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 }), wallet(B, { tokenBalance: '1000', allowance: '1000', nonce: 4 })],
  });
  await h.s.loadWallets([A, B]);
  const reads = h.log.wallets.length;
  h.api.onBroadcast = () => {
    throw new Error('429 rate limited');
  };
  const out = await h.s.sell(50);
  await flush();
  assert.equal(out.failed, 2);
  assert.deepEqual(
    h.s.view().rows.map((r) => [r.status, r.tokens]),
    [
      ['failed', '1000'],
      ['failed', '1000'],
    ]
  );
  assert.equal(h.log.wallets.length, reads + 1, 'one batched resync read');
  h.api.onBroadcast = null;
  await h.s.sell(50);
  assert.deepEqual(h.log.broadcast.at(-1), [`raw|${A}|0|sell:500`, `raw|${B}|4|sell:500`], 'the burnt nonces were given back');
});

test("'already known' is treated as sent, never re-signed", async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.api.onBroadcast = () => [{ ok: false, error: 'already known' }];
  const out = await h.s.sell(50);
  assert.equal(out.sent, 1);
  assert.equal(h.log.broadcast.length, 1);
  assert.equal(h.s.view().rows[0].status, 'sent');
});

test("a 'nonce too low' sell whose balance already dropped is recorded as landed, not sold twice", async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.byAddr.get(A).tokenBalance = '500';
  h.byAddr.get(A).nonce = 1;
  h.api.onBroadcast = () => [{ ok: false, error: 'nonce too low' }];
  await h.s.sell(50);
  await flush();
  assert.equal(h.log.broadcast.length, 1, 'no re-sign');
  assert.equal(h.s.view().rows[0].status, 'landed');
  assert.equal(h.s.view().rows[0].tokens, '500');
});

test('an early receipt (before the broadcast reply) still resolves the row', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.api.onBroadcast = (txs) => {
    h.s.onReceipt({ hash: `h:${txs[0]}`, status: 'landed', block: 20, gasUsed: '1' });
    return txs.map((raw) => ({ hash: `h:${raw}`, ok: true }));
  };
  await h.s.sell(50);
  await flush();
  assert.equal(h.s.view().rows[0].status, 'landed');
  // the same receipt again (a second stream during a timeframe switch) is ignored
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500), status: 'reverted', block: 20, gasUsed: '1' });
  assert.equal(h.s.view().rows[0].status, 'landed');
});

test('token-quoted curve: a landed sell swaps the NEW pair balance to ETH at consecutive nonces', async () => {
  const h = harness({
    venue: AMZN_CURVE,
    states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '100' })],
  });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  h.byAddr.get(A).pairBalance = '1000'; // 100 held before + 900 proceeds
  h.byAddr.get(A).tokenBalance = '500000';
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await flush();
  assert.deepEqual(h.log.pair, ['900'], 'the pre-existing 100 AMZN are left alone');
  const leg = h.log.broadcast[1];
  assert.equal(leg.length, 2);
  assert.equal(leg[0], `raw|${A}|1|approve:${PAIR}:${ROUTER}:900`);
  // quote 1800 x (1 - 15 %) = 1530
  assert.ok(leg[1].startsWith(`raw|${A}|2|swap:900:1530:`), leg[1]);
  const swapHash = `h:${leg[1]}`;
  h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
  h.s.onReceipt({ hash: swapHash, status: 'landed', block: 31, gasUsed: '1' });
  await flush();
  assert.equal(h.s.view().rows[0].status, 'landed');
  assert.match(h.s.view().rows[0].detail, /AMZN → ETH done/);
});

test('token-quoted curve without a pairBalance field swaps the guaranteed minimum-out', async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50); // expectedOut = 500, minOut = 425
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await flush();
  assert.deepEqual(h.log.pair, ['425']);
});

test('pool venue: a fresh quote cache means no quote request on the click; the click invalidates it', async () => {
  const calls = [];
  const h = harness({ venue: POOL, planSellCalls: calls, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.s.tick(); // cache refresh
  await flush();
  assert.equal(h.log.quote.length, 1);
  assert.deepEqual(h.log.quote[0], [{ address: A, amount: '1000000' }]);
  h.advance(1500);
  await h.s.sell(50);
  assert.equal(h.log.quote.length, 1, 'served from the cache');
  assert.equal(calls[0].quotes[0].amountOut, '250000', 'full-balance quote 500000 scaled to half');
  await h.s.sell(50);
  assert.equal(h.log.quote.length, 2, 'the first click invalidated the cache');
  assert.deepEqual(h.log.quote[1], [{ address: A, amount: '250000' }]);
});

test('a receipt missed during a reconnect is inferred from the nonce and the balance', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  h.byAddr.get(A).nonce = 1;
  h.byAddr.get(A).tokenBalance = '500';
  h.advance(21_000);
  await h.s.sweep();
  await flush();
  const row = h.s.view().rows[0];
  assert.equal(row.status, 'landed');
  assert.match(row.detail, /receipt not seen/);
});

test('the view carries addresses, balances and statuses only', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.api.onBroadcast = (txs) => txs.map(() => ({ hash: '0x' + 'f'.repeat(64), ok: true }));
  await h.s.sell(50);
  await flush();
  const v = h.views.at(-1);
  assert.deepEqual(Object.keys(v.rows[0]).sort(), ['address', 'canSell', 'detail', 'ethBalance', 'gasShort', 'hash', 'needsArm', 'status', 'ticked', 'tokens']);
  assert.ok(!JSON.stringify(v).includes('raw|'), 'no signed transaction reaches the view');
});

test('preview plans on a scratch nonce book and signs nothing', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  const p = h.s.preview(50);
  assert.equal(p.total, 500n);
  assert.equal(p.count, 1);
  await h.s.sell(50);
  assert.deepEqual(h.log.broadcast.at(-1), [`raw|${A}|0|sell:500000`], 'preview did not consume nonce 0');
});

// ── Task 10's REAL planner: harness({ real: true }) ──────────────────────────
// Venues must name the PINNED spenders or plan.js refuses them (checkSpenders):
// curve -> the curve itself; graduated -> Permit2 + UniversalRouter. SPCX and
// the poolKey are Task 10 plan.test.js's GRAD_VENUE fixture (SPCX: 18 decimals,
// backend/src/evm/v2/pairTokens.js:133). The session's clock is 1,000,000 ms,
// so planArm / planSell see now = 1000 s; the Permit2 grant below lives 24 h.
const CURVE_ADDR = '0x' + '3'.repeat(40);
const SPCX = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const GRANT = { amount: '1000000', expiration: 1000 + 86400 };
const REAL_CURVE = {
  kind: 'curve',
  token: TOKEN,
  curve: CURVE_ADDR,
  decimals: 18,
  nativeQuote: true,
  pairToken: NATIVE,
  pairSymbol: 'ETH',
  pairDecimals: 18,
  spenders: { approve: CURVE_ADDR },
};
const REAL_POOL = {
  kind: 'graduated',
  token: TOKEN,
  decimals: 18,
  nativeQuote: true,
  pairToken: NATIVE,
  pairSymbol: 'ETH',
  pairDecimals: 18,
  poolKey: { currency0: NATIVE, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
  spenders: { approve: PERMIT2, permit2Router: UNIVERSAL_ROUTER },
};
const SPCX_POOL = {
  ...REAL_POOL,
  nativeQuote: false,
  pairToken: SPCX,
  pairSymbol: 'SPCX',
  pairDecimals: 18,
  poolKey: { currency0: SPCX, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
};

const universal = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
const coder = AbiCoder.defaultAbiCoder();
/** The V4 swap inside a "signed" sell string — decoded as Task 10's plan.test.js graduated test does. */
function v4Sell(raw) {
  const data = raw.split('|')[3];
  const [, inputs] = universal.decodeFunctionData('execute', data);
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [swap] = coder.decode(
    ['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)'],
    params[0]
  );
  return { amountIn: swap.amountIn, minOut: swap.amountOutMinimum };
}

test('graduated, REAL planSell: cached AND fetched pool quotes carry their amount, so the click signs a sell (never "no quote")', async () => {
  const h = harness({
    venue: REAL_POOL,
    real: true,
    states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 4, permit2: GRANT })],
  });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows[0].status, 'ready');
  h.s.tick(); // quote cache: 1,000,000 tokens -> 500,000 wei (the fake pool pays half)
  await flush();
  h.advance(1500);
  const o1 = await h.s.sell(50);
  assert.deepEqual(o1.skipped, []);
  assert.equal(o1.sent, 1);
  assert.equal(h.log.quote.length, 1, 'served from the cache');
  const raw1 = h.log.broadcast[0][0];
  assert.ok(raw1.startsWith(`raw|${A}|4|0x3593564c`), raw1); // UniversalRouter.execute
  // the full-balance quote scaled to half: 250,000 x (1 - 15 %) = 212,500
  assert.deepEqual(v4Sell(raw1), { amountIn: 500000n, minOut: 212500n });

  const o2 = await h.s.sell(50); // the first click invalidated the cache: an exact quote for 250,000
  assert.deepEqual(o2.skipped, []);
  assert.equal(o2.sent, 1);
  assert.deepEqual(h.log.quote[1], [{ address: A, amount: '250000' }]);
  const raw2 = h.log.broadcast[1][0];
  assert.ok(raw2.startsWith(`raw|${A}|5|`), raw2);
  assert.deepEqual(v4Sell(raw2), { amountIn: 250000n, minOut: 106250n });

  h.s.tick(); // refill the cache for the preview
  await flush();
  const p = h.s.preview(50);
  assert.equal(p.count, 1, p.reason || 'preview plans through the same quote shape');
  assert.equal(p.total, 62500n); // 125,000 tokens -> half
});

test("REAL planArm: 'no gas' and 'state unavailable' are flagged, never read as armed; funding the wallet arms it", async () => {
  // approve 50,000 + sellCurve 200,000 gas at 1 wei = 250,000 wei to arm AND sell once.
  // A's 220,000 pays the sell alone: planArm answers {txs: [], reason: 'no gas'}, which
  // must not read as "no approval needed" (the row would say ready and every click skip it).
  const h = harness({
    venue: REAL_CURVE,
    real: true,
    states: [
      wallet(A, { tokenBalance: '1000', allowance: '0', ethBalance: '220000', nonce: 0 }),
      wallet(B, { tokenBalance: '1000', allowance: '1000', ethBalance: null, nonce: 3 }),
      wallet(C, { tokenBalance: '1000', allowance: '1000', nonce: 9 }),
    ],
  });
  await h.s.loadWallets([A, B, C]);
  await flush();
  const [a, b, c] = h.s.view().rows;
  assert.equal(a.status, 'skipped');
  assert.equal(a.needsArm, true);
  assert.equal(a.canSell, false);
  assert.match(a.detail, /ETH for gas/);
  assert.equal(b.status, 'failed');
  assert.equal(b.canSell, false);
  assert.match(b.detail, /state unavailable/);
  assert.equal(c.status, 'ready');
  assert.equal(c.canSell, true);
  assert.equal(h.s.view().totals.sellable, 1);
  assert.equal(h.log.broadcast.length, 0, 'no approval is sent for a wallet that could not then sell');

  h.byAddr.get(A).ethBalance = '1000000000000000000';
  await h.s.reload();
  await flush();
  assert.equal(h.log.broadcast.length, 1);
  assert.equal(h.log.broadcast[0].length, 1);
  assert.ok(h.log.broadcast[0][0].startsWith(`raw|${A}|0|0x095ea7b3`), 'approve(curve, balance) once funded');
  assert.equal(h.s.view().rows[0].status, 'arming');
  assert.equal(h.s.view().rows[1].status, 'failed', 'B stays flagged until its state reads');
});

test('graduated SPCX-paired, REAL planSell: the row reserves the pair-leg gas, and a landed sell swaps the SPCX to ETH', async () => {
  // sellV4 300,000 + approve 50,000 + pairSwap 300,000 = 650,000 wei at 1 wei/gas.
  // B's 400,000 pays the sell alone; planSell skips it 'no gas', so its row must not say ready.
  const h = harness({
    venue: SPCX_POOL,
    real: true,
    states: [
      wallet(A, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 4, pairBalance: '0' }),
      wallet(B, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0, ethBalance: '400000', pairBalance: '0' }),
    ],
  });
  await h.s.loadWallets([A, B]);
  const [a, b] = h.s.view().rows;
  assert.equal(a.status, 'ready');
  assert.equal(b.status, 'skipped');
  assert.equal(b.canSell, false);
  assert.match(b.detail, /ETH for gas/);
  h.s.tick();
  await flush();
  h.advance(1000);
  const out = await h.s.sell(50);
  assert.equal(out.sent, 1);
  assert.deepEqual(out.skipped, [{ address: B, reason: 'no gas' }]);
  assert.equal(h.log.broadcast[0].length, 1);
  const sellRaw = h.log.broadcast[0][0];
  assert.deepEqual(v4Sell(sellRaw), { amountIn: 500000n, minOut: 212500n }); // minOut is in SPCX units

  // The sell lands: 240,000 SPCX arrive (at least the 212,500 floor).
  h.byAddr.get(A).pairBalance = '240000';
  h.byAddr.get(A).tokenBalance = '500000';
  h.s.onReceipt({ hash: `h:${sellRaw}`, status: 'landed', block: 40, gasUsed: '1' });
  await flush();
  assert.deepEqual(h.log.pair, ['240000']);
  const leg = h.log.broadcast[1];
  assert.equal(leg.length, 2);
  assert.equal(leg[0], `raw|${A}|5|approve:${SPCX}:${ROUTER}:240000`);
  // pair quote 480,000 wei x (1 - 15 %) = 408,000, at the next consecutive nonce
  assert.ok(leg[1].startsWith(`raw|${A}|6|swap:240000:408000:`), leg[1]);
  h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 41, gasUsed: '1' });
  h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'landed', block: 41, gasUsed: '1' });
  await flush();
  assert.match(h.s.view().rows[0].detail, /SPCX → ETH done/);
});

test('graduated, REAL planSell, two wallets on a concave pool: cached AND fetched floors are priced for the worst landing order', async () => {
  // A concave fake pool, Q(x) = x * K / (x + K), answered cumulatively in body
  // order as Task 4 does. The session must hand planSell attachQuotes floors
  // (worstOut: the wallet landing after every other sell of the click), never
  // the send-order row — Task 10 contract notes 4 and 5.
  const K = 4_000_000n;
  const Q = (x) => (x * K) / (x + K);
  const h = harness({
    venue: REAL_POOL,
    real: true,
    states: [
      wallet(A, { tokenBalance: '3000000', allowance: '3000000', permit2: { amount: '3000000', expiration: 1000 + 86400 }, nonce: 0 }),
      wallet(B, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0 }),
    ],
  });
  h.api.postQuote = async (token, sells) => {
    h.log.quote.push(sells);
    let S = 0n;
    return {
      quotes: sells.map((s) => {
        const before = Q(S);
        S += BigInt(s.amount);
        return { address: s.address, amountOut: (Q(S) - before).toString(), impactBps: 10, ok: true, reason: null };
      }),
    };
  };
  await h.s.loadWallets([A, B]);
  h.s.tick(); // cache: [A 3,000,000 -> 1,714,285 ; B 1,000,000 -> 285,715], largest first
  await flush();
  assert.deepEqual(h.log.quote[0], [{ address: A, amount: '3000000' }, { address: B, amount: '1000000' }]);
  h.advance(1000);

  const o1 = await h.s.sell(50);
  assert.equal(o1.sent, 2);
  assert.equal(h.log.quote.length, 1, 'served from the cache');
  const [rawA1, rawB1] = h.log.broadcast[0];
  // A's cached worst-order floor 857,145 scaled to half = 428,572 -> x 85 % = 364,286
  // (A's send-order row, scaled, would have given 857,142 x 85 % = 728,570).
  assert.deepEqual(v4Sell(rawA1), { amountIn: 1500000n, minOut: 364286n });
  assert.deepEqual(v4Sell(rawB1), { amountIn: 500000n, minOut: 121428n });
  // what A is paid if it lands after B: Q(2,000,000) - Q(500,000) = 888,889 >= 428,572
  assert.ok(Q(2_000_000n) - Q(500_000n) >= 428_572n);

  const o2 = await h.s.sell(50); // cache invalidated: an exact quote of this click
  assert.equal(o2.sent, 2);
  assert.deepEqual(h.log.quote[1], [{ address: A, amount: '750000' }, { address: B, amount: '250000' }]);
  const [rawA2, rawB2] = h.log.broadcast[1];
  // attachQuotes: A's floor 750,000 x 168,422 / 250,000 = 505,266 -> x 85 % = 429,476
  // (its send-order row 631,578 x 85 % = 536,841 would revert if A landed last:
  //  Q(1,000,000) - Q(250,000) = 564,706).
  assert.deepEqual(v4Sell(rawA2), { amountIn: 750000n, minOut: 429476n });
  assert.deepEqual(v4Sell(rawB2), { amountIn: 250000n, minOut: 143158n });
});
