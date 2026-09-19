'use strict';

// Offline. Every transaction is signed here by a throwaway Wallet.createRandom()
// key; the "chain" is a fake provider that records sends and hands out receipts.
// Every broadcast() call injects `provider`, which also turns the configured
// TP_SEQUENCER_URL off (see broadcast.js), so no test can reach a real endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { AbiCoder, FetchRequest, Interface, JsonRpcProvider, Transaction, Wallet, solidityPacked } = require('ethers');

const C = require('./constants');
const { TpError } = require('./errors');
const { decodeRaw, validateTx, broadcast, watchReceipts, receiptBus, _private } = require('./broadcast');

const coder = AbiCoder.defaultAbiCoder();
const TOKEN = '0x1111111111111111111111111111111111111111';
const CURVE = '0x2222222222222222222222222222222222222222';
const V1_POOL = '0x3333333333333333333333333333333333333333';
const ATTACKER = '0x9999999999999999999999999999999999999999';
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const SPCX = '0xfffffffffffffffffffffffffffffffffffffff1'; // sorts ABOVE the token
const HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX160 = (1n << 160n) - 1n;

// ── the venues ───────────────────────────────────────────────────────────────
const curveNative = { kind: 'curve', token: TOKEN, curve: CURVE, pairToken: ZERO, nativeQuote: true, spenders: { approve: CURVE } };
const curveAmzn = { ...curveNative, pairToken: AMZN, nativeQuote: false };
const curveUsdg = { ...curveNative, pairToken: C.USDG, nativeQuote: false };
const nativeKey = { currency0: ZERO, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK };
const gradNative = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: ZERO,
  nativeQuote: true,
  poolKey: nativeKey,
  poolId: '0x' + '11'.repeat(32),
  spenders: { approve: C.PERMIT2, permit2Router: C.UNIVERSAL_ROUTER },
};
const spcxKey = { currency0: TOKEN, currency1: SPCX, fee: 0, tickSpacing: 200, hooks: HOOK };
const gradSpcx = { ...gradNative, pairToken: SPCX, nativeQuote: false, poolKey: spcxKey };
const v1Venue = { kind: 'v1', token: TOKEN, pool: V1_POOL, pairToken: C.WETH, nativeQuote: true, spenders: { approve: C.SWAP_ROUTER02 } };

// ── calldata, built the way the dApp's chain/build.js builds it ─────────────
const erc20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const curveI = new Interface(['function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)']);
const permit2I = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const urI = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
const routerI = new Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
]);
const EXACT_IN_SINGLE_T = _private.EXACT_IN_SINGLE_T;

/** backend/src/evm/v5/swap.js:451-493, for a SELL (token in, quote out, payerIsUser). */
function v4Sell({ key, token, recipient, amountIn = 10n ** 21n, minOut = 1n, commands = '0x10', actions = '0x060b0e', zeroForOne, hooks, takeCurrency }) {
  const tokenIsC0 = key.currency0 === token;
  const swapParam = coder.encode(
    [EXACT_IN_SINGLE_T],
    [{ poolKey: { ...key, hooks: hooks || key.hooks }, zeroForOne: zeroForOne ?? tokenIsC0, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n, hookData: '0x' }]
  );
  const settle = coder.encode(['address', 'uint256', 'bool'], [token, 0n, true]);
  const take = coder.encode(['address', 'address', 'uint256'], [takeCurrency || (tokenIsC0 ? key.currency1 : key.currency0), recipient, 0n]);
  const input = coder.encode(['bytes', 'bytes[]'], [actions, [swapParam, settle, take]]);
  return urI.encodeFunctionData('execute', [commands, [input], 1_900_000_000n]);
}

/** backend/src/evm/router.js:116-170 — Router02 shape. */
function v1Sell({ recipient, swapRecipient = C.SWAP_ROUTER02, fee = 10000, tokenOut = C.WETH, deadline = null, extra = [] }) {
  const swap = routerI.encodeFunctionData('exactInputSingle', [[TOKEN, tokenOut, fee, swapRecipient, 10n ** 21n, 1n, 0n]]);
  const unwrap = routerI.encodeFunctionData('unwrapWETH9', [0n, recipient]);
  const calls = [swap, unwrap, ...extra];
  return deadline == null
    ? routerI.encodeFunctionData('multicall(bytes[])', [calls])
    : routerI.encodeFunctionData('multicall(uint256,bytes[])', [deadline, calls]);
}

/** backend/src/evm/v3/swaproute.js:175-182. */
function pairToEth({ path, fees, recipient, deadline = null }) {
  const types = [];
  const values = [];
  path.forEach((a, i) => {
    types.push('address');
    values.push(a);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]);
    }
  });
  const swap = routerI.encodeFunctionData('exactInput', [[solidityPacked(types, values), C.SWAP_ROUTER02, 10n ** 18n, 1n]]);
  const unwrap = routerI.encodeFunctionData('unwrapWETH9', [0n, recipient]);
  return deadline == null
    ? routerI.encodeFunctionData('multicall(bytes[])', [[swap, unwrap]])
    : routerI.encodeFunctionData('multicall(uint256,bytes[])', [deadline, [swap, unwrap]]);
}

async function sign(wallet, { to, data, nonce = 0, chainId = 4663, value = 0n, type = 2, extra = {} }) {
  const base = { type, chainId, nonce, to, data, value, gasLimit: 500_000n };
  const fees = type === 0 ? { gasPrice: 10n ** 9n } : { maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n };
  return wallet.signTransaction({ ...base, ...fees, ...extra });
}

const ok = async (venue, tx) => {
  const w = tx.wallet || Wallet.createRandom();
  const data = typeof tx.data === 'function' ? tx.data(w.address.toLowerCase()) : tx.data;
  const d = decodeRaw(await sign(w, { ...tx, data }));
  validateTx(d, venue);
  return d;
};
const refused = async (venue, tx, pattern) => {
  const w = tx.wallet || Wallet.createRandom();
  const data = typeof tx.data === 'function' ? tx.data(w.address.toLowerCase()) : tx.data;
  const raw = await sign(w, { ...tx, data });
  assert.throws(
    () => validateTx(decodeRaw(raw), venue),
    (err) => err instanceof TpError && err.code === 'bad_tx' && (!pattern || pattern.test(err.message))
  );
};

// ── decodeRaw ────────────────────────────────────────────────────────────────
test('decodeRaw: returns the contract shape, lower-cased', async () => {
  const w = Wallet.createRandom();
  const data = erc20.encodeFunctionData('approve', [CURVE, 5n]);
  const raw = await sign(w, { to: TOKEN, data, nonce: 7 });
  const d = decodeRaw(raw);
  assert.deepEqual(
    Object.keys(d).sort(),
    ['chainId', 'data', 'from', 'gasLimit', 'hash', 'maxPriorityFeePerGas', 'nonce', 'selector', 'to', 'value'].sort()
  );
  assert.equal(d.from, w.address.toLowerCase());
  assert.equal(d.to, TOKEN);
  assert.equal(d.nonce, 7);
  assert.equal(d.chainId, 4663);
  assert.equal(d.selector, '0x095ea7b3');
  assert.equal(d.value, '0');
  assert.equal(d.gasLimit, '500000');
  assert.equal(d.maxPriorityFeePerGas, '0');
  assert.equal(d.hash, Transaction.from(raw).hash.toLowerCase());
});

test('decodeRaw: garbage, unsigned, legacy and EIP-7702 transactions are bad_tx', async () => {
  const w = Wallet.createRandom();
  const isBad = (fn, re) => assert.throws(fn, (e) => e instanceof TpError && e.code === 'bad_tx' && re.test(e.message));
  isBad(() => decodeRaw('hello'), /hex-encoded/);
  isBad(() => decodeRaw('0x1234'), /not a valid signed/);
  isBad(() => decodeRaw('0x' + 'ab'.repeat(9000)), /hex-encoded/);
  const unsigned = Transaction.from({ type: 2, chainId: 4663, nonce: 0, to: TOKEN, data: '0x', gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }).unsignedSerialized;
  isBad(() => decodeRaw(unsigned), /not signed/);
  const legacy = await sign(w, { to: TOKEN, data: erc20.encodeFunctionData('approve', [CURVE, 1n]), type: 0 });
  isBad(() => decodeRaw(legacy), /type 0/);
  // A 7702 authorization would hand the wallet to ATTACKER's code while `data` looks innocent.
  const auth = w.authorizeSync({ address: ATTACKER, nonce: 1, chainId: 4663 });
  const setCode = await sign(w, { to: TOKEN, data: erc20.encodeFunctionData('approve', [CURVE, 1n]), type: 4, extra: { authorizationList: [auth] } });
  isBad(() => decodeRaw(setCode), /type 4/);
});

// ── validateTx: what IS allowed ──────────────────────────────────────────────
test('allowed — curve: approve the curve, sell to yourself', async () => {
  await ok(curveNative, { to: TOKEN, data: erc20.encodeFunctionData('approve', [CURVE, 10n ** 24n]) });
  await ok(curveNative, { to: CURVE, data: (me) => curveI.encodeFunctionData('sell', [10n ** 21n, 1n, me]) });
});

test('allowed — token-quoted curve: pair approve to SwapRouter02 + pair -> USDG -> WETH -> unwrap', async () => {
  await ok(curveAmzn, { to: AMZN, data: erc20.encodeFunctionData('approve', [C.SWAP_ROUTER02, 10n ** 18n]) });
  for (const fee of [3000, 500, 100, 10000]) {
    await ok(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [AMZN, C.USDG, C.WETH], fees: [fee, 100], recipient: me }) });
  }
  await ok(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [AMZN, C.USDG, C.WETH], fees: [3000, 100], recipient: me, deadline: 1_900_000_000n }) });
  await ok(curveUsdg, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [C.USDG, C.WETH], fees: [100], recipient: me }) });
});

test('allowed — graduated native: token -> Permit2, Permit2 -> router, V4 sell to yourself', async () => {
  await ok(gradNative, { to: TOKEN, data: erc20.encodeFunctionData('approve', [C.PERMIT2, 10n ** 24n]) });
  await ok(gradNative, { to: C.PERMIT2, data: permit2I.encodeFunctionData('approve', [TOKEN, C.UNIVERSAL_ROUTER, MAX160 & 10n ** 24n, 1_900_000_000n]) });
  await ok(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me }) });
});

test('allowed — graduated token-quoted with the token as currency0 (zeroForOne) + its ETH leg', async () => {
  await ok(gradSpcx, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: spcxKey, token: TOKEN, recipient: me }) });
  await ok(gradSpcx, { to: SPCX, data: erc20.encodeFunctionData('approve', [C.SWAP_ROUTER02, 1n]) });
  await ok(gradSpcx, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [SPCX, C.USDG, C.WETH], fees: [3000, 100], recipient: me }) });
});

test('allowed — v1: approve SwapRouter02, multicall(exactInputSingle -> router, unwrapWETH9 -> you)', async () => {
  await ok(v1Venue, { to: TOKEN, data: erc20.encodeFunctionData('approve', [C.SWAP_ROUTER02, 10n ** 24n]) });
  await ok(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me }) });
  await ok(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, deadline: 1_900_000_000n }) });
});

// ── validateTx: what is NOT ──────────────────────────────────────────────────
test('refused — wrong chain, ETH value, contract creation', async () => {
  await refused(curveNative, { to: CURVE, chainId: 1, data: (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]) }, /chain id 1/);
  await refused(curveNative, { to: CURVE, value: 1n, data: (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]) }, /never carries ETH/);
  const w = Wallet.createRandom();
  const create = await w.signTransaction({ type: 2, chainId: 4663, nonce: 0, data: '0x6000', gasLimit: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
  assert.throws(() => validateTx(decodeRaw(create), curveNative), /contract creation/);
});

test('refused — a priority fee above 0 (Global Constraints: priority fee 0)', async () => {
  const sell = (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]);
  await refused(curveNative, { to: CURVE, data: sell, extra: { maxPriorityFeePerGas: 1n } }, /priority fee 1 is not 0/);
  await refused(curveNative, { to: CURVE, data: sell, extra: { maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 10n ** 11n } }, /priority fee/);
  // A decoded object without the field (a caller that skipped decodeRaw) is refused too.
  const w = Wallet.createRandom();
  const d = decodeRaw(await sign(w, { to: CURVE, data: sell(w.address.toLowerCase()) }));
  delete d.maxPriorityFeePerGas;
  assert.throws(() => validateTx(d, curveNative), (e) => e instanceof TpError && e.code === 'bad_tx' && /priority fee/.test(e.message));
});

test('refused — a gas limit above 1,000,000; exactly 1,000,000 passes', async () => {
  const sell = (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]);
  await refused(curveNative, { to: CURVE, data: sell, extra: { gasLimit: 1_000_001n } }, /gas limit 1000001 is above 1000000/);
  await refused(gradNative, { to: C.PERMIT2, data: permit2I.encodeFunctionData('approve', [TOKEN, C.UNIVERSAL_ROUTER, 1n, 1n]), extra: { gasLimit: 30_000_000n } }, /gas limit/);
  await ok(curveNative, { to: CURVE, data: sell, extra: { gasLimit: 1_000_000n } });
});

test('refused — approvals to anyone but the venue spender, and plain transfers', async () => {
  await refused(curveNative, { to: TOKEN, data: erc20.encodeFunctionData('approve', [ATTACKER, 1n]) }, /spender/);
  await refused(gradNative, { to: TOKEN, data: erc20.encodeFunctionData('approve', [C.SWAP_ROUTER02, 1n]) }, /spender/);
  await refused(curveNative, { to: TOKEN, data: erc20.encodeFunctionData('transfer', [ATTACKER, 1n]) }, /not allowed/);
  await refused(gradNative, { to: C.PERMIT2, data: permit2I.encodeFunctionData('approve', [TOKEN, ATTACKER, 1n, 1n]) }, /not the router/);
  await refused(gradNative, { to: C.PERMIT2, data: permit2I.encodeFunctionData('approve', [AMZN, C.UNIVERSAL_ROUTER, 1n, 1n]) }, /different token/);
  await refused(curveAmzn, { to: AMZN, data: erc20.encodeFunctionData('approve', [ATTACKER, 1n]) }, /SwapRouter02/);
  // A NATIVE venue has no pair leg at all.
  await refused(curveNative, { to: AMZN, data: erc20.encodeFunctionData('approve', [C.SWAP_ROUTER02, 1n]) }, /not allowed/);
});

test('refused — a curve sell that pays a third address, or to another curve', async () => {
  await refused(curveNative, { to: CURVE, data: curveI.encodeFunctionData('sell', [1n, 0n, ATTACKER]) }, /third address/);
  await refused(curveNative, { to: ATTACKER, data: (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]) }, /not allowed/);
  await refused(curveNative, { to: CURVE, data: (me) => curveI.encodeFunctionData('sell', [0n, 0n, me]) }, /0 tokens/);
});

test('refused — V4: third-address TAKE, another pool, a buy, extra commands, a curve venue', async () => {
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: v4Sell({ key: nativeKey, token: TOKEN, recipient: ATTACKER }) }, /third address/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me, hooks: ATTACKER }) }, /not this token's/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me, zeroForOne: true }) }, /a buy/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me, commands: '0x1004' }) }, /one V4_SWAP/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me, actions: '0x060b0f' }) }, /SETTLE, TAKE/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me, takeCurrency: AMZN }) }, /quote currency/);
  await refused(curveNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me }) }, /not allowed/);
});

test('refused — SwapRouter02: third-address unwrap, WETH straight to the wallet, extra calls, wrong route', async () => {
  await refused(v1Venue, { to: C.SWAP_ROUTER02, data: v1Sell({ recipient: ATTACKER }) }, /third address/);
  await refused(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, swapRecipient: me }) }, /router for the unwrap/);
  await refused(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, tokenOut: AMZN }) }, /WETH/);
  await refused(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, fee: 12345 }) }, /fee tier/);
  const sweep = routerI.encodeFunctionData('sweepToken', [TOKEN, 0n, ATTACKER]);
  await refused(v1Venue, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, extra: [sweep] }) }, /exactly \[swap, unwrapWETH9\]/);
  await refused(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [AMZN, ATTACKER, C.WETH], fees: [3000, 100], recipient: me }) }, /pair -> USDG -> WETH/);
  await refused(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [SPCX, C.USDG, C.WETH], fees: [3000, 100], recipient: me }) }, /pair -> USDG -> WETH/);
  await refused(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [AMZN, C.USDG, C.WETH], fees: [3000, 500], recipient: me }) }, /pair -> USDG -> WETH/);
  await refused(curveAmzn, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me }) }, /does not use/);
  await refused(curveNative, { to: C.SWAP_ROUTER02, data: (me) => pairToEth({ path: [AMZN, C.USDG, C.WETH], fees: [3000, 100], recipient: me }) }, /does not use/);
});

test('refused — calldata that is not canonically encoded', async () => {
  await refused(curveNative, { to: CURVE, data: (me) => curveI.encodeFunctionData('sell', [1n, 0n, me]) + '00' }, /canonical/);
  await refused(gradNative, { to: C.UNIVERSAL_ROUTER, data: (me) => v4Sell({ key: nativeKey, token: TOKEN, recipient: me }) + 'ff' }, /canonical/);
});

// ── broadcast ────────────────────────────────────────────────────────────────
function fakeSender({ fail = {}, delayMs = 0 } = {}) {
  const sent = [];
  return {
    sent,
    async send(method, params) {
      assert.equal(method, 'eth_sendRawTransaction');
      const d = Transaction.from(params[0]);
      const key = `${d.from.toLowerCase()}:${d.nonce}`;
      sent.push(key);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail[key]) {
        const err = new Error('could not coalesce error');
        err.info = { error: { code: -32000, message: fail[key] } };
        throw err;
      }
      return d.hash;
    },
  };
}

async function sellTx(wallet, nonce) {
  return sign(wallet, { to: CURVE, nonce, data: curveI.encodeFunctionData('sell', [1n, 0n, wallet.address]) });
}

test('broadcast: ONE bad transaction rejects the whole batch before anything is sent', async () => {
  const w = Wallet.createRandom();
  const rpc = fakeSender();
  const good = await sellTx(w, 0);
  const evil = await sign(w, { to: TOKEN, nonce: 1, data: erc20.encodeFunctionData('transfer', [ATTACKER, 1n]) });
  await assert.rejects(
    broadcast(curveNative, [good, evil], { provider: rpc }),
    (e) => e instanceof TpError && e.code === 'bad_tx' && /^tx 1: /.test(e.message)
  );
  assert.equal(rpc.sent.length, 0);
});

test('broadcast: size limits, duplicates and nonce clashes', async () => {
  const w = Wallet.createRandom();
  const rpc = fakeSender();
  const code = (p) => p.then(() => null, (e) => e.code);
  assert.equal(await code(broadcast(curveNative, [], { provider: rpc })), 'bad_request');
  assert.equal(await code(broadcast(curveNative, 'x', { provider: rpc })), 'bad_request');
  assert.equal(await code(broadcast(curveNative, new Array(101).fill('0x00'), { provider: rpc })), 'too_many');
  const one = await sellTx(w, 0);
  await assert.rejects(broadcast(curveNative, [one, one], { provider: rpc }), /appears twice/);
  const other = await sign(w, { to: TOKEN, nonce: 0, data: erc20.encodeFunctionData('approve', [CURVE, 1n]) });
  await assert.rejects(broadcast(curveNative, [one, other], { provider: rpc }), /share nonce 0/);
  assert.equal(rpc.sent.length, 0);
});

test('broadcast: wallets go concurrently, one wallet in nonce order, results in input order', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const rpc = fakeSender({ delayMs: 20 });
  const raws = [await sellTx(a, 6), await sellTx(b, 0), await sign(a, { to: TOKEN, nonce: 5, data: erc20.encodeFunctionData('approve', [CURVE, 1n]) })];
  const results = await broadcast(curveNative, raws, { provider: rpc });
  const A = a.address.toLowerCase();
  const B = b.address.toLowerCase();
  // a:5 goes before a:6 even though it was listed last; b does not wait for a.
  assert.deepEqual(rpc.sent, [`${A}:5`, `${B}:0`, `${A}:6`]);
  assert.deepEqual(results.map((r) => [r.from, r.nonce, r.ok, r.error]), [[A, 6, true, null], [B, 0, true, null], [A, 5, true, null]]);
  raws.forEach((raw, i) => assert.equal(results[i].hash, Transaction.from(raw).hash.toLowerCase()));
});

test('broadcast: a failed send holds back that wallet\'s later nonces only; "already known" counts as sent', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const A = a.address.toLowerCase();
  const B = b.address.toLowerCase();
  const rpc = fakeSender({ fail: { [`${A}:5`]: 'nonce too low', [`${B}:0`]: 'already known' } });
  const raws = [
    await sign(a, { to: TOKEN, nonce: 5, data: erc20.encodeFunctionData('approve', [CURVE, 1n]) }),
    await sellTx(a, 6),
    await sellTx(b, 0),
  ];
  const results = await broadcast(curveNative, raws, { provider: rpc });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /nonce too low/);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /not sent: nonce 5/);
  assert.equal(results[2].ok, true);
  assert.equal(rpc.sent.includes(`${A}:6`), false);
});

// ── the optional second endpoint (TP_SEQUENCER_URL) ──────────────────────────
test('sequencer: every tx ALSO goes to the sequencer; either endpoint accepting it counts as sent', async () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();
  const A = a.address.toLowerCase();
  const B = b.address.toLowerCase();
  // a:0 — the primary refuses (its node is behind), the sequencer takes it: sent, and a:1 follows.
  // b:0 — the primary takes it, the sequencer refuses: still sent.
  const rpc = fakeSender({ fail: { [`${A}:0`]: 'upstream connect error' } });
  const seq = fakeSender({ fail: { [`${B}:0`]: 'nonce too low' } });
  const raws = [await sellTx(a, 0), await sellTx(a, 1), await sellTx(b, 0)];
  const results = await broadcast(curveNative, raws, { provider: rpc, sequencer: seq });
  assert.deepEqual(results.map((r) => [r.from, r.nonce, r.ok, r.error]), [[A, 0, true, null], [A, 1, true, null], [B, 0, true, null]]);
  assert.deepEqual([...rpc.sent].sort(), [`${A}:0`, `${A}:1`, `${B}:0`].sort());
  assert.deepEqual([...seq.sent].sort(), [`${A}:0`, `${A}:1`, `${B}:0`].sort());
});

test('sequencer: when BOTH endpoints refuse, the primary\'s error is reported and later nonces wait', async () => {
  const a = Wallet.createRandom();
  const A = a.address.toLowerCase();
  const rpc = fakeSender({ fail: { [`${A}:0`]: 'insufficient funds for gas * price + value' } });
  const seq = fakeSender({ fail: { [`${A}:0`]: 'rejected by the sequencer' } });
  const results = await broadcast(curveNative, [await sellTx(a, 0), await sellTx(a, 1)], { provider: rpc, sequencer: seq });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /insufficient funds/);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /not sent: nonce 0/);
  assert.deepEqual(rpc.sent, [`${A}:0`]);
  assert.deepEqual(seq.sent, [`${A}:0`]);
});

test('sequencer: a hung sequencer never delays a tx the primary accepted, and is waited on at most its timeout', async () => {
  const a = Wallet.createRandom();
  const A = a.address.toLowerCase();
  const hung = {
    sent: [],
    send(method, params) {
      this.sent.push(Transaction.from(params[0]).nonce);
      return new Promise(() => {}); // never answers
    },
  };
  // The primary accepts: done at once, although the sequencer never answers.
  let t0 = Date.now();
  let results = await broadcast(curveNative, [await sellTx(a, 0)], { provider: fakeSender(), sequencer: hung, sequencerTimeoutMs: 5000 });
  assert.equal(results[0].ok, true);
  assert.ok(Date.now() - t0 < 1000, 'did not wait for the sequencer');
  // The primary refuses: the hung sequencer is given up on after sequencerTimeoutMs.
  t0 = Date.now();
  const refusing = fakeSender({ fail: { [`${A}:1`]: 'upstream connect error' } });
  results = await broadcast(curveNative, [await sellTx(a, 1)], { provider: refusing, sequencer: hung, sequencerTimeoutMs: 30 });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /upstream connect error/);
  assert.ok(Date.now() - t0 < 1000, 'gave up on the sequencer after its timeout');
  assert.deepEqual(hung.sent, [0, 1]);
});

test('sequencerProvider: none when TP_SEQUENCER_URL is blank; one cached JsonRpcProvider per URL', () => {
  const before = process.env.TP_SEQUENCER_URL;
  try {
    process.env.TP_SEQUENCER_URL = '';
    assert.equal(_private.sequencerProvider(), null);
    process.env.TP_SEQUENCER_URL = '   ';
    assert.equal(_private.sequencerProvider(), null);
    // Constructing it reads nothing: staticNetwork, so no eth_chainId round trip.
    process.env.TP_SEQUENCER_URL = 'http://127.0.0.1:9/rpc';
    const p = _private.sequencerProvider();
    assert.ok(p instanceof JsonRpcProvider);
    assert.equal(_private.sequencerProvider(), p, 'cached');
    process.env.TP_SEQUENCER_URL = 'http://127.0.0.1:10/rpc';
    assert.notEqual(_private.sequencerProvider(), p, 'a changed URL gets a new provider');
  } finally {
    _private.resetSequencer();
    if (before === undefined) delete process.env.TP_SEQUENCER_URL;
    else process.env.TP_SEQUENCER_URL = before;
  }
});

test('sequencerProvider: an http:// sequencer still works when RPC_URL is https (its own agent)', async () => {
  // evm/provider.js registers a PROCESS-WIDE https-only getUrl whenever RPC_URL is
  // https (the default). A provider without its own getUrlFunc inherits it, and node
  // then refuses every plain-http request (providers.js tpChartProvider). The
  // "sequencer" here is a loopback fake owned by this test.
  FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc({ agent: new https.Agent() }));
  const HASH = '0x' + '12'.repeat(32);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const one = (p) => ({ jsonrpc: '2.0', id: p.id, result: HASH });
      const payload = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(payload) ? payload.map(one) : one(payload)));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const before = process.env.TP_SEQUENCER_URL;
  try {
    process.env.TP_SEQUENCER_URL = `http://127.0.0.1:${server.address().port}/`;
    assert.equal(await _private.sequencerProvider().send('eth_sendRawTransaction', ['0x02']), HASH);
  } finally {
    _private.resetSequencer();
    FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc());
    server.close();
    server.closeAllConnections();
    if (before === undefined) delete process.env.TP_SEQUENCER_URL;
    else process.env.TP_SEQUENCER_URL = before;
  }
});

// ── watchReceipts ────────────────────────────────────────────────────────────
test('watchReceipts: announces landed and reverted receipts on receiptBus, then stops', async () => {
  const H1 = '0x' + 'a1'.repeat(32);
  const H2 = '0x' + 'b2'.repeat(32);
  const FROM = '0x' + 'cd'.repeat(20);
  const polls = { [H1]: 0, [H2]: 0 };
  const rpc = {
    async getTransactionReceipt(hash) {
      polls[hash] += 1;
      // H1: not mined for two polls, then landed. H2: one RPC blip, then reverted.
      if (hash === H1) return polls[H1] > 2 ? { from: FROM.toUpperCase().replace('0X', '0x'), status: 1, blockNumber: 1234, gasUsed: 150000n } : null;
      if (polls[H2] === 1) throw new Error('blip');
      return { from: FROM, status: 0, blockNumber: 1235, gasUsed: 90000n };
    },
  };
  const events = [];
  const on = (e) => events.push(e);
  receiptBus.on('receipt', on);
  try {
    const left = await watchReceipts(TOKEN.toUpperCase().replace('0X', '0x'), [H1, H2], { provider: rpc, pollMs: 1, timeoutMs: 1000 });
    assert.deepEqual(left, []);
  } finally {
    receiptBus.off('receipt', on);
  }
  const byHash = Object.fromEntries(events.map((e) => [e.hash, e]));
  assert.deepEqual(byHash[H1], { token: TOKEN, hash: H1, from: FROM, status: 'landed', block: 1234, gasUsed: '150000' });
  assert.deepEqual(byHash[H2], { token: TOKEN, hash: H2, from: FROM, status: 'reverted', block: 1235, gasUsed: '90000' });
});

test('watchReceipts: gives up after the timeout without an event', async () => {
  const rpc = { async getTransactionReceipt() { return null; } };
  const events = [];
  const on = (e) => events.push(e);
  receiptBus.on('receipt', on);
  try {
    const left = await watchReceipts(TOKEN, ['0x' + 'ee'.repeat(32)], { provider: rpc, pollMs: 2, timeoutMs: 20 });
    assert.deepEqual(left, ['0x' + 'ee'.repeat(32)]);
  } finally {
    receiptBus.off('receipt', on);
  }
  assert.equal(events.length, 0);
});

test('golden selectors', () => {
  assert.deepEqual(_private.SEL, {
    approve: '0x095ea7b3',
    sell: '0xd04c6983',
    permit2Approve: '0x87517c45',
    execute: '0x3593564c',
    multicall: '0xac9650d8',
    multicallDeadline: '0x5ae401dc',
    exactInputSingle: '0x04e45aaf',
    exactInput: '0xb858183f',
    unwrapWETH9: '0x49404b7c',
  });
});

// ── receipts scoped to the stream that asked for them (plan Task 7) ─────────────
test('watchReceipts: a well-formed sid tags every receipt; a malformed one tags none', async () => {
  const H = '0x' + 'f1'.repeat(32);
  const rpc = {
    async getTransactionReceipt() {
      return { from: '0x' + 'cd'.repeat(20), status: 1, blockNumber: 9, gasUsed: 21000n };
    },
  };
  const events = [];
  const on = (e) => events.push(e);
  receiptBus.on('receipt', on);
  try {
    await watchReceipts(TOKEN, [H], { provider: rpc, pollMs: 1, timeoutMs: 100, sid: 'ab'.repeat(16) });
    await watchReceipts(TOKEN, [H], { provider: rpc, pollMs: 1, timeoutMs: 100, sid: 'NOT-A-SID' });
    await watchReceipts(TOKEN, [H], { provider: rpc, pollMs: 1, timeoutMs: 100 });
  } finally {
    receiptBus.off('receipt', on);
  }
  assert.equal(events.length, 3);
  assert.equal(events[0].sid, 'ab'.repeat(16));
  assert.equal('sid' in events[1], false, 'a malformed sid is dropped: that receipt reaches no stream');
  assert.equal('sid' in events[2], false, 'no sid: the event keeps its Task 5 shape');
});

// ── receipt polls are reads, capped process-wide (review: tp reads share the console pool) ──
test('watchReceipts polls on the RECEIPT provider by default — never the read lane quotes use, never the send one', async () => {
  const providers = require('./providers');
  const saved = { read: providers.tpReadProvider, send: providers.tpSendProvider, receipt: providers.tpReceiptProvider };
  const used = [];
  const fake = (name, receipt) => () => ({
    async getTransactionReceipt() {
      used.push(name);
      return receipt;
    },
  });
  providers.tpReceiptProvider = fake('receipt', { from: '0x' + 'cd'.repeat(20), status: 1, blockNumber: 3, gasUsed: 21000n });
  providers.tpReadProvider = fake('read', null);
  providers.tpSendProvider = fake('send', null);
  try {
    const left = await watchReceipts(TOKEN, ['0x' + 'a7'.repeat(32)], { pollMs: 1, timeoutMs: 100 });
    assert.deepEqual(left, []);
  } finally {
    Object.assign(providers, { tpReadProvider: saved.read, tpSendProvider: saved.send, tpReceiptProvider: saved.receipt });
  }
  assert.deepEqual(used, ['receipt']);
});

test('watchReceipts watches at most maxWatched hashes across ALL calls; the rest are left to the page sweep', async () => {
  const polled = new Set();
  const rpc = {
    async getTransactionReceipt(hash) {
      polled.add(hash);
      return null; // never mined
    },
  };
  const h = (n) => '0x' + n.toString(16).padStart(64, '0');
  const first = watchReceipts(TOKEN, [h(1), h(2)], { provider: rpc, pollMs: 1, timeoutMs: 60, maxWatched: 3 });
  const second = watchReceipts(TOKEN, [h(3), h(4), h(5)], { provider: rpc, pollMs: 1, timeoutMs: 60, maxWatched: 3 });
  assert.deepEqual(await second, [h(3), h(4), h(5)], 'every hash that did not land is reported, watched or not');
  await first;
  assert.deepEqual([...polled].sort(), [h(1), h(2), h(3)], 'only three were ever polled');
  // Both watches ended: the room is back.
  polled.clear();
  await watchReceipts(TOKEN, [h(6), h(7), h(8)], { provider: rpc, pollMs: 1, timeoutMs: 10, maxWatched: 3 });
  assert.deepEqual([...polled].sort(), [h(6), h(7), h(8)]);
});

// ── v1: the launch's own pool tier only (review: v1 sell fee tier not pinned) ──
test('refused — a v1 sell at a fee tier other than the launch pool the venue names', async () => {
  const pinned = { ...v1Venue, poolFee: 10000 };
  await ok(pinned, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, fee: 10000 }) });
  for (const fee of [100, 500, 3000]) {
    await refused(pinned, { to: C.SWAP_ROUTER02, data: (me) => v1Sell({ recipient: me, fee }) }, /fee tier/);
  }
});

test('broadcast: a DRY_RUN server validates the batch but sends nothing', async () => {
  const w = Wallet.createRandom();
  const rpc = fakeSender();
  const good = await sellTx(w, 0);
  await assert.rejects(
    broadcast(curveNative, [good], { provider: rpc, dryRun: true }),
    (e) => e instanceof TpError && e.code === 'unavailable' && e.status === 503 && /DRY_RUN/.test(e.message)
  );
  assert.equal(rpc.sent.length, 0);
  // Validation still runs first: a bad batch is refused as bad_tx, not as dry run.
  const evil = await sign(w, { to: TOKEN, nonce: 1, data: erc20.encodeFunctionData('transfer', [ATTACKER, 1n]) });
  await assert.rejects(
    broadcast(curveNative, [evil], { provider: rpc, dryRun: true }),
    (e) => e instanceof TpError && e.code === 'bad_tx'
  );
  assert.equal(rpc.sent.length, 0);
});

test('broadcast: with no injected provider the dry-run flag comes from config', () => {
  const { _private } = require('./broadcast');
  assert.equal(_private.isDryRun({}), require('../config').dryRun);
  assert.equal(_private.isDryRun({ provider: {} }), false);
  assert.equal(_private.isDryRun({ provider: {}, dryRun: true }), true);
});
