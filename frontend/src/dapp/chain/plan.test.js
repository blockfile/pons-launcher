import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, Wallet, getAddress } from 'ethers';

import { planArm, planSell, planPairLeg, pctToBps, sellAmounts, sellRequests, attachQuotes, SKIP } from './plan.js';
import { NonceBook } from './nonces.js';
import { quoteCurveSell, applyCurveSell } from './curveMath.js';
import { NATIVE, PERMIT2, SWAP_ROUTER02, UNIVERSAL_ROUTER, USDG, WETH } from './constants.js';

const coder = AbiCoder.defaultAbiCoder();
const lc = (a) => String(a).toLowerCase();
const E18 = 10n ** 18n;
const NOW = 1_800_000_000;

const TOKEN = getAddress('0xd8865aa9052a5e2f59641bb613ca84ec9377b101');
const SPCX = getAddress('0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea');
const AMZN = getAddress('0x12f190a9f9d7d37a250758b26824b97ce941bf54');
const CURVE = getAddress('0x11b8bfae26690d21ae1963e5563062bc8bbc6ee2');
const HOOK = getAddress('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');

const FEES = {
  maxFeePerGas: '1000000000', // 1 gwei
  maxPriorityFeePerGas: '0',
  gasLimits: {
    approve: '100000',
    permit2Approve: '100000',
    sellCurve: '300000',
    sellV4: '500000',
    sellV1: '400000',
    pairSwap: '400000',
  },
};

const CURVE_VENUE = {
  kind: 'curve',
  token: TOKEN,
  curve: CURVE,
  pairToken: NATIVE,
  nativeQuote: true,
  phase: 0,
  spenders: { approve: CURVE },
};
// Task 3's curve Mark: curveFeeBps and creatorTaxBps, plus their sum feeBps.
const CURVE_MARK = {
  block: 1,
  price: 0,
  quoteReserve: String(3n * E18),
  tokenReserve: String(800_000_000n * E18),
  feeBps: 200,
  curveFeeBps: 100,
  creatorTaxBps: 100,
};
// The same curve as curveMath.js takes it.
const CURVE_START = { quoteReserve: 3n * E18, tokenReserve: 800_000_000n * E18, curveFeeBps: 100, creatorTaxBps: 100 };
const GRAD_VENUE = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: SPCX,
  nativeQuote: false,
  poolKey: { currency0: SPCX, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK },
  poolId: '0x048c7f7f128df4df2ca6394512ee2f949b9cff0ab4cb39ec84dd28aa8c39ff62',
  phase: 2,
  spenders: { approve: PERMIT2, permit2Router: UNIVERSAL_ROUTER },
};
const V1_VENUE = {
  kind: 'v1',
  token: TOKEN,
  pairToken: WETH,
  nativeQuote: true,
  poolFee: 10000,
  phase: null,
  spenders: { approve: SWAP_ROUTER02 },
};

function wallet(over = {}) {
  return {
    address: Wallet.createRandom().address,
    tokenBalance: String(1000n * E18),
    ethBalance: String(E18),
    nonce: 0,
    allowance: String(1000n * E18),
    permit2: null,
    ...over,
  };
}

/** A wallet holding `tokens` whole tokens, armed for all of them (curve / v1, and graduated via permit2). */
function holder(tokens, over = {}) {
  const units = String(BigInt(tokens) * E18);
  return wallet({ tokenBalance: units, allowance: units, permit2: { amount: units, expiration: NOW + 86400 }, ...over });
}

function book(wallets) {
  const nonces = new NonceBook();
  for (const w of wallets) nonces.seed(w.address, w.nonce);
  return nonces;
}

/** Every ordering of 0..n-1. */
function permutations(n) {
  if (n === 1) return [[0]];
  const out = [];
  for (const p of permutations(n - 1)) {
    for (let i = 0; i <= p.length; i += 1) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  }
  return out;
}

// A concave pool for the pool tests: constant product with a 1 % input fee that
// LEAVES the pool (as a V4 hook fee does), so selling x then y lands where
// selling x + y does, up to wei rounding.
const POOL0 = { t: 10n ** 9n * E18, q: 50n * E18 };
function poolSell(state, x) {
  const xi = (BigInt(x) * 99n) / 100n;
  const out = (state.q * xi) / (state.t + xi);
  return { out, next: { t: state.t + xi, q: state.q - out } };
}
const Q = (x) => poolSell(POOL0, x).out;

/** The /quote answer exactly as Task 4 builds it: cumulative, in request order, lower-case addresses. */
function answerFor(sells) {
  let S = 0n;
  let prev = 0n;
  return sells.map((s) => {
    S += BigInt(s.amount);
    const full = Q(S);
    const row = { address: lc(s.address), amountOut: String(full - prev), impactBps: 100, ok: true, reason: null };
    prev = full;
    return row;
  });
}

const curveIface = new Interface(['function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)']);
const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
const permit2 = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const universal = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
const router02 = new Interface([
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]);

test('two fast 50 % clicks sell 75 %, never 100 %', () => {
  const w = wallet();
  const nonces = book([w]);
  const first = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets: [w], pct: 50, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.equal(first[0].amount, 500n * E18);
  assert.equal(first[0].tx.nonce, 0);
  // The first click is in flight; the wallet read has not changed yet.
  const inflight = { [w.address]: first[0].amount };
  const second = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets: [w], pct: 50, slippageBps: 1500, fees: FEES, nonces, now: NOW, inflight });
  assert.equal(second[0].amount, 250n * E18);
  assert.equal(second[0].tx.nonce, 1);
  assert.equal(first[0].amount + second[0].amount, 750n * E18);
});

test('100 % is the exact balance; a fractional percent is exact in basis points', () => {
  const odd = 999999999999999999997n;
  const w = wallet({ tokenBalance: String(odd), allowance: String(odd) });
  assert.equal(sellAmounts({ wallets: [w], pct: 100 })[0].amount, odd);
  assert.equal(sellAmounts({ wallets: [w], pct: 33.33 })[0].amount, (odd * 3333n) / 10000n);
  assert.equal(sellAmounts({ wallets: [w], pct: 25 })[0].amount, odd / 4n);
  assert.equal(pctToBps(0.01), 1n);
  assert.throws(() => pctToBps(0.004), /between/);
  assert.throws(() => pctToBps(150), /between/);
  assert.throws(() => pctToBps('abc'), /number/);
  const inflight = new Map([[w.address.toLowerCase(), odd]]);
  assert.equal(sellAmounts({ wallets: [w], pct: 100, inflight })[0].amount, 0n, 'nothing left once all is in flight');
});

test('curve: expectedOut walks the reserves in send order, the curve giving up the GROSS', () => {
  const wallets = [holder(40_000_000), holder(10_000_000), holder(25_000_000), holder(5_000_000), holder(20_000_000)];
  const rows = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets, pct: 100, slippageBps: 1500, fees: FEES, nonces: book(wallets), now: NOW });
  // The walk by hand: each wallet is priced on the reserves the ones ahead of it
  // leave, the quote reserve falling by the gross (curveMath.test.js pins that
  // against a live CurveSell).
  let r = CURVE_START;
  let total = 0n;
  rows.forEach((row, i) => {
    assert.equal(row.reason, null);
    assert.equal(row.expectedOut, quoteCurveSell(r, row.amount), `wallet ${i} is estimated after the ${i} ahead of it`);
    total += row.expectedOut;
    r = applyCurveSell(r, row.amount);
    assert.ok(row.minOut <= row.worstOut && row.worstOut <= row.expectedOut, 'minOut <= worstOut <= expectedOut');
    const d = curveIface.decodeFunctionData('sell', row.tx.data);
    assert.equal(d[0], row.amount);
    assert.equal(d[1], row.minOut);
    assert.equal(d[2], getAddress(wallets[i].address), 'proceeds go to the wallet that sold');
    assert.equal(lc(row.tx.to), lc(CURVE));
  });
  assert.equal(r.tokenReserve, 800_000_000n * E18 + 100_000_000n * E18);
  assert.ok(total > 0n);
});

test('curve: every floor holds in EVERY landing order at slippage 0 — the click lands concurrently', () => {
  const wallets = [holder(40_000_000), holder(10_000_000), holder(25_000_000), holder(5_000_000)];
  const rows = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets, pct: 100, slippageBps: 0, fees: FEES, nonces: book(wallets), now: NOW });
  assert.ok(rows.every((row) => row.tx));
  for (const order of permutations(rows.length)) {
    let r = CURVE_START;
    for (const i of order) {
      const paid = quoteCurveSell(r, rows[i].amount); // what the chain pays (curveMath.test.js LIVE)
      assert.ok(paid >= rows[i].minOut, `order ${order}: wallet ${i} paid ${paid} < minOut ${rows[i].minOut}`);
      r = applyCurveSell(r, rows[i].amount);
    }
  }
  // Why the floor may not follow send order: the head, landing LAST, is paid
  // well under its send-order estimate — a floor at that estimate would revert.
  const others = [1, 2, 3].reduce((r, i) => applyCurveSell(r, rows[i].amount), CURVE_START);
  const headLast = quoteCurveSell(others, rows[0].amount);
  assert.ok(headLast < rows[0].expectedOut, 'landing order changes what a wallet is paid');
  assert.ok(headLast >= rows[0].minOut && headLast - rows[0].minOut <= 5n, 'and the floor is that worst case, to a few wei');
});

test('skip reasons; a skipped wallet neither moves the curve nor spends a nonce', () => {
  const empty = wallet({ tokenBalance: '0' });
  const unarmed = wallet({ allowance: String(10n * E18) });
  const broke = wallet({ ethBalance: '1000' });
  const ok = wallet({ nonce: 41 });
  const wallets = [empty, unarmed, broke, ok];
  const nonces = book(wallets);
  const rows = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets, pct: 50, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.deepEqual(rows.map((x) => x.reason), [SKIP.NO_BALANCE, SKIP.NOT_ARMED, SKIP.NO_GAS, null]);
  for (const x of rows.slice(0, 3)) {
    assert.equal(x.tx, null);
    assert.equal(x.amount, 0n);
  }
  // The only sender is alone in the click: estimated and floored on untouched
  // reserves (its worst case is itself, less the 1-wei rounding allowance).
  const alone = quoteCurveSell(CURVE_START, 500n * E18);
  assert.equal(rows[3].expectedOut, alone);
  assert.equal(rows[3].worstOut, alone - 1n);
  assert.equal(rows[3].minOut, ((alone - 1n) * 8500n) / 10000n);
  assert.equal(rows[3].tx.nonce, 41);
  for (const w of wallets.slice(0, 3)) assert.equal(nonces.peek(w.address), 0, 'no nonce spent');
});

test('a token-quoted curve needs gas for the pair -> ETH leg too', () => {
  const venue = { ...CURVE_VENUE, pairToken: AMZN, nativeQuote: false };
  // sellCurve alone = 300k gas; with approve + pairSwap = 800k gas, at 1 gwei.
  const justSell = wallet({ ethBalance: String(300000n * 1000000000n) });
  const enough = wallet({ ethBalance: String(800000n * 1000000000n) });
  const rows = planSell({ venue, mark: CURVE_MARK, wallets: [justSell, enough], pct: 50, slippageBps: 1500, fees: FEES, nonces: book([justSell, enough]), now: NOW });
  assert.equal(rows[0].reason, SKIP.NO_GAS);
  assert.equal(rows[1].reason, null);
});

test('graduated: permit2 missing, short or expiring means not armed; the order-free floor sets minOut', () => {
  const grant = { amount: String(1000n * E18), expiration: NOW + 86400 };
  const good = wallet({ permit2: grant });
  const noGrant = wallet({ permit2: null });
  const shortGrant = wallet({ permit2: { amount: String(E18), expiration: NOW + 86400 } });
  const expiring = wallet({ permit2: { amount: String(1000n * E18), expiration: NOW + 30 } });
  const unquoted = wallet({ permit2: grant });
  const wrongAmount = wallet({ permit2: grant });
  const refused = wallet({ permit2: grant });
  const bare = wallet({ permit2: grant });
  const wallets = [good, noGrant, shortGrant, expiring, unquoted, wrongAmount, refused, bare];
  const half = String(500n * E18);
  // attachQuotes' output shape, written out so each case is explicit.
  const quotes = new Map([
    [lc(good.address), { address: good.address, amount: half, amountOut: '1200000', worstOut: '1000000', impactBps: 10, ok: true, reason: null }],
    // A quote for a different size (an older chip) must not size this floor.
    [lc(wrongAmount.address), { address: wrongAmount.address, amount: '1', amountOut: '1200000', worstOut: '1000000', impactBps: 10, ok: true, reason: null }],
    [lc(refused.address), { address: refused.address, amount: half, amountOut: '0', worstOut: '0', impactBps: 9000, ok: false, reason: 'too thin' }],
    // A bare /quote row (no worstOut): not order-free, so not used.
    [lc(bare.address), { address: bare.address, amount: half, amountOut: '1200000', impactBps: 10, ok: true, reason: null }],
  ]);
  const rows = planSell({ venue: GRAD_VENUE, mark: {}, wallets, pct: 50, slippageBps: 1500, quotes, fees: FEES, nonces: book(wallets), now: NOW });
  assert.deepEqual(rows.map((x) => x.reason), [
    null,
    SKIP.NOT_ARMED,
    SKIP.NOT_ARMED,
    SKIP.NOT_ARMED,
    SKIP.NO_QUOTE,
    SKIP.NO_QUOTE,
    SKIP.NO_QUOTE,
    SKIP.NO_QUOTE,
  ]);
  assert.equal(rows[6].detail, 'too thin', "the backend's reason is carried for the UI");
  const row = rows[0];
  assert.equal(row.expectedOut, 1200000n);
  assert.equal(row.worstOut, 1000000n);
  assert.equal(row.minOut, 850000n, 'the floor is the WORST case less slippage');
  assert.equal(lc(row.tx.to), lc(UNIVERSAL_ROUTER));
  const [, inputs, deadline] = universal.decodeFunctionData('execute', row.tx.data);
  assert.equal(deadline, BigInt(NOW + 1200));
  const [, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [swap] = coder.decode(
    ['tuple(tuple(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)'],
    params[0]
  );
  assert.equal(swap.amountIn, 500n * E18);
  assert.equal(swap.amountOutMinimum, 850000n);
  const take = coder.decode(['address', 'address', 'uint256'], params[2]);
  assert.equal(take[1], getAddress(good.address), 'proceeds go to the wallet that sold');
});

test('v1: sells through SwapRouter02 with the quote floor', () => {
  const w = wallet();
  const sells = sellRequests({ wallets: [w], pct: 25 });
  const quotes = attachQuotes(sells, [{ address: lc(w.address), amountOut: String(E18), impactBps: 5, ok: true, reason: null }]);
  const rows = planSell({ venue: V1_VENUE, mark: {}, wallets: [w], pct: 25, slippageBps: 500, quotes, fees: FEES, nonces: book([w]), now: NOW });
  assert.equal(rows[0].reason, null);
  assert.equal(rows[0].amount, 250n * E18);
  assert.equal(rows[0].worstOut, E18, 'alone in the click, the worst case is its own quote');
  assert.equal(rows[0].minOut, (E18 * 9500n) / 10000n);
  assert.equal(lc(rows[0].tx.to), lc(SWAP_ROUTER02));
  assert.equal(rows[0].tx.gasLimit, 400000n);
});

test('pool: the /quote body is one row per wallet at its own amount, largest first, dust left out', () => {
  const big1 = holder(40_000_000);
  const small = holder(5_000_000);
  const mid = holder(25_000_000);
  const dust = wallet({ tokenBalance: '3', allowance: '3' });
  const empty = wallet({ tokenBalance: '0' });
  const sells = sellRequests({ wallets: [small, dust, big1, empty, mid], pct: 100 });
  assert.deepEqual(
    sells.map((s) => [s.address, s.amount]),
    [
      [big1.address, String(40_000_000n * E18)],
      [mid.address, String(25_000_000n * E18)],
      [small.address, String(5_000_000n * E18)],
    ]
  );
  // Equal amounts are ordered by address, so the body is reproducible.
  const a = holder(7);
  const b = holder(7);
  const tie = sellRequests({ wallets: [a, b], pct: 100 }).map((s) => lc(s.address));
  assert.deepEqual(tie, [lc(a.address), lc(b.address)].sort());
});

test('pool: floors are order-free — every landing order clears minOut; send-order floors would not', () => {
  const wallets = [holder(40_000_000), holder(10_000_000), holder(25_000_000), holder(5_000_000)];
  const sells = sellRequests({ wallets, pct: 100 });
  const answer = answerFor(sells);
  const quotes = attachQuotes(sells, answer);
  const S = sells.reduce((sum, s) => sum + BigInt(s.amount), 0n);

  // The smallest wallet is quoted last, against the whole click: exact.
  const smallest = sells[sells.length - 1];
  assert.equal(BigInt(quotes.get(lc(smallest.address)).worstOut), BigInt(answer[answer.length - 1].amountOut));
  // Every other floor is a lower bound on selling after all the rest.
  for (const s of sells) {
    const a = BigInt(s.amount);
    const q = quotes.get(lc(s.address));
    assert.equal(q.amount, s.amount);
    assert.ok(BigInt(q.worstOut) > 0n && BigInt(q.worstOut) <= Q(S) - Q(S - a), `${s.amount}: worstOut <= Q(S) - Q(S - a)`);
  }

  const rows = planSell({ venue: GRAD_VENUE, mark: {}, wallets, pct: 100, slippageBps: 1, quotes, fees: FEES, nonces: book(wallets), now: NOW });
  assert.ok(rows.every((r) => r.tx), 'every wallet is planned');
  const sumExpected = rows.reduce((sum, r) => sum + r.expectedOut, 0n);
  assert.equal(sumExpected, Q(S), 'the estimates add up to what the whole click pays');
  for (const order of permutations(rows.length)) {
    let state = POOL0;
    for (const i of order) {
      const { out, next } = poolSell(state, rows[i].amount);
      assert.ok(out >= rows[i].minOut, `order ${order}: wallet ${i} paid ${out} < minOut ${rows[i].minOut}`);
      state = next;
    }
  }
  // The largest wallet is quoted FIRST in the body; landing last it is paid far
  // under that row. A floor at the row (the old send-order floor) would revert.
  const first = rows[0];
  const rest = [1, 2, 3].reduce((st, i) => poolSell(st, rows[i].amount).next, POOL0);
  const paidLast = poolSell(rest, first.amount).out;
  assert.ok(paidLast < (first.expectedOut * 9999n) / 10000n, 'landing order changes what a wallet is paid');
});

test('pool: a tail refused by the saturation guard leaves every wallet unquoted, with the reason', () => {
  const wallets = [holder(40_000_000), holder(10_000_000), holder(25_000_000)];
  const sells = sellRequests({ wallets, pct: 100 });
  const answer = answerFor(sells);
  answer[2] = { ...answer[2], ok: false, impactBps: 6200, reason: 'the pool is too thin; sell a smaller %' };
  const quotes = attachQuotes(sells, answer);
  const rows = planSell({ venue: GRAD_VENUE, mark: {}, wallets, pct: 100, slippageBps: 1500, quotes, fees: FEES, nonces: book(wallets), now: NOW });
  assert.deepEqual(rows.map((r) => r.reason), [SKIP.NO_QUOTE, SKIP.NO_QUOTE, SKIP.NO_QUOTE]);
  assert.ok(rows.every((r) => r.detail === 'the pool is too thin; sell a smaller %'));
});

test('attachQuotes refuses an answer that does not line up with the body it answers', () => {
  const wallets = [holder(3), holder(2)];
  const sells = sellRequests({ wallets, pct: 100 });
  const answer = answerFor(sells);
  assert.throws(() => attachQuotes(sells, answer.slice(0, 1)), /does not match/);
  assert.throws(() => attachQuotes(sells, [answer[1], answer[0]]), /does not match/);
  assert.throws(() => attachQuotes(sells, [answer[0], { ...answer[1], address: lc(Wallet.createRandom().address) }]), /does not match/);
  assert.throws(() => attachQuotes([sells[0], sells[0]], [answer[0], answer[0]]), /does not match/);
  assert.throws(() => attachQuotes(sells, undefined), /does not match/);
});

test('every sell is a complete type-2 request for chain 4663 at priority 0, and ethers can sign it', async () => {
  const signer = Wallet.createRandom();
  const w = wallet({ address: signer.address, nonce: 3 });
  const [row] = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets: [w], pct: 50, slippageBps: 1500, fees: FEES, nonces: book([w]), now: NOW });
  const tx = row.tx;
  assert.deepEqual(
    Object.keys(tx).sort(),
    ['chainId', 'data', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce', 'to', 'type', 'value'].sort()
  );
  assert.equal(tx.chainId, 4663);
  assert.equal(tx.type, 2);
  assert.equal(tx.maxPriorityFeePerGas, 0n);
  assert.equal(tx.maxFeePerGas, 1000000000n);
  assert.equal(tx.gasLimit, 300000n);
  assert.equal(tx.value, 0n);
  assert.equal(tx.nonce, 3);
  const raw = await signer.signTransaction(tx);
  assert.match(raw, /^0x02/);
});

test('a venue whose spender is not the pinned contract is refused', () => {
  const w = wallet();
  const bad = { ...GRAD_VENUE, spenders: { approve: PERMIT2, permit2Router: SWAP_ROUTER02 } };
  assert.throws(() => planArm({ venue: bad, wallets: [w], fees: FEES, nonces: book([w]), now: NOW }), /refusing/);
  const bad2 = { ...CURVE_VENUE, spenders: { approve: SWAP_ROUTER02 } };
  assert.throws(() => planSell({ venue: bad2, mark: CURVE_MARK, wallets: [w], pct: 50, slippageBps: 1500, fees: FEES, nonces: book([w]), now: NOW }), /refusing/);
});

test('now must be seconds, slippage below 100 %, and a curve needs its fee and tax', () => {
  const w = wallet();
  const args = { venue: CURVE_VENUE, mark: CURVE_MARK, wallets: [w], pct: 50, slippageBps: 1500, fees: FEES, nonces: book([w]) };
  assert.throws(() => planSell({ ...args, now: Date.now() }), /SECONDS/);
  assert.throws(() => planSell({ ...args, now: NOW, slippageBps: 10000 }), /slippage/);
  assert.throws(() => planSell({ ...args, now: NOW, slippageBps: 1.5 }), /slippage/);
  const noFee = { block: 1, price: 0, quoteReserve: CURVE_MARK.quoteReserve, tokenReserve: CURVE_MARK.tokenReserve };
  assert.throws(() => planSell({ ...args, mark: noFee, now: NOW }), /no fee/);
  assert.throws(() => planSell({ ...args, mark: { ...noFee, curveFeeBps: 100 }, now: NOW }), /half/);
  assert.throws(() => planSell({ ...args, mark: { ...CURVE_MARK, feeBps: 300 }, now: NOW }), /does not add up/);
  assert.throws(() => planSell({ ...args, mark: {}, now: NOW }), /reserves/);
  // The sum alone still prices, floored once: never above the exact split figure.
  const [exact] = planSell({ ...args, nonces: book([w]), now: NOW });
  const [sumOnly] = planSell({ ...args, mark: { ...noFee, feeBps: 200 }, nonces: book([w]), now: NOW });
  assert.equal(sumOnly.reason, null, 'feeBps alone (the sum) is enough');
  assert.ok(sumOnly.expectedOut <= exact.expectedOut && exact.expectedOut - sumOnly.expectedOut <= 1n);
});

test('a field the server could not read (null) skips the wallet as state unavailable', () => {
  const noBalance = wallet({ tokenBalance: null });
  const noAllowance = wallet({ allowance: null });
  const noEth = wallet({ ethBalance: null });
  const wallets = [noBalance, noAllowance, noEth];
  const nonces = book(wallets);
  const rows = planSell({ venue: CURVE_VENUE, mark: CURVE_MARK, wallets, pct: 50, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.deepEqual(rows.map((x) => x.reason), [SKIP.UNREAD, SKIP.UNREAD, SKIP.UNREAD]);
  const grant = wallet({ permit2: { amount: null, expiration: null } });
  const [g] = planSell({ venue: GRAD_VENUE, mark: {}, wallets: [grant], pct: 50, slippageBps: 1500, quotes: new Map(), fees: FEES, nonces: book([grant]), now: NOW });
  assert.equal(g.reason, SKIP.UNREAD);
  const arm = planArm({ venue: CURVE_VENUE, wallets: [noEth], fees: FEES, nonces, now: NOW });
  assert.deepEqual(arm, [{ address: noEth.address, txs: [], reason: SKIP.UNREAD }]);
  for (const w of wallets) assert.equal(nonces.peek(w.address), 0, 'no nonce spent');
});

test('arm, curve: one exact approve of the balance to the curve; armed and empty wallets are left out', () => {
  const needs = wallet({ allowance: '0', nonce: 7 });
  const armed = wallet();
  const empty = wallet({ tokenBalance: '0', allowance: '0' });
  const nonces = book([needs, armed, empty]);
  const plan = planArm({ venue: CURVE_VENUE, wallets: [needs, armed, empty], fees: FEES, nonces, now: NOW });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].address, needs.address);
  assert.equal(plan[0].txs.length, 1);
  const tx = plan[0].txs[0];
  assert.equal(lc(tx.to), lc(TOKEN));
  const [spender, amount] = erc20.decodeFunctionData('approve', tx.data);
  assert.equal(lc(spender), lc(CURVE));
  assert.equal(amount, 1000n * E18);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.gasLimit, 100000n);
  assert.equal(tx.chainId, 4663);
});

test('arm, v1: approve the balance to SwapRouter02', () => {
  const w = wallet({ allowance: String(E18) });
  const [entry] = planArm({ venue: V1_VENUE, wallets: [w], fees: FEES, nonces: book([w]), now: NOW });
  const [spender, amount] = erc20.decodeFunctionData('approve', entry.txs[0].data);
  assert.equal(lc(spender), lc(SWAP_ROUTER02));
  assert.equal(amount, 1000n * E18);
});

test('arm, graduated: token -> Permit2 exact, then Permit2 -> router bounded to the balance for 24 h', () => {
  const fresh = wallet({ allowance: '0', permit2: null, nonce: 2 });
  const grantExpiring = wallet({ permit2: { amount: String(1000n * E18), expiration: NOW + 600 } });
  const done = wallet({ permit2: { amount: String(1000n * E18), expiration: NOW + 80000 } });
  const nonces = book([fresh, grantExpiring, done]);
  const plan = planArm({ venue: GRAD_VENUE, wallets: [fresh, grantExpiring, done], fees: FEES, nonces, now: NOW });
  assert.equal(plan.length, 2, 'the fully armed wallet is left out');

  const [a, b] = plan[0].txs;
  assert.equal(lc(a.to), lc(TOKEN));
  const [spender, amount] = erc20.decodeFunctionData('approve', a.data);
  assert.equal(lc(spender), lc(PERMIT2));
  assert.equal(amount, 1000n * E18);
  assert.equal(lc(b.to), lc(PERMIT2));
  const p = permit2.decodeFunctionData('approve', b.data);
  assert.equal(p[0], TOKEN);
  assert.equal(lc(p[1]), lc(UNIVERSAL_ROUTER));
  assert.equal(p[2], 1000n * E18);
  assert.equal(p[3], BigInt(NOW + 86400));
  assert.deepEqual([a.nonce, b.nonce], [2, 3], 'consecutive nonces');

  assert.equal(plan[1].txs.length, 1, 'an expiring grant is renewed without re-approving the token');
  assert.equal(lc(plan[1].txs[0].to), lc(PERMIT2));
});

test('arm: a wallet that cannot pay for approvals plus one sell is reported, not signed', () => {
  const broke = wallet({ allowance: '0', ethBalance: String(100000n * 1000000000n) });
  const nonces = book([broke]);
  const [entry] = planArm({ venue: CURVE_VENUE, wallets: [broke], fees: FEES, nonces, now: NOW });
  assert.deepEqual(entry.txs, []);
  assert.equal(entry.reason, SKIP.NO_GAS);
  assert.equal(nonces.peek(broke.address), 0, 'no nonce spent');
});

test('pair leg: approve exactly the proceeds to SwapRouter02, then swap to ETH, at consecutive nonces', () => {
  const venue = { ...CURVE_VENUE, pairToken: AMZN, nativeQuote: false };
  const signer = Wallet.createRandom();
  const nonces = new NonceBook();
  nonces.seed(signer.address, 9);
  const route = { amountOut: String(4n * 10n ** 15n), path: [AMZN, USDG, WETH], fees: [3000, 100], impactBps: 40, ok: true, reason: null };
  const leg = planPairLeg({ venue, address: signer.address, amountIn: 5n * E18, route, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.equal(leg.reason, null);
  assert.equal(leg.minOut, (4n * 10n ** 15n * 8500n) / 10000n);
  const [approve, swap] = leg.txs;
  assert.equal(lc(approve.to), lc(AMZN));
  const [spender, amount] = erc20.decodeFunctionData('approve', approve.data);
  assert.equal(lc(spender), lc(SWAP_ROUTER02));
  assert.equal(amount, 5n * E18);
  assert.equal(lc(swap.to), lc(SWAP_ROUTER02));
  assert.deepEqual([approve.nonce, swap.nonce], [9, 10]);
  assert.equal(swap.gasLimit, 400000n);

  const drained = planPairLeg({ venue, address: signer.address, amountIn: 5n * E18, route: { ...route, impactBps: 2500 }, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.equal(drained.reason, SKIP.IMPACT);
  assert.deepEqual(drained.txs, []);
  const other = { ...route, path: [SPCX, USDG, WETH] };
  assert.throws(() => planPairLeg({ venue, address: signer.address, amountIn: 5n * E18, route: other, slippageBps: 1500, fees: FEES, nonces, now: NOW }), /pair token/);
});

test('pair leg, USDG pair: one hop USDG -> WETH, exactly the route Task 4 quotes', () => {
  const venue = { ...CURVE_VENUE, pairToken: USDG, nativeQuote: false };
  const signer = Wallet.createRandom();
  const nonces = new NonceBook();
  nonces.seed(signer.address, 4);
  // Task 4 quotePairToEth's answer for a USDG pair (lower-case, one hop).
  const route = { amountOut: String(9n * 10n ** 15n), path: [lc(USDG), lc(WETH)], fees: [100], impactBps: 3, ok: true, reason: null };
  const leg = planPairLeg({ venue, address: signer.address, amountIn: 25n * 10n ** 6n, route, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.equal(leg.reason, null);
  const [approve, swap] = leg.txs;
  assert.equal(lc(approve.to), lc(USDG), 'USDG itself is approved');
  const [spender, amount] = erc20.decodeFunctionData('approve', approve.data);
  assert.equal(lc(spender), lc(SWAP_ROUTER02));
  assert.equal(amount, 25n * 10n ** 6n);
  const [calls] = router02.decodeFunctionData('multicall', swap.data);
  const [params] = router02.decodeFunctionData('exactInput', calls[0]);
  assert.equal(lc(params.path), '0x' + lc(USDG).slice(2) + '000064' + lc(WETH).slice(2));
  assert.equal(params.amountOutMinimum, (9n * 10n ** 15n * 8500n) / 10000n);
  assert.deepEqual([approve.nonce, swap.nonce], [4, 5]);
  // A USDG route on an AMZN venue is refused.
  const amznVenue = { ...venue, pairToken: AMZN };
  assert.throws(() => planPairLeg({ venue: amznVenue, address: signer.address, amountIn: 1n, route, slippageBps: 1500, fees: FEES, nonces, now: NOW }), /pair token/);
});

test('pair leg, graduated SPCX pool: the proceeds are SPCX, converted SPCX -> USDG -> WETH', () => {
  // The chain layer does not limit the ETH leg to curves: a graduated pool paired
  // with an ERC-20 pays that token, and the same leg converts it.
  const signer = Wallet.createRandom();
  const nonces = new NonceBook();
  nonces.seed(signer.address, 0);
  const route = { amountOut: String(2n * 10n ** 15n), path: [lc(SPCX), lc(USDG), lc(WETH)], fees: [3000, 100], impactBps: 12, ok: true, reason: null };
  const leg = planPairLeg({ venue: GRAD_VENUE, address: signer.address, amountIn: 7n * E18, route, slippageBps: 1500, fees: FEES, nonces, now: NOW });
  assert.equal(leg.reason, null);
  const [approve, swap] = leg.txs;
  assert.equal(lc(approve.to), lc(SPCX));
  const [spender, amount] = erc20.decodeFunctionData('approve', approve.data);
  assert.equal(lc(spender), lc(SWAP_ROUTER02));
  assert.equal(amount, 7n * E18);
  const [calls] = router02.decodeFunctionData('multicall', swap.data);
  const [params] = router02.decodeFunctionData('exactInput', calls[0]);
  assert.equal(lc(params.path), '0x' + lc(SPCX).slice(2) + '000bb8' + lc(USDG).slice(2) + '000064' + lc(WETH).slice(2));
  assert.equal(params.amountIn, 7n * E18);
  // A graduated sell reserves the gas for this leg too.
  const justSell = holder(1000, { ethBalance: String(500000n * 1000000000n) });
  const [row] = planSell({ venue: GRAD_VENUE, mark: {}, wallets: [justSell], pct: 50, slippageBps: 1500, quotes: new Map(), fees: FEES, nonces: book([justSell]), now: NOW });
  assert.equal(row.reason, SKIP.NO_GAS);
});
