import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, id } from 'ethers';
import { createSession } from './session.js';
import { createHub } from './hub.js';
import { createPairLedger } from './pairLedger.js';
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
const INFLIGHT = '0x0000000000000000000000000000000000000001';
/** The i-th of many wallets (never 0x...01, the session's in-flight label). */
const nth = (i) => '0x' + (0x1000 + i).toString(16).padStart(40, '0');

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
  peek(a) {
    return this.m.get(a.toLowerCase());
  }
}

function wallet(address, over = {}) {
  return { address, tokenBalance: '0', ethBalance: '1000000000000000000', nonce: 0, allowance: '0', permit2: null, ...over };
}

/** ui/pairLedger.js itself, in memory (no storage: the page without Remember). */
function memoryLedger() {
  return createPairLedger({ storage: null, hash: id });
}
/** What the ledger says a wallet is owed (0 when nothing). */
const owedIn = (ledger, addr) => (ledger.get(PAIR, addr) || { owed: 0n }).owed;

function harness({ venue, states, planSellCalls = [], real = false, live = true, pairLedger = null, fees: feesOver = {}, onVenue }) {
  const byAddr = new Map(states.map((s) => [s.address.toLowerCase(), s]));
  const log = { wallets: [], broadcast: [], quote: [], ahead: [], pair: [], token: 0 };
  const toasts = [];
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
    async postQuote(token, sells, opts) {
      log.quote.push(sells);
      log.ahead.push(opts && opts.ahead !== undefined ? String(opts.ahead) : null);
      return { quotes: sells.map((s) => ({ address: s.address, amountOut: (BigInt(s.amount) / 2n).toString(), impactBps: 10, ok: true, reason: null })) };
    },
    async postPairQuote(pairToken, amount) {
      log.pair.push(amount);
      return { amountOut: (BigInt(amount) * 2n).toString(), path: 'route', fees: [], impactBps: 5, ok: true, reason: null };
    },
    async getToken() {
      log.token += 1;
      throw new Error('no token read in this test');
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
      if (v.kind !== 'curve' && !q) return { address: w.address, amount: 0n, reason: 'no quote' };
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
    pairLedger,
  };
  const views = [];
  const hub = createHub();
  hub.on('toast', (t) => toasts.push(t));
  const own = { txs: new Set(), addrs: new Set() };
  const fees = {
    maxFeePerGas: '1',
    maxPriorityFeePerGas: '0',
    gasLimits: { approve: 50000, permit2Approve: 60000, sellCurve: 200000, sellV4: 300000, sellV1: 250000, pairSwap: 300000 },
    ...feesOver,
  };
  const mark = { block: 10, price: 0.000001, quoteReserve: '1000000000', tokenReserve: '1000000000' };
  const s = createSession({ venue, mark, fees, slippageBps: 1500, own, hub, deps, onView: (v) => views.push(v), onVenue });
  if (live) s.setLive(true);
  return {
    s,
    api,
    log,
    own,
    hub,
    byAddr,
    views,
    toasts,
    advance: (ms) => {
      clock += ms;
    },
    runTimers: async () => {
      for (let round = 0; round < 5; round += 1) {
        while (timers.length) timers.shift()();
        await flush();
      }
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
  await h.runTimers();
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
  Object.assign(h.byAddr.get(A), { pairBalance: '1000', tokenBalance: '500000', nonce: 1 }); // 100 held before + 900 proceeds
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
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
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['425']);
});

test('pool venue: every click quotes its OWN amounts exactly; the warm cache only feeds the preview', async () => {
  const calls = [];
  const h = harness({ venue: POOL, planSellCalls: calls, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  h.s.tick(); // the preview's cache: every wallet's FULL balance
  await flush();
  assert.equal(h.log.quote.length, 1);
  assert.deepEqual(h.log.quote[0], [{ address: A, amount: '1000000' }]);
  const pv = h.s.preview(50);
  assert.equal(pv.count, 1, pv.reason || '');
  assert.equal(pv.atLeast, true, 'a pool preview is scaled down from a full-balance quote: a lower bound');
  const planned = calls.length;
  h.advance(1500);
  await h.s.sell(50);
  assert.equal(h.log.quote.length, 2, 'the click asked for its own quote although the cache was warm');
  assert.deepEqual(h.log.quote[1], [{ address: A, amount: '500000' }]);
  assert.ok(calls.length > planned);
  assert.equal(calls.at(-1).quotes[0].amountOut, '250000');
  assert.equal(h.log.ahead[1], null, 'nothing in flight yet');
  await h.s.sell(50);
  assert.deepEqual(h.log.quote[2], [{ address: A, amount: '250000' }]);
  assert.equal(h.log.ahead[2], '500000', "a click is quoted BEHIND the tab's own sells still in flight");
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
  assert.deepEqual(Object.keys(v.rows[0]).sort(), [
    'address',
    'canConvert',
    'canSell',
    'detail',
    'ethBalance',
    'gasShort',
    'hash',
    'needsArm',
    'pairPending',
    'status',
    'ticked',
    'tokens',
  ]);
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
  phase: 0,
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
  phase: 2,
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
const permit2I = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const coder = AbiCoder.defaultAbiCoder();
/** The V4 swap inside a "signed" sell string — decoded as Task 10's plan.test.js graduated test does. */
function v4Sell(raw) {
  const data = raw.split('|')[3];
  const [, inputs, deadline] = universal.decodeFunctionData('execute', data);
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [swap] = coder.decode(
    ['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)'],
    params[0]
  );
  return { amountIn: swap.amountIn, minOut: swap.amountOutMinimum, deadline };
}
const sellOf = (raw) => {
  const { amountIn, minOut } = v4Sell(raw);
  return { amountIn, minOut };
};

/** A concave fake pool, Q(x) = x * K / (x + K), answered cumulatively in body order — behind `ahead` — as Task 4 does. */
function concavePool(h, K, capAt = null) {
  const Q = (x) => (x * K) / (x + K);
  h.api.postQuote = async (token, sells, opts) => {
    h.log.quote.push(sells);
    h.log.ahead.push(opts && opts.ahead !== undefined ? String(opts.ahead) : null);
    let S = opts && opts.ahead !== undefined ? BigInt(opts.ahead) : 0n;
    return {
      quotes: sells.map((s) => {
        const before = Q(S);
        S += BigInt(s.amount);
        const over = capAt !== null && S > capAt;
        return { address: s.address, amountOut: (Q(S) - before).toString(), impactBps: over ? 6000 : 10, ok: !over, reason: over ? 'the pool is too thin; sell a smaller %' : null };
      }),
    };
  };
  return Q;
}

test('graduated, REAL planSell: the click signs a sell priced from its own exact quote (never "no quote")', async () => {
  const h = harness({
    venue: REAL_POOL,
    real: true,
    states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 4, permit2: GRANT })],
  });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows[0].status, 'ready');
  h.s.tick(); // the preview cache: 1,000,000 tokens -> 500,000 wei (the fake pool pays half)
  await flush();
  h.advance(1500);
  const o1 = await h.s.sell(50);
  assert.deepEqual(o1.skipped, []);
  assert.equal(o1.sent, 1);
  assert.deepEqual(h.log.quote[1], [{ address: A, amount: '500000' }], 'an exact quote of this click');
  const raw1 = h.log.broadcast[0][0];
  assert.ok(raw1.startsWith(`raw|${A}|4|0x3593564c`), raw1); // UniversalRouter.execute
  // 500,000 -> 250,000 x (1 - 15 %) = 212,500
  assert.deepEqual(sellOf(raw1), { amountIn: 500000n, minOut: 212500n });

  h.s.onReceipt({ hash: `h:${raw1}`, status: 'landed', block: 20, gasUsed: '1' });
  const o2 = await h.s.sell(50);
  assert.deepEqual(o2.skipped, []);
  assert.equal(o2.sent, 1);
  assert.deepEqual(h.log.quote[2], [{ address: A, amount: '250000' }]);
  const raw2 = h.log.broadcast[1][0];
  assert.ok(raw2.startsWith(`raw|${A}|5|`), raw2);
  assert.deepEqual(sellOf(raw2), { amountIn: 250000n, minOut: 106250n });

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
  h.advance(1000);
  const out = await h.s.sell(50);
  assert.equal(out.sent, 1);
  assert.deepEqual(out.skipped, [{ address: B, reason: 'no gas' }]);
  assert.deepEqual(h.log.quote.at(-1), [{ address: A, amount: '500000' }], 'the gas-short wallet is not in the quote body');
  assert.equal(h.log.broadcast[0].length, 1);
  const sellRaw = h.log.broadcast[0][0];
  assert.deepEqual(sellOf(sellRaw), { amountIn: 500000n, minOut: 212500n }); // minOut is in SPCX units

  // The sell lands: 240,000 SPCX arrive (at least the 212,500 floor).
  Object.assign(h.byAddr.get(A), { pairBalance: '240000', tokenBalance: '500000', nonce: 5 });
  h.s.onReceipt({ hash: `h:${sellRaw}`, status: 'landed', block: 40, gasUsed: '1' });
  await h.runTimers();
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

test('graduated, REAL planSell, two wallets on a concave pool: floors are priced for the worst landing order, behind own sells in flight', async () => {
  // The session must hand planSell attachQuotes floors (worstOut: the wallet
  // landing after every other sell of the click), never the send-order row —
  // Task 10 contract notes 4 and 5.
  const h = harness({
    venue: REAL_POOL,
    real: true,
    states: [
      wallet(A, { tokenBalance: '3000000', allowance: '3000000', permit2: { amount: '3000000', expiration: 1000 + 86400 }, nonce: 0 }),
      wallet(B, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0 }),
    ],
  });
  const Q = concavePool(h, 4_000_000n);
  await h.s.loadWallets([A, B]);

  const o1 = await h.s.sell(50);
  assert.equal(o1.sent, 2);
  assert.deepEqual(h.log.quote[0], [
    { address: A, amount: '1500000' },
    { address: B, amount: '500000' },
  ]);
  const [rawA1, rawB1] = h.log.broadcast[0];
  // A's floor: 1,500,000 x 242,424 / 500,000 = 727,272 -> x 85 % = 618,181
  // (its send-order row 1,090,909 x 85 % = 927,272 would revert if A landed last:
  //  Q(2,000,000) - Q(500,000) = 888,889).
  assert.deepEqual(sellOf(rawA1), { amountIn: 1500000n, minOut: 618181n });
  assert.deepEqual(sellOf(rawB1), { amountIn: 500000n, minOut: 206060n });
  assert.ok(Q(2_000_000n) - Q(500_000n) >= 727_272n);

  // A second click before the first lands: quoted behind the 2,000,000 still in flight.
  const o2 = await h.s.sell(50);
  assert.equal(o2.sent, 2);
  assert.deepEqual(h.log.quote[1], [
    { address: A, amount: '750000' },
    { address: B, amount: '250000' },
  ]);
  assert.equal(h.log.ahead[1], '2000000');
  const [rawA2, rawB2] = h.log.broadcast[1];
  // A lands after the first click AND B at worst: Q(3,000,000) - Q(2,250,000) = 274,285 >= 253,968.
  assert.deepEqual(sellOf(rawA2), { amountIn: 750000n, minOut: 215872n });
  assert.deepEqual(sellOf(rawB2), { amountIn: 250000n, minOut: 71957n });
  assert.ok(Q(3_000_000n) - Q(2_250_000n) >= 253_968n);
});

// ── pool bodies hold only wallets that can sell (review: pool-body-includes-unsellable-wallets) ──
test('a ticked gas-short wallet and a still-arming wallet leave every other wallet floor unchanged', async () => {
  const K = 10_000_000n;
  const run = async (withOthers) => {
    const states = [wallet(A, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0 })];
    if (withOthers) {
      states.push(wallet(B, { tokenBalance: '8000000', allowance: '8000000', permit2: { amount: '8000000', expiration: 1000 + 86400 }, ethBalance: '1000', nonce: 0 }));
      states.push(wallet(C, { tokenBalance: '8000000', allowance: '0', nonce: 0 }));
    }
    const h = harness({ venue: REAL_POOL, real: true, states });
    concavePool(h, K);
    await h.s.loadWallets(states.map((s) => s.address));
    if (withOthers) {
      const [, b, c] = h.s.view().rows;
      assert.equal(b.status, 'skipped', 'B cannot pay for gas');
      assert.equal(c.status, 'arming', 'C is still being approved');
    }
    const out = await h.s.sell(25);
    assert.equal(out.sent, 1);
    return { body: h.log.quote.at(-1), raw: h.log.broadcast.at(-1)[0] };
  };
  const alone = await run(false);
  const crowd = await run(true);
  assert.deepEqual(crowd.body, [{ address: A, amount: '250000' }], 'only the wallet that can sell is quoted');
  assert.deepEqual(sellOf(crowd.raw), sellOf(alone.raw));
});

test('an unsellable wallet big enough to cross the pool impact cap does not stop the sellable ones', async () => {
  const states = [
    wallet(A, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0 }),
    wallet(B, { tokenBalance: '40000000', allowance: '40000000', permit2: { amount: '40000000', expiration: 1000 + 86400 }, ethBalance: '1000', nonce: 0 }),
  ];
  const h = harness({ venue: REAL_POOL, real: true, states });
  concavePool(h, 4_000_000n, 2_000_000n); // rows past 2,000,000 cumulative are refused
  await h.s.loadWallets([A, B]);
  const out = await h.s.sell(25);
  assert.equal(out.sent, 1, out.reason || JSON.stringify(out.skipped));
  assert.deepEqual(out.skipped, [{ address: B, reason: 'no gas' }]);
});

test('preview serves from the sellable-only cache', async () => {
  const states = [
    wallet(A, { tokenBalance: '1000000', allowance: '1000000', permit2: GRANT, nonce: 0 }),
    wallet(B, { tokenBalance: '8000000', allowance: '8000000', permit2: { amount: '8000000', expiration: 1000 + 86400 }, ethBalance: '1000', nonce: 0 }),
  ];
  const h = harness({ venue: REAL_POOL, real: true, states });
  concavePool(h, 10_000_000n);
  await h.s.loadWallets([A, B]);
  h.s.tick();
  await flush();
  assert.deepEqual(h.log.quote[0], [{ address: A, amount: '1000000' }]);
  const p = h.s.preview(50);
  assert.equal(p.count, 1, p.reason || '');
  assert.equal(p.skipped, 1);
});

test('a pool click refuses more than 100 wallets up front, with a reason', async () => {
  const states = Array.from({ length: 101 }, (_, i) => wallet(nth(i), { tokenBalance: '1000', allowance: '1000', nonce: 0 }));
  const h = harness({ venue: POOL, states });
  await h.s.loadWallets(states.map((s) => s.address));
  const out = await h.s.sell(50);
  assert.equal(out.sent, 0);
  assert.match(out.reason, /at most 100 wallets/);
  assert.equal(h.log.quote.length, 0);
});

test('a second pool click while 100 sells are in flight still quotes all 100 wallets, behind them', async () => {
  const states = Array.from({ length: 100 }, (_, i) => wallet(nth(i), { tokenBalance: '1000', allowance: '1000', nonce: 0 }));
  const h = harness({ venue: POOL, states });
  await h.s.loadWallets(states.map((s) => s.address));
  const o1 = await h.s.sell(25);
  assert.equal(o1.sent, 100);
  const o2 = await h.s.sell(25);
  assert.equal(o2.sent, 100, o2.reason || '');
  assert.equal(h.log.quote.at(-1).length, 100);
  assert.ok(!h.log.quote.at(-1).some((s) => s.address === INFLIGHT), 'what is in flight is not a row');
  assert.equal(h.log.ahead.at(-1), '25000', 'but the click is priced behind it');
});

// ── the pair -> ETH leg (review: pair-leg-owed-double-count, pair-proceeds-stranded-no-retry) ──
for (const own of ['1000', '0']) {
  test(`two sells land together: ONE leg swaps both proceeds and the visitor's own ${own} AMZN is never touched`, async () => {
    const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: own })] });
    await h.s.loadWallets([A]);
    await h.s.sell(25); // 250,000 -> expected 250, minOut 212
    await h.s.sell(25); // 187,500 -> expected 187, minOut 158
    const base = BigInt(own);
    Object.assign(h.byAddr.get(A), { nonce: 2, tokenBalance: '562500', pairBalance: String(base + 437n) });
    h.s.onReceipt({ hash: hashOfSell(A, 0, 250000), status: 'landed', block: 30, gasUsed: '1' });
    h.s.onReceipt({ hash: hashOfSell(A, 1, 187500), status: 'landed', block: 30, gasUsed: '1' });
    await h.runTimers();
    assert.deepEqual(h.log.pair, ['437']);
    const leg = h.log.broadcast.at(-1);
    assert.equal(leg[0], `raw|${A}|2|approve:${PAIR}:${ROUTER}:437`);
    Object.assign(h.byAddr.get(A), { nonce: 4, pairBalance: own });
    h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
    h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'landed', block: 31, gasUsed: '1' });
    await h.runTimers();
    for (let i = 0; i < 10; i += 1) h.s.tick();
    await h.runTimers();
    assert.deepEqual(h.log.pair, ['437'], 'no second leg');
    assert.equal(h.log.broadcast.length, 3);
    assert.equal(h.s.view().rows[0].pairPending, '0');
  });

  test(`a sell whose receipt arrives after the leg that already swapped its proceeds adds no leg (own ${own} AMZN)`, async () => {
    const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: own })] });
    await h.s.loadWallets([A]);
    await h.s.sell(25);
    await h.s.sell(25);
    const base = BigInt(own);
    Object.assign(h.byAddr.get(A), { nonce: 2, tokenBalance: '562500', pairBalance: String(base + 437n) }); // both on chain
    h.s.onReceipt({ hash: hashOfSell(A, 0, 250000), status: 'landed', block: 30, gasUsed: '1' });
    await h.runTimers();
    assert.deepEqual(h.log.pair, ['437'], 'the leg measured the balance: both sells are in it');
    const leg = h.log.broadcast.at(-1);
    Object.assign(h.byAddr.get(A), { nonce: 4, pairBalance: own });
    h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
    h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'landed', block: 31, gasUsed: '1' });
    await h.runTimers();
    h.s.onReceipt({ hash: hashOfSell(A, 1, 187500), status: 'landed', block: 30, gasUsed: '1' }); // late
    await h.runTimers();
    const row = h.s.view().rows[0];
    assert.equal(row.pairPending, '0', 'the leg already swapped the late sell’s proceeds: nothing owed');
    assert.doesNotMatch(row.detail, /waiting/, 'and no wait for a read that could never show them');
    for (let i = 0; i < 10; i += 1) h.s.tick();
    await h.runTimers();
    assert.deepEqual(h.log.pair, ['437']);
    assert.equal(h.log.broadcast.length, 3, 'no approve/swap for the late 158');
  });
}

test("a 'nonce too low' pair leg is rebuilt from a fresh read, never re-signed blindly", async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '1000' })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '1500' });
  h.api.onBroadcast = (txs, n) => {
    if (n !== 2) return txs.map((raw) => ({ hash: `h:${raw}`, ok: true }));
    // The leg already landed (an earlier copy): the chain moved on.
    Object.assign(h.byAddr.get(A), { nonce: 3, pairBalance: '1000' });
    return txs.map(() => ({ ok: false, error: 'nonce too low' }));
  };
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['500']);
  assert.equal(h.log.broadcast.length, 2, 'the refused leg was not re-signed');
  // The fresh read shows the proceeds gone — below what the landed sell guarantees.
  // One read never lowers what is owed; the shortfall is believed once it holds.
  for (let s = 0; s < 150; s += 5) {
    h.advance(5_000);
    for (let i = 0; i < 5; i += 1) h.s.tick();
    await h.runTimers();
  }
  assert.deepEqual(h.log.pair, ['500'], 'never a second leg');
  assert.equal(h.log.broadcast.length, 2);
  assert.equal(h.s.view().rows[0].pairPending, '0');
});

test('a leg refused for price impact retries on its own after a backoff, and Convert runs it at once', async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' })] });
  let impact = 1400;
  h.api.postPairQuote = async (pairToken, amount) => {
    h.log.pair.push(amount);
    return { amountOut: String(BigInt(amount) * 2n), path: 'route', fees: [], impactBps: impact, ok: impact <= 1000, reason: impact > 1000 ? 'too deep' : null };
  };
  await h.s.loadWallets([A]);
  await h.s.sell(100);
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '0', pairBalance: '1000' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['1000']);
  let row = h.s.view().rows[0];
  assert.equal(row.status, 'failed');
  assert.match(row.detail, /price impact over 10%/);
  assert.equal(row.canConvert, true);
  assert.equal(row.pairPending, '1000');
  assert.equal(h.s.view().totals.convertible, 1);

  for (let i = 0; i < 10; i += 1) h.s.tick();
  await h.runTimers();
  assert.equal(h.log.pair.length, 1, 'not hammered inside the backoff');
  h.advance(16_000);
  for (let i = 0; i < 5; i += 1) h.s.tick();
  await h.runTimers();
  assert.equal(h.log.pair.length, 2, 'retried on its own once the backoff passed');

  impact = 50;
  assert.equal(h.s.convertPair(A), 1);
  await h.runTimers();
  assert.equal(h.log.pair.length, 3, 'Convert does not wait for the (now doubled) backoff');
  const leg = h.log.broadcast.at(-1);
  assert.equal(leg[0], `raw|${A}|1|approve:${PAIR}:${ROUTER}:1000`);
  row = h.s.view().rows[0];
  assert.equal(row.canConvert, false, 'a leg in flight');
});

test('sweep settles a missed pair swap from the pair balance: a reverted swap is never reported done', async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '500' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.equal(h.log.broadcast.length, 2);
  // Both leg txs were mined (nonce 3) but the swap reverted: the 500 AMZN are still there.
  Object.assign(h.byAddr.get(A), { nonce: 3, pairBalance: '500' });
  h.advance(21_000);
  await h.s.sweep();
  await flush();
  const row = h.s.view().rows[0];
  assert.equal(row.status, 'reverted');
  assert.doesNotMatch(row.detail, /done/);
  assert.equal(row.pairPending, '500');
});

test('proceeds left in the pair token survive a reload: the next visit converts them, not the visitor’s own', async () => {
  const ledger = memoryLedger();
  const st = wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '1000' });
  const h1 = harness({ venue: AMZN_CURVE, states: [st], pairLedger: ledger });
  h1.api.postPairQuote = async (pairToken, amount) => {
    h1.log.pair.push(amount);
    return { amountOut: String(BigInt(amount) * 2n), path: 'route', fees: [], impactBps: 1400, ok: false, reason: 'too deep' };
  };
  await h1.s.loadWallets([A]);
  await h1.s.sell(100);
  Object.assign(st, { nonce: 1, tokenBalance: '0', pairBalance: '2000' });
  h1.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h1.runTimers();
  assert.deepEqual(h1.log.pair, ['1000'], 'refused: the 1000 AMZN proceeds stay in the wallet');
  h1.s.dispose();

  // The page reloads. The wallet holds no token any more, only 2000 AMZN (1000 its own).
  const h2 = harness({ venue: AMZN_CURVE, states: [{ ...st }], pairLedger: ledger });
  await h2.s.loadWallets([A]);
  const row = h2.s.view().rows[0];
  assert.ok(row, 'a wallet with unconverted proceeds stays listed at 0 tokens');
  assert.equal(row.pairPending, '1000');
  assert.equal(h2.s.convertPair(A), 1);
  await h2.runTimers();
  assert.deepEqual(h2.log.pair, ['1000'], 'the proceeds, not the whole 2000');
});

test("a pair balance that did not read at load is never taken as the visitor's baseline of 0", async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: null })] });
  await h.s.loadWallets([A]);
  await h.s.sell(25); // minOut 212
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '750000', pairBalance: '50250' }); // 50,000 of its own
  h.s.onReceipt({ hash: hashOfSell(A, 0, 250000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['212'], 'at most the landed minimum-out, never the whole 50,250');
});

// ── batched follow-ups (review: per-wallet-request-fanout-vs-rate-limits) ──
test('100 approvals landing together are confirmed with ONE /wallets read, not a hundred', async () => {
  const states = Array.from({ length: 100 }, (_, i) => wallet(nth(i), { tokenBalance: '1000', nonce: 0 }));
  const h = harness({ venue: CURVE, states });
  await h.s.loadWallets(states.map((s) => s.address));
  assert.equal(h.log.broadcast.length, 1);
  for (const s of states) s.allowance = '1000';
  const reads = h.log.wallets.length;
  for (const raw of h.log.broadcast[0]) h.s.onReceipt({ hash: `h:${raw}`, status: 'landed', block: 5, gasUsed: '1' });
  await h.runTimers();
  assert.equal(h.log.wallets.length - reads, 1);
  assert.equal(h.s.view().totals.sellable, 100);
});

test('100 pair legs: one read, two pair quotes, one broadcast request per 50 wallets', async () => {
  const states = Array.from({ length: 100 }, (_, i) => wallet(nth(i), { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' }));
  const h = harness({ venue: AMZN_CURVE, states });
  await h.s.loadWallets(states.map((s) => s.address));
  await h.s.sell(100); // each: expected 1000, minOut 850
  for (const s of states) Object.assign(s, { nonce: 1, tokenBalance: '0', pairBalance: '1000' });
  const reads = h.log.wallets.length;
  for (const s of states) h.s.onReceipt({ hash: hashOfSell(s.address, 0, 1000000), status: 'landed', block: 9, gasUsed: '1' });
  await h.runTimers();
  assert.ok(h.log.wallets.length - reads <= 2, `pair read + settle read (got ${h.log.wallets.length - reads})`);
  assert.deepEqual(h.log.pair, ['100000', '99000'], 'the whole batch, and the batch less its smallest leg');
  const legs = h.log.broadcast.slice(1);
  assert.equal(legs.length, 2);
  assert.deepEqual(
    legs.map((b) => b.length),
    [100, 100]
  );
  // Every leg is floored as if it landed LAST: 1000 x (200,000 - 198,000) / 1000 = 2000, x 85 %.
  assert.ok(legs[0][1].includes('|swap:1000:1700:'), legs[0][1]);
});

test("a re-read that fails never turns into a failed approval; Retry re-reads before it signs again", async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  const real = h.api.postWallets;
  h.api.postWallets = async () => {
    throw new Error('request failed (429)');
  };
  h.s.onReceipt({ hash: `h:raw|${A}|0|approve`, status: 'landed', block: 5, gasUsed: '1' });
  await h.runTimers();
  let row = h.s.view().rows[0];
  assert.equal(row.status, 'arming');
  assert.match(row.detail, /press Refresh/);
  assert.equal(h.s.view().totals.failedArm, 0, 'no Retry button that would pay for a second approval');

  // The allowance really does read short (the approval was front-run, say): failed.
  h.api.postWallets = real;
  await h.s.reload(); // the row rests at 'idle' / needs approval again, and re-arms at nonce 1
  assert.equal(h.log.broadcast.length, 2);
  h.s.onReceipt({ hash: `h:raw|${A}|1|approve`, status: 'landed', block: 6, gasUsed: '1' });
  await h.runTimers();
  row = h.s.view().rows[0];
  assert.equal(row.status, 'failed');
  assert.equal(h.s.view().totals.failedArm, 1);
  // ...then it lands after all: Retry reads first and signs nothing.
  h.byAddr.get(A).allowance = '1000';
  await h.s.arm({ retry: true });
  await flush();
  assert.equal(h.log.broadcast.length, 2, 'no second approval');
  assert.equal(h.s.view().rows[0].status, 'ready');
});

// ── the venue (review: venue-change-only-via-one-shot-phase) ──
test('a /wallets answer naming the graduated pool moves the session there and re-arms for Permit2', async () => {
  const moves = [];
  const h = harness({
    venue: REAL_CURVE,
    real: true,
    onVenue: (v) => moves.push(v),
    states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 3 })],
  });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows[0].status, 'ready');
  // The token graduated while the stream was away. The server reads allowances against Permit2 now.
  const onPool = wallet(A, { tokenBalance: '1000', allowance: '0', permit2: null, nonce: 3 });
  h.api.postWallets = async (token, addrs) => {
    h.log.wallets.push(addrs);
    return { venue: REAL_POOL, wallets: [{ ...onPool }] };
  };
  await h.s.reload();
  await h.runTimers();
  assert.equal(h.s.venue.kind, 'graduated');
  assert.deepEqual(moves, [REAL_POOL]);
  const arm = h.log.broadcast.at(-1);
  assert.equal(arm.length, 2);
  assert.ok(arm[0].startsWith(`raw|${A}|3|0x095ea7b3`) && arm[0].includes(PERMIT2.slice(2).toLowerCase()), 'token.approve(Permit2)');
  assert.ok(arm[1].startsWith(`raw|${A}|4|0x87517c45`), 'Permit2.approve(token, router)');
  assert.ok(!h.log.broadcast.flat().some((r) => r.includes(CURVE_ADDR.slice(2))), 'nothing is approved to the dead curve');
});

test('the same venue, another token or a step backwards is ignored', async () => {
  const h = harness({ venue: REAL_CURVE, real: true, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 3 })] });
  await h.s.loadWallets([A]);
  assert.equal(await h.s.applyVenue({ ...REAL_CURVE }), false);
  assert.equal(await h.s.applyVenue({ ...REAL_POOL, token: '0x' + '6'.repeat(40) }), false);
  assert.equal(h.s.venue.kind, 'curve');
  assert.equal(await h.s.applyVenue(REAL_POOL), true);
  assert.equal(await h.s.applyVenue(REAL_CURVE), false, 'a phase only moves forward');
  assert.equal(h.s.venue.kind, 'graduated');
});

// ── the curve mark (review: tp-max-tokens-exhaustion-freezes-mark, curve-floor-trusts-stale-mark) ──
test('with no live stream, a curve click reads a fresh mark first — and refuses when it cannot', async () => {
  const calls = [];
  const h = harness({ venue: CURVE, live: false, planSellCalls: calls, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  const fresh = { block: 50, price: 0.000002, quoteReserve: '2000000000', tokenReserve: '900000000' };
  h.api.getToken = async () => {
    h.log.token += 1;
    return { venue: CURVE, mark: fresh };
  };
  await h.s.loadWallets([A]);
  h.advance(6000);
  const o1 = await h.s.sell(50);
  assert.equal(o1.sent, 1);
  assert.equal(h.log.token, 1);
  assert.equal(calls.at(-1).mark.quoteReserve, fresh.quoteReserve);

  h.api.getToken = async () => {
    throw new Error('network error');
  };
  h.advance(6000);
  const o2 = await h.s.sell(50);
  assert.equal(o2.sent, 0);
  assert.match(o2.reason, /price feed/);
  assert.equal(h.log.broadcast.length, 1, 'no floor priced from a stale mark');
});

test('trades newer than the mark for over 1.5 s make it stale even while the stream is up', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  h.api.getToken = async () => {
    h.log.token += 1;
    return { venue: CURVE, mark: { block: 30, price: 1e-6, quoteReserve: '1000000000', tokenReserve: '1000000000' } };
  };
  await h.s.loadWallets([A]);
  h.s.onTrades([{ block: 20 }]);
  h.advance(1000);
  await h.s.sell(10);
  assert.equal(h.log.token, 0, 'within 1.5 s the mark may simply be on its way');
  h.advance(1000);
  await h.s.sell(10);
  assert.equal(h.log.token, 1);
});

// ── the chain's clock (review: deadline-and-permit2-expiry-from-local-clock) ──
test("deadlines and Permit2 expiries are dated by the chain's clock, not the PC's", async () => {
  const chainNow = 1000 + 3 * 86400; // the PC clock is three days slow
  const h = harness({
    venue: REAL_POOL,
    real: true,
    fees: { timestamp: chainNow },
    states: [wallet(A, { tokenBalance: '1000', allowance: '0', permit2: null, nonce: 0 })],
  });
  await h.s.loadWallets([A]);
  const [, p2] = h.log.broadcast[0];
  const [, , , expiration] = permit2I.decodeFunctionData('approve', p2.split('|')[3]);
  assert.ok(Math.abs(Number(expiration) - (chainNow + 86400)) <= 1, `expiration ${expiration}`);
  assert.ok(h.toasts.some((t) => /clock is off/.test(t.message)));
});

// ── a full load a block behind (review: optimistic-raised-by-stale-full-load) ──
test('a Refresh read a block behind cannot hand back tokens a sell just took', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500), status: 'landed', block: 12, gasUsed: '1' });
  await flush();
  assert.equal(h.s.view().rows[0].tokens, '500');
  await h.s.reload(); // the node still says 1000
  assert.equal(h.s.view().rows[0].tokens, '500');
});

test('an approval confirmed across a graduation is re-armed for the pool, never marked failed', async () => {
  const h = harness({ venue: REAL_CURVE, real: true, states: [wallet(A, { tokenBalance: '1000', allowance: '0', nonce: 3 })] });
  await h.s.loadWallets([A]);
  assert.equal(h.log.broadcast.length, 1, 'approve(curve)');
  // The curve approval lands, but by the time the page re-reads, the token has graduated.
  const onPool = wallet(A, { tokenBalance: '1000', allowance: '0', permit2: null, nonce: 4 });
  h.api.postWallets = async (token, addrs) => {
    h.log.wallets.push(addrs);
    return { venue: REAL_POOL, wallets: [{ ...onPool }] };
  };
  h.s.onReceipt({ hash: `h:${h.log.broadcast[0][0]}`, status: 'landed', block: 7, gasUsed: '1' });
  await h.runTimers();
  assert.equal(h.s.venue.kind, 'graduated');
  const row = h.s.view().rows[0];
  assert.notEqual(row.status, 'failed', row.detail);
  assert.equal(h.log.broadcast.length, 2, 'Permit2 approvals for the pool');
  assert.ok(h.log.broadcast[1][0].startsWith(`raw|${A}|4|0x095ea7b3`));
});

// ── the pair leg trusts no single read (review round 3: F2, F3, F9) ──────────
/** Serve the next `n` /wallets answers from a node behind the chain: `over` replaces each wallet's fields. */
function staleReads(h, n, over) {
  const real = h.api.postWallets;
  let left = n;
  h.api.postWallets = async (token, addrs) => {
    const res = await real(token, addrs);
    if (left <= 0) return res;
    left -= 1;
    return { ...res, wallets: res.wallets.map((w) => ({ ...w, ...over })) };
  };
  return () => left;
}

test('a pair read that lags its nonce never lowers what is owed: the leg waits and then swaps the real proceeds', async () => {
  const ledger = memoryLedger();
  const h = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '100' })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50); // expected 500, minOut 425
  // getTransactionCount reached a fresh node, the balance multicall one a block behind.
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '100' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, [], 'no leg from a read that cannot hold the landed proceeds');
  const row = h.s.view().rows[0];
  assert.equal(row.pairPending, '425', 'the landed minimum-out is still owed');
  assert.match(row.detail, /waiting for a fresh balance read/);
  assert.equal(owedIn(ledger, A), 425n, 'and remembered');

  h.byAddr.get(A).pairBalance = '1000'; // the node catches up: 100 of the visitor's own + 900 proceeds
  h.advance(16_000);
  for (let i = 0; i < 5; i += 1) h.s.tick();
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['900'], "the whole proceeds, never the visitor's 100");
});

test('a shortfall that holds across reads for a minute is believed: the leg stops waiting and swaps nothing', async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '100' })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  // The proceeds left the wallet some other way: every read shows the 100 alone.
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '100' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  for (let s = 0; s < 200; s += 5) {
    h.advance(5_000);
    for (let i = 0; i < 5; i += 1) h.s.tick();
    await h.runTimers();
  }
  assert.deepEqual(h.log.pair, [], 'never a swap of more than the balance above the baseline');
  assert.equal(h.s.view().rows[0].pairPending, '0');
  const reads = h.log.wallets.length;
  for (let s = 0; s < 120; s += 5) {
    h.advance(5_000);
    for (let i = 0; i < 5; i += 1) h.s.tick();
    await h.runTimers();
  }
  assert.ok(h.log.wallets.length - reads <= 1, 'and stops re-reading');
});

test("a read served behind the wallet's own landed leg is re-read, never measured: the visitor's pair tokens stay", async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '1000' })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50); // nonce 0: 500,000 -> minOut 425
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '1500' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['500']);
  const leg = h.log.broadcast.at(-1);
  Object.assign(h.byAddr.get(A), { nonce: 3, pairBalance: '1000' });
  h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
  h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'landed', block: 31, gasUsed: '1' });
  await h.runTimers();

  await h.s.sell(50); // nonce 3: 250,000 -> minOut 212
  Object.assign(h.byAddr.get(A), { nonce: 4, tokenBalance: '250000', pairBalance: '1250' });
  // The next reads reach a node from before the leg landed: nonce 1, 1,500 AMZN.
  const left = staleReads(h, 3, { nonce: 1, tokenBalance: '500000', pairBalance: '1500' });
  h.s.onReceipt({ hash: hashOfSell(A, 3, 250000), status: 'landed', block: 40, gasUsed: '1' });
  await h.runTimers();
  h.advance(16_000);
  for (let i = 0; i < 5; i += 1) h.s.tick();
  await h.runTimers();
  assert.equal(left(), 0, 'the stale reads were served');
  assert.deepEqual(h.log.pair, ['500', '250'], 'the 250 proceeds, never 500 again');
});

test('a reverted or refused pair swap writes its proceeds back to the ledger at once', async () => {
  for (const how of ['reverted', 'refused']) {
    const ledger = memoryLedger();
    const h = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' })] });
    await h.s.loadWallets([A]);
    await h.s.sell(100);
    Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '0', pairBalance: '1000' });
    if (how === 'refused') {
      h.api.onBroadcast = (txs, n) => txs.map((raw) => (n === 2 ? { ok: false, error: 'insufficient funds for gas * price + value' } : { hash: `h:${raw}`, ok: true }));
    }
    h.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
    await h.runTimers();
    assert.deepEqual(h.log.pair, ['1000'], how);
    if (how === 'reverted') {
      const leg = h.log.broadcast.at(-1);
      assert.equal(owedIn(ledger, A), 0n, 'written as if the swap will land while it is in flight');
      Object.assign(h.byAddr.get(A), { nonce: 3 });
      h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
      h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'reverted', block: 31, gasUsed: '1' });
      await flush();
    }
    assert.equal(owedIn(ledger, A), 1000n, `${how}: the proceeds are owed again`);
    assert.equal(h.s.view().rows[0].pairPending, '1000', how);
  }
});

test('a page closed while its pair swap is in flight lists nothing and sends nothing once that swap landed', async () => {
  const ledger = memoryLedger();
  const st = wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '300' });
  const h1 = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [st] });
  await h1.s.loadWallets([A]);
  await h1.s.sell(100);
  Object.assign(st, { nonce: 1, tokenBalance: '0', pairBalance: '1300' });
  h1.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h1.runTimers();
  assert.deepEqual(h1.log.pair, ['1000']);
  h1.s.dispose(); // closed before the leg's receipts

  Object.assign(st, { nonce: 3, pairBalance: '300' }); // the swap landed after the page closed
  const h2 = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [{ ...st }] });
  await h2.s.loadWallets([A]);
  assert.equal(h2.s.view().rows.length, 0, 'no token and nothing owed: not listed');
  for (let i = 0; i < 30; i += 1) h2.s.tick();
  await h2.runTimers();
  assert.deepEqual(h2.log.pair, []);
  assert.equal(h2.log.broadcast.length, 0);
});

// ── an earlier visit's proceeds are the visitor's to convert (review round 3: F1) ──
/** Visit 1: a 100 % sell whose leg is refused for impact, leaving 1000 AMZN of proceeds on top of `own`. */
async function leaveProceeds(ledger, own = 1000n) {
  const st = wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: String(own) });
  const h1 = harness({ venue: AMZN_CURVE, states: [st], pairLedger: ledger });
  h1.api.postPairQuote = async (pairToken, amount) => {
    h1.log.pair.push(amount);
    return { amountOut: String(BigInt(amount) * 2n), path: 'route', fees: [], impactBps: 1400, ok: false, reason: 'too deep' };
  };
  await h1.s.loadWallets([A]);
  await h1.s.sell(100);
  Object.assign(st, { nonce: 1, tokenBalance: '0', pairBalance: String(own + 1000n) });
  h1.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h1.runTimers();
  assert.deepEqual(h1.log.pair, ['1000']);
  h1.s.dispose();
  return st;
}

test("an earlier visit's proceeds are listed with Convert but never swapped without a click", async () => {
  const ledger = memoryLedger();
  const st = await leaveProceeds(ledger);
  const h2 = harness({ venue: AMZN_CURVE, states: [{ ...st }], pairLedger: ledger });
  await h2.s.loadWallets([A]);
  const row = h2.s.view().rows[0];
  assert.equal(row.pairPending, '1000');
  assert.equal(row.canConvert, true);
  for (let s = 0; s < 120; s += 5) {
    h2.advance(5_000);
    for (let i = 0; i < 5; i += 1) h2.s.tick();
    await h2.runTimers();
  }
  assert.deepEqual(h2.log.pair, [], 'two minutes of ticks: nothing converted on its own');
  assert.equal(h2.log.broadcast.length, 0);
  assert.equal(h2.s.convertPair(A), 1);
  await h2.runTimers();
  assert.deepEqual(h2.log.pair, ['1000'], 'the click converts the proceeds, not the 1000 of its own');
  assert.equal(h2.log.broadcast.at(-1)[0], `raw|${A}|1|approve:${PAIR}:${ROUTER}:1000`);
});

test('an entry is dropped when the wallet has sent a transaction the page did not (the visitor moved or re-bought)', async () => {
  const ledger = memoryLedger();
  const st = await leaveProceeds(ledger);
  // Between the visits: the 1000 AMZN are moved out and 1000 AMZN bought back to hold.
  Object.assign(st, { nonce: 3 });
  const h2 = harness({ venue: AMZN_CURVE, states: [{ ...st }], pairLedger: ledger });
  await h2.s.loadWallets([A]);
  assert.equal(h2.s.view().rows.length, 0, 'nothing listed');
  assert.equal(owedIn(ledger, A), 0n, 'and forgotten');
  assert.equal(h2.s.convertPair(A), 0);
  for (let i = 0; i < 30; i += 1) h2.s.tick();
  await h2.runTimers();
  assert.deepEqual(h2.log.pair, []);
});

test("an entry is clamped when the wallet holds less than the page recorded; the visitor's own pair tokens stay out", async () => {
  const ledger = memoryLedger();
  ledger.set(PAIR, A, 1000n, { nonce: 5, bal: 2000n }); // 1000 of its own + 1000 owed, next nonce 5
  const h = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [wallet(A, { tokenBalance: '0', nonce: 5, pairBalance: '1400' })] });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows[0].pairPending, '400');
  assert.equal(owedIn(ledger, A), 400n);
  h.s.convertPair(A);
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['400']);
});

test('a legacy entry without a nonce is not trusted', async () => {
  const ledger = memoryLedger();
  ledger.set(PAIR, A, 1000n, { bal: 5000n });
  const h = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [wallet(A, { tokenBalance: '0', nonce: 5, pairBalance: '5000' })] });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows.length, 0);
});

test("a sell of this session never takes an earlier visit's proceeds along: they wait for the click", async () => {
  const ledger = memoryLedger();
  ledger.set(PAIR, A, 1000n, { nonce: 0, bal: 2000n }); // 1000 of its own + 1000 carried
  const h = harness({ venue: AMZN_CURVE, pairLedger: ledger, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '2000' })] });
  await h.s.loadWallets([A]);
  assert.equal(h.s.view().rows[0].pairPending, '1000');
  await h.s.sell(50); // minOut 425
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '500000', pairBalance: '2500' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['500'], 'this sell’s 500 only');
  const leg = h.log.broadcast.at(-1);
  Object.assign(h.byAddr.get(A), { nonce: 3, pairBalance: '2000' });
  h.s.onReceipt({ hash: `h:${leg[0]}`, status: 'landed', block: 31, gasUsed: '1' });
  h.s.onReceipt({ hash: `h:${leg[1]}`, status: 'landed', block: 31, gasUsed: '1' });
  await h.runTimers();
  assert.equal(h.s.view().rows[0].pairPending, '1000', 'the carried proceeds are still offered');
  assert.equal(owedIn(ledger, A), 1000n);
  h.s.convertPair(A);
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['500', '1000']);
  const conv = h.log.broadcast.at(-1);
  Object.assign(h.byAddr.get(A), { nonce: 5, pairBalance: '1000' });
  h.s.onReceipt({ hash: `h:${conv[0]}`, status: 'landed', block: 32, gasUsed: '1' });
  h.s.onReceipt({ hash: `h:${conv[1]}`, status: 'landed', block: 32, gasUsed: '1' });
  await h.runTimers();
  assert.equal(h.s.view().rows[0].pairPending, '0');
  assert.equal(owedIn(ledger, A), 0n);
});

test("a Refresh read between a sell's landing and its receipt never becomes the baseline", async () => {
  const h = harness({ venue: AMZN_CURVE, states: [wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: null })] });
  await h.s.loadWallets([A]);
  await h.s.sell(25); // minOut 212
  // The sell is on chain (50,000 of the visitor's own + 250 proceeds) before its receipt reaches the page.
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '750000', pairBalance: '50250' });
  await h.s.reload();
  h.s.onReceipt({ hash: hashOfSell(A, 0, 250000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['212'], 'the landed minimum-out, never swallowed into a baseline');
});

test("the page's own sends on another token keep an earlier entry valid", async () => {
  const ledger = memoryLedger();
  const st = await leaveProceeds(ledger);
  // The visitor opens an ETH-quoted token and sells it from the same wallet (nonce 1 -> 2).
  const eth = harness({ venue: CURVE, pairLedger: ledger, states: [{ ...st, tokenBalance: '1000', allowance: '1000' }] });
  await eth.s.loadWallets([A]);
  await eth.s.sell(100);
  assert.equal(eth.log.broadcast.length, 1);
  eth.s.dispose();
  Object.assign(st, { nonce: 2 });
  const h2 = harness({ venue: AMZN_CURVE, states: [{ ...st }], pairLedger: ledger });
  await h2.s.loadWallets([A]);
  assert.equal(h2.s.view().rows[0].pairPending, '1000');
});

// ── a batch refused for impact is split, not retried whole forever (review round 3: F7) ──
test('a pair batch refused for price impact is split: what passes converts now, the rest shortly after', async () => {
  const states = Array.from({ length: 4 }, (_, i) => wallet(nth(i), { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' }));
  states.push(wallet(nth(9), { tokenBalance: '5000000', allowance: '5000000', nonce: 0, pairBalance: '0' }));
  const h = harness({ venue: AMZN_CURVE, states });
  // A thin AMZN route: anything over 2,000 AMZN moves it past the 10 % guard.
  h.api.postPairQuote = async (pairToken, amount) => {
    h.log.pair.push(amount);
    const deep = BigInt(amount) > 2000n;
    return { amountOut: String(BigInt(amount) * 2n), path: 'route', fees: [], impactBps: deep ? 1400 : 50, ok: !deep, reason: deep ? 'too deep' : null };
  };
  await h.s.loadWallets(states.map((s) => s.address));
  await h.s.sell(100);
  for (const s of states) Object.assign(s, { nonce: 1, tokenBalance: '0', pairBalance: String(BigInt(s === states[4] ? 5000 : 1000)) });
  for (const s of states) h.s.onReceipt({ hash: hashOfSell(s.address, 0, s === states[4] ? 5000000 : 1000000), status: 'landed', block: 9, gasUsed: '1' });
  await h.runTimers();
  const approvals = () =>
    h.log.broadcast
      .slice(1)
      .flat()
      .filter((raw) => raw.includes('|approve:'))
      .map((raw) => raw.split('|')[1]);
  assert.equal(h.log.pair[0], '9000', 'the whole batch first');
  assert.equal(approvals().length, 2, 'the half that passes converts at once');

  for (let s = 0; s < 30; s += 5) {
    h.advance(5_000);
    for (let i = 0; i < 5; i += 1) h.s.tick();
    await h.runTimers();
  }
  const done = approvals();
  assert.equal(done.length, 4, 'every wallet that passes on its own is converted');
  assert.equal(new Set(done).size, 4);
  assert.ok(!done.includes(states[4].address.toLowerCase()), 'the one leg too deep even alone stays');
  assert.equal(h.log.pair.filter((a) => a === '9000').length, 1, 'the refused batch is never quoted whole again');
  const big = h.s.view().rows.find((r) => r.address === states[4].address);
  assert.equal(big.pairPending, '5000');
  assert.match(big.detail, /price impact/);
});

// ── rows leaving the tab (Task 30): a synced removal or a Lock never resets the session ──
test('a wallet removed on another device while sells are in flight: the next 50 % sells 25 %, not 50 %', async () => {
  const calls = [];
  const h = harness({
    venue: CURVE,
    planSellCalls: calls,
    states: [
      wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 }),
      wallet(B, { tokenBalance: '1000', allowance: '1000', nonce: 0 }),
    ],
  });
  await h.s.loadWallets([A, B]);
  assert.equal((await h.s.sell(50)).sent, 2);
  // Another device removed B, and the same sync brought a wallet in: the page
  // reloads what the tab holds. The chain does not show A's sell yet.
  assert.deepEqual(h.s.removeRows([B]), { removed: 0, deferred: 1 });
  await h.s.loadWallets([A]);
  assert.deepEqual(
    h.s.view().rows.map((r) => [r.address, r.tokens]),
    [[A, '500']]
  );
  const out = await h.s.sell(50);
  assert.equal(out.sent, 1);
  assert.deepEqual(h.log.broadcast.at(-1), [`raw|${A}|1|sell:250`], '25 % of the position, never 50 % of it again');
  // the curve floor is still priced past BOTH sells in flight, the removed wallet's included
  assert.equal(calls[1].mark.tokenReserve, String(1_000_000_000 + 500 + 500));
});

test('a removed wallet with a sell in flight leaves the table at once, is never sold again, and goes once settled', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  assert.deepEqual(h.s.removeRows([A]), { removed: 0, deferred: 1 });
  assert.deepEqual(h.s.view().rows, []);
  const out = await h.s.sell(100);
  assert.equal(out.sent, 0);
  assert.equal(h.s.preview(50).count, 0);
  h.s.setAllTicked(true);
  await flush();
  assert.equal(h.log.broadcast.length, 1, 'nothing is signed for a wallet that left');
  h.s.tick();
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500), status: 'landed', block: 11, gasUsed: '1' });
  h.s.tick(); // settled: the row goes
  // Imported again later: a new row read from the chain (the wallet sent elsewhere meanwhile: nonce 7).
  Object.assign(h.byAddr.get(A), { tokenBalance: '500', nonce: 7 });
  await h.s.loadWallets([A]);
  assert.deepEqual(
    h.s.view().rows.map((r) => r.tokens),
    ['500']
  );
  await h.s.sell(100);
  assert.deepEqual(h.log.broadcast.at(-1), [`raw|${A}|7|sell:500`], 'a fresh row, its nonce seeded from the chain');
});

test('a wallet removed and loaded again before its sell settles keeps that sell counted', async () => {
  const h = harness({ venue: CURVE, states: [wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 })] });
  await h.s.loadWallets([A]);
  await h.s.sell(50);
  h.s.removeRows([A]); // e.g. Lock ...
  h.s.tick(); // ... still in flight: kept
  await h.s.loadWallets([A]); // ... and unlocked again at once; the chain still says 1000
  assert.deepEqual(
    h.s.view().rows.map((r) => [r.address, r.tokens, r.status]),
    [[A, '500', 'sent']]
  );
  await h.s.sell(50);
  assert.deepEqual(h.log.broadcast.at(-1), [`raw|${A}|1|sell:250`]);
  h.s.onReceipt({ hash: hashOfSell(A, 0, 500), status: 'landed', block: 11, gasUsed: '1' });
  h.s.tick();
  assert.equal(h.s.view().rows.length, 1, 'listed again: a settled sell does not drop it');
});

test("a removed wallet's pool sells in flight still ride ahead of the next click", async () => {
  const h = harness({
    venue: POOL,
    states: [
      wallet(A, { tokenBalance: '1000', allowance: '1000', nonce: 0 }),
      wallet(B, { tokenBalance: '1000', allowance: '1000', nonce: 0 }),
    ],
  });
  await h.s.loadWallets([A, B]);
  assert.equal((await h.s.sell(50)).sent, 2);
  h.s.removeRows([B]);
  const out = await h.s.sell(50);
  assert.equal(out.sent, 1);
  assert.deepEqual(h.log.quote.at(-1), [{ address: A, amount: '250' }]);
  assert.equal(h.log.ahead.at(-1), '1000', "A's 500 and B's 500 are still unmined");
});

test("a remote removal keeps the other wallets' owed pair legs; the removed wallet's proceeds stay on the ledger", async () => {
  const ledger = memoryLedger();
  const h = harness({
    venue: AMZN_CURVE,
    pairLedger: ledger,
    states: [
      wallet(A, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' }),
      wallet(B, { tokenBalance: '1000000', allowance: '1000000', nonce: 0, pairBalance: '0' }),
    ],
  });
  let impact = 1400;
  h.api.postPairQuote = async (pairToken, amount) => {
    h.log.pair.push(amount);
    return { amountOut: String(BigInt(amount) * 2n), path: 'route', fees: [], impactBps: impact, ok: impact <= 1000, reason: impact > 1000 ? 'too deep' : null };
  };
  await h.s.loadWallets([A, B]);
  await h.s.sell(100); // each: expected 1000 AMZN, minOut 850
  Object.assign(h.byAddr.get(A), { nonce: 1, tokenBalance: '0', pairBalance: '1000' });
  h.s.onReceipt({ hash: hashOfSell(A, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['1000'], "A's leg was refused for price impact: owed, retried after a backoff");

  h.s.removeRows([B]); // another device removed B while its sell is in flight
  Object.assign(h.byAddr.get(B), { nonce: 1, tokenBalance: '0', pairBalance: '1000' });
  h.s.onReceipt({ hash: hashOfSell(B, 0, 1000000), status: 'landed', block: 30, gasUsed: '1' });
  await h.runTimers();
  assert.equal(owedIn(ledger, B), 850n, "B's proceeds are remembered: an import lists them with Convert");

  impact = 50;
  h.advance(16_000);
  for (let i = 0; i < 5; i += 1) h.s.tick();
  await h.runTimers();
  assert.deepEqual(h.log.pair, ['1000', '1000'], "A's owed leg retried on its own");
  assert.equal(h.log.broadcast.at(-1)[0], `raw|${A}|1|approve:${PAIR}:${ROUTER}:1000`);
  assert.deepEqual(
    h.log.broadcast.flat().filter((raw) => raw.includes(`|${B}|`)),
    [`raw|${B}|0|sell:1000000`],
    'nothing but its own sell was ever signed for B'
  );
  assert.deepEqual(
    h.s.view().rows.map((r) => r.address),
    [A]
  );
});
