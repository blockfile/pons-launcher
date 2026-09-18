import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AbiCoder, Interface, Wallet, getAddress } from 'ethers';

import {
  approveTx,
  permit2ApproveTx,
  curveSellTx,
  v4SellTx,
  v1SellTx,
  pairToEthTx,
  routeHops,
} from './build.js';
import { PERMIT2, SWAP_ROUTER02, UNIVERSAL_ROUTER, USDG, WETH, NATIVE } from './constants.js';

// Test-only: the backend's verified ABIs and builders are the oracle.
const require = createRequire(import.meta.url);
const { SWAP_ROUTER_02_ABI } = require('../../../../backend/src/evm/abi.js');
const { CURVE_V2_ABI } = require('../../../../backend/src/evm/v2/abi.js');
const swaproute = require('../../../../backend/src/evm/v3/swaproute.js');
const poolswap = require('../../../../backend/src/evm/v3/poolswap.js');

const coder = AbiCoder.defaultAbiCoder();
const norm = (a) => getAddress(String(a).toLowerCase());
const lc = (a) => String(a).toLowerCase();

// The real graduated pons pool (backend/src/evm/v3/poolswap.test.js:79-88).
const TOKEN = norm('0xd8865AA9052A5E2f59641bB613cA84ec9377b101');
const SPCX = norm('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa');
const MEME_HOOK = norm('0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044');
const NATIVE_TOKEN = norm('0x2416A8bc9C617628A9105F6315F0c32E0A438860');
const AMZN = norm('0x12f190a9F9d7D37a250758b26824B97CE941bF54');
const CURVE = norm('0x11B8bfAE26690d21Ae1963E5563062bc8bbC6ee2');

// The EXACT bytes that were eth_simulateV1'd against live state and FILLED
// (backend/src/evm/v3/poolswap.test.js:121-129, FILLED_SELL).
const FILLED_SELL = {
  tokensIn: 10n ** 24n,
  minOut: 21514857779166072n,
  recipient: norm('0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952'),
  deadline: 4102444800n,
  data: '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000f4865700000000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003a0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060b0e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000280000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000200000000000000000000000004a0e65a3eccec6dbe60ae065f2e7bb85fae35eea000000000000000000000000d8865aa9052a5e2f59641bb613ca84ec9377b101000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c8000000000000000000000000e5e702641ea86f4ae6cc3cdaed2b886f976be044000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d3c21bcecceda1000000000000000000000000000000000000000000000000000000004c6fa62f51fb780000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000d8865aa9052a5e2f59641bb613ca84ec9377b1010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000004a0e65a3eccec6dbe60ae065f2e7bb85fae35eea000000000000000000000000267444d099b10fb5ed7c3cc7b7c767adca5749520000000000000000000000000000000000000000000000000000000000000000',
};

const GRADUATED = {
  kind: 'graduated',
  token: TOKEN,
  pairToken: SPCX,
  poolKey: { currency0: SPCX, currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: MEME_HOOK },
};

const erc20 = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const permit2 = new Interface(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const router02 = new Interface(SWAP_ROUTER_02_ABI);
const routerExactInput = new Interface([
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]);
const curveAbi = new Interface(CURVE_V2_ABI);
const universal = new Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);

/** Decode a UniversalRouter execute into its V4 plan. */
function decodeV4(data) {
  const [commands, inputs, deadline] = universal.decodeFunctionData('execute', data);
  const [actions, params] = coder.decode(['bytes', 'bytes[]'], inputs[0]);
  const [swap] = coder.decode(
    [
      'tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)',
    ],
    params[0]
  );
  const settle = coder.decode(['address', 'uint256', 'bool'], params[1]);
  const take = coder.decode(['address', 'address', 'uint256'], params[2]);
  return { commands, actions, deadline, swap, settle, take };
}

test('golden selectors: every builder emits the function the broadcast allowlist expects', () => {
  const wallet = Wallet.createRandom().address;
  assert.equal(approveTx(TOKEN, PERMIT2, 5n).data.slice(0, 10), '0x095ea7b3');
  assert.equal(permit2ApproveTx(TOKEN, UNIVERSAL_ROUTER, 5n, 1800000000).data.slice(0, 10), '0x87517c45');
  assert.equal(curveSellTx(CURVE, 5n, 1n, wallet).data.slice(0, 10), '0xd04c6983');
  assert.equal(v4SellTx(GRADUATED, 5n, 1n, wallet, 1800000000).data.slice(0, 10), '0x3593564c');
  const v1 = { kind: 'v1', token: TOKEN, pairToken: WETH, poolFee: 10000 };
  assert.equal(v1SellTx(v1, 5n, 1n, wallet, 1800000000).data.slice(0, 10), '0xac9650d8');
  const route = { path: [AMZN, USDG, WETH], fees: [3000, 100] };
  assert.equal(pairToEthTx(route, 5n, 1n, wallet, 1800000000).data.slice(0, 10), '0xac9650d8');
});

test('every builder returns value 0n and a pinned or venue-owned `to`', () => {
  const wallet = Wallet.createRandom().address;
  const v1 = { kind: 'v1', token: TOKEN, pairToken: WETH };
  const cases = [
    [approveTx(TOKEN, PERMIT2, 5n), TOKEN],
    [permit2ApproveTx(TOKEN, UNIVERSAL_ROUTER, 5n, 1800000000), PERMIT2],
    [curveSellTx(CURVE, 5n, 1n, wallet), CURVE],
    [v4SellTx(GRADUATED, 5n, 1n, wallet, 1800000000), UNIVERSAL_ROUTER],
    [v1SellTx(v1, 5n, 1n, wallet, 1800000000), SWAP_ROUTER02],
    [pairToEthTx({ path: [AMZN, USDG, WETH], fees: [3000, 100] }, 5n, 1n, wallet, 1800000000), SWAP_ROUTER02],
  ];
  for (const [tx, to] of cases) {
    assert.equal(tx.value, 0n);
    assert.equal(lc(tx.to), lc(to));
  }
});

test('approve and permit2 approve encode exactly the given spender, amount and expiry', () => {
  const a = erc20.decodeFunctionData('approve', approveTx(TOKEN, CURVE, 123n).data);
  assert.equal(a[0], CURVE);
  assert.equal(a[1], 123n);
  const p = permit2.decodeFunctionData('approve', permit2ApproveTx(TOKEN, UNIVERSAL_ROUTER, 456n, 1800086400).data);
  assert.equal(p[0], TOKEN);
  assert.equal(lc(p[1]), lc(UNIVERSAL_ROUTER));
  assert.equal(p[2], 456n);
  assert.equal(p[3], 1800086400n);
  assert.throws(() => permit2ApproveTx(TOKEN, UNIVERSAL_ROUTER, 1n << 160n, 1800086400), /out of range/);
  assert.throws(() => permit2ApproveTx(TOKEN, UNIVERSAL_ROUTER, 1n, 0), /positive/);
});

test('curve sell: amount, floor and the wallet as recipient, per the verified CURVE_V2_ABI', () => {
  const wallet = Wallet.createRandom().address;
  const d = curveAbi.decodeFunctionData('sell', curveSellTx(CURVE, 777n, 55n, wallet).data);
  assert.equal(d[0], 777n);
  assert.equal(d[1], 55n);
  assert.equal(d[2], getAddress(wallet), 'the proceeds go to the wallet that sold');
  assert.throws(() => curveSellTx(CURVE, 0n, 0n, wallet), /positive/);
});

test('v4 sell reproduces, byte for byte, a sell that FILLED the live pons pool', () => {
  const tx = v4SellTx(
    GRADUATED,
    FILLED_SELL.tokensIn,
    FILLED_SELL.minOut,
    FILLED_SELL.recipient,
    FILLED_SELL.deadline
  );
  assert.equal(tx.data.toLowerCase(), FILLED_SELL.data.toLowerCase());
  assert.equal(lc(tx.to), lc(UNIVERSAL_ROUTER));
});

test('v4 sell on a NATIVE pool matches the backend poolswap builder and takes to the wallet', () => {
  const wallet = Wallet.createRandom().address;
  const poolKey = { currency0: NATIVE, currency1: NATIVE_TOKEN, fee: 0, tickSpacing: 200, hooks: MEME_HOOK };
  const venue = { kind: 'graduated', token: NATIVE_TOKEN, pairToken: NATIVE, poolKey };
  const mine = v4SellTx(venue, 10n ** 24n, 12345n, wallet, 1800000000n);
  const theirs = poolswap.buildSellToPair({
    pool: { token: NATIVE_TOKEN, pairToken: NATIVE, poolKey, poolId: '0x01' },
    tokensIn: 10n ** 24n,
    minOut: 12345n,
    recipient: wallet,
    deadline: 1800000000n,
  });
  assert.equal(mine.data, theirs.data);

  const plan = decodeV4(mine.data);
  assert.equal(plan.commands, '0x10');
  assert.equal(plan.actions, '0x060b0e');
  assert.equal(plan.swap.zeroForOne, false, 'the token is currency1, so a sell is oneForZero');
  assert.equal(plan.swap.amountOutMinimum, 12345n);
  assert.equal(plan.settle[0], NATIVE_TOKEN, 'settle pays the token in');
  assert.equal(plan.settle[2], true, 'the router pulls it from the seller via Permit2');
  assert.equal(plan.take[0], getAddress(NATIVE), 'take receives native ETH');
  assert.equal(plan.take[1], getAddress(wallet), 'the proceeds go to the wallet that sold');
});

test('v4 sell refuses a floorless swap, an unsorted key and a key without the token', () => {
  const wallet = Wallet.createRandom().address;
  assert.throws(() => v4SellTx(GRADUATED, 5n, 0n, wallet, 1800000000), /minOut must be positive/);
  const unsorted = { ...GRADUATED, poolKey: { ...GRADUATED.poolKey, currency0: TOKEN, currency1: SPCX } };
  assert.throws(() => v4SellTx(unsorted, 5n, 1n, wallet, 1800000000), /not sorted/);
  const foreign = { ...GRADUATED, token: AMZN };
  assert.throws(() => v4SellTx(foreign, 5n, 1n, wallet, 1800000000), /not in the poolKey/);
});

test('v1 sell: multicall[exactInputSingle to the ROUTER, unwrapWETH9 to the wallet], floor on the swap', () => {
  const wallet = Wallet.createRandom().address;
  const venue = { kind: 'v1', token: TOKEN, pairToken: WETH, poolFee: 10000 };
  const tx = v1SellTx(venue, 1000n, 900n, wallet, 1800000000);
  const [calls] = router02.decodeFunctionData('multicall', tx.data);
  assert.equal(calls.length, 2);
  const [swap] = router02.decodeFunctionData('exactInputSingle', calls[0]);
  assert.equal(swap.tokenIn, TOKEN);
  assert.equal(lc(swap.tokenOut), lc(WETH));
  assert.equal(swap.fee, 10000n);
  assert.equal(lc(swap.recipient), lc(SWAP_ROUTER02), 'the swap pays the router, which unwraps');
  assert.equal(swap.amountIn, 1000n);
  assert.equal(swap.amountOutMinimum, 900n);
  assert.equal(swap.sqrtPriceLimitX96, 0n);
  const unwrap = router02.decodeFunctionData('unwrapWETH9', calls[1]);
  assert.equal(unwrap[0], 0n);
  assert.equal(unwrap[1], getAddress(wallet), 'native ETH goes to the wallet that sold');
  assert.throws(() => v1SellTx({ ...venue, pairToken: USDG }, 1000n, 900n, wallet, 1), /pairs with WETH/);
  assert.throws(() => v1SellTx(venue, 1000n, 0n, wallet, 1), /minOut must be positive/);
});

test('pair -> ETH equals the backend swaproute sell leg byte for byte', () => {
  const wallet = Wallet.createRandom().address;
  const mine = pairToEthTx({ path: [AMZN, USDG, WETH], fees: [3000, 100] }, 5n * 10n ** 18n, 4n * 10n ** 15n, wallet, 1);
  const theirs = swaproute.buildSwapPairToEth({
    pairToken: AMZN,
    amountIn: 5n * 10n ** 18n,
    minOut: 4n * 10n ** 15n,
    recipient: wallet,
    usdgFee: 3000,
  });
  assert.equal(mine.data, theirs.data);
  assert.equal(lc(mine.to), lc(theirs.to));

  const [calls] = router02.decodeFunctionData('multicall', mine.data);
  const [params] = routerExactInput.decodeFunctionData('exactInput', calls[0]);
  assert.equal(lc(params.recipient), lc(SWAP_ROUTER02));
  assert.equal(params.amountOutMinimum, 4n * 10n ** 15n);
  const unwrap = router02.decodeFunctionData('unwrapWETH9', calls[1]);
  assert.equal(unwrap[1], getAddress(wallet), 'native ETH goes to the wallet that sold');
});

test('the pair route accepts the packed path form and refuses anything off the pinned hops', () => {
  const packed = swaproute._private.sellPath(AMZN, 500);
  assert.deepEqual(routeHops({ path: packed }), { tokens: [AMZN, norm(USDG), norm(WETH)], fees: [500, 100] });
  assert.throws(() => routeHops({ path: [AMZN, WETH, USDG], fees: [3000, 100] }), /through USDG to WETH/);
  assert.throws(() => routeHops({ path: [AMZN, USDG, WETH], fees: [2500, 100] }), /fee tier/);
  assert.throws(() => routeHops({ path: [AMZN, USDG, WETH], fees: [3000, 500] }), /0.01% pool/);
  assert.throws(() => routeHops({ path: [WETH, USDG, WETH], fees: [3000, 100] }), /bad pair token/);
  assert.throws(() => routeHops({ path: [AMZN, WETH], fees: [3000] }), /pair -> USDG -> WETH/);
  const wallet = Wallet.createRandom().address;
  assert.throws(() => pairToEthTx({ path: [AMZN, USDG, WETH], fees: [3000, 100] }, 5n, 0n, wallet, 1), /minOut must be positive/);
});

test('a USDG pair converts in ONE hop, USDG -(0.01%)- WETH, in the bytes the broadcast validator reads', () => {
  const wallet = Wallet.createRandom().address;
  // Task 4 quotePairToEth answers a USDG pair with path [USDG, WETH], fees [100].
  const route = { path: [USDG, WETH], fees: [100] };
  assert.deepEqual(routeHops(route), { tokens: [norm(USDG), norm(WETH)], fees: [100] });

  const tx = pairToEthTx(route, 25n * 10n ** 6n, 9n * 10n ** 15n, wallet, 1);
  assert.equal(lc(tx.to), lc(SWAP_ROUTER02));
  assert.equal(tx.data.slice(0, 10), '0xac9650d8');
  const [calls] = router02.decodeFunctionData('multicall', tx.data);
  assert.equal(calls.length, 2);
  const [params] = routerExactInput.decodeFunctionData('exactInput', calls[0]);
  // Built by hand the way Task 5 checkPairPath reads a one-hop path: 86 hex
  // characters = USDG (40) + fee 100 as uint24 (6) + WETH (40).
  const byHand = '0x' + lc(USDG).slice(2) + '000064' + lc(WETH).slice(2);
  assert.equal(lc(params.path), byHand);
  assert.equal(params.path.length, 2 + 86);
  assert.equal(lc(params.recipient), lc(SWAP_ROUTER02), 'the swap pays the router, which unwraps');
  assert.equal(params.amountIn, 25n * 10n ** 6n);
  assert.equal(params.amountOutMinimum, 9n * 10n ** 15n);
  const unwrap = router02.decodeFunctionData('unwrapWETH9', calls[1]);
  assert.equal(unwrap[1], getAddress(wallet), 'native ETH goes to the wallet that sold');

  // The packed form round-trips; anything but USDG -> WETH at 0.01% is refused.
  assert.deepEqual(routeHops({ path: byHand }), { tokens: [norm(USDG), norm(WETH)], fees: [100] });
  assert.throws(() => routeHops({ path: [USDG, WETH], fees: [500] }), /0.01% pool/);
  assert.throws(() => routeHops({ path: [WETH, USDG], fees: [100] }), /pair -> USDG -> WETH/);
  assert.throws(() => routeHops({ path: [USDG, AMZN], fees: [100] }), /through USDG to WETH/);
  assert.throws(() => routeHops({ path: '0x' + lc(AMZN).slice(2) + '000064' + lc(WETH).slice(2) }), /pair -> USDG -> WETH/);
  assert.throws(() => routeHops({ path: [USDG, WETH], fees: [100, 100] }), /pair -> USDG -> WETH/);
  assert.throws(() => routeHops({ path: '0x' + lc(USDG).slice(2) + '000064' }), /43/);
});
